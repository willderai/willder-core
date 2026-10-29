// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Connector-item and file-ingest change events, against a real database.
//
// The claims under test, one per `describe`:
//   1. A synced connector item's `SourceFile` upsert and its `create` event commit
//      or roll back together.
//   2. An upstream edit announces the replaced episode as `supersede`, in the scope
//      it was actually removed from, in one transaction with the pointer drop, and
//      without the replacing text, which a reader of only that scope may not read.
//   3. A vanished item's retirement announces `delete` with the pointer drop, and a
//      retry of the same retirement does not announce it again.
//   4. A file ingest announces one `document` event once its stores are written, and
//      nothing when its source moved scope before the write.
//   5. A transient failure after an item's episode is deleted but before the pointer
//      drop commits does not leave the item stuck: the next sync finishes the retirement and
//      announces it exactly once.
//
// A transaction double cannot show any of the atomicity claims: it has no rollback
// to fail. Here the event write is made to fail for real (a scope Postgres could
// never cast to ltree is refused by recordChangeEvent after the SourceFile write has
// already run in the same transaction), and the assertion is on what survived. The
// memory stores are mocked: they are not Postgres, and a real episode id is all the
// events need from them.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never the sandbox's inherited
// DATABASE_URL, which points at live Neon. Skips cleanly without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

vi.mock("@/services/memory", () => ({
  memory: { ingest: vi.fn() },
  graphitiStore: {
    removeEpisode: vi.fn(),
    extractFile: vi.fn(),
    ingestBulk: vi.fn(),
    dedupeNodes: vi.fn(),
  },
  pgvectorStore: { ingest: vi.fn(), ingestAll: vi.fn() },
}));
vi.mock("@/services/enrichment", () => ({ enrich: vi.fn() }));
// The file-ingest job deletes its raw blob once extracted; these files hold no real blob.
vi.mock("@vercel/blob", () => ({ del: async () => undefined }));
vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: vi.fn(),
  recordEpisode: vi.fn(),
}));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-content-change";
const OTHER_ORG = "org-qa-content-change-other";
const SOURCE_ID = "src-qa-content-change";
const SCOPE = "org_qa.eng";
const OLD_SCOPE = "org_qa.eng.old";
/** Passes every TypeScript check and fails Postgres's ltree cast. */
const UNCASTABLE_SCOPE = "org_qa..eng";
/** The connect's own `memory.write` allow row: the authority a sync write happens under,
 * since the sync itself runs no `check()` (app/api/sources/route.ts). */
const CONNECT_ROW = "al-qa-connect-row";

const source = (scopePath = SCOPE) => ({
  id: SOURCE_ID,
  orgId: ORG,
  type: "slack",
  name: "#eng",
  scopePath,
  connectAuthorizationId: CONNECT_ROW,
});

const item = (text: string, checksum = "c1") => ({ id: "msg-1", checksum, text });

type StepCtx = {
  event: { id?: string; data: unknown };
  step: { run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T> };
  runId: string;
};

describe.skipIf(!QA_URL)("connector and file change events against a real database", () => {
  let db: PrismaClient;
  let inngestModule: typeof import("./inngest");
  let stores: typeof import("@/services/memory");

  beforeAll(async () => {
    // Before the import, so the `@/lib/db` singleton it writes through is built
    // against the QA database rather than the inherited DATABASE_URL.
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    inngestModule = await import("./inngest");
    stores = await import("@/services/memory");
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await db.changeEvent.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
    await db.source.deleteMany({ where: { id: SOURCE_ID } });
    await db.source.create({
      data: {
        id: SOURCE_ID,
        orgId: ORG,
        type: "slack",
        externalId: "C-qa",
        name: "#eng",
        scopePath: SCOPE,
        connectAuthorizationId: CONNECT_ROW,
      },
    });
  });

  const events = () => db.changeEvent.findMany({ where: { orgId: ORG }, orderBy: { seq: "asc" } });
  const sourceFile = () =>
    db.sourceFile.findUnique({
      where: { sourceId_externalFileId: { sourceId: SOURCE_ID, externalFileId: "msg-1" } },
    });
  const seedSyncedItem = (episodeScopePath: string) =>
    db.sourceFile.create({
      data: {
        sourceId: SOURCE_ID,
        externalFileId: "msg-1",
        checksum: "c0",
        episodeId: "episode-old",
        episodeScopePath,
      },
    });

  describe("a new connector item", () => {
    it("commits its SourceFile row and one create event for the new episode", async () => {
      vi.mocked(stores.memory.ingest).mockResolvedValue({ episodeId: "episode-new" } as never);

      const outcome = await inngestModule.syncOneTextItem(source(), item("Deploys freeze Friday.\nsecond line"), null);

      expect(outcome).toBe("synced");
      expect(await sourceFile()).toMatchObject({ episodeId: "episode-new", episodeScopePath: SCOPE });
      const recorded = await events();
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({
        recordType: "fact",
        recordId: "episode-new",
        op: "create",
        scopePath: SCOPE,
        actorId: `slack-sync:${SOURCE_ID}`,
        summary: "Deploys freeze Friday.",
        // The sync has no authorization of its own; the connect that put this source in
        // this scope is the one it records, so the write can answer who it happened under.
        authorizedById: CONNECT_ROW,
      });
      expect(await db.changeEvent.count({ where: { orgId: OTHER_ORG } })).toBe(0);
    });

    it("leaves no SourceFile row behind when its event cannot be recorded", async () => {
      vi.mocked(stores.memory.ingest).mockResolvedValue({ episodeId: "episode-new" } as never);

      const outcome = await inngestModule.syncOneTextItem(source(UNCASTABLE_SCOPE), item("text"), null);

      // No row means the next sync plans this item as new and ingests it again,
      // which is the retry that finally announces it.
      expect(outcome).toBe("failed");
      expect(await sourceFile()).toBeNull();
      expect(await events()).toHaveLength(0);
    });
  });

  describe("an item edited upstream", () => {
    it("announces the replaced episode as superseded where it lived, then the new one as created where it lives", async () => {
      await seedSyncedItem(OLD_SCOPE);
      vi.mocked(stores.graphitiStore.removeEpisode).mockResolvedValue({ removed: true });
      vi.mocked(stores.memory.ingest).mockResolvedValue({ episodeId: "episode-new" } as never);

      const outcome = await inngestModule.syncOneTextItem(source(), item("Deploys freeze Thursday.", "c1"), {
        episodeId: "episode-old",
        scopePath: OLD_SCOPE,
      });

      expect(outcome).toBe("synced");
      expect(await sourceFile()).toMatchObject({ checksum: "c1", episodeId: "episode-new", episodeScopePath: SCOPE });
      const recorded = await events();
      expect(recorded.map((e) => [e.op, e.recordId, e.scopePath, e.summary])).toEqual([
        // The source moved from OLD_SCOPE to its parent SCOPE, so a reader of
        // OLD_SCOPE alone cannot read the new text: the supersede must not carry it.
        ["supersede", "episode-old", OLD_SCOPE, ""],
        ["create", "episode-new", SCOPE, "Deploys freeze Thursday."],
      ]);
    });

    it("keeps the pointer to the old episode when its supersede cannot be recorded", async () => {
      await seedSyncedItem(UNCASTABLE_SCOPE);
      vi.mocked(stores.graphitiStore.removeEpisode).mockResolvedValue({ removed: true });

      const outcome = await inngestModule.syncOneTextItem(source(), item("Deploys freeze Thursday."), {
        episodeId: "episode-old",
        scopePath: UNCASTABLE_SCOPE,
      });

      expect(outcome).toBe("failed");
      expect(await sourceFile()).toMatchObject({ checksum: "c0", episodeId: "episode-old" });
      expect(stores.memory.ingest).not.toHaveBeenCalled();
      expect(await events()).toHaveLength(0);
    });

    it("announces nothing when the store did not remove the old episode", async () => {
      await seedSyncedItem(OLD_SCOPE);
      vi.mocked(stores.graphitiStore.removeEpisode).mockResolvedValue({ removed: false });

      const outcome = await inngestModule.syncOneTextItem(source(), item("Deploys freeze Thursday."), {
        episodeId: "episode-old",
        scopePath: OLD_SCOPE,
      });

      expect(outcome).toBe("failed");
      expect(await events()).toHaveLength(0);
    });
  });

  describe("an item that vanished upstream", () => {
    it("announces a delete in the scope it was removed from and drops the row", async () => {
      await seedSyncedItem(OLD_SCOPE);
      vi.mocked(stores.graphitiStore.removeEpisode).mockResolvedValue({ removed: true });

      const outcome = await inngestModule.retireVanishedTextItem(source(), {
        externalFileId: "msg-1",
        checksum: "c0",
        episodeId: "episode-old",
        episodeScopePath: OLD_SCOPE,
      });

      expect(outcome).toBe("retired");
      expect(await sourceFile()).toBeNull();
      const recorded = await events();
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({
        recordType: "fact",
        recordId: "episode-old",
        op: "delete",
        scopePath: OLD_SCOPE,
        actorId: `slack-sync:${SOURCE_ID}`,
        summary: "",
      });
    });

    it("keeps the row and its episode pointer when the delete cannot be recorded", async () => {
      await seedSyncedItem(UNCASTABLE_SCOPE);
      vi.mocked(stores.graphitiStore.removeEpisode).mockResolvedValue({ removed: true });

      const outcome = await inngestModule.retireVanishedTextItem(source(), {
        externalFileId: "msg-1",
        checksum: "c0",
        episodeId: "episode-old",
        episodeScopePath: UNCASTABLE_SCOPE,
      });

      expect(outcome).toBe("failed");
      expect(await sourceFile()).toMatchObject({ episodeId: "episode-old" });
      expect(await events()).toHaveLength(0);
    });

    it("does not announce the delete again when a retry finds the pointer already dropped", async () => {
      await seedSyncedItem(OLD_SCOPE);
      vi.mocked(stores.graphitiStore.removeEpisode).mockResolvedValue({ removed: true });
      // The first attempt dies after its transaction commits, before the row delete.
      const rowDelete = vi.spyOn((await import("@/lib/db")).db.sourceFile, "delete");
      rowDelete.mockRejectedValueOnce(new Error("connection lost"));

      const first = await inngestModule.retireVanishedTextItem(source(), {
        externalFileId: "msg-1",
        checksum: "c0",
        episodeId: "episode-old",
        episodeScopePath: OLD_SCOPE,
      });
      rowDelete.mockRestore();
      const stored = await sourceFile();
      const retry = await inngestModule.retireVanishedTextItem(source(), {
        externalFileId: "msg-1",
        checksum: stored!.checksum,
        episodeId: stored!.episodeId,
        episodeScopePath: stored!.episodeScopePath,
      });

      expect([first, retry]).toEqual(["failed", "retired"]);
      expect(await sourceFile()).toBeNull();
      expect((await events()).map((e) => e.op)).toEqual(["delete"]);
    });
  });

  describe("a transient failure between the episode delete and the pointer drop", () => {
    // The graph delete lands, then the transaction that records it fails once.
    // The episode is gone from then on, so the store answers not-found.
    const deleteThenFailRecordOnce = async () => {
      vi.mocked(stores.graphitiStore.removeEpisode)
        .mockResolvedValueOnce({ removed: true })
        .mockResolvedValue({ removed: false });
      const { db: appDb } = await import("@/lib/db");
      return vi.spyOn(appDb, "$transaction").mockRejectedValueOnce(new Error("connection lost"));
    };
    // What the next sync would plan from, read fresh as `load-existing-files` does.
    const plannedFromStore = async (items: { id: string; checksum: string }[]) => {
      const row = await sourceFile();
      return inngestModule.planConnectorSync(row ? [row] : [], items, SCOPE);
    };

    it("lets the next sync of an edited item finish, announcing the supersede once", async () => {
      await seedSyncedItem(OLD_SCOPE);
      vi.mocked(stores.memory.ingest).mockResolvedValue({ episodeId: "episode-new" } as never);
      const recordFails = await deleteThenFailRecordOnce();
      const edited = item("Deploys freeze Thursday.", "c1");

      const first = await inngestModule.syncOneTextItem(source(), edited, {
        episodeId: "episode-old",
        scopePath: OLD_SCOPE,
      });
      recordFails.mockRestore();
      const [planned] = (await plannedFromStore([edited])).toIngest;
      const retry = await inngestModule.syncOneTextItem(source(), edited, planned.previousEpisode);

      expect([first, retry]).toEqual(["failed", "synced"]);
      expect(await sourceFile()).toMatchObject({
        checksum: "c1",
        episodeId: "episode-new",
        episodeScopePath: SCOPE,
        episodeRetireStartedAt: null,
      });
      expect((await events()).map((e) => [e.op, e.recordId])).toEqual([
        ["supersede", "episode-old"],
        ["create", "episode-new"],
      ]);
    });

    it("lets the next sync of a vanished item finish, announcing the delete once", async () => {
      await seedSyncedItem(OLD_SCOPE);
      const recordFails = await deleteThenFailRecordOnce();

      const first = await inngestModule.retireVanishedTextItem(source(), {
        externalFileId: "msg-1",
        checksum: "c0",
        episodeId: "episode-old",
        episodeScopePath: OLD_SCOPE,
      });
      recordFails.mockRestore();
      const [stale] = (await plannedFromStore([])).toRetire;
      const retry = await inngestModule.retireVanishedTextItem(source(), stale);

      expect([first, retry]).toEqual(["failed", "retired"]);
      expect(await sourceFile()).toBeNull();
      expect((await events()).map((e) => [e.op, e.recordId])).toEqual([["delete", "episode-old"]]);
    });

    it("still fails a retry when the first attempt's own delete found nothing", async () => {
      await seedSyncedItem(OLD_SCOPE);
      vi.mocked(stores.graphitiStore.removeEpisode).mockResolvedValue({ removed: false });
      const vanished = {
        externalFileId: "msg-1",
        checksum: "c0",
        episodeId: "episode-old",
        episodeScopePath: OLD_SCOPE,
      };

      const first = await inngestModule.retireVanishedTextItem(source(), vanished);
      const retry = await inngestModule.retireVanishedTextItem(source(), vanished);

      expect([first, retry]).toEqual(["failed", "failed"]);
      expect(await sourceFile()).toMatchObject({ episodeId: "episode-old", episodeRetireStartedAt: null });
      expect(await events()).toHaveLength(0);
    });

    it("still fails a retry for a legacy row, whose not-found cannot be attributed", async () => {
      await db.sourceFile.create({
        data: {
          sourceId: SOURCE_ID,
          externalFileId: "msg-1",
          checksum: "c0",
          episodeId: "episode-old",
          episodeScopePath: null,
          episodeRetireStartedAt: new Date(),
        },
      });
      vi.mocked(stores.graphitiStore.removeEpisode).mockResolvedValue({ removed: false });

      const retry = await inngestModule.retireVanishedTextItem(source(), {
        externalFileId: "msg-1",
        checksum: "c0",
        episodeId: "episode-old",
        episodeScopePath: null,
      });

      expect(retry).toBe("failed");
      expect(await sourceFile()).toMatchObject({ episodeId: "episode-old" });
      expect(await events()).toHaveLength(0);
    });
  });

  describe("a file ingest", () => {
    const runIngest = (data: Record<string, unknown>, eventId = "job-1") => {
      const ctx: StepCtx = {
        event: { id: eventId, data },
        step: { run: async (_name, fn) => fn() },
        runId: "run-1",
      };
      return (inngestModule.fileIngest as unknown as { fn: (ctx: StepCtx) => Promise<unknown> }).fn(ctx);
    };

    beforeEach(() => {
      vi.mocked(stores.graphitiStore.extractFile).mockResolvedValue({ chunks: ["page one", "page two"] } as never);
    });

    it("announces one document event under the job's event id once both stores hold it", async () => {
      await runIngest({
        groupId: ORG,
        blobUrl: "https://blob.test/f",
        filename: "Q3 plan.pdf",
        fileType: "pdf",
        actorId: "user-1",
        scopePath: SCOPE,
      });

      const recorded = await events();
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({
        recordType: "document",
        recordId: "job-1",
        op: "create",
        scopePath: SCOPE,
        actorId: "user-1",
        summary: "Q3 plan.pdf",
      });
    });

    it("announces a Drive file under its source's scope and sync actor", async () => {
      await runIngest({
        groupId: ORG,
        blobUrl: "https://blob.test/f",
        filename: "Roadmap.docx",
        fileType: "docx",
        actorType: "extraction",
        actorId: `gdrive-sync:${SOURCE_ID}`,
        scopePath: SCOPE,
        sourceId: SOURCE_ID,
      });

      const [event] = await events();
      expect(event).toMatchObject({ recordId: "job-1", scopePath: SCOPE, actorId: `gdrive-sync:${SOURCE_ID}` });
    });

    it("announces nothing when the source moved scope before the write", async () => {
      await runIngest({
        groupId: ORG,
        blobUrl: "https://blob.test/f",
        filename: "Roadmap.docx",
        fileType: "docx",
        actorType: "extraction",
        actorId: `gdrive-sync:${SOURCE_ID}`,
        scopePath: OLD_SCOPE,
        sourceId: SOURCE_ID,
      });

      expect(stores.pgvectorStore.ingestAll).not.toHaveBeenCalled();
      expect(await events()).toHaveLength(0);
    });
  });
});
