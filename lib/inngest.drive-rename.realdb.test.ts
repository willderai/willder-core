// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A Drive rename reaches memory. Drive keeps a file's md5Checksum when it is
// renamed, and the stored episodes carry the file's name, so a sync that skipped
// on the checksum alone kept serving the old name. The claim under test: a renamed
// file is synced again under its new name and its old episodes retire, while a
// file nobody touched is still skipped; a rename onto an erased person's name
// retires the file's content and writes nothing back; and a row stored before
// the key held the name is skipped while its content is unchanged, then keyed
// the new way, rather than ingested a second time.
//
// Real: Postgres, the whole sourceSync job, the Drive connector's own listing and
// download code (services/connectors/gdrive.ts) against Drive v3 payloads in
// Drive's shape (services/connectors/fixtures/gdrive.ts), the change feed and the
// suppression list. Doubles: the graph store, Blob storage and the embedding
// service.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { stubEmbeddingService } from "@/services/memory/embedding-service-double.testsupport";
import {
  DRIVE_MIME,
  driveFile,
  editDriveFile,
  fakeDrive,
  pdfBytes,
  type FakeDriveState,
} from "@/services/connectors/fixtures/gdrive";

// GDRIVE_MOCK is read when gdrive.ts is imported; the real branch is the one under test.
vi.hoisted(() => vi.stubEnv("GDRIVE_MOCK", "false"));

/** The graph store: live episodes by group and id, with the name each was written under. */
const graph = vi.hoisted(() => {
  const live = new Map<string, string>(); // `${group}/${id}` -> episode name
  const writes: string[] = [];
  let nextId = 0;
  return {
    live,
    writes,
    reset() {
      live.clear();
      writes.length = 0;
      nextId = 0;
    },
    namesIn: (group: string) =>
      [...live.entries()]
        .filter(([key]) => key.startsWith(`${group}/`))
        .map(([, name]) => name)
        .sort(),
    store: {
      extractFile: async ({ filename }: { filename: string }) => ({ chunks: [`What ${filename} says.`] }),
      ingestBulk: async (inputs: { scopePath?: string; groupId: string; name?: string }[]) =>
        inputs.map((input) => {
          const id = `episode-${++nextId}`;
          live.set(`${input.scopePath ?? input.groupId}/${id}`, input.name ?? "");
          writes.push(input.name ?? "");
          return id;
        }),
      removeEpisode: async ({ groupId, episodeId }: { groupId: string; episodeId: string }) => ({
        removed: live.delete(`${groupId}/${episodeId}`),
      }),
      dedupeNodes: async () => 0,
    },
  };
});

vi.mock("@/lib/crypto", () => ({ unsealSecret: () => ({ token: "drive-token" }) }));
vi.mock("@/services/memory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory")>()),
  graphitiStore: graph.store,
}));
vi.mock("@vercel/blob", () => ({
  put: async (pathname: string) => ({ url: `https://blob.test/${pathname}` }),
  del: async () => undefined,
}));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-drive-rename";
const SOURCE_ID = "src-qa-drive-rename";
const FOLDER = "folder-qa-rename";
const SCOPE = "org_qa_rename.eng";
const ERASED = "Dana Whitfield";

type StepCtx = {
  event: { data: unknown };
  step: { run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T> };
};

describe.skipIf(!QA_URL)("Drive sync after a rename", () => {
  let db: PrismaClient;
  let inngestModule: typeof import("./inngest");
  let drive: FakeDriveState;

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    stubEmbeddingService();
    // Drive's API answers through the fixture; the memory service's /embed through the stub.
    const embed = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return url.startsWith("https://www.googleapis.com/") ? fakeDrive(drive).fetch(input) : embed(input, init);
    });
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    inngestModule = await import("./inngest");
  });

  afterAll(async () => {
    await db.$disconnect();
    vi.unstubAllGlobals();
  });

  beforeEach(async () => {
    graph.reset();
    drive = {
      files: [
        // The synced folder itself, which each listing reads first.
        driveFile(FOLDER, FOLDER, {
          name: "Eng",
          mimeType: DRIVE_MIME.folder,
          modifiedTime: "2026-10-01T09:00:00.000Z",
          parents: ["root"],
        }),
        driveFile(FOLDER, "f-contract", {
          name: "Contract.pdf",
          mimeType: DRIVE_MIME.pdf,
          modifiedTime: "2026-10-01T09:00:00.000Z",
          bytes: pdfBytes(4_000, "contract"),
        }),
        driveFile(FOLDER, "f-spec", {
          name: "Spec — v2 (draft)",
          mimeType: DRIVE_MIME.googleDoc,
          modifiedTime: "2026-10-02T09:00:00.000Z",
        }),
        driveFile(FOLDER, "f-notes", {
          name: "Notes.pdf",
          mimeType: DRIVE_MIME.pdf,
          modifiedTime: "2026-10-03T09:00:00.000Z",
          bytes: pdfBytes(2_000, "notes"),
        }),
      ],
      permissions: new Map(),
      failWith: null,
    };
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.memoryChunk.deleteMany({ where: { orgId: ORG } });
    await db.erasureSuppression.deleteMany({ where: { orgId: ORG } });
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

  const rename = (id: string, name: string) => {
    const file = drive.files.find((f) => f.id === id);
    if (!file) throw new Error(`fixture lost ${id}`);
    file.name = name;
  };

  const storedFile = (id: string) =>
    db.sourceFile.findUniqueOrThrow({
      where: { sourceId_externalFileId: { sourceId: SOURCE_ID, externalFileId: id } },
    });

  it("stores a renamed file under its new name and retires the old one, and still skips a file nobody touched", async () => {
    await runSync();
    const notesBefore = await storedFile("f-notes");
    const contractBefore = await storedFile("f-contract");
    graph.writes.length = 0;

    rename("f-contract", "Contract (signed).pdf");
    rename("f-spec", "Spec — v2 (final)");
    await runSync();

    expect(graph.namesIn(SCOPE)).toEqual(["Contract (signed).pdf", "Notes.pdf", "Spec — v2 (final)"]);
    expect(graph.writes.sort()).toEqual(["Contract (signed).pdf", "Spec — v2 (final)"]);
    expect(await storedFile("f-notes")).toMatchObject({
      checksum: notesBefore.checksum,
      episodeIds: notesBefore.episodeIds,
    });
    for (const id of contractBefore.episodeIds) expect(graph.live.has(`${SCOPE}/${id}`)).toBe(false);

    const feed = await db.changeEvent.findMany({
      where: { orgId: ORG, op: { not: "create" } },
      orderBy: { seq: "asc" },
    });
    expect(feed).toHaveLength(2);
    expect(feed.every((e) => e.op === "supersede")).toBe(true);
    expect(feed.map((e) => e.recordId)).toContain(contractBefore.episodeIds[0]);

    // Nothing changed since: the next sync writes nothing.
    graph.writes.length = 0;
    await runSync();
    expect(graph.writes).toEqual([]);
  });

  it("syncs a file again when it is renamed back to a name it had before", async () => {
    await runSync();
    rename("f-notes", "Notes (old).pdf");
    await runSync();
    rename("f-notes", "Notes.pdf");
    graph.writes.length = 0;
    await runSync();

    expect(graph.writes).toEqual(["Notes.pdf"]);
    expect(graph.namesIn(SCOPE)).toEqual(["Contract.pdf", "Notes.pdf", "Spec — v2 (draft)"]);
  });

  describe("a row stored before the change key held the name", () => {
    const legacyRow = async (id: string, extra: Record<string, unknown>) => {
      const file = drive.files.find((f) => f.id === id)!;
      await db.sourceFile.create({
        data: { sourceId: SOURCE_ID, externalFileId: id, checksum: file.md5Checksum!, ...extra },
      });
    };

    it("is skipped while its content is unchanged, so a row from before episodeIds is not served twice", async () => {
      // Written by the file-ingest job: its episode id is the job's event id, not an episode.
      graph.live.set(`${SCOPE}/legacy-episode`, "Notes.pdf");
      await legacyRow("f-notes", { episodeId: "evt-legacy", episodeScopePath: null });

      await runSync();

      expect(graph.namesIn(SCOPE).filter((name) => name === "Notes.pdf")).toHaveLength(1);
      expect(graph.writes.sort()).toEqual(["Contract.pdf", "Spec — v2 (draft)"]);
      // Keyed the current way: the key a fresh listing gives the same file, not the bare md5.
      const { listFolderFiles } = await import("@/services/connectors/gdrive");
      const listed = (await listFolderFiles(FOLDER, "drive-token")).find((f) => f.id === "f-notes");
      expect(listed?.checksum).not.toBe(listed?.contentVersion);
      expect(await storedFile("f-notes")).toMatchObject({ episodeId: "evt-legacy", checksum: listed?.checksum });
    });

    it("announces nothing for unchanged content, and syncs a rename after its key moved", async () => {
      await legacyRow("f-contract", { episodeIds: ["legacy-1"], episodeScopePath: SCOPE });
      graph.live.set(`${SCOPE}/legacy-1`, "Contract.pdf");

      await runSync();
      expect(await db.changeEvent.count({ where: { orgId: ORG, op: { not: "create" } } })).toBe(0);
      expect(graph.live.has(`${SCOPE}/legacy-1`)).toBe(true);

      rename("f-contract", "Contract (signed).pdf");
      graph.writes.length = 0;
      await runSync();
      expect(graph.writes).toEqual(["Contract (signed).pdf"]);
      expect(graph.live.has(`${SCOPE}/legacy-1`)).toBe(false);
    });

    it("is retired, not skipped, when it was renamed onto an erased person's name before its key moved", async () => {
      await legacyRow("f-contract", { episodeIds: ["legacy-1"], episodeScopePath: SCOPE });
      graph.live.set(`${SCOPE}/legacy-1`, "Contract.pdf");
      const { recordSuppressions } = await import("@/services/memory/erasure-suppression");
      await recordSuppressions(db, ORG, "erasure-qa-legacy-rename", { emails: [], names: [ERASED], contactIds: [] });
      rename("f-contract", `${ERASED} contract.pdf`);

      await runSync();
      await runSync();

      expect(graph.live.has(`${SCOPE}/legacy-1`)).toBe(false);
      expect(graph.writes.filter((name) => name.includes(ERASED))).toEqual([]);
      expect(await storedFile("f-contract")).toMatchObject({
        episodeIds: [],
        chunkIds: [],
        checksum: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
    });

    it("is synced again when its content changed", async () => {
      await legacyRow("f-contract", { episodeIds: ["legacy-1"], episodeScopePath: SCOPE });
      graph.live.set(`${SCOPE}/legacy-1`, "Contract.pdf");
      editDriveFile(
        drive.files.find((f) => f.id === "f-contract")!,
        pdfBytes(5_000, "contract v2"),
        "2026-10-10T09:00:00.000Z",
      );

      await runSync();

      expect(graph.writes).toContain("Contract.pdf");
      expect(graph.live.has(`${SCOPE}/legacy-1`)).toBe(false);
    });
  });

  it("retires a file renamed onto an erased person's name and writes nothing for it", async () => {
    await runSync();
    const { recordSuppressions } = await import("@/services/memory/erasure-suppression");
    await recordSuppressions(db, ORG, "erasure-qa-rename", { emails: [], names: [ERASED], contactIds: [] });

    rename("f-notes", `${ERASED} review.pdf`);
    graph.writes.length = 0;
    await runSync();

    expect(graph.writes).toEqual([]);
    expect(graph.namesIn(SCOPE)).toEqual(["Contract.pdf", "Spec — v2 (draft)"]);
    expect(await storedFile("f-notes")).toMatchObject({ episodeIds: [], chunkIds: [] });
  });

  // The change key is stored in source_files.checksum, which a person erasure
  // never rewrites. Whatever the key holds about an erased person's file name stays in the
  // database after the erasure, and the erased-name branch writes it again every sync.
  it("stores nothing of an erased person's name in the file's sync record", async () => {
    await runSync();
    const { recordSuppressions } = await import("@/services/memory/erasure-suppression");
    await recordSuppressions(db, ORG, "erasure-qa-rename-residue", { emails: [], names: [ERASED], contactIds: [] });

    rename("f-notes", `${ERASED} review.pdf`);
    await runSync();
    await runSync();

    const residue = await db.$queryRaw<{ externalFileId: string }[]>`
      SELECT f."externalFileId" FROM source_files f
      WHERE f."sourceId" = ${SOURCE_ID} AND f::text ILIKE ${`%${ERASED}%`}
    `;
    expect(residue).toEqual([]);
  });

  // The erased-name branch records the file as seen with
  // nothing written. Renaming the file off that name must sync it again under its new
  // name, a case-only rename must still count as a rename, and at no step may any sync
  // record hold either name: the record is keyed, never named.
  it("syncs a file again when it is renamed off an erased person's name, and keeps no name in any sync record at any step", async () => {
    const anyNamed = (needle: string) => db.$queryRaw<{ externalFileId: string }[]>`
      SELECT f."externalFileId" FROM source_files f
      WHERE f."sourceId" = ${SOURCE_ID} AND f::text ILIKE ${`%${needle}%`}
    `;
    const noNamesStored = async () => {
      for (const needle of [ERASED, "Notes.pdf", "review.pdf", "Contract.pdf", "Spec — v2"]) {
        expect(await anyNamed(needle), needle).toEqual([]);
      }
    };
    await runSync();
    await noNamesStored();
    const { recordSuppressions } = await import("@/services/memory/erasure-suppression");
    await recordSuppressions(db, ORG, "erasure-qa-rename-off", { emails: [], names: [ERASED], contactIds: [] });

    rename("f-notes", `${ERASED} review.pdf`);
    await runSync();
    expect(graph.namesIn(SCOPE)).toEqual(["Contract.pdf", "Spec — v2 (draft)"]);
    await noNamesStored();

    rename("f-notes", "Board review.pdf");
    graph.writes.length = 0;
    await runSync();
    expect(graph.writes).toEqual(["Board review.pdf"]);
    expect(graph.namesIn(SCOPE)).toEqual(["Board review.pdf", "Contract.pdf", "Spec — v2 (draft)"]);
    await noNamesStored();

    // Case only: still a different name, so still a rename.
    rename("f-notes", "board review.pdf");
    graph.writes.length = 0;
    await runSync();
    expect(graph.writes).toEqual(["board review.pdf"]);
    expect(graph.namesIn(SCOPE)).toEqual(["Contract.pdf", "Spec — v2 (draft)", "board review.pdf"]);
    await noNamesStored();

    // Settled: nothing touched, nothing written.
    graph.writes.length = 0;
    await runSync();
    expect(graph.writes).toEqual([]);
  });

  // A file already named after the person when the erasure lands: the erasure itself
  // rewrites no sync record, so the record must not have held the name in the first place.
  it("holds nothing of a person's name in a file's sync record before or after that person is erased", async () => {
    rename("f-notes", `${ERASED} — offer letter.pdf`);
    rename("f-spec", `Notes from ${ERASED.toUpperCase()}`);
    await runSync();
    const residue = () => db.$queryRaw<{ externalFileId: string }[]>`
      SELECT f."externalFileId" FROM source_files f
      WHERE f."sourceId" = ${SOURCE_ID} AND f::text ILIKE ${`%${ERASED}%`}
    `;
    expect(await storedFile("f-notes")).toMatchObject({ checksum: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(await residue()).toEqual([]);

    const { recordSuppressions } = await import("@/services/memory/erasure-suppression");
    await recordSuppressions(db, ORG, "erasure-qa-named-before", { emails: [], names: [ERASED], contactIds: [] });
    expect(await residue()).toEqual([]);

    graph.writes.length = 0;
    await runSync();
    await runSync();
    expect(await residue()).toEqual([]);
    // Unchanged files are skipped: nothing about the person is written back.
    expect(graph.writes).toEqual([]);
  });
});
