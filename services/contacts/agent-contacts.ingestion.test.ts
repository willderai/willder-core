import { beforeEach, describe, expect, it, vi } from "vitest";

// Agent-API contact writes must reach the memory graph: `ingestContactWrite`
// runs after the transaction commits, the same way both human-facing contact
// routes ingest.
//
// The only `ingestMemory` assertion in agent-contacts.test.ts is a NEGATIVE
// one on the replay path (`expect(ingestMemory).not.toHaveBeenCalled()`), so
// deleting the `await ingestContactWrite(ctx, result.contact)` line entirely
// would leave that suite green — a fix with no test that fails without it.
//
// This file is the positive half: an accepted create and an accepted update
// must each actually reach the memory graph. Both tests below fail against a
// build with the ingestion call removed.
vi.mock("@/lib/db", () => ({
  db: {
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit_test_id" }) },
    contact: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    contactIdempotencyKey: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/inngest", () => ({ ingestMemory: vi.fn().mockResolvedValue(undefined) }));

import { db } from "@/lib/db";
import { ingestMemory } from "@/lib/inngest";
import { upsertContact } from "./agent-contacts";
import type { AccessContext } from "@/services/access";

const ORG = "org_1";

const agentCtx = (): AccessContext => ({
  orgId: ORG,
  actor: { type: "agent", id: "agent_shin", capabilityToken: "wcap_test" },
  origin: "mcp",
});

const capabilityRow = (permission: "read" | "write" | "admin", agentId = "agent_shin") => [
  { permission, createdBy: "user_1", agentId },
];

function baseContact(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "contact_1",
    orgId: ORG,
    accountId: null,
    name: "Jane Prospect",
    email: "jane@acme.com",
    title: "VP Sales",
    type: "prospect",
    description: null,
    socialLinks: {},
    status: "active",
    entityId: null,
    enrichStatus: null,
    revision: 0,
    suppressed: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  // mockReset, not mockClear: vitest's clearAllMocks leaves queued
  // mockResolvedValueOnce values in place, so an unconsumed queue leaks into
  // the next test. Confirmed live on this suite — breaking the
  // concurrent-retry replay made the *control* test after it fail too, on
  // leaked state rather than on its own behavior.
  vi.resetAllMocks();
  vi.mocked(ingestMemory).mockResolvedValue(undefined as never);
  vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_test_id" } as never);
  vi.mocked(db.$transaction).mockImplementation(async (fn) => fn(db as never));
  vi.mocked(db.contactIdempotencyKey.findUnique).mockResolvedValue(null as never);
  vi.mocked(db.contactIdempotencyKey.create).mockResolvedValue({} as never);
  vi.mocked(db.contactIdempotencyKey.update).mockResolvedValue({} as never);
  // Default to "claim won" / "release succeeded" so this file's repair tests
  // (retry after a failed ingest, repeat-failure) reach ingestMemory without
  // modelling the delivery claim.
  vi.mocked(db.contactIdempotencyKey.updateMany).mockResolvedValue({ count: 1 } as never);
});

describe("upsertContact — memory-graph ingestion", () => {
  it("syncs an accepted CREATE into the memory graph", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValueOnce(capabilityRow("write") as never);
    vi.mocked(db.contact.create).mockResolvedValue(
      baseContact({ id: "contact_new", name: "Dana Buyer", type: "customer" }) as never,
    );

    await upsertContact(agentCtx(), { idempotencyKey: "ing-1", name: "Dana Buyer", type: "customer" });

    // The assertion that actually fails when the ingestion call is deleted.
    expect(ingestMemory).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ingestMemory).mock.calls[0][0]).toMatchObject({
      groupId: ORG,
      name: "Dana Buyer",
      actorType: "agent",
      actorId: "agent_shin",
    });
    // The seed must carry the contact's real identity, not an empty husk —
    // a graph row that says nothing is the same blind spot as no row at all.
    expect(String(vi.mocked(ingestMemory).mock.calls[0][0].content)).toContain("Dana Buyer");
  });

  it("syncs an accepted UPDATE into the memory graph", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValueOnce(capabilityRow("write") as never);
    vi.mocked(db.contact.findFirst).mockResolvedValue(baseContact({ revision: 5 }) as never);
    vi.mocked(db.contact.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.contact.findUniqueOrThrow).mockResolvedValue(
      baseContact({ revision: 6, title: "SVP Sales" }) as never,
    );

    await upsertContact(agentCtx(), {
      idempotencyKey: "ing-2",
      contactId: "contact_1",
      baseRevision: 5,
      title: "SVP Sales",
    });

    expect(ingestMemory).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ingestMemory).mock.calls[0][0]).toMatchObject({ groupId: ORG, name: "Jane Prospect" });
  });

  it("ingests only after the write and its idempotency key are both committed", async () => {
    // Ordering matters for the delete-safety guarantee in finding #2: the
    // ledger row is what a later retry replays from, so it must exist before
    // anything downstream of the graph can observe the contact.
    vi.mocked(db.$queryRaw).mockResolvedValueOnce(capabilityRow("write") as never);
    vi.mocked(db.contact.create).mockResolvedValue(baseContact({ id: "contact_new" }) as never);

    await upsertContact(agentCtx(), { idempotencyKey: "ing-3", name: "Jane Prospect" });

    const keyWrite = vi.mocked(db.contactIdempotencyKey.create).mock.invocationCallOrder[0];
    const ingest = vi.mocked(ingestMemory).mock.invocationCallOrder[0];
    expect(keyWrite).toBeLessThan(ingest);
  });
});

describe("upsertContact — ingestion failure after commit", () => {
  // Not a style nit. `ingestContactWrite` is awaited and deliberately NOT
  // swallowed (agent-contacts.ts's own doc comment says so, on purpose, so a
  // dropped ingestion is never silent). The consequence is that when the
  // enqueue fails, the contact row and its idempotency-key row are ALREADY
  // committed — the throw happens after `db.$transaction` resolved. So the
  // caller sees an error for a write that really did happen.
  //
  // A safe retry under the same idempotencyKey must not find the recorded
  // success and return it without ever reaching the graph — that would leave
  // an agent-written contact invisible in the memory graph, with the retry
  // that should have healed it reporting success instead. The ledger row
  // tracks `ingestedAt`, and `replayIdempotentResult` re-attempts the sync
  // before returning a recorded success whose `ingestedAt` is still null.
  //
  // WHO marks `ingestedAt` matters. Marking it in agent-contacts.ts when the
  // mocked `ingestMemory` resolves would only prove the ENQUEUE (a mocked
  // `ingestMemory` resolving is indistinguishable from a real landed graph
  // write). The mark happens inside `ingestMemory`'s real pipeline
  // (lib/inngest.ts's `runMemoryIngest`/`memoryIngest`, see
  // lib/inngest.contact-delivery.test.ts for that real-completion coverage)
  // once the write actually lands — this file, which mocks `ingestMemory`
  // wholesale, can only assert that agent-contacts.ts hands it the right
  // `confirmDelivery` target to do so, not that delivery itself happened.
  //
  // The first test below pins the write committing despite the enqueue
  // throwing. The second pins the repair: a later replay of that same key
  // repairs the gap instead of silently reporting success over it.
  it("leaves the contact and the idempotency key committed when ingestion throws", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValueOnce(capabilityRow("write") as never);
    vi.mocked(db.contact.create).mockResolvedValue(baseContact({ id: "contact_new" }) as never);
    vi.mocked(ingestMemory).mockRejectedValueOnce(new Error("inngest unreachable") as never);

    await expect(upsertContact(agentCtx(), { idempotencyKey: "ing-fail", name: "Jane Prospect" })).rejects.toThrow(
      "inngest unreachable",
    );

    // The write was not rolled back — it committed before ingestion ran.
    expect(db.contact.create).toHaveBeenCalledTimes(1);
    expect(db.contactIdempotencyKey.create).toHaveBeenCalledTimes(1);
  });

  it("repairs a failed-ingestion write on retry instead of replaying success over it", async () => {
    const snapshot = {
      id: "contact_new",
      name: "Jane Prospect",
      email: "jane@acme.com",
      title: "VP Sales",
      type: "prospect",
      status: "active",
      suppressed: false,
      revision: 0,
    };
    // The retry: same idempotencyKey, and the ledger row the first (ingestion
    // -failed) attempt already committed is now found up front, ingestedAt
    // still null.
    vi.mocked(db.$queryRaw).mockResolvedValueOnce(capabilityRow("write") as never);
    vi.mocked(db.contactIdempotencyKey.findUnique).mockResolvedValue({
      orgId: ORG,
      key: "ing-fail",
      // Fingerprint of the identical request body — a genuine safe retry.
      requestHash: "SET_BELOW",
      contactId: "contact_new",
      actorId: "agent_shin",
      resultAction: "created",
      resultRevision: 0,
      resultSnapshot: snapshot,
      createdAt: new Date(),
      ingestedAt: null,
    } as never);

    // Recover the real fingerprint the implementation computes, so this is a
    // true replay and not an idempotency_conflict.
    vi.mocked(db.$queryRaw).mockResolvedValueOnce(capabilityRow("write") as never);
    vi.mocked(db.contactIdempotencyKey.findUnique).mockResolvedValueOnce(null as never);
    vi.mocked(db.contact.create).mockResolvedValue(baseContact({ id: "contact_new" }) as never);
    let realHash = "";
    vi.mocked(db.contactIdempotencyKey.create).mockImplementation((async (args: unknown) => {
      realHash = (args as { data: { requestHash: string } }).data.requestHash;
      return {};
    }) as never);
    vi.mocked(ingestMemory).mockRejectedValueOnce(new Error("inngest unreachable") as never);
    await expect(upsertContact(agentCtx(), { idempotencyKey: "ing-fail", name: "Jane Prospect" })).rejects.toThrow(
      "inngest unreachable",
    );
    expect(realHash).not.toBe("");

    vi.mocked(ingestMemory).mockClear();
    vi.mocked(db.$queryRaw).mockResolvedValueOnce(capabilityRow("write") as never);
    vi.mocked(db.contactIdempotencyKey.findUnique).mockResolvedValue({
      orgId: ORG,
      key: "ing-fail",
      requestHash: realHash,
      contactId: "contact_new",
      actorId: "agent_shin",
      resultAction: "created",
      resultRevision: 0,
      resultSnapshot: snapshot,
      createdAt: new Date(),
      ingestedAt: null,
    } as never);

    const retry = await upsertContact(agentCtx(), { idempotencyKey: "ing-fail", name: "Jane Prospect" });

    // The retry reports the write succeeded...
    expect(retry).toEqual({ action: "created", contact: snapshot });
    // ...and this time it actually re-attempted the graph sync instead of
    // silently replaying success over the gap, and handed it a real
    // confirmDelivery target so the ACTUAL write, not this enqueue call, is
    // what marks the ledger (see lib/inngest.contact-delivery.test.ts for
    // the real-completion half of this — a mocked `ingestMemory` resolving
    // here proves nothing about delivery, only that agent-contacts.ts asked
    // for it correctly).
    expect(ingestMemory).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ingestMemory).mock.calls[0][0]).toMatchObject({
      groupId: ORG,
      name: "Jane Prospect",
      confirmDelivery: { kind: "contact-idempotency-key", orgId: ORG, key: "ing-fail" },
    });
    // agent-contacts.ts itself never stamps the ledger any more — this test
    // mocks ingestMemory wholesale, so nothing here could actually mark it.
    expect(db.contactIdempotencyKey.update).not.toHaveBeenCalled();
  });

  it("does not mark a replayed key ingested when the repair attempt fails again", async () => {
    const snapshot = {
      id: "contact_new",
      name: "Jane Prospect",
      email: "jane@acme.com",
      title: "VP Sales",
      type: "prospect",
      status: "active",
      suppressed: false,
      revision: 0,
    };
    // First attempt: real write commits, ingestion fails, key row lands with
    // ingestedAt null. Same "recover the real fingerprint" shape as the test
    // above — requestFingerprint isn't exported, so a genuine replay of this
    // exact request body has to reuse whatever hash the implementation
    // actually computed for it.
    vi.mocked(db.$queryRaw).mockResolvedValueOnce(capabilityRow("write") as never);
    vi.mocked(db.contact.create).mockResolvedValue(baseContact({ id: "contact_new" }) as never);
    let realHash = "";
    vi.mocked(db.contactIdempotencyKey.create).mockImplementation((async (args: unknown) => {
      realHash = (args as { data: { requestHash: string } }).data.requestHash;
      return {};
    }) as never);
    vi.mocked(ingestMemory).mockRejectedValueOnce(new Error("inngest unreachable") as never);
    await expect(
      upsertContact(agentCtx(), { idempotencyKey: "ing-fail-again", name: "Jane Prospect" }),
    ).rejects.toThrow("inngest unreachable");
    expect(realHash).not.toBe("");

    // Retry: repair attempt itself fails again too.
    vi.mocked(ingestMemory).mockClear();
    vi.mocked(db.contactIdempotencyKey.update).mockClear();
    vi.mocked(db.$queryRaw).mockResolvedValueOnce(capabilityRow("write") as never);
    vi.mocked(db.contactIdempotencyKey.findUnique).mockResolvedValue({
      orgId: ORG,
      key: "ing-fail-again",
      requestHash: realHash,
      contactId: "contact_new",
      actorId: "agent_shin",
      resultAction: "created",
      resultRevision: 0,
      resultSnapshot: snapshot,
      createdAt: new Date(),
      ingestedAt: null,
    } as never);
    vi.mocked(ingestMemory).mockRejectedValueOnce(new Error("inngest still unreachable") as never);

    await expect(
      upsertContact(agentCtx(), { idempotencyKey: "ing-fail-again", name: "Jane Prospect" }),
    ).rejects.toThrow("inngest still unreachable");

    // A repeat repair failure is not swallowed into a fake success.
    // agent-contacts.ts never marks the ledger itself (see this file's
    // header note), so the meaningful assertion here is that the
    // repair genuinely re-requested delivery confirmation for this exact key
    // — proving the retry path didn't silently drop confirmDelivery on a
    // repeat failure — not merely that nothing in THIS file's mocks got
    // called.
    expect(vi.mocked(ingestMemory).mock.calls[0][0]).toMatchObject({
      confirmDelivery: { kind: "contact-idempotency-key", orgId: ORG, key: "ing-fail-again" },
    });
    expect(db.contactIdempotencyKey.update).not.toHaveBeenCalled();
  });
});
