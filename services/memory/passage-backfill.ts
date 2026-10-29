// Backfill of passage embeddings for memory rows stored before passages existed, run by
// an operator through scripts/backfill-passage-embeddings.ts.
//
// Vector search can find a long row by its best passage (services/memory/passages.ts),
// and every ingest now stores a long row's passages with it. A row stored earlier has
// none, so only its first 512 tokens are searchable until this gives it the passages
// an ingest would have written: the same windows, embedded by the same service.
//
// The rule it enforces: it only ever adds passages to a row that has none, in one
// INSERT per row, so a row ends up with all of its passages or none, and a rerun skips
// every row already done. That makes it resumable at any point. A row deleted while its
// passages were being embedded is skipped, never recreated, and its passages are not
// left behind. Its log names row ids, never content.
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { Prisma } from "@/lib/generated/prisma/client";
import { flattenSql } from "@/services/access";
import { PASSAGE_CHARS, splitPassages } from "./passages";
import { embedPassages, insertPassagesSql, sqlState } from "./pgvector-store";

export interface PassageBackfillOptions {
  /** Write passages. Without it the run only counts what it would write. */
  apply: boolean;
  /** Limit the run to one org's rows (internal Org.id). */
  orgId?: string;
  /** Rows read per database page. */
  pageSize?: number;
  /** Stop after giving this many rows their passages; a rerun continues from there. */
  maxRows?: number;
  /** The most passage embeddings to request per second, so live traffic keeps the embedder. */
  maxEmbeddingsPerSecond?: number;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface PassageBackfillSummary {
  apply: boolean;
  /** Rows with none of the passages their length calls for, when the run looked. */
  rowsNeedingPassages: number;
  /** How many passages those rows need. */
  passagesPlanned: number;
  /** What those passages will take in the database, at BYTES_PER_PASSAGE each. */
  estimatedStorageBytes: number;
  /** Rows given their passages by this run (always 0 on a dry run). */
  rowsFilled: number;
  passagesWritten: number;
  /** Rows deleted between being read and their passages being written. */
  rowsGone: number;
  /** The last row this run read, for the log; a rerun does not need it. */
  lastRowId: string | null;
}

/**
 * What one stored passage takes, table, primary key and HNSW index together: 3,779 bytes,
 * measured on 20,000 passages in a freshly built table (1,638 heap, 89 key, 2,048 index).
 * A table that has seen deletes takes more until it is vacuumed.
 */
export const BYTES_PER_PASSAGE = 3_800;

export const DEFAULT_PAGE_SIZE = 100;
export const DEFAULT_MAX_EMBEDDINGS_PER_SECOND = 10;

/** Postgres's foreign-key violation: the row was deleted before its passages were written. */
const FOREIGN_KEY_VIOLATION = "23503";

/**
 * Give every row that needs passages and has none its passages, in id order, or count
 * them on a dry run. See the module comment for the rule.
 */
export async function backfillPassages(
  db: PrismaClient,
  options: PassageBackfillOptions,
): Promise<PassageBackfillSummary> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const rate = options.maxEmbeddingsPerSecond ?? DEFAULT_MAX_EMBEDDINGS_PER_SECOND;
  const log = options.log ?? (() => {});
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const summary: PassageBackfillSummary = {
    apply: options.apply,
    rowsNeedingPassages: 0,
    passagesPlanned: 0,
    estimatedStorageBytes: 0,
    rowsFilled: 0,
    passagesWritten: 0,
    rowsGone: 0,
    lastRowId: null,
  };

  for (let after = ""; ; ) {
    const page = await rowsWithoutPassages(db, { after, orgId: options.orgId, pageSize });
    if (page.length === 0) break;
    for (const row of page) {
      summary.lastRowId = row.id;
      const planned = splitPassages(row.content).length;
      if (planned === 0) continue;
      summary.rowsNeedingPassages++;
      summary.passagesPlanned += planned;
      summary.estimatedStorageBytes = summary.passagesPlanned * BYTES_PER_PASSAGE;
      if (!options.apply) continue;

      const started = now();
      const written = await writePassages(db, row);
      if (written === null) {
        summary.rowsGone++;
        log(`row ${row.id}: deleted before its passages were written; skipped`);
      } else {
        summary.rowsFilled++;
        summary.passagesWritten += written;
      }
      const wait = (planned / rate) * 1_000 - (now() - started);
      if (wait > 0) await sleep(wait);
      if (options.maxRows !== undefined && summary.rowsFilled >= options.maxRows) {
        log(`stopped after ${summary.rowsFilled} rows at row ${row.id}; rerun to continue`);
        return summary;
      }
    }
    after = page[page.length - 1]!.id;
    log(`read through row ${after}: ${summary.rowsFilled} rows given ${summary.passagesWritten} passages so far`);
  }
  return summary;
}

/**
 * The next page of rows that have no passages and may need some. `octet_length` is a
 * cheap upper bound on the UTF-16 length `splitPassages` measures, so no row that needs
 * passages is left out; the caller drops the ones that turn out to fit in one.
 */
function rowsWithoutPassages(
  db: PrismaClient,
  { after, orgId, pageSize }: { after: string; orgId?: string; pageSize: number },
): Promise<{ id: string; content: string }[]> {
  const inOrg = orgId === undefined ? Prisma.empty : Prisma.sql`AND c."orgId" = ${orgId}`;
  return db.$queryRaw<{ id: string; content: string }[]>(
    ...flattenSql(Prisma.sql`
      SELECT c.id, c.content FROM memory_chunks c
      WHERE c.id > ${after} ${inOrg}
        AND octet_length(c.content) > ${PASSAGE_CHARS}
        AND NOT EXISTS (SELECT 1 FROM memory_chunk_passages p WHERE p."chunkId" = c.id)
      ORDER BY c.id
      LIMIT ${pageSize}
    `),
  );
}

/** Embed and store one row's passages. Returns how many were written, or null when the row is gone. */
async function writePassages(db: PrismaClient, row: { id: string; content: string }): Promise<number | null> {
  const insert = insertPassagesSql(row.id, await embedPassages(row.content));
  if (insert === null) return 0;
  try {
    return await db.$executeRaw(...flattenSql(insert));
  } catch (error) {
    if (sqlState(error) === FOREIGN_KEY_VIOLATION) return null;
    throw error;
  }
}
