// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Drive sync retirement, against a real database: the chunk delete's org binding,
// retiring from the scope the episodes were written to after a reconnect moves the
// source, and content written by an attempt that failed partway through its ingest.
//
// Harness below is the same as lib/inngest.drive-retire.realdb.test.ts.
//
// The claim under test: once a Drive file is edited or leaves the folder, the content
// its previous sync wrote stops resolving, in both stores. Every Graphiti episode the
// file produced is deleted from the group it was written to, and every raw chunk row
// is deleted from `memory_chunks`.
//
// The whole `sourceSync` job runs, from listing to completion, so the vanished-file
// path is reached the way production reaches it: by a listing that no longer has the
// file. `memory_chunks` is real Postgres and chunks are resolved through the real
// pgvector store's `findFactById`. Graphiti is an in-memory double that hands out
// episode ids and deletes them by (group, id); it is the only store that is not
// Postgres. Drive and Blob are doubles because they are remote services.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never the sandbox's inherited
// DATABASE_URL, which points at live Neon. Skips cleanly without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { stubEmbeddingService } from "@/services/memory/embedding-service-double.testsupport";

/** Graphiti, reduced to what Drive sync uses: episodes keyed by group and id. */
const graphiti = vi.hoisted(() => {
  const episodes = new Map<string, string>(); // `${group}/${id}` -> content
  let nextId = 0;
  return {
    episodes,
    reset() {
      episodes.clear();
      nextId = 0;
    },
    resolves: (group: string, id: string) => episodes.has(`${group}/${id}`),
    store: {
      extractFile: async ({ url }: { url: string }) => ({ chunks: blobs.get(url)!.split("\n\n") }),
      ingestBulk: async (inputs: { scopePath?: string; groupId: string; content: string }[]) =>
        inputs.map((input) => {
          const id = `episode-${++nextId}`;
          episodes.set(`${input.scopePath ?? input.groupId}/${id}`, input.content);
          return id;
        }),
      removeEpisode: async ({ groupId, episodeId }: { groupId: string; episodeId: string }) => ({
        removed: episodes.delete(`${groupId}/${episodeId}`),
      }),
      dedupeNodes: async () => 0,
    },
  };
});
/** What `put` stored, read back by `extractFile`. */
const blobs = vi.hoisted(() => new Map<string, string>());
const drive = vi.hoisted(() => ({
  files: [] as { id: string; name: string; mimeType: string; checksum: string; fileType: "pdf" }[],
  content: new Map<string, string>(),
}));

// A gdrive sync event seals its client token; the job opens it.
vi.mock("@/lib/crypto", () => ({ unsealSecret: () => ({ token: "drive-token" }) }));
vi.mock("@/services/memory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory")>()),
  graphitiStore: graphiti.store,
}));
vi.mock("@/services/connectors/gdrive", () => ({
  listFolderFiles: async () => drive.files,
  downloadFile: async (file: { id: string }) => new Blob([drive.content.get(file.id)!]),
}));
vi.mock("@vercel/blob", () => ({
  put: async (pathname: string, body: Buffer) => {
    const url = `https://blob.test/${pathname}`;
    blobs.set(url, body.toString());
    return { url };
  },
  del: async (url: string) => {
    blobs.delete(url);
  },
}));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-drive-retire-beta";
const OTHER_ORG = "org-qa-drive-retire-beta-other";
const SOURCE_ID = "src-qa-drive-retire-beta";
const SCOPE = "org_qa.eng";
const FILE_ID = "drive-file-1";

type StepCtx = {
  event: { data: unknown };
  step: { run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T> };
};

describe.skipIf(!QA_URL)("Drive sync retirement against a real database", () => {
  let db: PrismaClient;
  let inngestModule: typeof import("./inngest");
  let pgvectorStore: typeof import("@/services/memory").pgvectorStore;

  beforeAll(async () => {
    // Before the imports, so the `@/lib/db` singleton is built against the QA
    // database. The embedding double has to be in place before the first ingest
    // too: the pgvector store writes no row without an embedding and throws when
    // the call fails, so an unserved `/embed` would stop this suite before it
    // reaches the retirement it tests.
    process.env.DATABASE_URL = QA_URL;
    stubEmbeddingService();
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    inngestModule = await import("./inngest");
    ({ pgvectorStore } = await import("@/services/memory"));
  });

  afterAll(async () => {
    await db.$disconnect();
    vi.unstubAllGlobals();
  });

  beforeEach(async () => {
    graphiti.reset();
    blobs.clear();
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.memoryChunk.deleteMany({ where: { orgId: ORG } });
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
    await db.source.deleteMany({ where: { id: SOURCE_ID } });
    await db.source.create({
      data: { id: SOURCE_ID, orgId: ORG, type: "gdrive", externalId: "folder-qa", name: "Eng Drive", scopePath: SCOPE },
    });
  });

  const listFolder = (files: { checksum: string; text: string }[]) => {
    drive.files = files.map(({ checksum }) => ({
      id: FILE_ID,
      name: "Roadmap.pdf",
      mimeType: "application/pdf",
      checksum,
      fileType: "pdf" as const,
    }));
    drive.content = new Map(files.map(({ text }) => [FILE_ID, text]));
  };

  const runSync = () => {
    const ctx: StepCtx = {
      event: { data: { sourceId: SOURCE_ID, orgId: ORG, sealedToken: "sealed-drive-token" } },
      step: { run: async (_name, fn) => fn() },
    };
    return (inngestModule.sourceSync as unknown as { fn: (ctx: StepCtx) => Promise<unknown> }).fn(ctx);
  };

  const sourceFile = () =>
    db.sourceFile.findUnique({ where: { sourceId_externalFileId: { sourceId: SOURCE_ID, externalFileId: FILE_ID } } });

  it("never deletes another org's chunk, even when that chunk carries this source's id", async () => {
    await db.org.upsert({ where: { id: OTHER_ORG }, update: {}, create: { id: OTHER_ORG, name: OTHER_ORG } });
    await db.memoryChunk.deleteMany({ where: { orgId: OTHER_ORG } });
    const foreign = await pgvectorStore.ingest({
      groupId: OTHER_ORG,
      content: "Another org's chunk.",
      actorType: "extraction",
      origin: "connector-sync",
      actorId: "gdrive-sync:foreign",
      scopePath: "org_other.eng",
      sourceId: SOURCE_ID,
    });
    await db.sourceFile.create({
      data: {
        sourceId: SOURCE_ID,
        externalFileId: FILE_ID,
        checksum: "v1",
        chunkIds: [foreign.episodeId],
        episodeScopePath: SCOPE,
      },
    });

    listFolder([]);
    await runSync();

    expect(await sourceFile()).toBeNull();
    expect(await db.memoryChunk.count({ where: { id: foreign.episodeId, orgId: OTHER_ORG } })).toBe(1);
    await db.memoryChunk.deleteMany({ where: { orgId: OTHER_ORG } });
  });

  it("retires an edited file's episodes from the scope they were written to, after the source moved", async () => {
    listFolder([{ checksum: "v1", text: "Launch is in March.\n\nOwner is Priya." }]);
    await runSync();
    const original = (await sourceFile())!;
    const MOVED = "org_qa.eng.platform";
    await db.source.update({ where: { id: SOURCE_ID }, data: { scopePath: MOVED } });

    listFolder([{ checksum: "v2", text: "Launch moved to April." }]);
    await runSync();

    for (const id of original.episodeIds) expect(graphiti.resolves(SCOPE, id)).toBe(false);
    const edited = (await sourceFile())!;
    expect(edited).toMatchObject({ checksum: "v2", episodeScopePath: MOVED });
    expect(edited.episodeIds.every((id) => graphiti.resolves(MOVED, id))).toBe(true);
  });

  it("leaves nothing retrievable from an attempt that failed after its episodes were written", async () => {
    listFolder([{ checksum: "v1", text: "Launch is in March.\n\nOwner is Priya." }]);
    // The graph ingest succeeds; the second raw chunk write fails, as a dropped
    // connection or a timed-out step would leave it.
    const realIngest = pgvectorStore.ingest.bind(pgvectorStore);
    let calls = 0;
    const spy = vi.spyOn(pgvectorStore, "ingest").mockImplementation(async (input) => {
      if (++calls === 2) throw new Error("connection lost");
      return realIngest(input);
    });
    await runSync();
    spy.mockRestore();

    await runSync();
    listFolder([]);
    await runSync();

    expect(await sourceFile()).toBeNull();
    expect([...graphiti.episodes.keys()]).toEqual([]);
    expect(await db.memoryChunk.count({ where: { orgId: ORG } })).toBe(0);
  });
});
