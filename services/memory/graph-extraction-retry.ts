// Graph extraction owed to versions that are already stored and acknowledged. The
// request-path ingest (INNGEST_BYPASS, run in `after()`) extracts a write into the graph once
// the reply has gone. When that extraction fails, the version stays readable but is missing
// from the graph; on 2026-10-16 the extraction model's provider refused every call for a day,
// and each failure was logged and dropped. The rule this file keeps: such a version has a
// row in graph_extraction_retries until an attempt succeeds or the version is gone.
//
// A row holds the ingest's settings, never its text. The text is read from the version's
// own row at retry time, so deleting or erasing the version removes what is owed with it
// (ON DELETE CASCADE), and nothing here can outlive an erasure.
import { Prisma } from "@/lib/generated/prisma/client";
import { db } from "@/lib/db";
import { MemoryServiceError } from "./graphiti-store";
import type { IngestInput } from "@/types/memory";

/** Wait before the second attempt; each later failure doubles it, up to RETRY_MAX_DELAY_MS. */
export const RETRY_BASE_DELAY_MS = 10 * 60_000;
export const RETRY_MAX_DELAY_MS = 6 * 60 * 60_000;
/** Versions one pass attempts at most. */
export const RETRY_BATCH_SIZE = 20;
/** How long a pass holds the rows it claimed, so an overlapping pass skips them. */
export const RETRY_CLAIM_LEASE_MS = 15 * 60_000;
/** Longest failure text kept on a row. */
const MAX_ERROR_LENGTH = 500;

/** A stored ingest whose graph extraction failed; `job.readableId` is the stored version. */
export class GraphExtractionError extends Error {
  constructor(
    readonly job: IngestInput & { readableId: string },
    cause: unknown,
  ) {
    super(`graph extraction of version ${job.readableId} failed: ${messageOf(cause)}`, { cause });
    this.name = "GraphExtractionError";
  }
}

/** The wait after `attempts` failed attempts, before the next one. */
export function retryDelayMs(attempts: number): number {
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** Math.min(Math.max(0, attempts - 1), 30), RETRY_MAX_DELAY_MS);
}

/**
 * Record that the extraction of `error.job` failed: a new row on the first failure, one more
 * attempt on a row already there. Writes nothing when the version is no longer stored.
 */
export async function deferGraphExtraction(error: GraphExtractionError, now = new Date()): Promise<void> {
  const { job } = error;
  // The reference time: the write's own time, never later than the version's write time (as the store clamps it),
  // else the version's receivedAt. NULL when it has neither: the pass then uses createdAt.
  const stated =
    job.occurredAt === undefined || Number.isNaN(Date.parse(job.occurredAt)) ? null : new Date(job.occurredAt);
  await db.$executeRaw`
    INSERT INTO graph_extraction_retries ("chunkId", "orgId", "job", "attempts", "lastError", "nextAttemptAt", "referenceAt")
    SELECT c.id, c."orgId", ${JSON.stringify(storedJob(job))}::jsonb, 1, ${failureText(error.cause)},
           ${new Date(now.getTime() + retryDelayMs(1))},
           COALESCE(CASE WHEN ${stated}::timestamp IS NULL THEN NULL ELSE LEAST(${stated}::timestamp, c."createdAt") END, c."receivedAt")
    FROM memory_chunks c
    WHERE c.id = ${job.readableId} AND c."orgId" = ${job.groupId}
    ON CONFLICT ("chunkId") DO UPDATE SET
      "attempts" = graph_extraction_retries."attempts" + 1,
      "lastError" = EXCLUDED."lastError",
      "referenceAt" = COALESCE(graph_extraction_retries."referenceAt", EXCLUDED."referenceAt"),
      -- EXCLUDED holds now + retryDelayMs(1); shift it to now + retryDelayMs(attempts + 1).
      -- Computed from the bound value, never from a cast, so the session time zone cannot move it.
      "nextAttemptAt" = EXCLUDED."nextAttemptAt" + make_interval(secs => (${delaySql("graph_extraction_retries")} - ${RETRY_BASE_DELAY_MS}::float8) / 1000)
  `;
}

/** What one retry pass did. */
export interface RetryPass {
  /** Versions whose extraction was attempted. */
  attempted: number;
  /** Of those, extracted: their rows are gone. */
  extracted: number;
  /** Of those, failed again: their rows wait longer. */
  failed: number;
}

interface ClaimedRow {
  chunkId: string;
  job: Omit<IngestInput, "content">;
  content: string;
  createdAt: Date;
  referenceAt: Date | null;
}

/**
 * Attempt the extraction of up to `limit` versions that are due, oldest due first. `extract`
 * is the ingest job (`runMemoryIngest`); it re-checks that the version is still stored,
 * still connected and not an erased correction before it writes anything, so a version
 * withdrawn since its row was written is settled without a graph write.
 *
 * Each version is claimed just before its attempt (SKIP LOCKED), and the claim itself counts
 * the attempt and sets the next one, never sooner than RETRY_CLAIM_LEASE_MS away. So two
 * passes that overlap attempt a version twice only when one attempt outlasts the lease, and
 * an attempt the platform kills mid-step still backs off. `now` fixes the clock, for tests.
 */
export async function retryDeferredGraphExtractions(
  extract: (job: IngestInput) => Promise<void>,
  options: { now?: Date; limit?: number } = {},
): Promise<RetryPass> {
  const clock = () => options.now ?? new Date();
  const pass: RetryPass = { attempted: 0, extracted: 0, failed: 0 };
  while (pass.attempted < (options.limit ?? RETRY_BATCH_SIZE)) {
    const row = await claimNextDue(clock());
    if (!row) break;
    pass.attempted += 1;
    try {
      // The stored text is what the first attempt stored, already resolved: never resolve it again.
      // It is dated at the write's own time (its occurredAt, else receivedAt; createdAt for a row
      // from before the column), never now: the graph's reference time decides
      // which of two contradicting facts it retires, and a late extraction must not outrank a
      // newer version that was extracted on time.
      await extract({
        ...row.job,
        content: row.content,
        readableId: row.chunkId,
        resolve: false,
        referenceTime: (row.referenceAt ?? row.createdAt).toISOString(),
      });
      await db.$executeRaw`DELETE FROM graph_extraction_retries WHERE "chunkId" = ${row.chunkId}`;
      pass.extracted += 1;
    } catch (e) {
      pass.failed += 1;
      // The attempt is already counted by its claim. A deletion of the org opened since then
      // refuses this note; the row goes with the org.
      await db.$executeRaw`
        UPDATE graph_extraction_retries SET "lastError" = ${failureText(e)} WHERE "chunkId" = ${row.chunkId}
      `.catch((noteError: unknown) =>
        console.warn(`[memory] could not note the failed extraction of ${row.chunkId}:`, messageOf(noteError)),
      );
    }
  }
  return pass;
}

/**
 * Claim the version due first at `now`, of an org with no open deletion, or null when none is:
 * count its attempt and move its
 * next attempt to `now` plus the longer of the lease and retryDelayMs(attempts + 1).
 */
async function claimNextDue(now: Date): Promise<ClaimedRow | null> {
  const [row] = await db.$queryRaw<ClaimedRow[]>`
    WITH due AS (
      SELECT q."chunkId" FROM graph_extraction_retries q
      WHERE q."nextAttemptAt" <= ${now}
        -- An org being deleted is extracted into nothing, and its rows cannot be moved
        -- (org_deletion_refuse_write): skip them, or they would stall every other org.
        AND NOT EXISTS (
          SELECT 1 FROM org_deletions d WHERE d."orgId" = q."orgId" AND d."status" IN ('pending', 'deleting')
        )
      ORDER BY q."nextAttemptAt", q."chunkId"
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE graph_extraction_retries r
    SET "attempts" = r."attempts" + 1,
        -- The driver binds a Date as UTC wall time with no zone, as the column stores it; a
        -- timestamp cast keeps it as is (a timestamptz cast would read it in the session's zone).
        "nextAttemptAt" = ${now}::timestamp + make_interval(secs => GREATEST(${RETRY_CLAIM_LEASE_MS}::float8, ${delaySql("r")}) / 1000)
    FROM due, memory_chunks c
    WHERE r."chunkId" = due."chunkId" AND c.id = r."chunkId"
    RETURNING r."chunkId", r."job", c."content", c."createdAt", r."referenceAt"
  `;
  return row ?? null;
}

/** retryDelayMs(attempts + 1) in SQL for the row aliased `alias`; the exponent is capped so power() cannot overflow. */
function delaySql(alias: "r" | "graph_extraction_retries"): Prisma.Sql {
  return Prisma.sql`LEAST(${RETRY_BASE_DELAY_MS}::float8 * power(2, LEAST(${Prisma.raw(`${alias}."attempts"`)}, 30)), ${RETRY_MAX_DELAY_MS}::float8)`;
}

/** The ingest as a row keeps it: without its text, which the version's row holds, and its stated date. */
function storedJob(job: IngestInput): Omit<IngestInput, "content" | "occurredAt"> {
  const { content: _text, occurredAt: _statedDate, ...settings } = job;
  return settings;
}

/** The failure as a row keeps it: the memory service's status and message, cut to MAX_ERROR_LENGTH. */
function failureText(error: unknown): string {
  const cause = error instanceof GraphExtractionError ? error.cause : error;
  const status = cause instanceof MemoryServiceError && cause.status !== undefined ? `HTTP ${cause.status}: ` : "";
  return (status + messageOf(cause)).slice(0, MAX_ERROR_LENGTH);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
