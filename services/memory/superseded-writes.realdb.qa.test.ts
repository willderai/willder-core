// markSupersededWrites (services/memory/superseded-facts.ts), the
// change-log half of conflict resolution: a write whose version a later `supersedes` edge
// retired is listed only as superseded.
//
// The read-path suite (mcp/conflict-every-read-path.realdb.test.ts) races one fact
// through `create` events with a single supersedes edge, so three predicates had not
// run: an `update` event (connector items announce edits as `fact` updates,
// services/memory/content-change-event.ts), more than one edge retiring the same
// version (the first recorded names the winner), and an edge recorded in another org.
//
// Set QA_DATABASE_URL to an ISOLATED, migrated test database; skips when unset.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const QA_URL = process.env.QA_DATABASE_URL;
if (QA_URL) process.env.DATABASE_URL = QA_URL;

const ORG = "orgQaSupersededWrites";
const OTHER_ORG = "orgQaSupersededWritesOther";
const ORGS = { in: [ORG, OTHER_ORG] };

describe.skipIf(!QA_URL)("markSupersededWrites against real Postgres", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let db: any, markSupersededWrites: any;

  const edge = (orgId: string, fromId: string, toId: string, createdAt: Date) =>
    db.factEdge.create({
      data: {
        orgId,
        fromId,
        toId,
        kind: "supersedes",
        scopePath: `org_${orgId}`,
        actorType: "agent",
        actorId: "qa",
        createdAt,
      },
    });
  const event = (recordId: string, op: string) => ({ recordType: "fact", recordId, op, summary: `wrote ${recordId}` });

  beforeAll(async () => {
    ({ db } = await import("@/lib/db"));
    ({ markSupersededWrites } = await import("./superseded-facts"));
  });

  beforeEach(async () => {
    await db.factEdge.deleteMany({ where: { orgId: ORGS } });
    await db.org.deleteMany({ where: { id: ORGS } });
    for (const id of [ORG, OTHER_ORG]) await db.org.create({ data: { id, name: id } });
  });

  afterAll(async () => {
    await db.factEdge.deleteMany({ where: { orgId: ORGS } });
    await db.org.deleteMany({ where: { id: ORGS } });
    await db.$disconnect();
  });

  it("marks an update event of a superseded version, not only a create", async () => {
    await edge(ORG, "qa-winner", "qa-edited", new Date());
    const [marked] = await markSupersededWrites(ORG, [event("qa-edited", "update")]);
    expect(marked.supersededById).toBe("qa-winner");
    expect(marked.summary).toBe("[superseded by qa-winner] wrote qa-edited");
  });

  it("names the first recorded winner when two edges retire one version", async () => {
    await edge(ORG, "qa-second", "qa-loser", new Date("2026-10-06T10:00:05Z"));
    await edge(ORG, "qa-first", "qa-loser", new Date("2026-10-06T10:00:00Z"));
    const [marked] = await markSupersededWrites(ORG, [event("qa-loser", "create")]);
    expect(marked.supersededById).toBe("qa-first");
  });

  it("ignores an edge recorded in another org", async () => {
    await edge(OTHER_ORG, "qa-foreign", "qa-mine", new Date());
    const [marked] = await markSupersededWrites(ORG, [event("qa-mine", "create")]);
    expect(marked).toMatchObject({ supersededById: null, summary: "wrote qa-mine" });
  });

  it("leaves a delete event and a supersede event as they were", async () => {
    await edge(ORG, "qa-winner", "qa-gone", new Date());
    const marked = await markSupersededWrites(ORG, [event("qa-gone", "delete"), event("qa-gone", "supersede")]);
    expect(marked.map((e: any) => e.supersededById)).toEqual([null, null]);
  });
});
