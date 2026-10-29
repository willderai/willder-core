// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A Drive sync that loses access part way through, through the real `sourceSync`
// and the real Drive connector (`listFolderFiles`, `downloadFile`) against the
// fake Drive API, on real Postgres.
//
// The claims under test:
// - access lost while the folder is being listed retires nothing: the stored
//   files, their records and their content all stay;
// - a sync whose Google sign-in expires part way through stops there, retires
//   nothing, and stores a line naming the fix in `meta.error`,
//   never nothing and never Drive's raw answer.
//
// Graphiti and Blob are doubles because they are remote services.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { stubEmbeddingService } from "@/services/memory/embedding-service-double.testsupport";
import { DRIVE_MIME, driveFile, fakeDrive, type FakeDriveState } from "@/services/connectors/fixtures/gdrive";

const graphiti = vi.hoisted(() => {
  const episodes = new Map<string, string>();
  let nextId = 0;
  return {
    episodes,
    reset() {
      episodes.clear();
      nextId = 0;
    },
    store: {
      extractFile: async ({ url }: { url: string }) => ({ chunks: [blobs.get(url)!] }),
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
const blobs = vi.hoisted(() => new Map<string, string>());

vi.mock("@/lib/crypto", () => ({ unsealSecret: () => ({ token: "drive-token" }) }));
vi.mock("@/services/memory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory")>()),
  graphitiStore: graphiti.store,
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
const ORG = "org-qa-drive-mid-sync";
const SOURCE_ID = "src-qa-drive-mid-sync";
const SCOPE = "org_qa.eng";
const FOLDER = "folder-qa-mid-sync";

type StepCtx = {
  event: { data: unknown };
  step: { run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T> };
};

/** The folder and three PDFs in it. */
function folderState(): FakeDriveState {
  const at = "2026-10-01T00:00:00Z";
  return {
    files: [
      driveFile("root", FOLDER, { name: "Eng", mimeType: "application/vnd.google-apps.folder", modifiedTime: at }),
      ...["a", "b", "c"].map((id) =>
        driveFile(FOLDER, `file-${id}`, {
          name: `${id}.pdf`,
          mimeType: DRIVE_MIME.pdf,
          modifiedTime: at,
          bytes: new TextEncoder().encode(`File ${id}`),
        }),
      ),
    ],
    permissions: new Map(),
    failWith: null,
  };
}

describe.skipIf(!QA_URL)("Drive sync that loses access part way through", () => {
  let db: PrismaClient;
  let inngestModule: typeof import("./inngest");
  let state: FakeDriveState;
  /** Called after each Drive request with the number answered since `watch` set it. */
  let afterRequest: (count: number) => void;
  let requestCount = 0;
  const watch = (fn: (count: number) => void) => {
    requestCount = 0;
    afterRequest = fn;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    vi.stubEnv("GDRIVE_MOCK", "false");
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
    state = folderState();
    afterRequest = () => {};
    const drive = fakeDrive(state);
    const embed = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith("https://www.googleapis.com/")) return embed(input, init);
      const res = await drive.fetch(input);
      afterRequest(++requestCount);
      return res;
    });
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.memoryChunk.deleteMany({ where: { orgId: ORG } });
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
    await db.source.deleteMany({ where: { id: SOURCE_ID } });
    await db.source.create({
      data: { id: SOURCE_ID, orgId: ORG, type: "gdrive", externalId: FOLDER, name: "Eng Drive", scopePath: SCOPE },
    });
  });

  const runSync = () => {
    const ctx: StepCtx = {
      event: { data: { sourceId: SOURCE_ID, orgId: ORG, sealedToken: "sealed-drive-token" } },
      step: { run: async (_name, fn) => fn() },
    };
    return (inngestModule.sourceSync as unknown as { fn: (ctx: StepCtx) => Promise<unknown> }).fn(ctx);
  };
  const stored = () => db.sourceFile.findMany({ where: { sourceId: SOURCE_ID }, orderBy: { externalFileId: "asc" } });
  const meta = async () =>
    (await db.source.findUniqueOrThrow({ where: { id: SOURCE_ID } })).meta as Record<string, unknown>;

  it("retires nothing when the folder stops being shared while it is listed", async () => {
    await runSync();
    const before = await stored();
    expect(before.map((f) => f.externalFileId)).toEqual(["file-a", "file-b", "file-c"]);

    // Right after the first folder read: the listing comes back empty.
    watch((count) => {
      if (count === 1) state.files = state.files.filter((f) => f.id !== FOLDER && !f.parents.includes(FOLDER));
    });
    await runSync();

    expect(await stored()).toEqual(before);
    expect(graphiti.episodes.size).toBe(3);
    expect(await meta()).toMatchObject({ accessLost: true });
    expect(await meta()).not.toHaveProperty("synced");
  });

  // Requests 1-3 are the folder read, the listing and the folder read again; 4 is the first download.
  it.each([
    [
      "the Google sign-in expires after the listing",
      3,
      { status: 401, reason: "authError" },
      /sign-in expired.*Sync again and sign in with Google/,
    ],
    [
      "the Google sign-in expires after one file synced",
      4,
      { status: 401, reason: "authError" },
      /sign-in expired.*Sync again and sign in with Google/,
    ],
  ] as const)("stops the run, names the fix and retires nothing when %s", async (_case, after, failWith, line) => {
    await runSync();
    const firstChecksums = new Map((await stored()).map((f) => [f.externalFileId, f.checksum]));
    for (const f of state.files)
      if (f.id !== FOLDER) {
        f.md5Checksum = `edited-${f.id}`;
      }

    watch((count) => {
      if (count === after) state.failWith = failWith;
    });
    await expect(runSync()).rejects.toThrow(`: ${failWith.status} {`);

    const row = await db.source.findUniqueOrThrow({ where: { id: SOURCE_ID } });
    expect(row.status).toBe("error");
    expect((row.meta as Record<string, unknown>).error).toMatch(line);
    // Each file keeps its content: the failed downloads retired nothing.
    expect((await stored()).map((f) => f.externalFileId)).toEqual(["file-a", "file-b", "file-c"]);
    expect(graphiti.episodes.size).toBe(3);
    // The card reads these counts beside the fix: they are what this run did, not zeros it never measured.
    // The run before this one stored each file's first version; `synced` counts the files this run rewrote.
    const rewritten = (await stored()).filter((f) => f.checksum !== firstChecksums.get(f.externalFileId)).length;
    expect(rewritten).toBe(after === 4 ? 1 : 0);
    expect(row.meta).toMatchObject({ synced: rewritten });
  });
});
