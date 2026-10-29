// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A Drive retirement that resumes after a failed record write, against a real database.
//
// lib/inngest.drive-retire.realdb.test.ts fails the record write after a file's FIRST
// episode delete. These cases cover the rest: a failure after a later episode (the mark then
// names an episode that is not the file's first), a delete that landed but reported
// a transport error, and the mark write staying bound to this source's row, so a
// failure here never marks another org's row that happens to share the file id and
// episode id.
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

const ORG = "org-qa-drive-resume";
const SOURCE_ID = "src-qa-drive-resume";
const SCOPE = "org_qa.eng";
const FILE_ID = "drive-file-1";

type StepCtx = {
  event: { data: unknown };
  step: { run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T> };
};

describe.skipIf(!QA_URL)("Drive retirement resumes after a failure", () => {
  let db: PrismaClient;
  let inngestModule: typeof import("./inngest");

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

  const OTHER_ORG = "org-qa-drive-resume-other";
  const OTHER_SOURCE = "src-qa-drive-resume-other";

  const feed = async () =>
    (await db.changeEvent.findMany({ where: { orgId: ORG }, orderBy: { seq: "asc" } })).map((e) => [e.op, e.recordId]);

  /** Fail the record transaction once, right after the `nth` successful graph delete. */
  const failRecordAfterDelete = async (nth: number) => {
    const { db: appDb } = await import("@/lib/db");
    const removeEpisode = graphiti.store.removeEpisode;
    let deletes = 0;
    const removeSpy = vi.spyOn(graphiti.store, "removeEpisode").mockImplementation(async (args) => {
      const result = await removeEpisode(args);
      if (result.removed) deletes++;
      return result;
    });
    const transaction = appDb.$transaction.bind(appDb);
    let failed = false;
    const transactionSpy = vi.spyOn(appDb, "$transaction").mockImplementation(((...args: unknown[]) => {
      if (deletes === nth && !failed) {
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

  it("resumes when the record write fails after the second of three episodes", async () => {
    listFolder([{ checksum: "v1", text: "Launch is in March.\n\nOwner is Priya.\n\nBudget is 40k." }]);
    await runSync();
    expect((await sourceFile())!.episodeIds).toEqual(["episode-1", "episode-2", "episode-3"]);

    listFolder([]);
    const restore = await failRecordAfterDelete(2);
    await runSync();
    restore();
    const wedged = (await sourceFile())!;
    expect(wedged.episodeIds).toEqual(["episode-2", "episode-3"]);
    expect(wedged.episodeRetireStartedAt).not.toBeNull();
    expect(graphiti.resolves(SCOPE, "episode-2")).toBe(false);

    await runSync();

    expect(await sourceFile()).toBeNull();
    expect(graphiti.episodes.size).toBe(0);
    expect(await db.memoryChunk.count({ where: { orgId: ORG } })).toBe(0);
    expect(await feed()).toEqual([
      ["create", "episode-1"],
      ["create", "episode-2"],
      ["create", "episode-3"],
      ["delete", "episode-1"],
      ["delete", "episode-2"],
      ["delete", "episode-3"],
    ]);
  });

  it("resumes when the graph delete landed but the call reported a transport error", async () => {
    listFolder([{ checksum: "v1", text: "Launch is in March.\n\nOwner is Priya." }]);
    await runSync();
    listFolder([{ checksum: "v2", text: "Launch moved to April." }]);
    const removeEpisode = graphiti.store.removeEpisode;
    let thrown = false;
    const spy = vi.spyOn(graphiti.store, "removeEpisode").mockImplementation(async (args) => {
      const result = await removeEpisode(args);
      if (!thrown) {
        thrown = true;
        throw new Error("socket hang up");
      }
      return result;
    });
    await runSync();
    spy.mockRestore();
    expect(graphiti.resolves(SCOPE, "episode-1")).toBe(false);
    expect((await sourceFile())!).toMatchObject({ checksum: "v1", episodeIds: ["episode-1", "episode-2"] });

    await runSync();

    expect(await sourceFile()).toMatchObject({
      checksum: "v2",
      episodeIds: ["episode-3"],
      episodeRetireStartedAt: null,
    });
    expect(await feed()).toEqual([
      ["create", "episode-1"],
      ["create", "episode-2"],
      ["supersede", "episode-1"],
      ["supersede", "episode-2"],
      ["create", "episode-3"],
    ]);
  });

  it("never marks another org's row that shares the file id and episode id", async () => {
    await db.sourceFile.deleteMany({ where: { sourceId: OTHER_SOURCE } });
    await db.source.deleteMany({ where: { id: OTHER_SOURCE } });
    await db.org.upsert({ where: { id: OTHER_ORG }, update: {}, create: { id: OTHER_ORG, name: OTHER_ORG } });
    await db.source.create({
      data: {
        id: OTHER_SOURCE,
        orgId: OTHER_ORG,
        type: "gdrive",
        externalId: "folder-other",
        name: "Other",
        scopePath: "org_other.eng",
      },
    });
    await db.sourceFile.create({
      data: {
        sourceId: OTHER_SOURCE,
        externalFileId: FILE_ID,
        checksum: "other",
        episodeIds: ["episode-1", "episode-2"],
        episodeScopePath: "org_other.eng",
      },
    });

    listFolder([{ checksum: "v1", text: "Launch is in March.\n\nOwner is Priya." }]);
    await runSync();
    listFolder([]);
    const restore = await failRecordAfterDelete(1);
    await runSync();
    restore();

    expect((await sourceFile())!.episodeRetireStartedAt).not.toBeNull();
    const other = await db.sourceFile.findUnique({
      where: { sourceId_externalFileId: { sourceId: OTHER_SOURCE, externalFileId: FILE_ID } },
    });
    expect(other).toMatchObject({ episodeIds: ["episode-1", "episode-2"], episodeRetireStartedAt: null });

    await db.sourceFile.deleteMany({ where: { sourceId: OTHER_SOURCE } });
    await db.source.deleteMany({ where: { id: OTHER_SOURCE } });
  });
});
