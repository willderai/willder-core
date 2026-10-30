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
import { lockOrgChangeFeed, recordChangeEvent, recordChangeEvents, recordFactCreateOnce } from "./change-events";

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

  it("makes a writer wait for a reader holding the org's feed lock, the same lock the write takes", async () => {
    let releaseReader: () => void = () => {};
    const readerDone = new Promise<void>((resolve) => {
      releaseReader = resolve;
    });

    const reader = db.$transaction(async (tx) => {
      await lockOrgChangeFeed(tx, ORG);
      await readerDone;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));

    const writer = db.$transaction(async (tx) => (await recordChangeEvent(tx, event(ORG))).seq);

    expect(await settledWithin(writer, 500)).toBe(false);
    releaseReader();
    await reader;
    expect(await writer).toBe(BigInt(1));
  });

  it("reads the next seq after its lock is granted: a writer that waited follows the batch it waited on", async () => {
    let releaseFirst: () => void = () => {};
    const firstCommitted = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = db.$transaction(async (tx) => {
      await recordChangeEvents(tx, [event(ORG), event(ORG), event(ORG)]);
      await firstCommitted;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));

    const second = db.$transaction(async (tx) => recordFactCreateOnce(tx, event(ORG)));

    expect(await settledWithin(second, 500)).toBe(false);
    releaseFirst();
    await first;
    expect((await second)?.seq).toBe(BigInt(4));
  });

  it("gives writers racing in one org consecutive seqs, one each, with no gap", async () => {
    const writers = Array.from({ length: 8 }, (_, i) =>
      db.$transaction(async (tx) => {
        if (i % 4 === 1) return recordChangeEvents(tx, [event(ORG), event(ORG)]);
        if (i % 4 === 2) return recordFactCreateOnce(tx, event(ORG));
        return recordChangeEvent(tx, event(ORG));
      }),
    );
    await Promise.all(writers);

    const rows = await db.changeEvent.findMany({
      where: { orgId: ORG },
      orderBy: { seq: "asc" },
      select: { seq: true },
    });
    expect(rows.map((row) => Number(row.seq))).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
  });

  it("does not take a seq for a fact version already announced", async () => {
    const announced = event(ORG);
    expect((await db.$transaction(async (tx) => recordFactCreateOnce(tx, announced)))?.seq).toBe(BigInt(1));
    expect(await db.$transaction(async (tx) => recordFactCreateOnce(tx, announced))).toBeNull();
    expect((await db.$transaction(async (tx) => recordChangeEvent(tx, event(ORG)))).seq).toBe(BigInt(2));
  });

  it("under a race of 100 writer transactions of every kind, with locked readers and cursor readers, seqs stay gapless and commit-ordered", async () => {
    // Twenty writers of five transactions each mix single events, batches, a fact announced
    // twice (the second takes no seq) and both in one transaction, holding the lock a moment
    // before commit to widen any ordering window. Locked readers check that nothing is written
    // under their lock; cursor readers, which take no lock, check they never skip a seq.
    let done = false;
    let expected = 0;
    const lockedViolations: string[] = [];
    const cursorViolations: string[] = [];
    const slow = { timeout: 60_000, maxWait: 60_000 };

    const writers = Array.from({ length: 20 }, async (_, w) => {
      for (let r = 0; r < 5; r++) {
        const kind = (w + r) % 4;
        const added = await db.$transaction(async (tx) => {
          let added = 0;
          if (kind === 0) {
            await recordChangeEvent(tx, event(ORG));
            added = 1;
          } else if (kind === 1) {
            const k = 2 + ((w + r) % 3);
            await recordChangeEvents(
              tx,
              Array.from({ length: k }, () => event(ORG)),
            );
            added = k;
          } else if (kind === 2) {
            const twice = event(ORG);
            if (await recordFactCreateOnce(tx, twice)) added++;
            if (await recordFactCreateOnce(tx, twice)) added++;
          } else {
            await recordChangeEvent(tx, event(ORG));
            await recordChangeEvents(tx, [event(ORG), event(ORG)]);
            added = 3;
          }
          await tx.$queryRaw`SELECT pg_sleep(${Math.random() * 0.005})::text AS slept`;
          return added;
        }, slow);
        expected += added;
      }
    });

    const lockedReaders = Array.from({ length: 2 }, async () => {
      while (!done) {
        await db.$transaction(async (tx) => {
          await lockOrgChangeFeed(tx, ORG);
          const [before] = await tx.$queryRaw<
            { c: bigint; m: bigint | null }[]
          >`SELECT count(*)::bigint AS c, max("seq") AS m FROM "change_events" WHERE "orgId" = ${ORG}`;
          if (Number(before!.c) !== Number(before!.m ?? 0))
            lockedViolations.push(`count ${before!.c}, max ${before!.m}`);
          await tx.$queryRaw`SELECT pg_sleep(0.002)::text AS slept`;
          const [after] = await tx.$queryRaw<
            { m: bigint | null }[]
          >`SELECT max("seq") AS m FROM "change_events" WHERE "orgId" = ${ORG}`;
          if (Number(after!.m ?? 0) !== Number(before!.m ?? 0))
            lockedViolations.push(`written under a reader's lock: ${before!.m} -> ${after!.m}`);
        }, slow);
      }
    });

    const cursorReaders = Array.from({ length: 2 }, async () => {
      let cursor = 0;
      const step = async () => {
        const rows = await db.$queryRaw<
          { seq: bigint }[]
        >`SELECT "seq" FROM "change_events" WHERE "orgId" = ${ORG} AND "seq" > ${cursor} ORDER BY "seq"`;
        for (const row of rows) {
          if (Number(row.seq) !== cursor + 1) cursorViolations.push(`cursor ${cursor} saw ${row.seq}`);
          cursor = Number(row.seq);
        }
      };
      while (!done) await step();
      await step();
      return cursor;
    });

    // A writer that throws must end the readers too, so the test fails at once rather than at its timeout.
    try {
      await Promise.all(writers);
    } finally {
      done = true;
    }
    await Promise.all(lockedReaders);
    const finalCursors = await Promise.all(cursorReaders);

    const rows = await db.changeEvent.findMany({
      where: { orgId: ORG },
      orderBy: { seq: "asc" },
      select: { seq: true },
    });
    expect(rows.map((row) => Number(row.seq))).toEqual(Array.from({ length: expected }, (_, i) => i + 1));
    expect(lockedViolations).toEqual([]);
    expect(cursorViolations).toEqual([]);
    expect(finalCursors).toEqual([expected, expected]);
  }, 120_000);

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
