import { beforeEach, describe, expect, it, vi } from "vitest";
import { storesNewRow } from "@/services/memory/pgvector-store.testsupport";

// `ContactIdempotencyKey.ingestedAt` is stamped only once the memory write has
// really landed, never when it was merely enqueued.
//
// A stamp taken right after `ingestMemory` RESOLVES proves only that the write
// was enqueued (Inngest) or deferred (`after()` under INNGEST_BYPASS=1), never
// that it reached the memory graph. A queued job that later exhausts its
// retries, or a bypass `after()` run whose failure `.catch(() => {})` swallows,
// would leave the ledger claiming a delivery that never happened, and the next
// replay would see "already ingested" and skip the repair.
//
// A test that mocks `ingestMemory` wholesale and asserts the ledger update
// fires right after it resolves has exactly the shape of that bug, so this
// file exercises the REAL `runMemoryIngest` (the pipeline the Inngest-queued
// `memoryIngest` function and the INNGEST_BYPASS=1 path both funnel through;
// see lib/inngest.ts's "dev-mode direct ingest bypass" section) with only the
// outer graph/db boundary mocked. The ledger-vs-graph-state divergence is then
// observable: the mark only follows a REAL completed write, and a write that
// fails (the retry-exhaustion analog) leaves the ledger unmarked.
vi.mock("@/lib/db", () => ({
  db: {
    // The applied row commits in one transaction with the fact's change event
    // (services/memory/fact-change-event.ts); the callback runs against this mock.
    $transaction(fn: (tx: unknown) => unknown) {
      return fn(this);
    },
    $queryRaw: vi.fn().mockResolvedValue([{ next: BigInt(1), id: "change_1", seq: BigInt(1) }]),
    changeEvent: { create: vi.fn().mockResolvedValue({ id: "change_1" }), findFirst: vi.fn().mockResolvedValue(null) },
    contactIdempotencyKey: { updateMany: vi.fn() },
    org: { findUnique: vi.fn(), update: vi.fn() },
    // runMemoryIngest also records the confirmed-applied audit signal
    // (services/access's real, unmocked recordAppliedChange) once the content's
    // row is stored, before its graph write.
    auditLog: { create: vi.fn() },
  },
}));
vi.mock("@/services/memory", () => ({
  memory: {},
  graphitiStore: { ingest: vi.fn() },
  pgvectorStore: { ingestOnce: vi.fn(), isStored: vi.fn() },
  GraphitiMemoryStore: class {},
}));
vi.mock("@/services/enrichment", () => ({ enrich: vi.fn() }));
vi.mock("@/services/resolver", () => ({ resolveEntities: vi.fn() }));

import { db } from "@/lib/db";
import { graphitiStore, pgvectorStore } from "@/services/memory";
import { runMemoryIngest } from "./inngest";
import type { IngestInput } from "@/types/memory";

const CONFIRM = { kind: "contact-idempotency-key" as const, orgId: "org_1", key: "ing-1" };

function agentInput(overrides: Partial<IngestInput> = {}): IngestInput {
  return {
    groupId: "org_1",
    // Short, agent-provenance content — stays under the 300-char distill
    // threshold (shouldDistillContent), so this exercises the plain store
    // path, not the LLM-distillation branch.
    content: "Jane Prospect is a prospect.",
    source: "agent-contacts",
    name: "Jane Prospect",
    actorType: "agent",
    origin: "mcp",
    actorId: "agent_shin",
    confirmDelivery: CONFIRM,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.contactIdempotencyKey.updateMany).mockResolvedValue({ count: 1 } as never);
  vi.mocked(pgvectorStore.ingestOnce).mockImplementation(storesNewRow("chunk_1"));
  vi.mocked(pgvectorStore.isStored).mockResolvedValue(true);
});

/** When the last of the job's store writes for the content ran. */
const lastStoreWrite = () =>
  Math.max(
    ...vi.mocked(pgvectorStore.ingestOnce).mock.invocationCallOrder,
    ...vi.mocked(graphitiStore.ingest).mock.invocationCallOrder,
  );

describe("runMemoryIngest — contact ledger delivery confirmation", () => {
  it("marks the ledger delivered only after the real graph write completes, not before", async () => {
    vi.mocked(graphitiStore.ingest).mockResolvedValue({ episodeId: "ep_1" });

    await runMemoryIngest(agentInput());

    expect(pgvectorStore.ingestOnce).toHaveBeenCalledTimes(1);
    expect(graphitiStore.ingest).toHaveBeenCalledTimes(1);
    // A guarded updateMany (ingestedAt: null in the WHERE), not a plain update
    // on the unique key — see markContactIngestDelivered's own doc comment for why.
    expect(db.contactIdempotencyKey.updateMany).toHaveBeenCalledWith({
      where: { orgId: "org_1", key: "ing-1", ingestedAt: null },
      data: { ingestedAt: expect.any(Date) },
    });
    // Ordering, not just occurrence: the mark must follow the real write.
    const writeOrder = lastStoreWrite();
    const markOrder = vi.mocked(db.contactIdempotencyKey.updateMany).mock.invocationCallOrder[0];
    expect(writeOrder).toBeLessThan(markOrder);

    // UC6 staleness reads memory.write.applied, recorded once the content's row
    // lands, tagged with this org's root scope since agentInput() sets no
    // explicit scopePath.
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orgId: "org_1",
        actorType: "agent",
        actorId: "agent_shin",
        action: "memory.write.applied",
        target: "org_org_1",
        decision: "allow",
      }),
    });
    const appliedOrder = vi.mocked(db.auditLog.create).mock.invocationCallOrder[0];
    expect(vi.mocked(pgvectorStore.ingestOnce).mock.invocationCallOrder[0]).toBeLessThan(appliedOrder);
  });

  it("leaves the ledger unmarked when the real write fails — the retry-exhaustion analog", async () => {
    // Stands in for a queued job that exhausts its retries, or a bypass
    // after() run whose failure the caller's .catch(() => {}) swallows:
    // either way the graph write never actually lands.
    vi.mocked(graphitiStore.ingest).mockRejectedValue(new Error("graph store unreachable"));

    await expect(runMemoryIngest(agentInput())).rejects.toThrow("graph store unreachable");

    // This is the observable divergence finding #3 is about: under the old
    // design the ledger could be marked delivered regardless of this
    // outcome. It must now stay null so a later replay still repairs it.
    expect(db.contactIdempotencyKey.updateMany).not.toHaveBeenCalled();
    // The content's row landed before the graph write failed, so it is readable
    // and announced as applied: the ledger tracks the whole ingest, the applied
    // signal tracks the stored text.
    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it("does not touch the contact ledger at all for an ingest with no confirmDelivery target", async () => {
    // Every other caller of ingestMemory/runMemoryIngest (human contact
    // routes, enrichment, source sync, …) has no idempotency ledger to
    // confirm — confirmDelivery must be strictly opt-in, never a default
    // write against an unrelated caller's data.
    vi.mocked(graphitiStore.ingest).mockResolvedValue({ episodeId: "ep_2" });

    await runMemoryIngest(agentInput({ confirmDelivery: undefined }));

    expect(graphitiStore.ingest).toHaveBeenCalledTimes(1);
    expect(db.contactIdempotencyKey.updateMany).not.toHaveBeenCalled();
    // The confirmed-applied signal is unconditional — independent of whether
    // this particular caller has an idempotency ledger to confirm.
    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
  });
});
