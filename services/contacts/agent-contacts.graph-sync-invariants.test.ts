import { beforeEach, describe, expect, it, vi } from "vitest";

// Three rules of the agent contact surface's graph sync, each pinned against
// the real upsertContact/replayIdempotentResult code: description reaches the
// graph, a hard-deleted contact is never re-ingested by a replay, and a
// repair attributes the fact to the original actor. The enqueue-vs-delivery
// contract has its own coverage: agent-contacts.ingestion.test.ts (the
// agent-contacts.ts contract with ingestMemory) and
// lib/inngest.contact-delivery.test.ts (the real delivery behavior).
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

const agentCtx = (agentId = "agent_shin"): AccessContext => ({
  orgId: ORG,
  actor: { type: "agent", id: agentId, capabilityToken: "wcap_test" },
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
  vi.resetAllMocks();
  vi.mocked(ingestMemory).mockResolvedValue(undefined as never);
  vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_test_id" } as never);
  vi.mocked(db.$transaction).mockImplementation(async (fn) => fn(db as never));
  vi.mocked(db.contactIdempotencyKey.findUnique).mockResolvedValue(null as never);
  vi.mocked(db.contactIdempotencyKey.create).mockResolvedValue({} as never);
  vi.mocked(db.contactIdempotencyKey.update).mockResolvedValue({} as never);
  // Default to "claim won" / "release succeeded" so this file's repair-path
  // tests (hard-delete guard, actor attribution) exercise the
  // ingestMemory-gets-called behavior without modelling the delivery claim.
  vi.mocked(db.contactIdempotencyKey.updateMany).mockResolvedValue({ count: 1 } as never);
});

describe("upsertContact — description reaches the graph", () => {
  // ingestContactWrite carries name/title/status through; description is
  // accepted and persisted to Contact.description by this surface's upsert,
  // so it must reach the graph too, not be silently absent from what the
  // graph is told.
  it("includes description in the graph content for a CREATE", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValueOnce(capabilityRow("write") as never);
    vi.mocked(db.contact.create).mockResolvedValue(
      baseContact({
        id: "contact_new",
        name: "Dana Buyer",
        type: "customer",
        description: "Series B, expanding into EMEA this quarter",
      }) as never,
    );

    await upsertContact(agentCtx(), {
      idempotencyKey: "desc-1",
      name: "Dana Buyer",
      type: "customer",
      description: "Series B, expanding into EMEA this quarter",
    });

    expect(String(vi.mocked(ingestMemory).mock.calls[0][0].content)).toContain(
      "Series B, expanding into EMEA this quarter",
    );
  });

  it("includes description in the graph content for an UPDATE", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValueOnce(capabilityRow("write") as never);
    vi.mocked(db.contact.findFirst).mockResolvedValue(baseContact({ revision: 2 }) as never);
    vi.mocked(db.contact.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.contact.findUniqueOrThrow).mockResolvedValue(
      baseContact({ revision: 3, description: "Blocked on legal review" }) as never,
    );

    await upsertContact(agentCtx(), {
      idempotencyKey: "desc-2",
      contactId: "contact_1",
      baseRevision: 2,
      description: "Blocked on legal review",
    });

    expect(String(vi.mocked(ingestMemory).mock.calls[0][0].content)).toContain("Blocked on legal review");
  });

  it("omits the description clause entirely when there is none, rather than a stray period/space", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValueOnce(capabilityRow("write") as never);
    vi.mocked(db.contact.create).mockResolvedValue(
      baseContact({ id: "contact_new", title: null, description: null }) as never,
    );

    await upsertContact(agentCtx(), { idempotencyKey: "desc-3", name: "Jane Prospect" });

    const content = String(vi.mocked(ingestMemory).mock.calls[0][0].content);
    expect(content).toBe("Jane Prospect is a prospect.");
  });
});

describe("replayIdempotentResult — hard-deleted contact", () => {
  // Contact.idempotencyKeys' contactId FK is `onDelete: SetNull` specifically
  // so a hard delete (services/memory/person-erasure.ts) never wipes the
  // ledger row a replay depends on. contactId turning null IS the
  // hard-delete signal: repairing the graph sync at that point would
  // re-ingest the frozen resultSnapshot and reseed a person a human
  // explicitly deleted.
  it("does not re-ingest a replay whose contact has since been hard-deleted", async () => {
    // First call: real write, ingestion fails so ingestedAt stays null —
    // same "recover the real fingerprint" shape as agent-contacts.ingestion
    // .test.ts, since requestFingerprint isn't exported.
    vi.mocked(db.$queryRaw).mockResolvedValueOnce(capabilityRow("write") as never);
    vi.mocked(db.contact.create).mockResolvedValue(baseContact({ id: "contact_new" }) as never);
    let realHash = "";
    vi.mocked(db.contactIdempotencyKey.create).mockImplementation((async (args: unknown) => {
      realHash = (args as { data: { requestHash: string } }).data.requestHash;
      return {};
    }) as never);
    vi.mocked(ingestMemory).mockRejectedValueOnce(new Error("inngest unreachable") as never);
    await expect(upsertContact(agentCtx(), { idempotencyKey: "hard-del-1", name: "Jane Prospect" })).rejects.toThrow(
      "inngest unreachable",
    );
    expect(realHash).not.toBe("");

    // Between the two calls, a human hard-deletes the contact: contactId is
    // now null on this exact ledger row (ON DELETE SET NULL), ingestedAt is
    // still null from the failed first attempt.
    vi.mocked(ingestMemory).mockClear();
    vi.mocked(db.$queryRaw).mockResolvedValueOnce(capabilityRow("write") as never);
    vi.mocked(db.contactIdempotencyKey.findUnique).mockResolvedValue({
      orgId: ORG,
      key: "hard-del-1",
      requestHash: realHash,
      contactId: null,
      actorId: "agent_shin",
      resultAction: "created",
      resultRevision: 0,
      resultSnapshot: {
        id: "contact_new",
        name: "Jane Prospect",
        email: null,
        title: null,
        type: "prospect",
        status: "active",
        suppressed: false,
        revision: 0,
        description: null,
      },
      createdAt: new Date(),
      ingestedAt: null,
    } as never);

    const replayed = await upsertContact(agentCtx(), { idempotencyKey: "hard-del-1", name: "Jane Prospect" });

    // The recorded outcome still replays verbatim...
    expect(replayed).toEqual({
      action: "created",
      contact: expect.objectContaining({ id: "contact_new", name: "Jane Prospect" }),
    });
    // ...but the graph is never re-seeded with a person who no longer
    // exists in the contacts table.
    expect(ingestMemory).not.toHaveBeenCalled();
  });

  it("control: still repairs the sync when the contact is live (contactId present)", async () => {
    // Same shape as the test above, but contactId stays populated — proves
    // the guard is specifically about hard-delete, not a blanket regression
    // that stops all repair.
    vi.mocked(db.$queryRaw).mockResolvedValueOnce(capabilityRow("write") as never);
    vi.mocked(db.contactIdempotencyKey.findUnique).mockResolvedValue({
      orgId: ORG,
      key: "hard-del-2",
      requestHash: "irrelevant",
      contactId: "contact_still_here",
      actorId: "agent_shin",
      resultAction: "created",
      resultRevision: 0,
      resultSnapshot: {
        id: "contact_still_here",
        name: "Jane Prospect",
        email: null,
        title: null,
        type: "prospect",
        status: "active",
        suppressed: false,
        revision: 0,
        description: null,
      },
      createdAt: new Date(),
      ingestedAt: null,
    } as never);
    // Match the recorded fingerprint by stubbing requestFingerprint's input
    // shape identically — simplest: assert idempotency_conflict is NOT what
    // happens by checking ingestMemory does get called (a conflict would
    // never reach ingestContactWrite either, so this alone distinguishes
    // "guard blocked it" from "hash mismatch blocked it" clearly enough
    // combined with the hard-delete test above using the real hash).
    vi.mocked(db.contactIdempotencyKey.findUnique).mockResolvedValueOnce(null as never);
    vi.mocked(db.contact.create).mockResolvedValue(baseContact({ id: "contact_still_here" }) as never);
    let realHash = "";
    vi.mocked(db.contactIdempotencyKey.create).mockImplementation((async (args: unknown) => {
      realHash = (args as { data: { requestHash: string } }).data.requestHash;
      return {};
    }) as never);
    vi.mocked(ingestMemory).mockRejectedValueOnce(new Error("inngest unreachable") as never);
    await expect(upsertContact(agentCtx(), { idempotencyKey: "hard-del-2", name: "Jane Prospect" })).rejects.toThrow(
      "inngest unreachable",
    );

    vi.mocked(ingestMemory).mockClear();
    vi.mocked(db.$queryRaw).mockResolvedValueOnce(capabilityRow("write") as never);
    vi.mocked(db.contactIdempotencyKey.findUnique).mockResolvedValue({
      orgId: ORG,
      key: "hard-del-2",
      requestHash: realHash,
      contactId: "contact_still_here",
      actorId: "agent_shin",
      resultAction: "created",
      resultRevision: 0,
      resultSnapshot: {
        id: "contact_still_here",
        name: "Jane Prospect",
        email: null,
        title: null,
        type: "prospect",
        status: "active",
        suppressed: false,
        revision: 0,
        description: null,
      },
      createdAt: new Date(),
      ingestedAt: null,
    } as never);

    await upsertContact(agentCtx(), { idempotencyKey: "hard-del-2", name: "Jane Prospect" });

    expect(ingestMemory).toHaveBeenCalledTimes(1);
  });
});

describe("replayIdempotentResult — actor attribution on repair", () => {
  // The repair must not call ingestContactWrite with ctx's actor — ctx being
  // whichever caller is CURRENTLY retrying. A retry legitimately can arrive
  // under a different capability/agent than the one that made the original
  // write (requestFingerprint only covers the request body, never
  // ctx.actor.id, so a same-body retry from a different agent is a
  // supported replay, not a hash mismatch). Stamping the retrying actor
  // mis-attributes authorship of the fact for provenance ranking.
  it("attributes the repaired fact to the ORIGINAL actor, not the retrying one", async () => {
    // Original write: agent_original, ingestion fails.
    vi.mocked(db.$queryRaw).mockResolvedValueOnce(capabilityRow("write", "agent_original") as never);
    vi.mocked(db.contact.create).mockResolvedValue(baseContact({ id: "contact_new" }) as never);
    let realHash = "";
    vi.mocked(db.contactIdempotencyKey.create).mockImplementation((async (args: unknown) => {
      realHash = (args as { data: { requestHash: string } }).data.requestHash;
      return {};
    }) as never);
    vi.mocked(ingestMemory).mockRejectedValueOnce(new Error("inngest unreachable") as never);
    await expect(
      upsertContact(agentCtx("agent_original"), { idempotencyKey: "attr-1", name: "Jane Prospect" }),
    ).rejects.toThrow("inngest unreachable");
    expect(realHash).not.toBe("");

    // Retry: a DIFFERENT agent (agent_retry) presents the identical request
    // body under the same idempotencyKey — the ledger row still records the
    // original actor.
    vi.mocked(ingestMemory).mockClear();
    vi.mocked(db.$queryRaw).mockResolvedValueOnce(capabilityRow("write", "agent_retry") as never);
    vi.mocked(db.contactIdempotencyKey.findUnique).mockResolvedValue({
      orgId: ORG,
      key: "attr-1",
      requestHash: realHash,
      contactId: "contact_new",
      actorId: "agent_original",
      resultAction: "created",
      resultRevision: 0,
      resultSnapshot: {
        id: "contact_new",
        name: "Jane Prospect",
        email: null,
        title: null,
        type: "prospect",
        status: "active",
        suppressed: false,
        revision: 0,
        description: null,
      },
      createdAt: new Date(),
      ingestedAt: null,
    } as never);

    await upsertContact(agentCtx("agent_retry"), { idempotencyKey: "attr-1", name: "Jane Prospect" });

    expect(ingestMemory).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ingestMemory).mock.calls[0][0]).toMatchObject({
      actorId: "agent_original",
      actorName: "agent:agent_original",
    });
  });

  it("control: a fresh (non-replay) write attributes to the actual caller", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValueOnce(capabilityRow("write", "agent_fresh") as never);
    vi.mocked(db.contact.create).mockResolvedValue(baseContact({ id: "contact_new" }) as never);

    await upsertContact(agentCtx("agent_fresh"), { idempotencyKey: "attr-2", name: "Jane Prospect" });

    expect(vi.mocked(ingestMemory).mock.calls[0][0]).toMatchObject({
      actorId: "agent_fresh",
      actorName: "agent:agent_fresh",
    });
  });
});
