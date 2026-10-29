// The backfill for file episodes written before file passages were stamped. An operator
// runs it through scripts/backfill-file-episode-stamps.ts.
//
// Every graph episode a write creates now carries the `memory_chunks` id of the row it was
// extracted from (`chunk_id`). That stamp is how deleting the row, removing its upload or
// erasing a person retires what the graph extracted from it (`removeChunkFacts`). An
// uploaded file's passages were once written to the graph without it. Their episodes
// therefore outlive the passage: an upload removed back then still has readable graph facts,
// and a kept upload's episodes would outlive its removal.
//
// The rule it enforces: nothing is retired without positive evidence that it is orphaned.
// For each unstamped file episode:
//  - **stamp:** its text is a stored row's, in the same partition, whatever the row is filed
//    under (older uploads filed their passages under the filename). It gets that
//    row's id, as ingest would have stamped it, and from then on goes when that row goes.
//  - **retire:** the org's change feed records the file it is named for as removed, in its
//    scope: every `create` of a document with that name there has its `delete`, and no kept
//    upload there carries the name. It gets an orphan stamp and is retired through the same
//    chunk retirement a deleted fact's episodes go through.
//  - **leave, and count:** anything else. That includes a kept file whose passage is missing
//    (erased with a person, deleted as a fact, or stored under text the run cannot match): a
//    missing row is not evidence. It also includes a file the feed does not record as removed.
//
// Nothing the service lists is memory text or a name: each episode is named by digests of its
// text and filename, salted with a random value made for this run, so the digests mean
// nothing outside it; this side salts the stored rows and filenames the same way to compare.
// The summary carries counts only. A dry run reads and writes nothing. An applied run writes
// only graph stamps and retirements: no change event, notice or audit row, since nothing a
// reader sees as current changes. A row is checked again just before its id is stamped, and
// one deleted meanwhile leaves its episode as it is. Every write is conditional and
// idempotent: a stamped episode is no longer listed, an orphan whose retirement failed is
// listed as pending and retired by the next run, and a second run writes nothing.
import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import type { EpisodeStampOutcome, UnstampedFileEpisodePage } from "./graphiti-store";
import type { RemoveChunkFactsResult } from "@/types/memory";

/** The stamp an orphan gets so the chunk retirement takes it; the memory service lists such an episode as pending. */
const ORPHAN_CHUNK_PREFIX = "w3c-orphan:";

/**
 * The id of the recorded operator approval for an applied run (`approval-<slug>-<yyyymmdd>`,
 * the approval log's id format).
 */
const DECISION_ID = /^approval-[a-z0-9]+(?:-[a-z0-9]+)*-\d{8}[a-z]?$/;

/** The graph calls the backfill makes (GraphitiMemoryStore). */
export interface FileEpisodeGraph {
  listUnstampedFileEpisodes(input: {
    groupId: string;
    salt: string;
    after?: string;
    limit: number;
  }): Promise<UnstampedFileEpisodePage>;
  stampEpisodeChunk(input: { groupId: string; episodeUuid: string; chunkId: string }): Promise<EpisodeStampOutcome>;
  removeChunkFacts(input: { groupId: string; chunkId: string }): Promise<RemoveChunkFactsResult | void>;
}

export interface FileEpisodeStampOptions {
  /** Write stamps and retire orphans. Without it the run only counts. */
  apply: boolean;
  /** Required with `apply`: the id of the recorded operator approval that allowed the run. */
  decisionId?: string;
  /** Limit the run to one org (internal Org.id). */
  orgId?: string;
  /** Episodes read per memory-service page. */
  pageSize?: number;
  /** The run's digest salt; a fresh random one by default. */
  salt?: string;
  log?: (line: string) => void;
}

interface FileEpisodeStampCounts {
  /** Unstamped file episodes listed. */
  listed: number;
  /** Episodes whose text a stored row in the partition holds: stamped, or that a dry run would stamp. */
  toStamp: number;
  /** Orphans of a file the change feed records as removed from its scope: retired, or that a dry run would retire. */
  orphansOfRemovedFiles: number;
  /** Orphans an earlier run marked and did not get to retire. */
  orphansPending: number;
  /** Left as they are: their file is still kept or announced, but no stored row holds their text. */
  unplacedKeptFile: number;
  /** Left as they are: nothing in the org records their file as removed. */
  unplacedUnknownFile: number;
  /** Writes made (always 0 on a dry run). */
  stamped: number;
  retired: number;
  /** Stamps the memory service refused or found gone, and stamps whose row went first: left as they are. */
  skipped: number;
}

export interface FileEpisodeStampSummary extends FileEpisodeStampCounts {
  apply: boolean;
  decisionId: string | null;
  orgs: number;
  partitions: number;
}

const ZERO: FileEpisodeStampCounts = {
  listed: 0,
  toStamp: 0,
  orphansOfRemovedFiles: 0,
  orphansPending: 0,
  unplacedKeptFile: 0,
  unplacedUnknownFile: 0,
  stamped: 0,
  retired: 0,
  skipped: 0,
};

/** Refuse an applied run without a recorded operator approval. */
export function assertMayApply(options: Pick<FileEpisodeStampOptions, "apply" | "decisionId">): void {
  if (!options.apply) return;
  if (!options.decisionId || !DECISION_ID.test(options.decisionId)) {
    throw new Error(
      "--apply needs --decision <approval id>, such as approval-w3c-backfill-20261024: the recorded operator approval for this run",
    );
  }
}

/** The digest the memory service gives a value: SHA-256 of `salt + ":" + value`, as hex. */
function saltedDigest(salt: string, value: string): string {
  return createHash("sha256").update(`${salt}:${value}`, "utf8").digest("hex");
}

/** One graph partition of an org: a scope path, or the bare org id for untagged rows. */
interface Partition {
  /** What ingest passed as the group: the scope path, or the org id. */
  groupId: string;
  /** The scope its rows and files carry; null for the bare org. */
  scopePath: string | null;
}

/** What one scope's records say of its files, as salted digests of their names. */
interface ScopeFiles {
  /** Files still there: a kept upload's name, or a document announced and never removed. */
  live: Set<string>;
  /** Files the feed records as removed: every document announced under the name was removed. */
  removed: Set<string>;
}

export async function backfillFileEpisodeStamps(
  db: PrismaClient,
  graph: FileEpisodeGraph,
  options: FileEpisodeStampOptions,
): Promise<FileEpisodeStampSummary> {
  assertMayApply(options);
  const log = options.log ?? (() => {});
  const pageSize = options.pageSize ?? 200;
  const salt = options.salt ?? randomBytes(16).toString("hex");
  const orgs = await db.org.findMany({
    where: options.orgId ? { id: options.orgId } : {},
    select: { id: true },
    orderBy: { id: "asc" },
  });
  const total: FileEpisodeStampCounts = { ...ZERO };
  let partitions = 0;
  for (const { id: orgId } of orgs) {
    const counts: FileEpisodeStampCounts = { ...ZERO };
    const files = await filesByScope(db, orgId, salt);
    for (const partition of await partitionsOf(db, orgId)) {
      partitions++;
      const scopeFiles = (partition.scopePath && files.get(partition.scopePath)) || {
        live: new Set<string>(),
        removed: new Set<string>(),
      };
      await backfillPartition(db, graph, orgId, partition, scopeFiles, counts, {
        apply: options.apply,
        pageSize,
        salt,
      });
    }
    if (counts.listed > 0) log(`[file-episode-stamps] org ${orgId}: ${JSON.stringify(counts)}`);
    for (const key of Object.keys(total) as (keyof FileEpisodeStampCounts)[]) total[key] += counts[key];
  }
  return {
    apply: options.apply,
    decisionId: options.apply ? options.decisionId! : null,
    orgs: orgs.length,
    partitions,
    ...total,
  };
}

async function partitionsOf(db: PrismaClient, orgId: string): Promise<Partition[]> {
  const scopes = await db.scope.findMany({ where: { orgId }, select: { path: true }, orderBy: { path: "asc" } });
  return [{ groupId: orgId, scopePath: null }, ...scopes.map((s) => ({ groupId: s.path, scopePath: s.path }))];
}

/**
 * Each scope's files, by the salted digest of their names. A document's `create` event is
 * titled by its filename (its summary, services/memory/change-events.ts); its `delete` event,
 * written by `removeUpload`, carries the same record id. A summary that is not the filename
 * itself (cut short, or blanked by an erasure) matches no episode's name, so that file is
 * never evidence of anything.
 */
async function filesByScope(db: PrismaClient, orgId: string, salt: string): Promise<Map<string, ScopeFiles>> {
  const events = await db.changeEvent.findMany({
    where: { orgId, recordType: "document", op: { in: ["create", "delete"] } },
    select: { scopePath: true, recordId: true, op: true, summary: true },
  });
  const kept = await db.uploadedFile.findMany({
    where: { orgId, removedAt: null },
    select: { scopePath: true, filename: true },
  });
  const deletedIds = new Set(events.filter((e) => e.op === "delete").map((e) => `${e.scopePath}\u0000${e.recordId}`));
  const byScope = new Map<string, ScopeFiles>();
  const scope = (path: string) => {
    let files = byScope.get(path);
    if (!files) byScope.set(path, (files = { live: new Set(), removed: new Set() }));
    return files;
  };
  for (const e of events) {
    if (e.op !== "create" || e.summary === "") continue;
    const digest = saltedDigest(salt, e.summary);
    if (deletedIds.has(`${e.scopePath}\u0000${e.recordId}`)) scope(e.scopePath).removed.add(digest);
    else scope(e.scopePath).live.add(digest);
  }
  for (const upload of kept) scope(upload.scopePath).live.add(saltedDigest(salt, upload.filename));
  // A name with a document still there is live, whatever else was removed under it.
  for (const files of byScope.values()) for (const digest of files.live) files.removed.delete(digest);
  return byScope;
}

async function backfillPartition(
  db: PrismaClient,
  graph: FileEpisodeGraph,
  orgId: string,
  partition: Partition,
  files: ScopeFiles,
  counts: FileEpisodeStampCounts,
  { apply, pageSize, salt }: { apply: boolean; pageSize: number; salt: string },
): Promise<void> {
  // Orphans are marked and retired once the partition is read, so every page is read from
  // the partition as it stood.
  const orphans: string[] = [];
  let rows: Map<string, string> | null = null;
  let after: string | undefined;
  do {
    const page = await graph.listUnstampedFileEpisodes({ groupId: partition.groupId, salt, after, limit: pageSize });
    for (const episode of page.episodes) {
      counts.listed++;
      if (episode.pendingRetirement) {
        counts.orphansPending++;
        orphans.push(episode.uuid);
        continue;
      }
      rows ??= await storedRowsByDigest(db, orgId, partition.scopePath, salt);
      const rowId = rows.get(episode.contentDigest);
      if (rowId) {
        counts.toStamp++;
        if (!apply) continue;
        // Checked again just before the stamp: a row deleted since it was read leaves its
        // episode as it is, never stamped with an id no row holds, and never retired either.
        if (await rowStored(db, orgId, rowId)) await stamp(graph, partition, episode.uuid, rowId, counts);
        else counts.skipped++;
        continue;
      }
      if (files.removed.has(episode.fileNameDigest)) {
        counts.orphansOfRemovedFiles++;
        orphans.push(episode.uuid);
      } else if (files.live.has(episode.fileNameDigest)) {
        counts.unplacedKeptFile++;
      } else {
        counts.unplacedUnknownFile++;
      }
    }
    after = page.nextAfter ?? undefined;
  } while (after);

  if (!apply) return;
  for (const uuid of orphans) {
    const mark = `${ORPHAN_CHUNK_PREFIX}${uuid}`;
    if (!(await stamp(graph, partition, uuid, mark, counts))) continue;
    await graph.removeChunkFacts({ groupId: partition.groupId, chunkId: mark });
    counts.retired++;
  }
}

/** Stamp one episode; true when it carries the stamp afterwards. */
async function stamp(
  graph: FileEpisodeGraph,
  partition: Partition,
  episodeUuid: string,
  chunkId: string,
  counts: FileEpisodeStampCounts,
): Promise<boolean> {
  const outcome = await graph.stampEpisodeChunk({ groupId: partition.groupId, episodeUuid, chunkId });
  if (outcome === "stamped" && !chunkId.startsWith(ORPHAN_CHUNK_PREFIX)) counts.stamped++;
  if (outcome === "refused" || outcome === "missing") {
    counts.skipped++;
    return false;
  }
  return true;
}

/**
 * Every stored row in one partition, as the salted digest of its text to its id; of two with
 * the same text, the oldest. Any row counts, whatever it is filed under or wherever it came
 * from: a row holding the episode's text is reason to keep the episode, never to retire it.
 * Read once per partition that lists an episode, and only ids and digests leave the database.
 */
async function storedRowsByDigest(
  db: PrismaClient,
  orgId: string,
  scopePath: string | null,
  salt: string,
): Promise<Map<string, string>> {
  const rows = await db.$queryRaw<{ id: string; digest: string }[]>`
    SELECT DISTINCT ON (digest) id, digest FROM (
      SELECT id, "createdAt", encode(sha256(convert_to(${salt} || ':' || content, 'UTF8')), 'hex') AS digest
      FROM memory_chunks
      WHERE "orgId" = ${orgId} AND "scopePath"::text IS NOT DISTINCT FROM ${scopePath}::text
    ) stored
    ORDER BY digest, "createdAt", id
  `;
  return new Map(rows.map((r) => [r.digest, r.id]));
}

async function rowStored(db: PrismaClient, orgId: string, id: string): Promise<boolean> {
  return (await db.memoryChunk.count({ where: { orgId, id } })) > 0;
}
