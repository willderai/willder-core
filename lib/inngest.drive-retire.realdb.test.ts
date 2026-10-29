// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Drive sync retires an edited or vanished file's old content, against a real database.
//
// The claim under test: once a Drive file is edited or leaves the folder, the content
// its previous sync wrote stops resolving, in both stores. Every Graphiti episode the
// file produced is deleted from the group it was written to, and every raw chunk row
// is deleted from `memory_chunks`. Before this, the Drive `SourceFile` row recorded
// the file-ingest job's event id instead of an episode id, so nothing could retire it.
//
// The whole `sourceSync` job runs, from listing to completion, so the vanished-file
// path is reached the way production reaches it: by a listing that no longer has the
// file. `memory_chunks` is real Postgres and chunks are resolved through the real
// pgvector store's `findFactById`. Graphiti is an in-memory double that hands out
// episode ids and deletes them by (group, id); it is the only store that is not
// Postgres. Drive and Blob are doubles because they are remote services.
//
// A second claim: a transient failure after one of a file's episodes is deleted from
// the graph, but before the write that records it commits, does not leave the file stuck.
// The next sync finishes the retirement and announces that episode exactly once.
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
  /** The account can no longer open the folder: the listing throws, as the real one does. */
  accessLost: false,
}));

// A gdrive sync event seals its client token; the job opens it.
vi.mock("@/lib/crypto", () => ({ unsealSecret: () => ({ token: "drive-token" }) }));
vi.mock("@/services/memory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory")>()),
  graphitiStore: graphiti.store,
}));
vi.mock("@/services/connectors/gdrive", async () => {
  const { SourceAccessError } = await import("@/services/connectors/source-access");
  return {
    listFolderFiles: async () => {
      if (drive.accessLost) throw new SourceAccessError("This Google account can no longer open this Drive folder.");
      return drive.files;
    },
    downloadFile: async (file: { id: string }) => new Blob([drive.content.get(file.id)!]),
  };
});
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

const ORG = "org-qa-drive-retire";
const SOURCE_ID = "src-qa-drive-retire";
const SCOPE = "org_qa.eng";
const FILE_ID = "drive-file-1";

type StepCtx = {
  event: { data: unknown };
  step: { run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T> };
};

describe.skipIf(!QA_URL)("Drive sync retires an edited or vanished file's content", () => {
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
    drive.accessLost = false;
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

  const chunkResolves = async (id: string) =>
    (await pgvectorStore.findFactById({ groupId: SCOPE, tenantId: ORG, factId: id })) !== null;

  it("records the episodes the sync wrote, not the job's event id", async () => {
    listFolder([{ checksum: "v1", text: "Launch is in March.\n\nOwner is Priya." }]);

    await runSync();

    const row = await sourceFile();
    expect(row).toMatchObject({ checksum: "v1", episodeId: null, episodeScopePath: SCOPE });
    expect(row!.episodeIds).toEqual(["episode-1", "episode-2"]);
    expect(row!.episodeIds.every((id) => graphiti.resolves(SCOPE, id))).toBe(true);
    expect(row!.chunkIds).toHaveLength(2);
    for (const id of row!.chunkIds) expect(await chunkResolves(id)).toBe(true);
  });

  it("stops resolving the old episodes and chunks once the file is edited, then once it vanishes", async () => {
    listFolder([{ checksum: "v1", text: "Launch is in March.\n\nOwner is Priya." }]);
    await runSync();
    const original = (await sourceFile())!;

    listFolder([{ checksum: "v2", text: "Launch moved to April." }]);
    await runSync();

    const edited = (await sourceFile())!;
    for (const id of original.episodeIds) expect(graphiti.resolves(SCOPE, id)).toBe(false);
    for (const id of original.chunkIds) expect(await chunkResolves(id)).toBe(false);
    expect(edited).toMatchObject({ checksum: "v2", episodeIds: ["episode-3"] });
    expect(graphiti.resolves(SCOPE, "episode-3")).toBe(true);
    expect(await chunkResolves(edited.chunkIds[0])).toBe(true);

    listFolder([]);
    await runSync();

    expect(await sourceFile()).toBeNull();
    expect(graphiti.episodes.size).toBe(0);
    expect(await db.memoryChunk.count({ where: { orgId: ORG } })).toBe(0);

    const feed = await db.changeEvent.findMany({ where: { orgId: ORG }, orderBy: { seq: "asc" } });
    expect(feed.map((e) => [e.op, e.recordId])).toEqual([
      ["create", "episode-1"],
      ["create", "episode-2"],
      ["supersede", "episode-1"],
      ["supersede", "episode-2"],
      ["create", "episode-3"],
      ["delete", "episode-3"],
    ]);
    // A supersede is announced where the old content lived, which is not always
    // where the file lives now, so it never carries the file's current name.
    expect(feed.filter((e) => e.op === "supersede").map((e) => e.summary)).toEqual(["", ""]);
  });

  it("keeps a file's episodes and chunks when the account loses the folder, and marks the source access lost", async () => {
    listFolder([{ checksum: "v1", text: "Launch is in March.\n\nOwner is Priya." }]);
    await runSync();
    const synced = (await sourceFile())!;

    drive.accessLost = true;
    expect(await runSync()).toMatchObject({ accessLost: true, disconnected: false });

    expect(await sourceFile()).toEqual(synced);
    for (const id of synced.episodeIds) expect(graphiti.resolves(SCOPE, id)).toBe(true);
    for (const id of synced.chunkIds) expect(await chunkResolves(id)).toBe(true);
    const source = await db.source.findUniqueOrThrow({ where: { id: SOURCE_ID } });
    expect(source.status).toBe("error");
    expect(source.meta).toMatchObject({
      accessLost: true,
      error: expect.stringContaining("can no longer open"),
      fileCount: 1,
    });
  });

  it("retries a failed edit even when the file reverts to the checksum it had before", async () => {
    listFolder([{ checksum: "v1", text: "Launch is in March." }]);
    await runSync();
    // The edit's graph ingest lands, then its raw chunk write fails.
    const spy = vi.spyOn(pgvectorStore, "ingest").mockRejectedValueOnce(new Error("connection lost"));
    listFolder([{ checksum: "v2", text: "Launch moved to April." }]);
    await runSync();
    spy.mockRestore();
    expect(await sourceFile()).toMatchObject({ checksum: "", episodeIds: ["episode-2"], chunkIds: [] });

    listFolder([{ checksum: "v1", text: "Launch is in March." }]);
    await runSync();

    const row = (await sourceFile())!;
    expect(row).toMatchObject({ checksum: "v1", episodeIds: ["episode-3"] });
    expect([...graphiti.episodes.keys()]).toEqual([`${SCOPE}/episode-3`]);
    expect(await db.memoryChunk.count({ where: { orgId: ORG } })).toBe(1);
    expect(await chunkResolves(row.chunkIds[0])).toBe(true);
  });

  it("deletes only chunks that belong to this source, whatever ids its record lists", async () => {
    const otherSource = await pgvectorStore.ingest({
      groupId: ORG,
      content: "Another source's chunk.",
      actorType: "extraction",
      origin: "connector-sync",
      actorId: "slack-sync:src-other",
      scopePath: SCOPE,
      sourceId: "src-other",
    });
    await db.sourceFile.create({
      data: {
        sourceId: SOURCE_ID,
        externalFileId: FILE_ID,
        checksum: "v1",
        chunkIds: [otherSource.episodeId],
        episodeScopePath: SCOPE,
      },
    });

    listFolder([]);
    await runSync();

    expect(await sourceFile()).toBeNull();
    expect(await chunkResolves(otherSource.episodeId)).toBe(true);
  });

  it("keeps an episode it could not delete on record, so the next sync retries only that one", async () => {
    listFolder([{ checksum: "v1", text: "Launch is in March.\n\nOwner is Priya." }]);
    await runSync();
    // The second episode is missing from the group on record: the store reports it
    // not removed, which retirement treats as a failure rather than a no-op.
    graphiti.episodes.delete(`${SCOPE}/episode-2`);

    listFolder([]);
    await runSync();

    const row = await sourceFile();
    expect(row).toMatchObject({ episodeIds: ["episode-2"] });
    expect(graphiti.resolves(SCOPE, "episode-1")).toBe(false);
    expect(row!.chunkIds).toHaveLength(2);
    const source = await db.source.findUnique({ where: { id: SOURCE_ID } });
    expect(source!.meta).toMatchObject({ failed: 1 });
  });

  describe("a transient failure between an episode delete and the write that records it", () => {
    // The first graph delete of the next sync lands, then the transaction that
    // records it fails once. The episode is gone from then on.
    const failRecordAfterFirstDelete = async () => {
      const { db: appDb } = await import("@/lib/db");
      const removeEpisode = graphiti.store.removeEpisode;
      let deleted = false;
      const removeSpy = vi.spyOn(graphiti.store, "removeEpisode").mockImplementation(async (args) => {
        const result = await removeEpisode(args);
        deleted ||= result.removed;
        return result;
      });
      const transaction = appDb.$transaction.bind(appDb);
      let failed = false;
      const transactionSpy = vi.spyOn(appDb, "$transaction").mockImplementation(((...args: unknown[]) => {
        if (deleted && !failed) {
          failed = true;
          return Promise.reject(new Error("connection lost"));
        }
        return (transaction as (...a: unknown[]) => unknown)(...args);
      }) as typeof appDb.$transaction);
      return () => {
        removeSpy.mockRestore();
        transactionSpy.mockRestore();
      };
    };
    const feed = async () =>
      (await db.changeEvent.findMany({ where: { orgId: ORG }, orderBy: { seq: "asc" } })).map((e) => [
        e.op,
        e.recordId,
      ]);

    it("lets the next sync of an edited file finish, announcing each supersede once", async () => {
      listFolder([{ checksum: "v1", text: "Launch is in March.\n\nOwner is Priya." }]);
      await runSync();
      listFolder([{ checksum: "v2", text: "Launch moved to April." }]);
      const restore = await failRecordAfterFirstDelete();
      await runSync();
      restore();
      expect(graphiti.resolves(SCOPE, "episode-1")).toBe(false);
      expect(await sourceFile()).toMatchObject({ checksum: "v1", episodeIds: ["episode-1", "episode-2"] });

      await runSync();

      expect(await sourceFile()).toMatchObject({
        checksum: "v2",
        episodeIds: ["episode-3"],
        episodeRetireStartedAt: null,
      });
      expect([...graphiti.episodes.keys()]).toEqual([`${SCOPE}/episode-3`]);
      expect(await db.memoryChunk.count({ where: { orgId: ORG } })).toBe(1);
      expect(await feed()).toEqual([
        ["create", "episode-1"],
        ["create", "episode-2"],
        ["supersede", "episode-1"],
        ["supersede", "episode-2"],
        ["create", "episode-3"],
      ]);
    });

    it("lets the next sync of a vanished file finish, announcing each delete once", async () => {
      listFolder([{ checksum: "v1", text: "Launch is in March.\n\nOwner is Priya." }]);
      await runSync();
      listFolder([]);
      const restore = await failRecordAfterFirstDelete();
      await runSync();
      restore();
      expect(await sourceFile()).toMatchObject({ episodeIds: ["episode-1", "episode-2"] });

      await runSync();

      expect(await sourceFile()).toBeNull();
      expect(graphiti.episodes.size).toBe(0);
      expect(await db.memoryChunk.count({ where: { orgId: ORG } })).toBe(0);
      expect(await feed()).toEqual([
        ["create", "episode-1"],
        ["create", "episode-2"],
        ["delete", "episode-1"],
        ["delete", "episode-2"],
      ]);
    });

    it("still fails a retry when the earlier attempt's own delete found nothing", async () => {
      listFolder([{ checksum: "v1", text: "Launch is in March.\n\nOwner is Priya." }]);
      await runSync();
      graphiti.episodes.delete(`${SCOPE}/episode-2`);
      listFolder([]);

      await runSync();
      await runSync();

      expect(await sourceFile()).toMatchObject({ episodeIds: ["episode-2"], episodeRetireStartedAt: null });
      const source = await db.source.findUnique({ where: { id: SOURCE_ID } });
      expect(source!.meta).toMatchObject({ failed: 1 });
      expect(await feed()).toEqual([
        ["create", "episode-1"],
        ["create", "episode-2"],
        ["delete", "episode-1"],
      ]);
    });
  });
});
