/**
 * Verifying an org's audit chain: the tamper-evidence half of the audit log.
 *
 * The rule this file enforces: a chain passes only if every chained row still
 * hashes to the value written when it was inserted, follows the row before it
 * with no gap, and ends where the org's chain head says it ends. The first row
 * that breaks any of these is named by its position.
 *
 * Each org is read inside one REPEATABLE READ, READ ONLY transaction, so the
 * head and every row come from the same snapshot. Without it a row committed
 * between the head read and the walk reads as a head mismatch: a false break
 * on any database that is taking writes.
 *
 * The database writes the chain (the audit_log insert trigger in
 * prisma/migrations/20261006160000_audit_log_tamper_evident); this file only
 * reads it. The hash is recomputed here in Node rather than by calling the
 * database's own hash function, so a verifier run does not trust a function
 * that someone with write access to the database could have replaced.
 *
 * Limits a reader should know:
 *  - Rows written before the chain existed have no position and are counted as
 *    unchained. They are protected from UPDATE and DELETE by the same trigger
 *    as every other row, but nothing here can prove they were never altered.
 *  - The insert trigger only ever assigns positions from 1 up, so a row at
 *    position 0 or below was written around it, and is a break.
 *  - A row with no position written around the trigger after the chain began
 *    is counted as unchained: nothing stored tells it apart from a pre-chain
 *    row. Its `at` cannot, because the writer sets it, and it does not come
 *    from the same clock as the head's `startedAt`.
 *  - There is no secret in the hash. Someone who can bypass the trigger and
 *    rewrite every row after the one they changed, and the head, produces a
 *    chain that verifies. Recording the head hash somewhere the database
 *    cannot reach (the CLI prints it) is what turns that into a detectable
 *    change.
 */
import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@/lib/generated/prisma/client";
import { db } from "@/lib/db";

/** The `prevHash` of an org's first chained row. */
export const AUDIT_CHAIN_GENESIS_HASH = "0".repeat(64);

/** Version tag that opens every canonical string; bump it to change the format. */
const CANONICAL_VERSION = "willder-audit-v1;";

/** Rows read per query while walking a chain. */
const PAGE_SIZE = 1000;

/**
 * How long one org's snapshot may stay open. Prisma's 5 s default would end a
 * long chain's walk early; past this the verifier fails rather than passes.
 */
const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;

/** How long to wait for a connection to open the snapshot on. */
const VERIFY_MAX_WAIT_MS = 30 * 1000;

/**
 * One audit row as it is hashed: every column except `rowHash`, each as the
 * exact text Postgres produces for it (`metadata::text`, `decision::text`, `at`
 * to the microsecond with no time zone).
 */
export interface CanonicalAuditRow {
  id: string;
  orgId: string;
  chainSeq: number;
  prevHash: string;
  actorType: string;
  actorId: string;
  action: string;
  target: string | null;
  decision: string;
  reason: string | null;
  metadata: string;
  at: string;
  runId: string | null;
}

/** Why a chain failed, at its first broken position. */
export type AuditChainBreakKind =
  /** One or more positions are absent: rows were deleted. */
  | "missing"
  /** The row's content no longer matches its hash: it was altered, or moved from another position. */
  | "altered"
  /** The row is intact but does not follow the row before it: rows were relinked or reordered. */
  | "unlinked"
  /** The chain's last row and the org's chain head disagree. */
  | "head-mismatch"
  /** A row sits at position 0 or below, which the insert trigger never assigns. */
  | "out-of-range";

export interface AuditChainBreak {
  /**
   * The first position (1-based `chainSeq`) at which the chain stops verifying;
   * for an out-of-range row, the position it carries.
   */
  position: number;
  /** The row found at that position, or null when the position itself is missing. */
  rowId: string | null;
  kind: AuditChainBreakKind;
  message: string;
}

export interface AuditChainReport {
  orgId: string;
  ok: boolean;
  /** Chained rows read before the first break (all of them when `ok`). */
  verified: number;
  /** Rows with no position, normally those written before the chain existed. Reported, never counted as broken. */
  unchained: number;
  /** The org's chain head, or null when no chained row was ever written. */
  head: { seq: number; hash: string } | null;
  firstBreak: AuditChainBreak | null;
}

function field(value: string | null): string {
  if (value === null) return "N;";
  return `S${Buffer.byteLength(value, "utf8")}:${value};`;
}

/**
 * The SHA-256 (hex) of one row's canonical content. Must stay byte-for-byte
 * identical to `audit_log_row_hash()` in the migration; the real-Postgres test
 * checks the two agree on every row it writes.
 */
export function auditRowHash(row: CanonicalAuditRow): string {
  const canonical =
    CANONICAL_VERSION +
    field(row.orgId) +
    field(String(row.chainSeq)) +
    field(row.prevHash) +
    field(row.id) +
    field(row.actorType) +
    field(row.actorId) +
    field(row.action) +
    field(row.target) +
    field(row.decision) +
    field(row.reason) +
    field(row.metadata) +
    field(row.at) +
    field(row.runId);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

type ChainRow = CanonicalAuditRow & { rowHash: string | null; prevHash: string | null };

/**
 * Walks one org's audit chain in position order and reports the first break,
 * as the chain stood when the walk began. Read-only. `client` defaults to the
 * app's database client.
 */
export async function verifyAuditChain(orgId: string, client: PrismaClient = db): Promise<AuditChainReport> {
  return client.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      return walkChain(orgId, tx);
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      maxWait: VERIFY_MAX_WAIT_MS,
      timeout: VERIFY_TIMEOUT_MS,
    },
  );
}

/** The walk itself; `tx` must hold one snapshot for every read below. */
async function walkChain(orgId: string, client: Prisma.TransactionClient): Promise<AuditChainReport> {
  const [{ unchained }] = await client.$queryRaw<{ unchained: number }[]>`
    SELECT count(*)::int AS unchained FROM "audit_log" WHERE "orgId" = ${orgId} AND "chainSeq" IS NULL`;
  const heads = await client.$queryRaw<{ seq: number; hash: string }[]>`
    SELECT "seq", "hash" FROM "audit_chain_heads" WHERE "orgId" = ${orgId}`;
  const head = heads[0] ?? null;

  const report = (verified: number, firstBreak: AuditChainBreak | null): AuditChainReport => ({
    orgId,
    ok: firstBreak === null,
    verified,
    unchained,
    head,
    firstBreak,
  });

  let expectedSeq = 1;
  let expectedPrev = AUDIT_CHAIN_GENESIS_HASH;
  for (;;) {
    const page = await client.$queryRaw<ChainRow[]>`
      SELECT "id", "orgId", "chainSeq", "prevHash", "rowHash", "actorType", "actorId", "action",
             "target", "decision"::text AS "decision", "reason", "metadata"::text AS "metadata",
             to_char("at", 'YYYY-MM-DD"T"HH24:MI:SS.US') AS "at", "runId"
        FROM "audit_log"
       WHERE "orgId" = ${orgId} AND "chainSeq" >= ${expectedSeq}
       ORDER BY "chainSeq"
       LIMIT ${PAGE_SIZE}`;

    for (const row of page) {
      const verified = expectedSeq - 1;
      if (row.chainSeq !== expectedSeq) {
        const last = row.chainSeq - 1;
        return report(verified, {
          position: expectedSeq,
          rowId: null,
          kind: "missing",
          message: `audit chain for org ${orgId}: position${last > expectedSeq ? `s ${expectedSeq}-${last} are` : ` ${expectedSeq} is`} missing`,
        });
      }
      if (
        row.prevHash === null ||
        row.rowHash === null ||
        auditRowHash({ ...row, prevHash: row.prevHash }) !== row.rowHash
      ) {
        return report(verified, {
          position: expectedSeq,
          rowId: row.id,
          kind: "altered",
          message: `audit chain for org ${orgId}: row ${row.id} at position ${expectedSeq} does not match its hash (altered, or moved from another position)`,
        });
      }
      if (row.prevHash !== expectedPrev) {
        return report(verified, {
          position: expectedSeq,
          rowId: row.id,
          kind: "unlinked",
          message: `audit chain for org ${orgId}: row ${row.id} at position ${expectedSeq} does not follow the row before it`,
        });
      }
      expectedPrev = row.rowHash;
      expectedSeq += 1;
    }
    if (page.length < PAGE_SIZE) break;
  }

  const verified = expectedSeq - 1;
  const headSeq = head?.seq ?? 0;
  const headHash = head?.hash ?? AUDIT_CHAIN_GENESIS_HASH;
  if (headSeq > verified) {
    return report(verified, {
      position: verified + 1,
      rowId: null,
      kind: "missing",
      message: `audit chain for org ${orgId}: the head records ${headSeq} rows but the chain ends at ${verified}; position${headSeq > verified + 1 ? `s ${verified + 1}-${headSeq} are` : ` ${headSeq} is`} missing`,
    });
  }
  if (headSeq !== verified || headHash !== expectedPrev) {
    return report(verified, {
      position: verified,
      rowId: null,
      kind: "head-mismatch",
      message: `audit chain for org ${orgId}: the chain ends at position ${verified} but the head records position ${headSeq} with a different hash`,
    });
  }
  return report(verified, await findOutOfRangeRow(orgId, client));
}

/**
 * The lowest row at a position below 1, which only a write around the insert
 * trigger can produce. The walk above reads positions from 1 up, so without
 * this such a row would be neither verified nor counted.
 */
async function findOutOfRangeRow(orgId: string, client: Prisma.TransactionClient): Promise<AuditChainBreak | null> {
  const rows = await client.$queryRaw<{ id: string; chainSeq: number }[]>`
    SELECT "id", "chainSeq" FROM "audit_log"
     WHERE "orgId" = ${orgId} AND "chainSeq" < 1
     ORDER BY "chainSeq", "id"
     LIMIT 1`;
  const row = rows[0];
  if (!row) return null;
  return {
    position: row.chainSeq,
    rowId: row.id,
    kind: "out-of-range",
    message: `audit chain for org ${orgId}: row ${row.id} is at position ${row.chainSeq}, which the chain never assigns (inserted around the chain trigger)`,
  };
}

/** Every org that has an audit chain head or any audit row, for verifying them all. */
export async function listAuditedOrgIds(client: PrismaClient = db): Promise<string[]> {
  const rows = await client.$queryRaw<{ orgId: string }[]>`
    SELECT "orgId" FROM "audit_chain_heads"
    UNION
    SELECT DISTINCT "orgId" FROM "audit_log"
    ORDER BY 1`;
  return rows.map((r) => r.orgId);
}
