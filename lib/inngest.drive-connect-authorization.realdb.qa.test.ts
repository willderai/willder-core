// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A Drive sync's change events carry the connect that authorized the source, on all
// three of its writes -- a new file's create, an edited file's supersede of what the last
// sync wrote, and a vanished file's delete, through lib/inngest/connector-drive-files.ts.
// The text-item path is covered in lib/inngest.content-change-events.realdb.test.ts.
//
// Real: Source/SourceFile rows, the change feed, the per-file stop checks. Faked: the
// Drive download, the blob put, and the graph/vector stores.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

vi.mock("@/services/memory", () => ({
  memory: { ingest: vi.fn() },
  graphitiStore: { removeEpisode: vi.fn(), extractFile: vi.fn(), ingestBulk: vi.fn(), dedupeNodes: vi.fn() },
  pgvectorStore: { ingest: vi.fn() },
}));

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "org-qa-drive-connect";
const SOURCE_ID = "src-qa-drive-connect";
const SCOPE = "org_qadrive.docs";
const CONNECT_ROW = "al-qa-drive-connect-row";

const source = { id: SOURCE_ID, orgId: ORG, name: "Contracts", scopePath: SCOPE, connectAuthorizationId: CONNECT_ROW };
const file = (checksum: string) => ({ id: "file-1", name: "MSA.docx", fileType: "docx", checksum }) as never;
const deps = {
  downloadFile: async () => new Blob(["contract text"]),
  put: async () => ({ url: "https://blob.test/msa" }),
  del: async () => undefined,
};

describe.skipIf(!QA_URL)("Drive sync writes carry the connect authorization, real Postgres", () => {
  let db: PrismaClient;
  let drive: typeof import("./inngest/connector-drive-files");
  let stores: typeof import("@/services/memory");

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    drive = await import("./inngest/connector-drive-files");
    stores = await import("@/services/memory");
  });

  afterAll(async () => {
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.source.deleteMany({ where: { id: SOURCE_ID } });
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.$disconnect();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
    await db.source.deleteMany({ where: { id: SOURCE_ID } });
    await db.source.create({
      data: {
        id: SOURCE_ID,
        orgId: ORG,
        type: "gdrive",
        externalId: "F-qa",
        name: "Contracts",
        scopePath: SCOPE,
        connectAuthorizationId: CONNECT_ROW,
      },
    });
    let n = 0;
    vi.mocked(stores.graphitiStore.extractFile).mockResolvedValue({ chunks: ["clause one"] } as never);
    vi.mocked(stores.graphitiStore.ingestBulk).mockImplementation((async () => [`drive-ep-${++n}`]) as never);
    vi.mocked(stores.graphitiStore.removeEpisode).mockResolvedValue({ removed: true } as never);
    vi.mocked(stores.pgvectorStore.ingest).mockImplementation((async () => ({ episodeId: `chunk-${++n}` })) as never);
  });

  const events = () => db.changeEvent.findMany({ where: { orgId: ORG }, orderBy: { seq: "asc" } });

  it("stamps the connect row on a new file's create", async () => {
    expect(await drive.processDriveFile(source, file("v1"), "token", deps)).toBe("synced");
    expect((await events()).map((e) => [e.op, e.authorizedById])).toEqual([["create", CONNECT_ROW]]);
  });

  it("stamps it on an edited file's supersede and its new create", async () => {
    await drive.processDriveFile(source, file("v1"), "token", deps);
    expect(await drive.processDriveFile(source, file("v2"), "token", deps)).toBe("synced");
    expect((await events()).map((e) => [e.op, e.authorizedById])).toEqual([
      ["create", CONNECT_ROW],
      ["supersede", CONNECT_ROW],
      ["create", CONNECT_ROW],
    ]);
  });

  it("stamps it on a vanished file's delete", async () => {
    await drive.processDriveFile(source, file("v1"), "token", deps);
    const row = await db.sourceFile.findUniqueOrThrow({
      where: { sourceId_externalFileId: { sourceId: SOURCE_ID, externalFileId: "file-1" } },
    });
    const outcome = await drive.retireVanishedDriveFile(source, {
      externalFileId: "file-1",
      checksum: row.checksum,
      episodeIds: row.episodeIds,
      chunkIds: row.chunkIds,
      episodeScopePath: row.episodeScopePath,
    });
    expect(outcome).toBe("retired");
    expect((await events()).map((e) => [e.op, e.authorizedById])).toEqual([
      ["create", CONNECT_ROW],
      ["delete", CONNECT_ROW],
    ]);
  });
});
