// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The contention rule in conflict.ts reads only the versions themselves: a version that
// replaced a fact the change feed never announced (one stored before the feed existed), and
// that carries the same name as a rival version stored within the window, contends with it
// like any other pair. Exactly one of the two stays current, the one stored first, in
// either announcement order, and the replaced fact's own `supersedes` edge is left alone.
// An earlier winner rule took a version's standing from the one it replaced, so a
// never-announced predecessor gave it none; this pins that
// the replaced version's history now plays no part.
//
// This is not what PATCH /api/memory/facts/:id writes. A real correction is named
// factCorrectionName(id, now), never the fact's own name, so it never shares a contention
// key with a rival write of the fact it corrects, and both stay current whether or not the
// fact was announced (conflict-legacy-correction.qa.realdb.test.ts). Whether a
// correction should contend with such a rival is an open question this file does not settle.
//
// Set QA_DATABASE_URL to an ISOLATED test database, never the inherited DATABASE_URL.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const ORG = `legacycorr${RUN}`;
const SCOPE = `org_${ORG}.eng`;
const T = new Date(Date.UTC(2026, 9, 16, 12, 0, 0));
const ms = (offset: number) => new Date(T.getTime() + offset);

describe.skipIf(!QA_URL)("a same-named version replacing a never-announced fact contends like any version", () => {
  let db: PrismaClient;
  let resolveFactContention: (typeof import("./conflict"))["resolveFactContention"];

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ resolveFactContention } = await import("./conflict"));
    await db.org.create({ data: { id: ORG, name: ORG } });
  });

  beforeEach(async () => {
    await db.factEdge.deleteMany({ where: { orgId: ORG } });
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.memoryChunk.deleteMany({ where: { orgId: ORG } });
  });

  afterAll(async () => {
    if (!QA_URL) return;
    await db.org.deleteMany({ where: { id: ORG } });
    await db.$disconnect();
  });

  /**
   * A legacy fact (no version mark, no `create` event), a person's correction of it with
   * the `supersedes` edge the correction records, and an agent's rival version stored
   * `rivalOffset` ms from the correction.
   */
  async function seed(rivalOffset: number) {
    const chunk = (id: string, createdAt: Date, actorType: string, actorId: string, factVersion: boolean | null) =>
      db.memoryChunk.create({
        data: {
          id,
          orgId: ORG,
          content: `${id}: launch is in May`,
          entityName: "Launch",
          scopePath: SCOPE,
          actorType,
          actorId,
          factVersion,
          createdAt,
        },
      });
    await chunk("v-legacy", new Date(T.getTime() - 86_400_000), "human", "u-dana", null);
    await chunk("v-correction", T, "human", "u-dana", true);
    await chunk("v-rival", ms(rivalOffset), "agent", "agent-1", true);
    await db.factEdge.create({
      data: {
        orgId: ORG,
        fromId: "v-correction",
        toId: "v-legacy",
        kind: "supersedes",
        scopePath: SCOPE,
        actorType: "human",
        actorId: "u-dana",
        createdAt: T,
      },
    });
  }

  const announce = (versionId: string) =>
    db.$transaction((tx) =>
      resolveFactContention(tx, {
        orgId: ORG,
        versionId,
        entityName: "Launch",
        storedScopePath: SCOPE,
        eventScopePath: SCOPE,
        origin: "mcp",
      }),
    );

  /** Versions no `supersedes` edge points at. */
  async function current(): Promise<string[]> {
    const replaced = new Set(
      (await db.factEdge.findMany({ where: { orgId: ORG, kind: "supersedes" } })).map((e) => e.toId),
    );
    return ["v-legacy", "v-correction", "v-rival"].filter((id) => !replaced.has(id));
  }

  it.each([
    ["correction first, rival 300 ms later", 300, ["v-correction", "v-rival"], "v-correction"],
    ["rival announced first, stored 300 ms later", 300, ["v-rival", "v-correction"], "v-correction"],
    ["rival stored 300 ms before the correction", -300, ["v-correction", "v-rival"], "v-rival"],
    ["rival stored before, announced first", -300, ["v-rival", "v-correction"], "v-rival"],
  ])("%s: one version stays current, the one stored first", async (_name, offset, order, winner) => {
    await seed(offset);
    for (const id of order) await announce(id);
    expect(await current()).toEqual([winner]);
    // The legacy fact stays replaced by its correction alone, whatever happened to the correction.
    expect((await db.factEdge.findMany({ where: { orgId: ORG, toId: "v-legacy" } })).map((e) => e.fromId)).toEqual([
      "v-correction",
    ]);
  });
});
