// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// deleteSourceFileChunks() against a real database.
//
// A connector sync replacing or removing a Drive file deletes the chunks that
// file's sync record lists. The ids come from a stored record, so the delete is
// also bound to the org and the source: a stale or wrong id must not reach
// another source's or another org's row. memory_chunks.sourceId has no foreign
// key, so nothing in the schema stops a row in another org carrying the same
// source id; only the predicate does. Each guard has its own test here, and the
// delete must run in the caller's transaction so a rollback keeps the chunks.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never the sandbox's
// inherited DATABASE_URL, which points at live Neon. Skips cleanly without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-c45";
const OTHER_ORG = "org-qa-c45-other";
const SCOPE = "org_1.sales";

describe.skipIf(!QA_URL)("deleteSourceFileChunks() on a real database", () => {
  let db: PrismaClient;
  let deleteSourceFileChunks: (typeof import("./source-retirement"))["deleteSourceFileChunks"];

  let sourceId = "";
  let otherSourceId = "";
  /** Chunk id by content label. */
  let ids: Record<string, string> = {};

  async function clearTenants() {
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.memoryChunk.deleteMany({ where: { orgId } });
      await db.source.deleteMany({ where: { orgId } });
    }
    await db.org.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
  }

  async function surviving(): Promise<string[]> {
    const rows = await db.memoryChunk.findMany({
      where: { orgId: { in: [ORG, OTHER_ORG] } },
      select: { content: true },
      orderBy: { content: "asc" },
    });
    return rows.map((r) => r.content);
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ deleteSourceFileChunks } = await import("./source-retirement"));
    await clearTenants();
    for (const orgId of [ORG, OTHER_ORG]) await db.org.create({ data: { id: orgId, name: orgId } });
  });

  beforeEach(async () => {
    await db.memoryChunk.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
    await db.source.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
    const source = await db.source.create({
      data: { orgId: ORG, type: "gdrive", externalId: "drive-a", name: "drive a", scopePath: SCOPE },
    });
    const other = await db.source.create({
      data: { orgId: ORG, type: "gdrive", externalId: "drive-b", name: "drive b", scopePath: SCOPE },
    });
    sourceId = source.id;
    otherSourceId = other.id;

    const seed = [
      { label: "file-chunk-1", orgId: ORG, sourceId },
      { label: "file-chunk-2", orgId: ORG, sourceId },
      { label: "same-source-unlisted", orgId: ORG, sourceId },
      { label: "other-source-same-org", orgId: ORG, sourceId: otherSourceId },
      { label: "other-org-same-source", orgId: OTHER_ORG, sourceId },
      { label: "unattributed", orgId: ORG, sourceId: null },
    ];
    ids = {};
    for (const row of seed) {
      const created = await db.memoryChunk.create({
        data: { orgId: row.orgId, scopePath: SCOPE, sourceId: row.sourceId, content: row.label },
      });
      ids[row.label] = created.id;
    }
  });

  afterAll(async () => {
    await clearTenants();
    await db.$disconnect();
  });

  const all = [
    "file-chunk-1",
    "file-chunk-2",
    "other-org-same-source",
    "other-source-same-org",
    "same-source-unlisted",
    "unattributed",
  ];

  it("deletes the listed chunks of this source in this org, and no other row", async () => {
    await db.$transaction((tx) =>
      deleteSourceFileChunks(tx, { orgId: ORG, sourceId, chunkIds: [ids["file-chunk-1"], ids["file-chunk-2"]] }),
    );
    expect(await surviving()).toEqual(all.filter((c) => !c.startsWith("file-chunk")));
  });

  it("leaves a listed id that belongs to another source in the same org", async () => {
    await db.$transaction((tx) =>
      deleteSourceFileChunks(tx, {
        orgId: ORG,
        sourceId,
        chunkIds: [ids["file-chunk-1"], ids["other-source-same-org"]],
      }),
    );
    expect(await surviving()).toEqual(all.filter((c) => c !== "file-chunk-1"));
  });

  it("leaves a listed id in another org even when that row carries the same source id", async () => {
    await db.$transaction((tx) =>
      deleteSourceFileChunks(tx, {
        orgId: ORG,
        sourceId,
        chunkIds: [ids["file-chunk-1"], ids["other-org-same-source"]],
      }),
    );
    expect(await surviving()).toEqual(all.filter((c) => c !== "file-chunk-1"));
  });

  it("deletes nothing for an empty id list", async () => {
    await db.$transaction((tx) => deleteSourceFileChunks(tx, { orgId: ORG, sourceId, chunkIds: [] }));
    expect(await surviving()).toEqual(all);
  });

  it("runs in the caller's transaction, so a rollback keeps the chunks", async () => {
    await expect(
      db.$transaction(async (tx) => {
        await deleteSourceFileChunks(tx, { orgId: ORG, sourceId, chunkIds: [ids["file-chunk-1"]] });
        throw new Error("sourceFile update failed");
      }),
    ).rejects.toThrow("sourceFile update failed");
    expect(await surviving()).toEqual(all);
  });
});
