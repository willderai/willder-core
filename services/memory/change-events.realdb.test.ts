// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The ordering claim, proved against a real Postgres instead of a double.
//
// `recordChangeEvent` promises that within an org, `seq` order is commit order:
// a reader that has consumed up to `seq = N` can take everything after it and
// never find an older event appearing later. That promise rests entirely on
// `pg_advisory_xact_lock` being held to commit, which no unit test can observe —
// a fake transaction that "serializes" is just this file's own assumption
// restated, and would pass whether or not the lock is really taken.
//
// So the source of truth here is Postgres's own locking. The first writer takes
// its seq and deliberately stays open; the second must still be blocked while
// that is true, and must get the following seq once the first commits.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never the sandbox's
// inherited DATABASE_URL, which points at live Neon. Skips cleanly without it.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { recordChangeEvent } from "./change-events";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-change-events";
const OTHER_ORG = "org-qa-change-events-other";

const db = QA_URL
  ? new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) })
  : (null as unknown as PrismaClient);

// Each event names its own fact version: one version is announced once
// (migration 20261007220000_fact_create_event_once).
let versions = 0;
const event = (orgId: string) => ({
  orgId,
  scopePath: "org_1.sales",
  recordType: "fact",
  recordId: `fact-${++versions}`,
  op: "create" as const,
  actorId: "agent-1",
  actorType: "agent" as const,
  origin: "mcp" as const,
  title: "Acme moved the renewal to Q3",
});

/** Resolves once `promise` settles, or after `ms`, reporting which happened. */
async function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  const pending = Symbol("pending");
  const timer = new Promise<typeof pending>((resolve) => setTimeout(() => resolve(pending), ms));
  return (await Promise.race([promise.then(() => "settled"), timer])) !== pending;
}

describe.skipIf(!QA_URL)("recordChangeEvent against a real database", () => {
  afterAll(async () => {
    await db?.$disconnect();
  });

  beforeEach(async () => {
    await db.changeEvent.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
    for (const id of [ORG, OTHER_ORG]) {
      await db.org.upsert({ where: { id }, update: {}, create: { id, name: id } });
    }
  });

  it("holds the per-org lock until commit, so a second writer waits for the first", async () => {
    let releaseFirst: () => void = () => {};
    const firstCommitted = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = db.$transaction(async (tx) => {
      const { seq } = await recordChangeEvent(tx, event(ORG));
      await firstCommitted; // stay open, lock still held
      return seq;
    });

    // Let the first transaction reach its lock before the second tries.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const second = db.$transaction(async (tx) => (await recordChangeEvent(tx, event(ORG))).seq);

    expect(await settledWithin(second, 500)).toBe(false);

    releaseFirst();
    expect(await first).toBe(BigInt(1));
    expect(await second).toBe(BigInt(2));
  });

  it("does not make one org's writers wait on another org's", async () => {
    let releaseOther: () => void = () => {};
    const otherCommitted = new Promise<void>((resolve) => {
      releaseOther = resolve;
    });

    const other = db.$transaction(async (tx) => {
      await recordChangeEvent(tx, event(OTHER_ORG));
      await otherCommitted;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));

    const mine = db.$transaction(async (tx) => (await recordChangeEvent(tx, event(ORG))).seq);

    // A write that waits on the other org's lock never settles while it is held, so 15 s tells
    // the two apart as 2 s did, without failing a loaded machine's slow but unblocked write.
    expect(await settledWithin(mine, 15_000)).toBe(true);
    expect(await mine).toBe(BigInt(1));

    releaseOther();
    await other;
  }, 30_000);

  it("numbers each org's events from one, independently", async () => {
    await db.$transaction(async (tx) => {
      await recordChangeEvent(tx, event(ORG));
    });
    const otherFirst = await db.$transaction(async (tx) => recordChangeEvent(tx, event(OTHER_ORG)));

    expect(otherFirst.seq).toBe(BigInt(1));
  });

  it("rolls the event back with the write it describes", async () => {
    await expect(
      db.$transaction(async (tx) => {
        await recordChangeEvent(tx, event(ORG));
        throw new Error("the write this event describes failed");
      }),
    ).rejects.toThrow("the write this event describes failed");

    expect(await db.changeEvent.count({ where: { orgId: ORG } })).toBe(0);
  });

  it("rejects a second event claiming a seq the org already used", async () => {
    await db.$transaction(async (tx) => {
      await recordChangeEvent(tx, event(ORG));
    });

    await expect(
      db.changeEvent.create({ data: { ...event(ORG), seq: BigInt(1), summary: "duplicate" } }),
    ).rejects.toThrow();
  });

  it("stores a scope the read path can cast to ltree", async () => {
    await db.$transaction(async (tx) => {
      await recordChangeEvent(tx, { ...event(ORG), scopePath: "org_1.sales.eu" });
    });

    const covered = await db.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "change_events"
      WHERE "orgId" = ${ORG} AND "scopePath"::ltree <@ ${"org_1.sales"}::ltree
    `;

    expect(covered).toHaveLength(1);
  });
});
