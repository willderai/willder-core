import { beforeEach, describe, expect, it, vi } from "vitest";

// A same-key retry that lands while the original delivery is still in flight
// must not dispatch a second graph episode.
//
// ContactIdempotencyKey.ingestedAt means delivery-complete, not
// enqueue-complete, so the row's ingestedAt stays null for the whole delivery
// latency, not just when the request died mid-flight. An ORDINARY client
// retry-on-timeout landing in that window would otherwise walk straight into
// replayIdempotentResult's repair branch and dispatch a SECOND
// ingestContactWrite/ingestMemory call for a delivery that was only ever
// still in flight, never actually broken: a successful write followed by a
// same-key retry before delivery completes would call ingestMemory twice for
// one accepted write. Not data loss, but it burns org episode-cap quota on a
// real duplicate graph episode for nothing that ever needed repairing.
//
// NOT A TAUTOLOGY (same discipline as this directory's own
// agent-contacts.suppression.test.ts header): db.contactIdempotencyKey's
// updateMany/create/findUnique below are a small, honest, stateful fake. It
// tracks ONE ledger row's real (ingestedAt, deliveryClaimedAt) state across
// both calls in this file and only reports a claim won (`{ count: 1 }`) when
// agent-contacts.ts's actual WHERE conditions — ingestedAt IS NULL AND
// (deliveryClaimedAt IS NULL OR past the lease) — genuinely hold against
// that tracked state, exactly matching claimDeliveryAttempt's real
// WHERE clause, not a hardcoded per-call-number response. Reverting
// replayIdempotentResult's repair branch to call ingestContactWrite
// unconditionally makes the first test below fail with `ingestMemory` called
// twice.
//
// This proves the concurrency contract the same way agent-contacts.test.ts's
// concurrent-revision-race test does for a different race on this same
// function: real upsertContact code, a fake that honestly enforces the real
// conditional semantics being relied on, not a mock that blindly resolves
// success.
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

const capabilityRow = () => [{ permission: "write" as const, createdBy: "user_1", agentId: "agent_shin" }];

function baseContact(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "contact_1",
    orgId: ORG,
    accountId: null,
    name: "Jane Prospect",
    email: null,
    title: null,
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

// Matches agent-contacts.ts's own DELIVERY_CLAIM_LEASE_MS — duplicated here
// deliberately rather than exported/imported, so this test pins the actual
// contract (a ~10 minute lease) instead of whatever the constant happens to
// be renamed to.
const DELIVERY_CLAIM_LEASE_MS = 10 * 60 * 1000;

interface FakeLedgerRow {
  orgId: string;
  key: string;
  requestHash: string;
  contactId: string | null;
  resultAction: string;
  resultRevision: number;
  resultSnapshot: unknown;
  actorId: string;
  ingestedAt: Date | null;
  deliveryClaimedAt: Date | null;
}

// The one ledger row this file's tests drive — real state, honestly mutated
// by the fake db calls below (see file header).
let ledger: FakeLedgerRow | null;

beforeEach(() => {
  vi.resetAllMocks();
  ledger = null;

  vi.mocked(db.$transaction).mockImplementation(async (fn) => fn(db as never));
  vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_test_id" } as never);
  vi.mocked(db.$queryRaw).mockResolvedValue(capabilityRow() as never);
  vi.mocked(ingestMemory).mockResolvedValue(undefined as never);

  vi.mocked(db.contactIdempotencyKey.findUnique).mockImplementation((async (args: unknown) => {
    const where = (args as { where: { orgId_key: { orgId: string; key: string } } }).where.orgId_key;
    if (ledger && ledger.orgId === where.orgId && ledger.key === where.key) {
      return { ...ledger };
    }
    return null;
  }) as never);

  vi.mocked(db.contactIdempotencyKey.create).mockImplementation((async (args: unknown) => {
    const data = (args as { data: Omit<FakeLedgerRow, "ingestedAt"> & { deliveryClaimedAt?: Date | null } }).data;
    ledger = { ...data, ingestedAt: null, deliveryClaimedAt: data.deliveryClaimedAt ?? null };
    return {};
  }) as never);

  // Honest CAS: implements the exact WHERE contract claimDeliveryAttempt,
  // releaseDeliveryClaim, and markContactIngestDelivered each issue against
  // `ledger`'s real tracked state — not a hardcoded pass. See file header.
  vi.mocked(db.contactIdempotencyKey.updateMany).mockImplementation((async (args: unknown) => {
    const { where, data } = args as {
      where: {
        orgId: string;
        key: string;
        ingestedAt?: null;
        OR?: Array<{ deliveryClaimedAt: null } | { deliveryClaimedAt: { lt: Date } }>;
      };
      data: { deliveryClaimedAt?: Date | null; ingestedAt?: Date };
    };
    if (!ledger || ledger.orgId !== where.orgId || ledger.key !== where.key) {
      return { count: 0 };
    }
    if ("ingestedAt" in where && where.ingestedAt === null && ledger.ingestedAt !== null) {
      return { count: 0 };
    }
    if (where.OR) {
      const claimable = where.OR.some((cond) => {
        if ("deliveryClaimedAt" in cond && cond.deliveryClaimedAt === null) {
          return ledger!.deliveryClaimedAt === null;
        }
        const lease = (cond as { deliveryClaimedAt: { lt: Date } }).deliveryClaimedAt.lt;
        return ledger!.deliveryClaimedAt !== null && ledger!.deliveryClaimedAt < lease;
      });
      if (!claimable) return { count: 0 };
    }
    ledger = { ...ledger, ...data };
    return { count: 1 };
  }) as never);
});

describe("upsertContact — concurrent-retry duplicate-episode window", () => {
  it("does not re-ingest on a same-key retry that arrives before delivery completes", async () => {
    vi.mocked(db.contact.create).mockResolvedValue(baseContact({ id: "contact_1" }) as never);

    const first = await upsertContact(agentCtx(), { idempotencyKey: "dup-1", name: "Jane Prospect" });
    expect(first.action).toBe("created");
    expect(ingestMemory).toHaveBeenCalledTimes(1);
    // Delivery genuinely still pending: nothing in this test's mocks ever
    // calls markContactIngestDelivered (that's lib/inngest.ts's job, covered
    // separately by lib/inngest.contact-delivery.test.ts), so ingestedAt
    // stays null here exactly the way it stays null for the real delivery's
    // whole latency, not just a failure.
    expect(ledger?.ingestedAt).toBeNull();
    expect(ledger?.deliveryClaimedAt).not.toBeNull();

    // The ordinary case this round closes: a client retry-on-timeout, same
    // idempotencyKey, arriving while the original delivery is still working.
    const retry = await upsertContact(agentCtx(), { idempotencyKey: "dup-1", name: "Jane Prospect" });

    expect(retry).toEqual(first);
    // The actual defect: this was 2 before the fix (a real duplicate graph
    // episode for a write that was never broken).
    expect(ingestMemory).toHaveBeenCalledTimes(1);
    expect(db.contact.create).toHaveBeenCalledTimes(1);
  });

  it("still repairs a genuinely dead delivery once its claim's lease has expired (does not trade the duplicate bug for a permanent-loss one)", async () => {
    vi.mocked(db.contact.create).mockResolvedValue(baseContact({ id: "contact_2" }) as never);

    await upsertContact(agentCtx(), { idempotencyKey: "dup-2", name: "Jane Prospect" });
    expect(ingestMemory).toHaveBeenCalledTimes(1);

    // Simulate the delivery having actually died with nothing to release the
    // claim — the still-open, non-blocking gap this round doesn't close (the
    // queued Inngest path has no failure handler, see markContactIngestDelivered's
    // doc comment) — by back-dating the claim past its lease.
    ledger!.deliveryClaimedAt = new Date(Date.now() - DELIVERY_CLAIM_LEASE_MS - 1_000);

    await upsertContact(agentCtx(), { idempotencyKey: "dup-2", name: "Jane Prospect" });

    // Unlike the ordinary-retry case above, a claim this stale must still be
    // reclaimable — the lease exists specifically so a truly dead delivery
    // still self-heals instead of staying missing from the graph forever.
    expect(ingestMemory).toHaveBeenCalledTimes(2);
  });

  it("releases the claim immediately on a synchronous dispatch failure, so the already-fixed #3 repair path isn't slowed by the lease", async () => {
    vi.mocked(db.contact.create).mockResolvedValue(baseContact({ id: "contact_3" }) as never);
    vi.mocked(ingestMemory).mockRejectedValueOnce(new Error("inngest unreachable") as never);

    await expect(upsertContact(agentCtx(), { idempotencyKey: "dup-3", name: "Jane Prospect" })).rejects.toThrow(
      "inngest unreachable",
    );
    // A synchronous enqueue failure is the original #3 bug shape — the claim
    // must come back off right away, not sit until the lease expires.
    expect(ledger?.deliveryClaimedAt).toBeNull();

    vi.mocked(ingestMemory).mockClear();
    const retry = await upsertContact(agentCtx(), { idempotencyKey: "dup-3", name: "Jane Prospect" });

    expect(retry.action).toBe("created");
    expect(ingestMemory).toHaveBeenCalledTimes(1);
  });
});
