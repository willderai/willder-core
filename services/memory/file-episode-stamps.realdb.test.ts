// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test Postgres;
// without it every test in this file is skipped, not failed.
//
// The backfill for file episodes written before each passage's chunk id was stamped on
// its graph episode (services/memory/file-episode-stamps.ts). Real: Postgres, the passages,
// the upload records and the change feed. Double: the memory service's three routes
// (`/episodes/unstamped-files`, `/episodes/stamp-chunk`, `DELETE /chunks`), which keep what
// memory-service/tests/test_unstamped_file_episodes_integration.py checks on Neo4j: it lists
// only unstamped document episodes with no source, by salted digests of their text and
// filename; it stamps only such an episode; and the chunk retirement removes the episodes
// stamped with one id.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { FileEpisodeGraph } from "./file-episode-stamps";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;
const DIMENSIONS = 384;
const ORG = "w3cstamps";
const ROOT = `org_${ORG}`;
const HB = `${ROOT}.hb`;
const OTHER_ORG = "w3cstamps2";
const OWNER = "u-w3cstamps-owner";
const DECISION = "approval-w3c-backfill-20261024";

interface Episode {
  groupId: string;
  name: string;
  content: string;
  source: string;
  sourceId?: string;
  chunkId?: string;
}

const digest = (salt: string, value: string) => createHash("sha256").update(`${salt}:${value}`, "utf8").digest("hex");

/** The memory service's graph, as its three routes see it. `beforeList` runs before each page is read. */
function fakeGraph() {
  const episodes = new Map<string, Episode>();
  const knobs: { beforeList?: (call: number) => Promise<void> } = {};
  let lists = 0;
  const unstampedFile = (e: Episode) =>
    e.source === "document" && !e.sourceId && (!e.chunkId || e.chunkId.startsWith("w3c-orphan:"));
  const graph: FileEpisodeGraph & { calls: string[] } = {
    calls: [],
    async listUnstampedFileEpisodes({ groupId, salt, after, limit }) {
      graph.calls.push("list");
      await knobs.beforeList?.(++lists);
      const page = [...episodes]
        .filter(([uuid, e]) => e.groupId === groupId && (!after || uuid > after))
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(0, limit);
      return {
        episodes: page
          .filter(([, e]) => unstampedFile(e))
          .map(([uuid, e]) => ({
            uuid,
            contentDigest: digest(salt, e.content),
            fileNameDigest: digest(salt, /^(.*) \(part \d+\/\d+\)$/.exec(e.name)?.[1] ?? e.name),
            pendingRetirement: Boolean(e.chunkId),
          })),
        scanned: page.length,
        nextAfter: page.length === limit ? page.at(-1)![0] : null,
      };
    },
    async stampEpisodeChunk({ groupId, episodeUuid, chunkId }) {
      graph.calls.push(`stamp ${episodeUuid}`);
      const e = episodes.get(episodeUuid);
      if (!e || e.groupId !== groupId) return "missing";
      if (e.chunkId === chunkId) return "already";
      if (!unstampedFile(e)) return "refused";
      e.chunkId = chunkId;
      return "stamped";
    },
    async removeChunkFacts({ groupId, chunkId }) {
      graph.calls.push(`retire ${chunkId}`);
      for (const [uuid, e] of episodes) if (e.groupId === groupId && e.chunkId === chunkId) episodes.delete(uuid);
    },
  };
  return { graph, episodes, knobs };
}

describe.skipIf(!QA_URL)("old file episodes are stamped with their passage or retired with it", () => {
  let db: PrismaClient;
  let backfill: (typeof import("./file-episode-stamps"))["backfillFileEpisodeStamps"];
  let pgvectorStore: (typeof import("./pgvector-store"))["pgvectorStore"];
  let recordDocumentIngested: (typeof import("./content-change-event"))["recordDocumentIngested"];
  let recordDocumentRemoved: (typeof import("./content-change-event"))["recordDocumentRemoved"];
  let fake: ReturnType<typeof fakeGraph>;
  const ids: Record<string, string> = {};

  async function wipe(): Promise<void> {
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.changeEvent.deleteMany({ where: { orgId } });
      await db.memoryChunk.deleteMany({ where: { orgId } });
      await db.uploadedFile.deleteMany({ where: { orgId } });
      await db.auditLog.deleteMany({ where: { orgId } });
      await db.scope.deleteMany({ where: { orgId } });
      await deleteOrgsWithRetry(db, { where: { id: orgId } });
    }
  }

  const passage = async (content: string, uploadId: string | null) => {
    const [id] = await pgvectorStore.ingestAll([
      {
        groupId: ORG,
        content,
        source: "document",
        scopePath: HB,
        actorType: "human",
        actorId: OWNER,
        origin: "app",
        uploadId: uploadId ?? undefined,
      },
    ]);
    return id!;
  };
  const upload = (filename: string, removed = false) =>
    db.uploadedFile.create({
      data: {
        orgId: ORG,
        scopePath: HB,
        filename,
        fileType: "pdf",
        blobUrl: `https://blob.test/${filename}-${Math.random()}`,
        actorId: OWNER,
        removedAt: removed ? new Date() : null,
      },
    });
  const announce = (filename: string) =>
    recordDocumentIngested(
      { orgId: ORG, scopePath: HB, actorId: OWNER, actorType: "human", origin: "app", filename },
      `doc-${filename}`,
    );
  /** The `delete` event removeUpload writes for the document announced as `doc-<filename>`. */
  const announceRemoved = (filename: string) =>
    db.$transaction((tx) =>
      recordDocumentRemoved(tx, {
        orgId: ORG,
        scopePath: HB,
        documentId: `doc-${filename}`,
        actorId: OWNER,
        actorType: "human",
        origin: "app",
      }),
    );
  const writeTrail = async () => ({
    events: await db.changeEvent.count({ where: { orgId: ORG } }),
    audit: await db.auditLog.count({ where: { orgId: ORG } }),
    chunks: await db.memoryChunk.count({ where: { orgId: ORG } }),
  });
  const graphState = () => JSON.stringify([...fake.episodes].sort());

  beforeAll(async () => {
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ embedding: new Array(DIMENSIONS).fill(0.01) }))),
    );
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ backfillFileEpisodeStamps: backfill } = await import("./file-episode-stamps"));
    ({ pgvectorStore } = await import("./pgvector-store"));
    ({ recordDocumentIngested, recordDocumentRemoved } = await import("./content-change-event"));
  }, 60_000);

  afterAll(async () => {
    if (db) {
      await wipe();
      await db.$disconnect();
    }
    vi.unstubAllGlobals();
  });

  beforeEach(async () => {
    await wipe();
    fake = fakeGraph();
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    await db.scope.create({ data: { orgId: ORG, path: HB, name: "hb" } });
    await db.org.create({ data: { id: OTHER_ORG, name: OTHER_ORG } });

    // A kept upload whose one passage is stored.
    const keep = await upload("keep.pdf");
    await announce("keep.pdf");
    ids.keep = await passage("Travel needs approval.", keep.id);
    // A kept upload from an older version: its passage is filed under the filename, as a version.
    const legacy = await upload("legacy.pdf");
    await announce("legacy.pdf");
    ids.legacy = await passage("Expenses close on the 5th.", legacy.id);
    await db.memoryChunk.update({ where: { id: ids.legacy }, data: { entityName: "legacy.pdf", factVersion: true } });
    // A kept upload one of whose two passages is gone (an erasure, or a fact delete).
    const renewals = await upload("renewals.pdf");
    await announce("renewals.pdf");
    ids.renewalDate = await passage("Renewal date is March.", renewals.id);
    // An upload removed before stamping: its record is gone; the feed has its create and its delete.
    await announce("gone.pdf");
    await announceRemoved("gone.pdf");
    // A file announced and never removed, with no record (the inline path): no evidence it went.
    await announce("inline.pdf");
    // Episodes, as ingest wrote them before stamping: no chunk stamp.
    const old = (name: string, content: string, extra: Partial<Episode> = {}): Episode => ({
      groupId: HB,
      name,
      content,
      source: "document",
      ...extra,
    });
    fake.episodes.set("ep-1", old("keep.pdf", "Travel needs approval."));
    fake.episodes.set("ep-2", old("renewals.pdf (part 1/2)", "Renewal owner is Dana Whitfield."));
    fake.episodes.set("ep-3", old("renewals.pdf (part 2/2)", "Renewal date is March."));
    fake.episodes.set("ep-4", old("gone.pdf", "Q3 targets: 40 logos."));
    fake.episodes.set("ep-5", old("episode:u-w3cstamps-owner", "Acme renews in March."));
    fake.episodes.set("ep-9", old("legacy.pdf", "Expenses close on the 5th."));
    fake.episodes.set("ep-a", old("inline.pdf", "Q4 targets: 55 logos."));
    // Not listed: stamped by ingest, a Drive passage, a message.
    fake.episodes.set("ep-6", old("keep.pdf", "Travel needs approval.", { chunkId: ids.keep }));
    fake.episodes.set("ep-7", old("handbook.pdf", "Leave is 20 days.", { sourceId: "src-drive" }));
    fake.episodes.set("ep-8", old("keep.pdf", "Travel needs approval.", { source: "message" }));
  });

  const apply = (extra: Record<string, unknown> = {}) =>
    backfill(db, fake.graph, { apply: true, decisionId: DECISION, orgId: ORG, ...extra });

  it("a dry run counts what it would do and writes nothing, in the graph or in Postgres", async () => {
    const before = { graph: graphState(), trail: await writeTrail() };

    const summary = await backfill(db, fake.graph, { apply: false, orgId: ORG });

    expect(summary).toMatchObject({
      apply: false,
      decisionId: null,
      orgs: 1,
      partitions: 3,
      listed: 7,
      toStamp: 3,
      orphansOfRemovedFiles: 1,
      orphansPending: 0,
      unplacedKeptFile: 2,
      unplacedUnknownFile: 1,
      stamped: 0,
      retired: 0,
      skipped: 0,
    });
    expect(fake.graph.calls.every((c) => c === "list")).toBe(true);
    expect(graphState()).toBe(before.graph);
    expect(await writeTrail()).toEqual(before.trail);
  });

  it("keeps and stamps the episode of an older upload's passage, filed under its filename as a version", async () => {
    const summary = await apply();

    expect(fake.episodes.get("ep-9")?.chunkId).toBe(ids.legacy);
    expect(summary.retired).toBe(1);
  });

  it("retires only an episode whose file the feed records as removed; a kept file's missing passage is left", async () => {
    await apply();

    expect(fake.episodes.has("ep-4")).toBe(false);
    // No row holds its text, but its upload is kept: not evidence enough to retire.
    expect(fake.episodes.get("ep-2")?.chunkId).toBeUndefined();
    // Announced and never removed: left.
    expect(fake.episodes.get("ep-a")?.chunkId).toBeUndefined();
  });

  it("a removal of one of two documents under the same name is not evidence: the other is still there", async () => {
    await recordDocumentIngested(
      { orgId: ORG, scopePath: HB, actorId: OWNER, actorType: "human", origin: "app", filename: "gone.pdf" },
      "doc-gone-again",
    );

    const summary = await apply();

    expect(fake.episodes.has("ep-4")).toBe(true);
    expect(summary).toMatchObject({ orphansOfRemovedFiles: 0, retired: 0 });
  });

  it("the summary and the log carry counts and org ids only, never memory text or a filename", async () => {
    const lines: string[] = [];
    const summary = await apply({ log: (l: string) => lines.push(l) });

    const printed = JSON.stringify(summary) + lines.join("\n");
    for (const text of ["Travel", "Renewal", "Dana", "logos", "Acme", "Expenses", ".pdf"])
      expect(printed).not.toContain(text);
  });

  it("refuses an applied run without a recorded approval, and changes nothing", async () => {
    const before = graphState();

    await expect(backfill(db, fake.graph, { apply: true, orgId: ORG })).rejects.toThrow(/--decision/);
    await expect(backfill(db, fake.graph, { apply: true, decisionId: "yes", orgId: ORG })).rejects.toThrow(
      /--decision/,
    );

    expect(fake.graph.calls).toEqual([]);
    expect(graphState()).toBe(before);
  });

  it("stamps each episode a stored row holds, retires the removed file's, leaves the rest, and writes nothing in Postgres", async () => {
    const trail = await writeTrail();

    const summary = await apply();

    expect(summary).toMatchObject({
      apply: true,
      decisionId: DECISION,
      toStamp: 3,
      stamped: 3,
      retired: 1,
      skipped: 0,
    });
    expect(fake.episodes.get("ep-1")?.chunkId).toBe(ids.keep);
    expect(fake.episodes.get("ep-3")?.chunkId).toBe(ids.renewalDate);
    expect([...fake.episodes.keys()].sort()).toEqual([
      "ep-1",
      "ep-2",
      "ep-3",
      "ep-5",
      "ep-6",
      "ep-7",
      "ep-8",
      "ep-9",
      "ep-a",
    ]);
    // No change event, audit row or memory row: nothing a reader sees as current changed.
    expect(await writeTrail()).toEqual(trail);

    // Stamped, an old episode now goes with its row, as a new one does.
    await fake.graph.removeChunkFacts({ groupId: HB, chunkId: ids.keep });
    expect(fake.episodes.has("ep-1")).toBe(false);
  });

  it("a second run is a no-op: nothing stamped, nothing retired, the graph unchanged", async () => {
    await apply();
    const after = graphState();
    fake.graph.calls.length = 0;

    const second = await apply();

    expect(second).toMatchObject({
      listed: 3,
      toStamp: 0,
      stamped: 0,
      retired: 0,
      orphansOfRemovedFiles: 0,
      unplacedKeptFile: 2,
      unplacedUnknownFile: 1,
    });
    expect(fake.graph.calls.every((c) => c === "list")).toBe(true);
    expect(graphState()).toBe(after);
  });

  it("an orphan marked by a run whose retirement failed is retired by the next run", async () => {
    const retire = fake.graph.removeChunkFacts.bind(fake.graph);
    fake.graph.removeChunkFacts = async () => {
      throw new Error("memory service unavailable");
    };
    await expect(apply()).rejects.toThrow(/unavailable/);
    fake.graph.removeChunkFacts = retire;

    const next = await apply();

    expect(next).toMatchObject({ orphansPending: 1, retired: 1 });
    expect(fake.episodes.has("ep-4")).toBe(false);
  });

  it("a row deleted after the run read it leaves its episode as it is: never stamped, never retired", async () => {
    // One episode per page: the rows are read with the first page in the partition (ep-1),
    // and ep-3's row is deleted before the page that lists it (ep-1, ep-2, ep-3, ...).
    fake.knobs.beforeList = async (call) => {
      if (call === 5) await db.memoryChunk.deleteMany({ where: { id: ids.renewalDate } });
    };

    const summary = await apply({ pageSize: 1 });

    expect(fake.episodes.get("ep-3")).toMatchObject({ name: "renewals.pdf (part 2/2)" });
    expect(fake.episodes.get("ep-3")?.chunkId).toBeUndefined();
    expect(summary).toMatchObject({ stamped: 2, skipped: 1 });
  });

  it("touches only the org it is given", async () => {
    await db.scope.create({ data: { orgId: OTHER_ORG, path: `org_${OTHER_ORG}`, name: "root" } });
    fake.episodes.set("ep-other", {
      groupId: `org_${OTHER_ORG}`,
      name: "gone.pdf",
      content: "Q3 targets: 40 logos.",
      source: "document",
    });

    await apply();

    expect(fake.episodes.get("ep-other")?.chunkId).toBeUndefined();
    expect(fake.graph.calls.some((c) => c.includes("ep-other"))).toBe(false);
  });
});
