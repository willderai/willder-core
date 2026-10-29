// The task-start block's folded supersede lookup
// (services/memory/task-start.ts, readTaskStartUnchecked): the served writes must be marked
// exactly as the change feed marks them (markSupersededWrites,
// services/memory/superseded-facts.ts), for the same rows.
//
// The fold re-implements supersedingVersions in SQL, so each of its predicates is a
// separate place the two readers can drift apart: the org filter, the edge kind, the
// edge order, and the order among edges recorded in the same millisecond (fact_edges
// stores createdAt at millisecond precision). None of those had a test that fails when
// the predicate is removed; the content-parity oracle in task-start-latency compares
// only the context of readTaskStartUnchecked, which drops the record of winners.
//
// Set QA_DATABASE_URL to an ISOLATED, migrated test database; skips when unset.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const QA_URL = process.env.QA_DATABASE_URL;
if (QA_URL) process.env.DATABASE_URL = QA_URL;

const ORG = "orgQaTaskStartSupersede";
const OTHER_ORG = "orgQaTaskStartSupersedeOther";
const ORGS = { in: [ORG, OTHER_ORG] };
const SCOPE = "org_qa_ts.sales";
const TASK = "deploy note";
const TIE_GROUPS = 150;
// Tied groups whose edge ids run opposite to insertion order, so a reader that relies on
// the table returning equal-timestamp rows in insertion order names a different winner.
const ID_TIE_GROUPS = 40;
// One read serves at most 30 writes that match its task, so the writes are read in batches:
// each summary names its batch, and one read per batch names only that batch.
const BATCH_SIZE = 25;
const batchOf = (index: number) => `batch${String(Math.floor(index / BATCH_SIZE)).padStart(2, "0")}`;

describe.skipIf(!QA_URL)("task-start marks served writes as the change feed does", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let db: any, readTaskStartUnchecked: any, markWritesAgainst: any, markSupersededWrites: any;
  const ctx = { orgId: ORG, actor: { type: "agent", id: "qa" }, origin: "mcp" };
  const base = Date.UTC(2026, 9, 1);
  const at = (seconds: number) => new Date(base + seconds * 1000);

  async function cleanup(): Promise<void> {
    await db.factEdge.deleteMany({ where: { orgId: ORGS } });
    await db.changeEvent.deleteMany({ where: { orgId: ORGS } });
    await db.org.deleteMany({ where: { id: ORGS } });
  }

  beforeAll(async () => {
    ({ db } = await import("@/lib/db"));
    ({ readTaskStartUnchecked } = await import("@/services/memory/task-start"));
    ({ markWritesAgainst, markSupersededWrites } = await import("@/services/memory/superseded-facts"));
    await cleanup();
    for (const id of [ORG, OTHER_ORG]) await db.org.create({ data: { id, name: id } });

    const events: object[] = [];
    const edges: object[] = [];
    const event = (recordId: string, op: string, recordType = "fact") =>
      events.push({
        orgId: ORG,
        seq: BigInt(events.length + 1),
        scopePath: SCOPE,
        recordType,
        recordId,
        op,
        actorId: "qa",
        summary: `${TASK} ${recordId} ${batchOf(events.length)}`,
        createdAt: at(events.length),
      });
    const edge = (fromId: string, toId: string, createdAt: Date, extra: object = {}) =>
      edges.push({
        orgId: ORG,
        fromId,
        toId,
        kind: "supersedes",
        scopePath: SCOPE,
        actorType: "agent",
        actorId: "qa",
        createdAt,
        ...extra,
      });

    event("f-simple", "create");
    edge("w-simple", "f-simple", at(1));
    // Two edges, the later-dated one inserted first, so table order is not date order
    // (the earlier-dated one is written in a later statement, below).
    event("f-two", "update");
    edge("w-two-late", "f-two", at(50));
    // Another org's edge to the same id, dated earliest.
    event("f-other-org", "create");
    edge("w-other-org", "f-other-org", at(0), { orgId: OTHER_ORG });
    // An edge of another kind.
    event("f-depends", "create");
    edge("w-depends", "f-depends", at(1), { kind: "dependsOn" });
    // Events that do not announce a fact version are never marked.
    event("f-supersede-op", "supersede");
    edge("w-supersede-op", "f-supersede-op", at(1));
    event("b-brief", "create", "brief");
    edge("w-brief", "b-brief", at(1));
    // Edges recorded in the same millisecond, inserted in varying order.
    for (let group = 0; group < TIE_GROUPS; group++) {
      event(`f-tie-${group}`, "create");
      const winners = [`w-tie-${group}-m`, `w-tie-${group}-z`, `w-tie-${group}-a`];
      if (group % 2) winners.reverse();
      for (const winner of winners) edge(winner, `f-tie-${group}`, at(5));
    }
    // Same millisecond, ids inserted in descending order, and the lowest id carrying the
    // highest fromId: only an explicit order by edge id names `w-tieid-<n>-z`.
    for (let group = 0; group < ID_TIE_GROUPS; group++) {
      event(`f-tieid-${group}`, "create");
      for (const [rank, winner] of [
        [3, "a"],
        [2, "m"],
        [1, "z"],
      ] as const)
        edge(`w-tieid-${group}-${winner}`, `f-tieid-${group}`, at(5), { id: `qa-tieid-${group}-${rank}` });
    }
    await db.changeEvent.createMany({ data: events });
    await db.factEdge.createMany({ data: edges });
    await db.factEdge.create({
      data: {
        orgId: ORG,
        fromId: "w-two-early",
        toId: "f-two",
        kind: "supersedes",
        scopePath: SCOPE,
        actorType: "agent",
        actorId: "qa",
        createdAt: at(10),
      },
    });
  });

  afterAll(async () => {
    await cleanup();
  });

  /** Every write marked both ways, read batch by batch so each one is served. */
  async function bothMarkings(): Promise<{
    served: Record<string, string | null>;
    feed: Record<string, string | null>;
  }> {
    const total = 6 + TIE_GROUPS + ID_TIE_GROUPS;
    const byRecord = (rows: { recordId: string; supersededById: string | null }[]) =>
      Object.fromEntries(rows.map((row) => [row.recordId, row.supersededById]));
    const served: Record<string, string | null> = {};
    const feed: Record<string, string | null> = {};
    for (let index = 0; index < total; index += BATCH_SIZE) {
      const { context, winners } = await readTaskStartUnchecked(ctx, SCOPE, batchOf(index));
      expect(context.writes.length).toBe(Math.min(BATCH_SIZE, total - index));
      Object.assign(served, byRecord(markWritesAgainst(context.writes, winners)));
      Object.assign(feed, byRecord(await markSupersededWrites(ORG, context.writes)));
    }
    expect(Object.keys(served)).toHaveLength(total);
    return { served, feed };
  }

  it("names the first-dated winner in this org, of kind supersedes, on fact versions only", async () => {
    const { served, feed } = await bothMarkings();
    for (const marking of [served, feed]) {
      expect(marking["f-simple"]).toBe("w-simple");
      expect(marking["f-two"]).toBe("w-two-early");
      expect(marking["f-other-org"]).toBeNull();
      expect(marking["f-depends"]).toBeNull();
      expect(marking["f-supersede-op"]).toBeNull();
      expect(marking["b-brief"]).toBeNull();
    }
  });

  it("agrees with the change feed when edges share a millisecond", async () => {
    const { served, feed } = await bothMarkings();
    const disagreements = Object.keys(served).filter((recordId) => served[recordId] !== feed[recordId]);
    expect(disagreements).toEqual([]);
  });

  it("names the lowest edge id among same-millisecond edges, whatever the insertion order", async () => {
    const { served, feed } = await bothMarkings();
    for (const marking of [served, feed]) {
      const wrong = Array.from({ length: ID_TIE_GROUPS }, (_, group) => `f-tieid-${group}`).filter(
        (recordId) => marking[recordId] !== `w-${recordId.slice(2)}-z`,
      );
      expect(wrong).toEqual([]);
    }
  });
});
