// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A correction that was never announced, through the real path. conflict-legacy-correction
// .realdb.test.ts names the correction "Launch", the corrected fact's own name. PATCH /api/memory/facts/:id names it
// factCorrectionName(id, now) instead, so a real correction never shares a contention key
// with a rival write of the fact it corrected, announced or not. This pins what the real
// path does: both the correction and the rival stay current.
//
// Set QA_DATABASE_URL to an ISOLATED test database, never the inherited DATABASE_URL.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { factCorrectionName } from "./correction-names";

const QA_URL = process.env.QA_DATABASE_URL;
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const ORG = `legacycorrqa${RUN}`;
const SCOPE = `org_${ORG}.eng`;
const T = new Date(Date.UTC(2026, 9, 16, 12, 0, 0));

describe.skipIf(!QA_URL)("a correction named as PATCH names it, against a rival write of the corrected fact", () => {
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

  it.each([
    ["announced", true],
    ["never announced", null],
  ] as const)("%s legacy fact: correction and rival 300 ms apart both stay current", async (_label, factVersion) => {
    const correctionName = factCorrectionName("v-legacy", T);
    const chunk = (
      id: string,
      entityName: string,
      createdAt: Date,
      actorType: string,
      actorId: string,
      fv: boolean | null,
    ) =>
      db.memoryChunk.create({
        data: {
          id,
          orgId: ORG,
          content: `${id}: launch`,
          entityName,
          scopePath: SCOPE,
          actorType,
          actorId,
          factVersion: fv,
          createdAt,
        },
      });
    await chunk("v-legacy", "Launch", new Date(T.getTime() - 86_400_000), "human", "u-dana", factVersion);
    await chunk("v-correction", correctionName, T, "human", "u-dana", true);
    await chunk("v-rival", "Launch", new Date(T.getTime() + 300), "agent", "agent-1", true);
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
    for (const [versionId, entityName] of [
      ["v-correction", correctionName],
      ["v-rival", "Launch"],
    ] as const) {
      await db.$transaction((tx) =>
        resolveFactContention(tx, {
          orgId: ORG,
          versionId,
          entityName,
          storedScopePath: SCOPE,
          eventScopePath: SCOPE,
          origin: "mcp",
        }),
      );
    }
    const replaced = new Set(
      (await db.factEdge.findMany({ where: { orgId: ORG, kind: "supersedes" } })).map((e) => e.toId),
    );
    expect(["v-legacy", "v-correction", "v-rival"].filter((id) => !replaced.has(id))).toEqual([
      "v-correction",
      "v-rival",
    ]);
  });
});
