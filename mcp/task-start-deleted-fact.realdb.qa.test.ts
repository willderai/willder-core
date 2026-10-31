// The task-start block's removed-fact filter
// (services/memory/task-start.ts, readTaskStartUnchecked): a recent write about a fact version
// a later removal took out of storage is left out, and nothing else is. A removal is a
// delete, or a supersede of a version that is no longer stored (a correction, or a connector
// item's upstream edit). Both of those record a `supersedes` edge to the version they replace,
// as a conflict does, so the edge cannot tell them apart; whether the version is still stored
// does.
//
// The filter is one NOT EXISTS whose predicates a reader could lose without the
// end-to-end suite (mcp/task-start-deleted-fact.realdb.test.ts) noticing: the op, the
// org of the event and of the stored row, the stored-row check, the removal's order after
// the write, and the scope it deliberately does not apply. Losing the stored-row check hides
// the create of a conflict's loser, which stays stored and is served marked with its winner.
// Reading the edge instead keeps the create of a corrected version its correction now names.
// Letting the stored row excuse a delete keeps the create of a conflict's loser a person
// then deleted. Losing the order hides a removal's own event. Losing either org lets another
// org's event or row decide what this org is shown. Each case below fails when its predicate
// is removed.
//
// Set QA_DATABASE_URL to an ISOLATED, migrated test database; skips when unset.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;
if (QA_URL) process.env.DATABASE_URL = QA_URL;

const ORG = "orgQaTaskStartDeleted";
const OTHER_ORG = "orgQaTaskStartDeletedOther";
const ORGS = { in: [ORG, OTHER_ORG] };
const ROOT = "org_qa_tsd";
const SCOPE = `${ROOT}.web`;
const TASK = "checkout cache";

describe.skipIf(!QA_URL)("task-start leaves out only the writes of deleted fact versions", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let db: any, readTaskStartUnchecked: any, markWritesAgainst: any;
  const ctx = { orgId: ORG, actor: { type: "agent", id: "qa" }, origin: "mcp" };
  const base = Date.UTC(2026, 9, 1);

  async function cleanup(): Promise<void> {
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" IN (${ORG}, ${OTHER_ORG})`;
    await db.factEdge.deleteMany({ where: { orgId: ORGS } });
    await db.changeEvent.deleteMany({ where: { orgId: ORGS } });
    await deleteOrgsWithRetry(db, { where: { id: ORGS } });
  }

  beforeAll(async () => {
    ({ db } = await import("@/lib/db"));
    ({ readTaskStartUnchecked } = await import("@/services/memory/task-start"));
    ({ markWritesAgainst } = await import("@/services/memory/superseded-facts"));
    await cleanup();
    for (const id of [ORG, OTHER_ORG]) await db.org.create({ data: { id, name: id } });

    // Each org numbers its own events; the other org's run ahead, so its delete is newer
    // by seq than this org's create and only the org predicate keeps the two apart.
    const seqs = new Map<string, number>([[OTHER_ORG, 1000]]);
    const events: object[] = [];
    const event = (
      recordId: string,
      op: string,
      options: { orgId?: string; scopePath?: string; summary?: string } = {},
    ) => {
      const orgId = options.orgId ?? ORG;
      const seq = (seqs.get(orgId) ?? 0) + 1;
      seqs.set(orgId, seq);
      events.push({
        orgId,
        seq: BigInt(seq),
        scopePath: options.scopePath ?? SCOPE,
        recordType: "fact",
        recordId,
        op,
        actorId: "qa",
        summary: options.summary ?? (op === "create" ? `${TASK} ${recordId}` : ""),
        createdAt: new Date(base + events.length * 1000),
      });
    };

    event("f-deleted", "create");
    event("f-deleted-at-root", "create");
    event("f-superseded", "create");
    event("f-updated", "create");
    event("f-other-org-delete", "create");
    event("f-kept", "create");
    event("f-corrected", "create");
    event("f-corrected-derived", "create");
    event("f-corrected-winner", "create");
    event("f-loser-deleted", "create");
    event("f-corrected-named", "create");

    event("f-deleted", "delete");
    // Authorized above the reader's scope, so the event is stored outside it.
    event("f-deleted-at-root", "delete", { scopePath: ROOT });
    // A conflict retires f-superseded: the version stays stored and is served marked.
    event("f-superseded", "supersede");
    event("f-updated", "update");
    // Another org's delete of a record with the same id says nothing about this org.
    event("f-other-org-delete", "delete", { orgId: OTHER_ORG });
    // A person's correction recorded before corrections named their replacement: a
    // supersede with no `supersedes` edge, the version removed.
    event("f-corrected", "supersede", { summary: `${TASK} corrected text` });
    // Corrected too; another fact was derived from it, an edge of another kind.
    event("f-corrected-derived", "supersede");
    // Corrected after winning a conflict: the edge runs from it, not to it.
    event("f-corrected-winner", "supersede");
    // A conflict's loser that a person then deleted.
    event("f-loser-deleted", "supersede");
    event("f-loser-deleted", "delete");
    // Corrected, and its correction recorded as what replaced it.
    event("f-corrected-named", "supersede");

    await db.changeEvent.createMany({ data: events });
    const edge = (fromId: string, toId: string, kind: string) => ({
      orgId: ORG,
      fromId,
      toId,
      kind,
      scopePath: SCOPE,
      actorType: "agent",
      actorId: "qa",
      createdAt: new Date(base + 60_000),
    });
    await db.factEdge.createMany({
      data: [
        edge("f-winner", "f-superseded", "supersedes"),
        edge("f-derived", "f-corrected-derived", "derivedFrom"),
        edge("f-corrected-winner", "f-old-loser", "supersedes"),
        edge("f-winner-2", "f-loser-deleted", "supersedes"),
        edge("f-correction", "f-corrected-named", "supersedes"),
      ],
    });
    // What is still stored: the conflict's loser, and the other versions no removal touched.
    // Another org stores a row under the corrected version's id, which says nothing about
    // this org's.
    const stored = (orgId: string, id: string) =>
      db.$executeRaw`INSERT INTO memory_chunks ("id","orgId","content","source","actorType","scopePath") VALUES (${id}, ${orgId}, ${`${TASK} ${id}`}, 'mcp', 'agent', ${SCOPE})`;
    for (const id of ["f-superseded", "f-updated", "f-other-org-delete", "f-kept"]) await stored(ORG, id);
    await stored(OTHER_ORG, "f-corrected-named");
  });

  afterAll(async () => {
    await cleanup();
  });

  /** Every served write, marked with the version that replaced it, if any. */
  async function servedWrites(): Promise<{ recordId: string; op: string; supersededById: string | null }[]> {
    const { context, winners } = await readTaskStartUnchecked(ctx, SCOPE, TASK);
    return markWritesAgainst(context.writes, winners);
  }

  /** Each served create's fact version, with the version that replaced it, if any. */
  async function servedCreates(): Promise<Map<string, string | null>> {
    const marked = await servedWrites();
    return new Map(marked.filter((w) => w.op === "create").map((w) => [w.recordId, w.supersededById]));
  }

  it("leaves out the create of a deleted version, wherever the delete was recorded", async () => {
    const served = await servedCreates();
    expect(served.has("f-deleted")).toBe(false);
    expect(served.has("f-deleted-at-root")).toBe(false);
  });

  it("still serves a superseded version's create, marked with the version that replaced it", async () => {
    const served = await servedCreates();
    expect(served.has("f-superseded")).toBe(true);
    expect(served.get("f-superseded")).toBe("f-winner");
  });

  it("still serves the create of a version a later update touched", async () => {
    expect((await servedCreates()).has("f-updated")).toBe(true);
  });

  it("does not let another org's delete hide this org's write", async () => {
    const served = await servedCreates();
    expect(served.has("f-other-org-delete")).toBe(true);
    expect(served.has("f-kept")).toBe(true);
  });

  it("leaves out the create of a corrected version, whatever edges it has", async () => {
    const served = await servedCreates();
    expect(served.has("f-corrected")).toBe(false);
    expect(served.has("f-corrected-derived")).toBe(false);
    expect(served.has("f-corrected-winner")).toBe(false);
    expect(served.has("f-corrected-named")).toBe(false);
  });

  it("leaves out the create of a conflict's loser a person then deleted", async () => {
    expect((await servedCreates()).has("f-loser-deleted")).toBe(false);
  });

  it("still serves the correction's own event", async () => {
    const served = await servedWrites();
    expect(served.some((w) => w.recordId === "f-corrected" && w.op === "supersede")).toBe(true);
  });
});
