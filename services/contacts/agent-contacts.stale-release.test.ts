import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A stale attempt's failed dispatch must not clear a live claim.
//
// Delivery dispatch is claim-based (`claimDeliveryAttempt`, an atomic
// updateMany CAS on `deliveryClaimedAt`). The claim is a 10-minute LEASE,
// deliberately: an attempt that dies async must not hold the row forever. A
// `releaseDeliveryClaim` fenced only on `ingestedAt: null` proves delivery
// hasn't landed, but never proves the CALLER still owns the current lease. A
// stale attempt's late failure would then clear whatever claim is on the row
// at that moment, including a newer attempt's live one, reopening the exact
// window the claim exists to close: two dispatches in flight for one accepted
// write, burning org episode-cap quota on a duplicate graph episode.
//
// Fencing `releaseDeliveryClaim` on `deliveryClaimedAt` equality (the
// caller's own claim timestamp) is INSUFFICIENT, not just a simpler
// alternative: `new Date()` has millisecond resolution, and a reclaim landing
// in the same millisecond as the stale claim it's replacing produces an equal
// timestamp -- the equality fence silently degrades back to unfenced in
// exactly that interleaving. Every dispatch attempt instead gets its own
// opaque `randomUUID()` token (`deliveryClaimToken`), and the release is
// fenced on token identity, which has no such collision regardless of clock
// resolution.
//
// The interleavings below are the real ones, made deterministic (no timers
// beyond the frozen-clock case, no sleeps): attempt A's dispatch outlives its
// lease, retry B reclaims the row and dispatches, and only then does A's own
// dispatch fail. A's failure handler is the token-fenced release.
//
// NOT A TAUTOLOGY (same discipline as agent-contacts.concurrent-retry.test.ts, whose
// fake this one reuses): the fake db below is stateful and honestly enforces
// the real WHERE contract -- a claim is reported won only when
// `ingestedAt IS NULL AND (deliveryClaimedAt IS NULL OR past the lease)`
// genuinely holds against the tracked row, and a release only succeeds when
// its own `deliveryClaimToken` still matches the row's current one, never a
// hardcoded per-call answer. Which branch the code lands on is decided by
// the filter the code itself asks for. An unfenced release, or a
// timestamp-equality fence under the frozen-clock test below, turns these
// tests RED.
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
const DELIVERY_CLAIM_LEASE_MS = 10 * 60 * 1000;

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
  deliveryClaimToken: string | null;
}

let ledger: FakeLedgerRow | null;

beforeEach(() => {
  vi.resetAllMocks();
  ledger = null;

  vi.mocked(db.$transaction).mockImplementation(async (fn) => fn(db as never));
  vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_test_id" } as never);
  vi.mocked(db.$queryRaw).mockResolvedValue(capabilityRow() as never);
  vi.mocked(db.contact.create).mockResolvedValue(baseContact() as never);

  vi.mocked(db.contactIdempotencyKey.findUnique).mockImplementation((async (args: unknown) => {
    const where = (args as { where: { orgId_key: { orgId: string; key: string } } }).where.orgId_key;
    if (ledger && ledger.orgId === where.orgId && ledger.key === where.key) return { ...ledger };
    return null;
  }) as never);

  vi.mocked(db.contactIdempotencyKey.create).mockImplementation((async (args: unknown) => {
    const data = (
      args as {
        data: Omit<FakeLedgerRow, "ingestedAt"> & {
          deliveryClaimedAt?: Date | null;
          deliveryClaimToken?: string | null;
        };
      }
    ).data;
    ledger = {
      ...data,
      ingestedAt: null,
      deliveryClaimedAt: data.deliveryClaimedAt ?? null,
      deliveryClaimToken: data.deliveryClaimToken ?? null,
    };
    return {};
  }) as never);

  // Honest CAS over the tracked row -- implements the real WHERE contract that
  // claimDeliveryAttempt / releaseDeliveryClaim each issue, including the
  // ownership predicate a FENCED release adds (`deliveryClaimToken` equal to
  // the caller's own claim token). An unfenced release simply never sends
  // that predicate; a fence on `deliveryClaimedAt` equality is deliberately
  // NOT special-cased here, since that fence is what the frozen-clock test
  // below proves insufficient.
  vi.mocked(db.contactIdempotencyKey.updateMany).mockImplementation((async (args: unknown) => {
    const { where, data } = args as {
      where: {
        orgId: string;
        key: string;
        ingestedAt?: null;
        deliveryClaimToken?: string;
        OR?: Array<{ deliveryClaimedAt: null } | { deliveryClaimedAt: { lt: Date } }>;
      };
      data: { deliveryClaimedAt?: Date | null; deliveryClaimToken?: string | null; ingestedAt?: Date };
    };
    if (!ledger || ledger.orgId !== where.orgId || ledger.key !== where.key) return { count: 0 };
    if ("ingestedAt" in where && where.ingestedAt === null && ledger.ingestedAt !== null) return { count: 0 };
    // Ownership fence, when the caller supplies one (exact token identity,
    // NOT timestamp equality).
    if (where.deliveryClaimToken !== undefined) {
      if (ledger.deliveryClaimToken !== where.deliveryClaimToken) return { count: 0 };
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

describe("upsertContact — a stale attempt's failed dispatch must not clear a live claim", () => {
  it("leaves the reclaiming attempt's live lease intact when an expired attempt's dispatch later fails", async () => {
    let attempt = 0;
    let claimHeldByB: { deliveryClaimedAt: Date | null; deliveryClaimToken: string | null } | null = null;

    vi.mocked(ingestMemory).mockImplementation((async () => {
      attempt += 1;
      if (attempt === 1) {
        // Attempt A is dispatching. Its dispatch is slow -- slow enough that
        // its own 10-minute lease expires while it is still in flight.
        ledger!.deliveryClaimedAt = new Date(Date.now() - DELIVERY_CLAIM_LEASE_MS - 1_000);

        // Retry B arrives, legitimately reclaims the expired row (the lease's
        // self-heal path), and dispatches. B gets
        // its own fresh claim token, distinct from A's.
        await upsertContact(agentCtx(), { idempotencyKey: "race-1", name: "Jane Prospect" });
        claimHeldByB = { deliveryClaimedAt: ledger!.deliveryClaimedAt, deliveryClaimToken: ledger!.deliveryClaimToken };
        expect(claimHeldByB.deliveryClaimedAt).not.toBeNull();
        expect(claimHeldByB.deliveryClaimToken).not.toBeNull();

        // ...and only now does A's own dispatch fail, running A's release.
        throw new Error("inngest unreachable");
      }
      return undefined;
    }) as never);

    await expect(upsertContact(agentCtx(), { idempotencyKey: "race-1", name: "Jane Prospect" })).rejects.toThrow(
      "inngest unreachable",
    );

    // B is still in flight and still owns the row. A is a stale loser: its
    // release must be a no-op, not a reset of someone else's lease.
    expect(ledger?.deliveryClaimedAt).not.toBeNull();
    expect(ledger?.deliveryClaimedAt?.getTime()).toBe(claimHeldByB!.deliveryClaimedAt!.getTime());
    expect(ledger?.deliveryClaimToken).toBe(claimHeldByB!.deliveryClaimToken);
  });

  it("does not let a third retry dispatch a duplicate delivery alongside the in-flight one", async () => {
    let attempt = 0;

    vi.mocked(ingestMemory).mockImplementation((async () => {
      attempt += 1;
      if (attempt === 1) {
        ledger!.deliveryClaimedAt = new Date(Date.now() - DELIVERY_CLAIM_LEASE_MS - 1_000);
        await upsertContact(agentCtx(), { idempotencyKey: "race-2", name: "Jane Prospect" });
        throw new Error("inngest unreachable");
      }
      return undefined;
    }) as never);

    await expect(upsertContact(agentCtx(), { idempotencyKey: "race-2", name: "Jane Prospect" })).rejects.toThrow(
      "inngest unreachable",
    );

    // Two dispatches so far: A (failed) and B (live, still in flight).
    expect(attempt).toBe(2);

    // A same-key retry now. B's claim is live and well inside its lease, so
    // this retry must trust B and NOT dispatch -- that is the entire point of
    // the claim. If A's release had wiped B's claim, this retry sees an
    // unclaimed row and fires a duplicate episode for one accepted write.
    await upsertContact(agentCtx(), { idempotencyKey: "race-2", name: "Jane Prospect" });

    expect(attempt).toBe(2);
  });

  describe("same-millisecond claim collision (why a timestamp fence isn't enough)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("still isolates a stale release from a live reclaim when both claims stamp the identical frozen instant", async () => {
      const frozenNow = new Date("2026-09-16T00:00:00.000Z");
      vi.setSystemTime(frozenNow);

      let attempt = 0;
      let tokenHeldByA: string | null = null;
      let claimHeldByB: { deliveryClaimedAt: Date | null; deliveryClaimToken: string | null } | null = null;

      vi.mocked(ingestMemory).mockImplementation((async () => {
        attempt += 1;
        if (attempt === 1) {
          tokenHeldByA = ledger!.deliveryClaimToken;
          // Back-date A's own claim so it reads as lease-expired, but keep
          // the clock itself frozen at frozenNow throughout -- so when B's
          // claimDeliveryAttempt below stamps `new Date()`, it produces the
          // EXACT SAME millisecond A's original claim would have used had it
          // been made "now" instead of backdated. This is the interleaving a
          // timestamp-equality fence cannot tell apart: A's own recorded
          // `deliveryClaimedAt` (below) and B's fresh one are bit-for-bit
          // identical Date values, only their opaque tokens differ.
          ledger!.deliveryClaimedAt = new Date(frozenNow.getTime() - DELIVERY_CLAIM_LEASE_MS - 1_000);

          await upsertContact(agentCtx(), { idempotencyKey: "race-3", name: "Jane Prospect" });
          claimHeldByB = {
            deliveryClaimedAt: ledger!.deliveryClaimedAt,
            deliveryClaimToken: ledger!.deliveryClaimToken,
          };

          // The actual same-millisecond collision: B's claim timestamp is
          // exactly `frozenNow`, same clock instant a naive re-claim of A's
          // own (never-backdated) timestamp would have produced too.
          expect(claimHeldByB.deliveryClaimedAt?.getTime()).toBe(frozenNow.getTime());
          expect(claimHeldByB.deliveryClaimToken).not.toBe(tokenHeldByA);

          throw new Error("inngest unreachable");
        }
        return undefined;
      }) as never);

      await expect(upsertContact(agentCtx(), { idempotencyKey: "race-3", name: "Jane Prospect" })).rejects.toThrow(
        "inngest unreachable",
      );

      // A's release carries A's own token (tokenHeldByA), not a timestamp
      // equal to frozenNow -- so even though A's and B's `deliveryClaimedAt`
      // would collide under a timestamp-equality fence (both == frozenNow),
      // the token fence correctly tells them apart: B's claim survives.
      expect(ledger?.deliveryClaimToken).toBe(claimHeldByB!.deliveryClaimToken);
      expect(ledger?.deliveryClaimToken).not.toBe(tokenHeldByA);
      expect(ledger?.deliveryClaimedAt?.getTime()).toBe(frozenNow.getTime());
    });
  });
});
