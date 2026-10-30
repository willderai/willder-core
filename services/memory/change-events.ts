// The change feed's write side.
//
// One row in `change_events` per governed write, inserted in the SAME database
// transaction as the write it describes. That is the whole point: the feed cannot
// announce a change that was rolled back, and it cannot miss one that committed.
//
// The one rule this file enforces: within an org, `seq` order is commit order.
// A reader holding a cursor at `seq = N` may take everything with `seq > N` and
// trust that nothing older is still in flight.
import { randomUUID } from "node:crypto";
import type { ChangeOp } from "@/lib/generated/prisma/enums";
import { Prisma } from "@/lib/generated/prisma/client";
import { isValidLtreePath } from "@/services/access";
import type { AuditOrigin } from "@/services/access/origin";
import type { ActorType } from "@/types/memory";

export type { ChangeOp };

/** The change feed's `recordType` for a fact. Its `recordId` is the id of the stored
 * version the event is about: on `create` the version the ingest stored, on `delete`
 * the version removed, on `supersede` the version that was replaced. */
export const FACT_RECORD_TYPE = "fact";

/** Hard ceiling on `summary`, in Unicode code points. */
export const SUMMARY_MAX_CHARS = 200;

/**
 * Advisory-lock namespace for per-org change-event sequencing. Postgres advisory
 * locks share one server-wide space, so the two-key form keeps this apart from any
 * other future lock: the first key names the purpose, the second the org.
 */
const CHANGE_EVENT_LOCK_NAMESPACE = 8_241_001;

/** The write half of one change event. `scopePath` and `title` are read off the
 * record being written — never taken from the caller of the API that triggered it. */
export interface ChangeEventInput {
  orgId: string;
  /** ltree scope of the record this event describes. */
  scopePath: string;
  /** Table-independent name of what changed, e.g. "fact", "brief", "source". */
  recordType: string;
  recordId: string;
  op: ChangeOp;
  /** User id or agent id. Never a capability token. */
  actorId: string;
  /** What kind of principal `actorId` is. A system job (a connector sync, an
   * erasure) is "extraction", never an agent. */
  actorType: ActorType;
  /** The entry point the change came in through: the request's own origin, or the
   * job's when no request is behind it. */
  origin: AuditOrigin;
  /** The record's own title or first line. Empty is allowed: an event with no
   * human-readable title still tells a reader that `recordId` changed. */
  title: string;
  /**
   * The `audit_log` id of the visible `memory.write`/`memory.delete` allow row that
   * authorized this change (`check()` returns it as `AccessDecision.auditLogId`).
   * `GET /api/audit` renders it back as that row's `changeId`, which is how a reader
   * of the visible audit log identifies the change an authorization produced.
   *
   * Omit it when no single authorization produced this event -- a connector sync's
   * own write, or the supersede of a version that lost a concurrent write -- rather
   * than passing another change's row.
   */
  authorizedById?: string;
  /**
   * The task the write was made for, as its writer's session named it (`willder/task`).
   * Omit when the writer named none. Read only by the task-start block, to serve a later
   * session of the same task (services/memory/task-start.ts).
   */
  task?: string;
  /**
   * The session the write was made in, as its writer's call named it (`willder/session`) or
   * its MCP connection was. Omit when there is none. Read only to link a claim to the
   * evidence its own session recorded (services/memory/claim-status.ts).
   */
  sessionKey?: string;
}

/** Who made a change and where it came in: the three fields every producer states. */
export interface ChangeAuthor {
  actorType: ActorType;
  actorId: string;
  origin: AuditOrigin;
}

/** A Prisma client bound to an open transaction. `recordChangeEvent` takes this
 * rather than the global client so it cannot be called outside one by accident. */
export type ChangeEventTransaction = Pick<Prisma.TransactionClient, "$queryRaw" | "changeEvent">;

/**
 * Build an event summary from a record's title. Pure string handling — no model
 * runs in a write path, so the same record always yields the same summary.
 *
 * Takes the first line, collapses runs of whitespace, drops control characters,
 * and truncates to {@link SUMMARY_MAX_CHARS} code points with a trailing ellipsis.
 * Truncation counts code points rather than UTF-16 code units so it can never
 * split a surrogate pair and emit a lone surrogate.
 */
export function summarizeChange(title: string): string {
  const firstLine = title.split("\n", 1)[0] ?? "";
  const cleaned = firstLine
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const points = Array.from(cleaned);
  if (points.length <= SUMMARY_MAX_CHARS) return cleaned;
  return points.slice(0, SUMMARY_MAX_CHARS - 1).join("") + "…";
}

/**
 * Take the org's change-feed lock for the rest of the caller's transaction. Every event
 * for the org is written under it, so a caller that takes it first and then reads the
 * feed sees every event committed before it, and no other transaction can write one for
 * the org until the caller's commits. Taking it again in the same transaction does not block.
 *
 * Writers take the same lock inside the statement that writes the event, through
 * `public.change_event_next_seq` (migration 20261029120000_change_event_next_seq), whose
 * namespace and key are this function's.
 */
export async function lockOrgChangeFeed(tx: ChangeEventTransaction, orgId: string): Promise<void> {
  // `hashtext` narrows orgId to int4, so two orgs can collide and serialize behind
  // each other. That costs a little throughput at a shared lock and never
  // correctness: an org's own writes are always serialized against each other.
  // Called in FROM, not as a bare SELECT expression: the function returns `void`,
  // which the Prisma pg adapter cannot deserialize as a column.
  await tx.$queryRaw`
    SELECT true AS locked
    FROM pg_advisory_xact_lock(${CHANGE_EVENT_LOCK_NAMESPACE}::int4, hashtext(${orgId})::int4)
  `;
}

/**
 * The org's next `seq`, as SQL to place in the statement that uses it. It takes the org's
 * change-feed lock, held until the caller's transaction commits, and then reads MAX(seq) + 1
 * with a snapshot taken after the lock was granted, all inside that one statement.
 *
 * Held to commit, so the next writer for this org cannot read a next-seq that this one is
 * about to take. That is what makes seq order commit order: without it, two transactions can
 * both read MAX(seq) = 40, and the one that wrote 41 can commit while 42 is still open,
 * leaving a reader that consumed 42 to skip 41 forever. One statement rather than three
 * (lock, read, insert), because every other writer in the org waits on this lock until the
 * commit: each round trip inside it is paid again by every writer queued behind it.
 */
function nextSeq(orgId: string): Prisma.Sql {
  return Prisma.sql`public.change_event_next_seq(${orgId})`;
}

/** Refuse an event a reader could not filter: its scope must be a valid ltree path. */
function assertEventScope(input: Pick<ChangeEventInput, "scopePath" | "recordType">): void {
  if (!isValidLtreePath(input.scopePath)) {
    throw new Error(
      `change event needs a valid ltree scopePath, got ${JSON.stringify(input.scopePath)}: ` +
        `pass the scope of the ${input.recordType} record being written`,
    );
  }
}

/** One event's row values, in the column order {@link EVENT_COLUMNS} names, with `seq` given as SQL. */
function eventValues(input: ChangeEventInput, seq: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(${randomUUID()}, ${input.orgId}, ${seq}, ${input.scopePath}, ${input.recordType}, ${input.recordId},
    ${input.op}::"ChangeOp", ${input.actorId}, ${input.actorType ?? null}, ${input.origin ?? null}, ${summarizeChange(input.title)},
    ${input.authorizedById ?? null}, ${input.task ?? null}, ${input.sessionKey ?? null}, ${WRITTEN_AT})`;
}

// Prisma's create fills `id` and `createdAt` client-side, so a raw insert spells both out:
// `id` a v4 UUID as the column's default makes, and `createdAt` the moment the row is written.
//
// `createdAt` is the wall clock when the insert evaluates the row (clock_timestamp()), not the
// transaction's start (now(), sqlUtcNow), so it keeps the meaning Prisma's client-side default
// gave it: when the event was written, at most the commit's round trip before it is visible.
// services/memory/dependencies.ts compares it with a derivation's own createdAt to decide
// whether a source changed after a dependent was built; with the transaction's start, a long
// transaction would date its change before a dependent built while it was open, and the
// dependent would never read as stale. Taken as UTC wall-clock time, the column's form,
// whatever the session TimeZone (lib/sql-utc-now.ts). It is still not monotonic with `seq`:
// order events by `seq`, never by `createdAt`.
const WRITTEN_AT = Prisma.sql`(clock_timestamp() AT TIME ZONE 'UTC')`;

const EVENT_COLUMNS = Prisma.sql`("id", "orgId", "seq", "scopePath", "recordType", "recordId", "op",
  "actorId", "actorType", "origin", "summary", "authorizedById", "task", "sessionKey", "createdAt")`;

/**
 * Append one change event, inside the caller's transaction.
 *
 * Callers pass the transaction that performs the write itself, so the event and
 * the write commit or roll back together. Throws — rolling the caller's write
 * back — rather than recording an event a reader could not filter, because a
 * write nobody can see announced is safer than one announced to the wrong scope.
 *
 * @returns the new event's `id` (the feed's opaque public cursor) and the `seq`
 * assigned to it (internal ordering, never handed to a reader).
 */
export async function recordChangeEvent(
  tx: ChangeEventTransaction,
  input: ChangeEventInput,
): Promise<{ id: string; seq: bigint }> {
  assertEventScope(input);
  // An INSERT ... VALUES of one row returns exactly one row, so the tuple type is the real shape.
  const [created] = await tx.$queryRaw<[{ id: string; seq: bigint | string }]>`
    INSERT INTO "change_events" ${EVENT_COLUMNS}
    VALUES ${eventValues(input, nextSeq(input.orgId))}
    RETURNING "id", "seq"
  `;
  // node-postgres hands BIGINT back as a string rather than losing precision to a
  // JS number, so the conversion is load-bearing, not a formality.
  return { id: created.id, seq: BigInt(created.seq) };
}

/**
 * Append several change events in one statement, inside the caller's transaction, with
 * consecutive `seq`s in the order given: the batched form of {@link recordChangeEvent}, for a
 * write that announces many records at once, so its cost does not grow by a round trip per record.
 */
export async function recordChangeEvents(
  tx: ChangeEventTransaction,
  inputs: readonly ChangeEventInput[],
): Promise<void> {
  if (inputs.length === 0) return;
  for (const input of inputs) {
    if (input.orgId !== inputs[0]!.orgId) throw new Error("recordChangeEvents takes one org's events per call");
    assertEventScope(input);
  }
  // The first seq is read once, in a subquery the planner runs once, so the rows take
  // first, first + 1, ... in the order given.
  await tx.$queryRaw`
    INSERT INTO "change_events" ${EVENT_COLUMNS}
    SELECT v.* FROM (SELECT ${nextSeq(inputs[0]!.orgId)} AS first) f,
    LATERAL (VALUES ${Prisma.join(inputs.map((input, i) => eventValues(input, Prisma.sql`f.first + ${i}`)))}) AS v
  `;
}

/**
 * Append the `create` event of one fact version, inside the caller's transaction,
 * unless that version already has one.
 *
 * The database decides: the insert defers to the partial unique index on a fact's
 * `create` events (migration 20261007220000_fact_create_event_once), so a replayed or
 * concurrent announcement of one version writes nothing. A skipped insert consumes no
 * `seq`, so the feed stays gapless.
 *
 * @param input the event, minus its record type and op, which are always `fact` and `create`.
 * @returns the new event's `id` and `seq`, or null when the version was already announced.
 */
export async function recordFactCreateOnce(
  tx: ChangeEventTransaction,
  input: Omit<ChangeEventInput, "recordType" | "op">,
): Promise<{ id: string; seq: bigint } | null> {
  const event = { ...input, recordType: FACT_RECORD_TYPE, op: "create" as const };
  assertEventScope(event);
  // Prisma's create has no ON CONFLICT. The conflict target names the index's predicate
  // as literals, which is how Postgres matches a partial unique index.
  const inserted = await tx.$queryRaw<{ id: string; seq: bigint | string }[]>`
    INSERT INTO "change_events" ${EVENT_COLUMNS}
    VALUES ${eventValues(event, nextSeq(event.orgId))}
    ON CONFLICT ("orgId", "recordId") WHERE "recordType" = 'fact' AND "op" = 'create' DO NOTHING
    RETURNING "id", "seq"
  `;
  return inserted.length === 1 ? { id: inserted[0].id, seq: BigInt(inserted[0].seq) } : null;
}
