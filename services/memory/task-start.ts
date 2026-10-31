// The task-start read: what an agent should know before it starts work.
//
// On the first tool call of a session, an agent is served the working notes other agents
// have live in its scope, what decides its task, then the standing rules of its scope and
// the open run state around it. It does not have to think to ask; the block rides on
// whatever it called first (mcp/task-start-notice.ts).
//
// What decides a task is what earlier sessions of the same task decided and wrote. A
// session names its task with `willder/task`, and every write it makes through
// memory_ingest records that name on its change event. A later session naming the same
// task is served the decisions those writes recorded and the facts they touched, each
// in the version current now: a decision someone replaced is served as its replacement,
// and a fact as the versions no `supersedes` edge retired (the winner rule,
// services/memory/conflict.ts), whoever wrote them. A version retired by losing a conflict to
// another writer, not replaced by a write based on it, is read too, and served only beside the
// versions it conflicts with, which the block flags and asks the person about
// (services/memory/served-conflicts.ts): the product records a winner, but the block does not
// choose one silently. Which records are the task's is decided
// by the task's identity and their writing alone, never by the words of the task, so how a
// session phrases its task can never bring in a record that is not the task's. Their order is
// the session's, and so, within the block's budget, is which of them fit: the facts that decide the task first, as their writers
// declared them (a fact's `role`, services/memory/fact-roles.ts); within each, the newest
// source on the session's subject that quotes none of its text, then each write by its relevance to what the
// session is doing (rankTaskFacts), the newest first among equals, a write that restates the
// session's own text last, and
// the parts of one write, stored at one instant, together in the order they were written. No
// model and no embedding decides what is served.
//
// The scope's rules come in the order services/memory/rule-order.ts gives them: those the task
// cites by name first, then the newest, then the rest by relevance. Its recent writes are
// ranked by relevance, which is lexical (services/memory/relevance.ts): a record ranks by the
// task's terms it contains, each weighted by how rare it is among the records ranked, an
// identifier counting double. Recency only breaks ties. The read considers more than it can
// serve, each pool bounded by an index: the scope's 100 newest rules, a task's 200 newest
// writes, and among the scope's 500 newest writes the 30 that hold a task term as a whole
// word, those holding it in their summary first. A rule the task names by id or subject is
// read too, however old; no index finds one, so only a task that names something pays to read
// the scope's rules for it. The newest 200 are also
// matched on the first 4,000 characters of the fact each created, but a match in the text
// alone must carry half the task's weight: a passing mention is not what the block's budget
// is for.
//
// Records served that were written at one instant are ordered by id, compared as bytes
// (`COLLATE "C"`). An id is an opaque key, so no language's collation applies to it, and the
// database's default would make the same store serve a different block on a server created
// with another locale. The one id tie-break left to the database is the lookup of the version
// that retired a fact, which must agree with supersedingVersions
// (services/memory/superseded-facts.ts), the vector read path's lookup.
//
// This file reads and ranks; it does not decide whether a caller may see anything.
// Every read here filters by ltree containment within a scope the caller has
// already been allowed to read, and the caller runs the audited check() before
// anything read here leaves the server. A fact naming a person erased from the org,
// written before that erasure and put back by a restored backup, is never served
// (services/memory/erasure-suppression.ts), the same as on the vector read path. That check
// reads a fact's whole text, so it is run on what a block would serve, and only that
// (readServableTaskStart): a record that fails it is dropped and the next one takes its place.
// A write's own summary, which the erasure blanks when it names the person, is checked the
// same way before anything is picked, since a restored backup can put that back too.
//
// The one rule this file enforces: a session is served at most once. The
// `task_start_deliveries` row for (org, agent, session) is claimed atomically, so two
// tool calls racing at the start of a session produce one delivery, not two.
import { Prisma } from "@/lib/generated/prisma/client";
import { db } from "@/lib/db";
import { sqlUtcNow } from "@/lib/sql-utc-now";
import { flattenSql, scopeContainsSql, type AccessContext } from "@/services/access";
import { scopeWithinWalkedSql } from "@/services/access/scope-containment";
import { FACT_RECORD_TYPE, type ChangeOp } from "./change-events";
import { CONVENTION_RECORD_TYPE, type ConventionKind } from "./conventions";
import { supersessionOpening, type StoredWriter } from "./conflict";
import { servedConflicts } from "./served-conflicts";
import type { ClaimWriter } from "./claim-status";
import { factRoleTier, factRoleTierSql, type FactRole } from "./fact-roles";
import { loadErasedContentFilter, type ErasedContentFilter } from "./erasure-suppression";
import { withoutErasedWinners } from "./superseded-facts";
import { citedNames, orderRules } from "./rule-order";
import { SESSION_STATE_NAME_OPENING } from "./session-state";
import { CLAIM_RETURNING, servedLogInsert } from "./task-start-served";
import { servedAnchorSql } from "./raw-rows";
import { versionsSightedCte } from "./fact-reads";
import { scopesShownCte } from "@/services/access/derived-writes";
import {
  sinceLastSessionOf,
  sinceLastSessionSql,
  type SinceLastSession,
  type SinceLastSessionRow,
} from "./since-last-session";
import { WORKING_NOTE_RECORD_TYPE, noteTaskKey, type WorkingNoteKind } from "./working-notes";
import {
  TEXT_RANKED_CHARS,
  holdsATaskTerm,
  isAboutTheTask,
  namesIn,
  ownTermsOf,
  rankByRelevance,
  rankedText,
  relevanceOf,
  termCountsOf,
  termsOf,
  weighTaskTerms,
  type TermCounts,
  type TermWeights,
} from "./relevance";

/**
 * A session ends after this long without a tool call, and its next call starts a new one.
 * Long enough that a working agent pausing to think stays in one session; short
 * enough that the next scheduled run of the same agent starts a new one. A new MCP
 * connection is a new session at once (mcp/connection-session.ts), so this window alone
 * decides only for a client that keeps one connection or one session name across runs, or
 * that does not send its connection's session id back.
 */
export const SESSION_IDLE_MS = 30 * 60 * 1000;

/** Most rules considered per read. Past this, the rules the task names win, then the newest. */
const MAX_CANDIDATE_RULES = 100;
/**
 * The scope's newest writes whose summaries are searched for the task's terms; the newest of
 * those, in which a write is also matched on its fact's text and served on a passing mention
 * of the task in its summary (an older one is served only when its summary is about the
 * task); and the most of the matches read back.
 */
const MAX_CANDIDATE_WRITES = 500;
const MAX_RECENT_WRITES = 200;
const MAX_MATCHING_WRITES = 30;
const MAX_STALE_FLAGS = 3;
/** Most of a task's own writes considered, and most decisions served from them. */
const MAX_TASK_WRITES = 200;
const MAX_TASK_DECISIONS = 20;
/** Most current versions of a task's facts served. */
const MAX_TASK_FACTS = 20;
/**
 * Most versions read for each picked fact beyond {@link MAX_TASK_FACTS}, the newest first, because
 * they share its name and scope: what a conflict on it needs to be served whole
 * (services/memory/served-conflicts.ts). Counted per fact, so one fact with many versions never
 * takes another's. A fact with more versions than this is flagged over its newest ones.
 */
const MAX_CONFLICT_PARTNERS = 10;
/**
 * Most of a task's captured session states read to tell what its sessions ran. Read apart from
 * the served facts, so a capture the served limit leaves out still counts; past this many, the
 * read says it holds only the newest ({@link TaskCaptures.all}).
 */
const MAX_TASK_CAPTURES = 50;
/**
 * Characters of a rule or fact handed to the block, which picks its most relevant passage
 * from them (mcp/task-start-notice.ts) and never serves more than a few hundred. They are
 * also all a write's fact text is matched on.
 */
const FACT_TEXT_SERVED_CHARS = TEXT_RANKED_CHARS;
/** Recent writes served when the task says nothing to rank them by. */
const WRITES_WITHOUT_TASK_TERMS = 3;
/**
 * Most live working notes served. A note line is at most about 130 tokens (its task cut to
 * 120 characters, a 280-character body and an agent id; mcp/task-start-notice.ts), so these
 * always fit the block's budget, ahead of the rest.
 */
const MAX_LIVE_NOTES = 3;

/** A current convention or decision, as served. */
export interface ServedRule {
  id: string;
  kind: ConventionKind;
  subject: string;
  text: string;
  /**
   * Set on a task decision the task itself recorded: the version in force is one of its own
   * writes, not a replacement someone else made. Absent on every other rule.
   */
  ofTask?: true;
  /** Who recorded the version in force, as its create event says (services/memory/claim-status.ts); absent where not read. */
  by?: ClaimWriter;
  /** On a task decision: the session its create event recorded, or null for none. */
  sessionKey?: string | null;
  /** When the version in force was recorded, as an ISO instant; absent where not read. */
  writtenAt?: string;
  /** Who recorded the version in force, as the block names it ({@link RULE_WRITTEN_BY_SQL}); absent where not read. */
  writtenBy?: string;
  /** On a task decision: the scope the version in force is stored in. */
  scopePath?: string;
}

/** A recent write in the scope, as served. */
export interface ServedWrite {
  id: string;
  recordType: string;
  recordId: string;
  op: ChangeOp;
  actorId: string;
  summary: string;
  /** When the write was recorded, as an ISO instant; absent where not read. */
  writtenAt?: string;
  /**
   * The text of the fact version a matching write created, at most
   * {@link FACT_TEXT_SERVED_CHARS} characters, so the block can serve its relevant passage
   * rather than its first line. Absent for any other write, and when the task names nothing.
   */
  content?: string;
  /** Set when the version it created must pass the erased-person check before it is served ({@link readServableTaskStart}). */
  erasureCheckDue?: boolean;
  /**
   * Set, with when the write was recorded as an ISO instant, when the write's own summary must
   * pass the erased-person check before it is served: it names something and was recorded at
   * or before the org's latest erasure, which blanks every summary naming the person, so it may
   * be one a restored backup put back ({@link readServableTaskStart}).
   */
  summaryCheckDue?: { writtenAt: string };
  /**
   * Set when the session reading names a task and the write was recorded for that same task
   * (its change event's `task`, matched exactly): the task's own claims are judged against its
   * captured tests (mcp/task-start-notice.ts). Absent for every other write.
   */
  ofTask?: true;
}

/** A fact whose recorded source has moved since it was recorded. */
export interface StaleFlag {
  id: string;
  /** The scope the source link was recorded in (mcp/tools/fact-link-source.ts). */
  scopePath: string;
  graphitiFactUuid: string;
  sourceType: string;
  sourceRef: string;
  flaggedAt: Date;
}

/** The current version of a fact a task touched, as served. */
export interface ServedFact {
  /** The version's id, which a later write names as its `baseVersion`. */
  id: string;
  /** The entity the fact is about; null for a version stored without one. */
  entityName: string | null;
  /** The version's text, at most {@link FACT_TEXT_SERVED_CHARS} characters of it. */
  content: string;
  /** What the version is to the task, as its writer declared it; null when it declared none. */
  role: FactRole | null;
  /**
   * When the version was stored, as an ISO instant. The parts of one write share it, which is
   * how the block serves them together. Absent where it is not known.
   */
  writtenAt?: string;
  /** Set when the version must pass the erased-person check before it is served ({@link readServableTaskStart}). */
  erasureCheckDue?: boolean;
  /**
   * Set when the task itself wrote this version, as one of its own writes. Absent for a current
   * version another task or a person wrote under the same name and scope, which is served too.
   */
  ofTask?: true;
  /** Who recorded the version, as its create event says (services/memory/claim-status.ts); absent where not read. */
  by?: ClaimWriter;
  /** The session the version's create event recorded, or null for none; absent where not read. */
  sessionKey?: string | null;
  /** The scope the version is stored in; absent where not read. */
  scopePath?: string;
  /** Who stored the version, as `memory_chunks` records it: the writer the conflict rule compares (services/memory/conflict.ts). */
  writer?: StoredWriter;
  /** Who wrote the version, as the block names it ({@link writtenByLabelSql}); absent where not read. */
  writtenBy?: string;
  /**
   * Set when the winner rule retired the version, which is served only beside the versions it
   * conflicts with (services/memory/served-conflicts.ts). Absent on a current version.
   */
  retired?: true;
  /** Set when the version was read only because it shares a served fact's name and scope; served only in a conflict. */
  partner?: true;
}

/** A working note live now in the scope, as served. */
export interface ServedNote {
  id: string;
  agentId: string;
  scopePath: string;
  task: string;
  kind: WorkingNoteKind;
  body: string;
  expiresAt: Date;
  /** Whether the note is on the task the session names; never when it names none. */
  ofTask: boolean;
}

/** The working notes live now in the scope: the few served, and how many are live in all. */
export interface LiveNotes {
  /** Notes on the session's own task first, then the newest; at most {@link MAX_LIVE_NOTES}. */
  served: ServedNote[];
  /** Every live note in the scope, counted only within the scope the reader may read. */
  total: number;
}

/** Everything a session could be served, most relevant first in each list. */
export interface TaskStartContext {
  rules: ServedRule[];
  writes: ServedWrite[];
  stale: StaleFlag[];
  /**
   * How much each of the task's terms counted in ranking these lists, which the block uses
   * to pick each record's most relevant passage. Empty when the task names nothing.
   */
  weights?: TermWeights;
}

/** What earlier sessions of the named task left. */
export interface TaskContext {
  /** The decisions and conventions the task recorded, as the versions in force now, newest first. */
  decisions: ServedRule[];
  /**
   * The current versions of the facts the task wrote: those whose role decides the task
   * first, then those with no role, then progress (services/memory/fact-roles.ts); within each,
   * the newest source on the session's subject that quotes none of its text, then the writes most relevant to the session, the
   * newest first among equals, and a write restating the session's own text last
   * ({@link rankTaskFacts}), and the parts of one write together in the order they were written.
   */
  facts: ServedFact[];
  /**
   * How much each term of the session's text counts among the task's own writes
   * ({@link weighTaskFacts}): {@link facts} were ranked by these, less the terms every write
   * holds, and the block cuts each fact's excerpt around all of them. Absent, or empty, when the
   * session's text names nothing.
   */
  factWeights?: TermWeights;
  /**
   * The task's own captured session states, read apart from {@link facts}: what decides what the
   * block says of the task's tests (mcp/task-start-notice.ts). Absent where no read supplied them.
   */
  captures?: TaskCaptures;
}

/** The current versions the task itself stored under a captured session-state name, newest first. */
export interface TaskCaptures {
  /** At most {@link MAX_TASK_CAPTURES} of them, each read as {@link ServedFact} is. */
  read: ServedFact[];
  /** Whether {@link read} holds every one, rather than only the newest. */
  all: boolean;
}

/** The task-start context and, read in the same statement, which of its writes lost a conflict. */
export interface TaskStartRead {
  context: TaskStartContext;
  /** What the named task left; both lists are empty when the session named no task. */
  task: TaskContext;
  /** The working notes live now in the scope (services/memory/working-notes.ts). */
  notes: LiveNotes;
  /**
   * For each fact version a served write announced that a `supersedes` edge in
   * `fact_edges` has since retired, the version that retired it, keyed by the retired
   * version's id. The shape `supersedingVersions` (services/memory/superseded-facts.ts)
   * returns, so `markWritesAgainst` marks the writes exactly as the change feed does; null in
   * place of a version that reads as erased, which is not named.
   */
  winners: Map<string, string | null>;
  /**
   * The date each replacement in `winners` is served with, by retired version, as an ISO instant: the date its replacement is
   * served with (`occurredAt`, else when it was written, as memory_query and memory_version date
   * it), or the `supersedes` edge's own time when the replacement's row is gone. A served
   * write's mark says it (`markWritesAgainst`), so a history imported with its dates reads as it
   * happened, not as the day it was imported.
   */
  replacementDatedAt?: Map<string, string>;
  /**
   * The org's suppression list as it stood for this read: when its newest erasure was
   * recorded and how many entries it held, or null when the org never erased anyone. An
   * erased-person verdict on a fact holds until this changes ({@link readServableTaskStart}).
   */
  erasureMark: string | null;
  /**
   * What changed in the scope since the agent's last session, when this session is a return
   * and something did (services/memory/since-last-session.ts); null otherwise. Read before the
   * session's delivery is claimed, since the claim moves the agent's last call to now.
   */
  since: SinceLastSession | null;
}

/** Builds the ltree containment filter on one column for the scope being read. */
type WithinScope = (column: string) => Prisma.Sql;

/** Builds the expression saying whether a fact written at `createdAt` is due the erased-person check ({@link erasureCheckDueSql}). */
type ErasureCheckDue = (createdAt: string) => Prisma.Sql;

/**
 * Whether a fact must pass the erased-person check before it is served: it was written at or
 * before the org's latest erasure, so it may be a copy a restored backup put back
 * (services/memory/erasure-suppression.ts). The check reads the fact's whole text, which this
 * read does not: it is run on the records a block serves, and only those
 * ({@link readServableTaskStart}). The latest erasure is looked up once per statement.
 */
function erasureCheckDueSql(orgId: string): ErasureCheckDue {
  const latestErasure = Prisma.sql`(SELECT max("createdAt") FROM "erasure_suppressions" WHERE "orgId" = ${orgId})`;
  return (createdAt) => Prisma.sql`COALESCE(${Prisma.raw(createdAt)} <= ${latestErasure}, false)`;
}

/**
 * A LATERAL join giving `w."by"` and `w."sessionKey"` for the record whose id is in `idColumn`,
 * one row for every record:
 * who its create event says recorded it ("person" for a human, "agent", or "unknown" for any
 * other principal and for an event written before the type was recorded), and the session the
 * event recorded. What services/memory/claim-status.ts decides a claim's status from. Each is
 * one lookup by the record's id: a fact's create event by the index that keeps it unique, a
 * rule's by the partial index on rule creates.
 */
export function writtenBySql(orgId: string, recordType: string, idColumn: string): Prisma.Sql {
  // Aggregated, so a record with no create event still gets one row: "unknown", no session.
  return Prisma.sql`CROSS JOIN LATERAL (
      SELECT COALESCE(max(x."by"), 'unknown') AS "by", max(x."sessionKey") AS "sessionKey"
      FROM (
        SELECT CASE e."actorType" WHEN 'human' THEN 'person' WHEN 'agent' THEN 'agent' ELSE 'unknown' END AS "by",
               e."sessionKey"
        FROM "change_events" e
        WHERE e."orgId" = ${orgId} AND e."recordType" = ${recordType} AND e."recordId" = ${Prisma.raw(idColumn)} AND e."op" = 'create'
        ORDER BY e."seq" ASC
        LIMIT 1
      ) x
    ) w`;
}

/**
 * Who wrote the `memory_chunks` row `c`, as the block names it on the row's line
 * (mcp/task-start-notice.ts): a connected source by its type, an agent by the id it writes under
 * (the id recent writes already name it by), a person as "person", and any other writer, a
 * document upload or a seed, as "imported". A person is never named: the name a row stores is not
 * cleared when that person is erased, and a reader of the block needs only to know a person said it.
 *
 * A source is named only when its row is in the reader's org and scope (`within`); a source in a
 * scope the reader cannot read, and one whose row was deleted, are both "connector", so the line
 * never tells a hidden source from an absent one. A disconnected source keeps its row, so in the
 * reader's scope it is still named by its type: the type is what wrote the fact, not whether it
 * still syncs.
 */
function writtenByLabelSql(within: WithinScope): Prisma.Sql {
  return Prisma.sql`CASE
      WHEN c."sourceId" IS NOT NULL THEN COALESCE((
        SELECT src."type"::text FROM "sources" src
        WHERE src."orgId" = c."orgId" AND src."id" = c."sourceId" AND ${within('src."scopePath"')}
      ), 'connector')
      WHEN c."actorType" = 'agent' THEN COALESCE(NULLIF(btrim(c."actorId"), ''), 'agent')
      WHEN c."actorType" = 'human' THEN 'person'
      ELSE 'imported'
    END`;
}

/**
 * Who recorded the `conventions` row `c`, as the block names it, given `w."by"` from
 * {@link writtenBySql}: an agent by its id, a person as "person" ({@link writtenByLabelSql} says
 * why), and a rule whose create event names neither as "unknown".
 */
const RULE_WRITTEN_BY_SQL = Prisma.sql`CASE w."by" WHEN 'agent' THEN COALESCE(NULLIF(btrim(c."actorId"), ''), 'agent') WHEN 'person' THEN 'person' ELSE 'unknown' END`;

/**
 * A LATERAL join giving, for the `memory_chunks` row `c`, `s."superseded"`: whether a `supersedes`
 * edge retired it; and `s."retired"`: whether it was retired by losing a conflict to another
 * writer's version rather than replaced by a write based on it. The change feed says which: the
 * `supersede` event on a retired version opens with how (`supersessionOpening`,
 * services/memory/conflict.ts). Each is a lookup by the version's id, the events by the partial
 * (orgId, recordId) index on supersede events.
 */
function retiredSql(orgId: string): Prisma.Sql {
  const announced = (how: "superseded" | "replaced") => Prisma.sql`EXISTS (
      SELECT 1 FROM "change_events" x
      WHERE x."orgId" = ${orgId} AND x."recordType" = ${FACT_RECORD_TYPE} AND x."recordId" = c."id"
        AND x."op" = 'supersede' AND starts_with(x."summary", ${supersessionOpening(how)})
    )`;
  return Prisma.sql`CROSS JOIN LATERAL (
      SELECT e."superseded", e."superseded" AND ${announced("superseded")} AND NOT ${announced("replaced")} AS "retired"
      FROM (
        SELECT EXISTS (
          SELECT 1 FROM "fact_edges" e
          WHERE e."orgId" = ${orgId} AND e."toId" = c."id" AND e."kind" = 'supersedes'
        ) AS "superseded"
      ) e
    ) s`;
}

/**
 * The first {@link FACT_TEXT_SERVED_CHARS} characters of the text in `column`. A text of no
 * more bytes than that has no more characters either, and is taken as it is: counting
 * characters in UTF-8 costs more than matching them, and most facts are that short.
 */
function firstCharsSql(column: string): Prisma.Sql {
  return Prisma.sql`CASE WHEN octet_length(${Prisma.raw(column)}) <= ${FACT_TEXT_SERVED_CHARS} THEN ${Prisma.raw(column)}
    ELSE left(${Prisma.raw(column)}, ${FACT_TEXT_SERVED_CHARS}) END`;
}

/** The task sections of the task-start statement: the CTEs they read and the two columns they fill. */
interface TaskSectionsSql {
  with: Prisma.Sql;
  columns: Prisma.Sql;
}

/** A session that names no task reads none of the task's tables. */
const NO_TASK_SECTIONS: TaskSectionsSql = {
  with: Prisma.empty,
  columns: Prisma.sql`'[]'::json AS "taskDecisions", '[]'::json AS "taskFacts", json_build_object('read', '[]'::json, 'all', true) AS "taskCaptures"`,
};

/**
 * The task sections for the task named `taskKey`.
 *
 * They start from the task's newest writes in scope. A decision it recorded is followed
 * along `supersedesId` to the version in force now, and served only if that version is
 * still in force and in scope: a replacement can be stored in another scope. A fact it
 * wrote is (entity name, stored scope); every version of that fact no `supersedes` edge
 * points at is current, as memory_version reports it, and is served whoever wrote it. A version
 * that lost a conflict ({@link retiredSql}) is read as well, marked `retired`, and so are the
 * versions of a served fact the limit left out, marked `partner`, at most
 * {@link MAX_CONFLICT_PARTNERS} of them for each fact: the block serves either only inside a conflicting set
 * (services/memory/served-conflicts.ts). Each version carries who wrote it ({@link writtenByLabelSql}).
 * Those versions share the stored scope of the one the task wrote, so the scope filter on
 * the task's writes bounds them too. A version stored without an entity name is a fact of
 * its own. memory_ingest stores a rule's text as a fact as well; that copy is left out,
 * since the rule is served as the version in force, and its copy stays behind unchanged
 * when the rule is replaced.
 *
 * The facts are ordered by their role before their age ({@link factRoleTierSql}), and the
 * limit is taken after that ordering, so a decision written first is still served when the
 * task's later progress notes outnumber the limit. Versions stored at the same instant, the
 * parts of one write, come in the order the task's write events recorded them.
 *
 * A fact's text is read up to {@link FACT_TEXT_SERVED_CHARS} characters, all the block serves,
 * with whether it is due the erased-person check ({@link erasureCheckDueSql}).
 *
 * The task's captured session states are read again on their own, from every write of the task
 * rather than its newest {@link MAX_TASK_WRITES}, and past the facts' limit: what the task's
 * sessions ran is decided from all of them, not from the ones that happen to be served.
 */
function taskSectionsSql(
  orgId: string,
  taskKey: string,
  within: WithinScope,
  walked: WithinScope,
  checkDue: ErasureCheckDue,
): TaskSectionsSql {
  const roleTier = factRoleTierSql(Prisma.raw('c."role"'));
  return {
    with: Prisma.sql`
    WITH RECURSIVE task_writes AS (
      SELECT "recordType", "recordId", "seq"
      FROM "change_events"
      WHERE "orgId" = ${orgId}
        AND "task" = ${taskKey}
        AND "op" = 'create'
        AND ${walked('"scopePath"')}
      ORDER BY "seq" DESC
      LIMIT ${MAX_TASK_WRITES}
    ),
    task_rule_lineage("rootId", "id", "depth") AS (
      SELECT c."id", c."id", 0
      FROM "conventions" c
      JOIN task_writes t ON t."recordType" = ${CONVENTION_RECORD_TYPE} AND t."recordId" = c."id"
      WHERE c."orgId" = ${orgId}
      UNION ALL
      SELECT l."rootId", n."id", l."depth" + 1
      FROM task_rule_lineage l
      JOIN "conventions" n ON n."orgId" = ${orgId} AND n."supersedesId" = l."id"
    ),
    task_facts AS (
      SELECT v."id", v."entityName", v."scopePath"
      FROM "memory_chunks" v
      JOIN task_writes t ON t."recordType" = ${FACT_RECORD_TYPE} AND t."recordId" = v."id"
      WHERE v."orgId" = ${orgId}
    ),
    task_fact_versions AS (
      SELECT c."id"
      FROM task_facts t
      JOIN "memory_chunks" c
        ON c."orgId" = ${orgId} AND c."entityName" = t."entityName" AND c."scopePath" = t."scopePath"
      UNION
      SELECT "id" FROM task_facts WHERE "entityName" IS NULL
    ),
    task_fact_candidates AS (
      SELECT c."id", c."entityName", ${firstCharsSql('c."content"')} AS "content", c."role", c."createdAt", ${roleTier} AS "roleTier",
             c."scopePath", c."actorType", c."actorId", w."by", w."sessionKey",
             ${writtenByLabelSql(within)} AS "writtenBy",
             ${checkDue('c."createdAt"')} AS "erasureCheckDue",
             -- Where the task's own write stored this version: the order a write split
             -- into parts at one instant was written in.
             (SELECT min(t."seq") FROM task_writes t
               WHERE t."recordType" = ${FACT_RECORD_TYPE} AND t."recordId" = c."id") AS "writtenSeq",
             s."retired"
      FROM "memory_chunks" c
      ${writtenBySql(orgId, FACT_RECORD_TYPE, 'c."id"')}
      ${retiredSql(orgId)}
      WHERE c."id" IN (SELECT "id" FROM task_fact_versions)
        AND NOT EXISTS (
          SELECT 1 FROM "conventions" r
          WHERE r."orgId" = c."orgId" AND r."scopePath" = c."scopePath"
            AND r."subject" = c."entityName" AND r."text" = c."content"
        )
        AND (s."retired" OR NOT s."superseded")
    ),
    -- Only current versions compete for the limit, as before retired ones were read: a version
    -- that lost a conflict is read only as a partner of a picked one.
    task_fact_picked AS (
      SELECT * FROM task_fact_candidates
      WHERE NOT "retired"
      ORDER BY "roleTier", "createdAt" DESC, "writtenSeq" ASC NULLS LAST, "id" COLLATE "C" DESC
      LIMIT ${MAX_TASK_FACTS}
    ),
    -- The other versions of a picked fact, which the limit left out: a conflict is served whole
    -- or not at all (services/memory/served-conflicts.ts).
    task_fact_partners AS (
      SELECT "id", "entityName", "content", "role", "createdAt", "roleTier", "scopePath", "actorType", "actorId",
             "by", "sessionKey", "writtenBy", "erasureCheckDue", "writtenSeq", "retired"
      FROM (
        SELECT c.*, row_number() OVER (
                 PARTITION BY c."entityName", c."scopePath" ORDER BY c."createdAt" DESC, c."id" COLLATE "C" DESC
               ) AS "partnerRank"
        FROM task_fact_candidates c
        WHERE c."entityName" IS NOT NULL
          AND c."id" NOT IN (SELECT "id" FROM task_fact_picked)
          AND EXISTS (
            SELECT 1 FROM task_fact_picked p
            WHERE p."entityName" = c."entityName" AND p."scopePath" = c."scopePath"
          )
      ) ranked
      WHERE "partnerRank" <= ${MAX_CONFLICT_PARTNERS}
    )
    `,
    columns: Prisma.sql`
      (SELECT COALESCE(json_agg(json_build_object(
                'id', d."id", 'kind', d."kind", 'subject', d."subject", 'text', d."text"
                , 'ofTask', d."ofTask", 'by', d."by", 'sessionKey', d."sessionKey", 'scopePath', d."scopePath", 'writtenBy', d."writtenBy",
                'writtenAt', to_char(d."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
              ) ORDER BY d."createdAt" DESC, d."id" COLLATE "C" DESC), '[]'::json)
         FROM (
           SELECT c."id", c."kind", c."subject", c."text", c."createdAt", c."scopePath", w."by", w."sessionKey",
                  ${RULE_WRITTEN_BY_SQL} AS "writtenBy",
                  EXISTS (SELECT 1 FROM task_writes t WHERE t."recordType" = ${CONVENTION_RECORD_TYPE} AND t."recordId" = c."id") AS "ofTask"
           FROM "conventions" c
           ${writtenBySql(orgId, CONVENTION_RECORD_TYPE, 'c."id"')}
           WHERE c."id" IN (
               SELECT DISTINCT ON ("rootId") "id" FROM task_rule_lineage ORDER BY "rootId", "depth" DESC
             )
             AND c."supersededById" IS NULL
             AND c."retiredAt" IS NULL
             AND ${within('c."scopePath"')}
           ORDER BY c."createdAt" DESC, c."id" COLLATE "C" DESC
           LIMIT ${MAX_TASK_DECISIONS}
         ) d) AS "taskDecisions",
      (SELECT COALESCE(json_agg(json_build_object(
                'id', f."id", 'entityName', f."entityName", 'content', f."content", 'role', f."role",
                'erasureCheckDue', f."erasureCheckDue", 'ofTask', f."writtenSeq" IS NOT NULL,
                'by', f."by", 'sessionKey', f."sessionKey", 'scopePath', f."scopePath",
                'writer', json_build_object('actorType', f."actorType", 'actorId', f."actorId"),
                'writtenBy', f."writtenBy", 'retired', f."retired", 'partner', f."partner",
                -- Stored as UTC without a zone, spelled out so it parses back to the same instant.
                'writtenAt', to_char(f."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
              ) ORDER BY f."partner", f."roleTier", f."createdAt" DESC, f."writtenSeq" ASC NULLS LAST, f."id" COLLATE "C" DESC), '[]'::json)
         FROM (
           SELECT *, false AS "partner" FROM task_fact_picked
           UNION ALL
           SELECT *, true AS "partner" FROM task_fact_partners
         ) f) AS "taskFacts",
      (SELECT json_build_object(
                'read', COALESCE(json_agg(json_build_object(
                  'id', k."id", 'entityName', k."entityName", 'content', k."content", 'role', k."role",
                  'erasureCheckDue', k."erasureCheckDue", 'ofTask', true,
                  'by', k."by", 'sessionKey', k."sessionKey", 'scopePath', k."scopePath",
                  'writtenAt', to_char(k."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                ) ORDER BY k."createdAt" DESC, k."id" COLLATE "C" DESC) FILTER (WHERE k."rank" <= ${MAX_TASK_CAPTURES}), '[]'::json),
                'all', count(*) <= ${MAX_TASK_CAPTURES})
         FROM (
           SELECT c."id", c."entityName", ${firstCharsSql('c."content"')} AS "content", c."role", c."createdAt",
                  ${checkDue('c."createdAt"')} AS "erasureCheckDue", c."scopePath", w."by", w."sessionKey",
                  row_number() OVER (ORDER BY c."createdAt" DESC, c."id" COLLATE "C" DESC) AS "rank"
           FROM "memory_chunks" c
           ${writtenBySql(orgId, FACT_RECORD_TYPE, 'c."id"')}
           WHERE c."orgId" = ${orgId}
             AND c."role"::text = 'progress'
             AND c."entityName" LIKE ${`${SESSION_STATE_NAME_OPENING}%`}
             AND ${within('c."scopePath"')}
             AND c."id" IN (
               SELECT "recordId" FROM "change_events"
               WHERE "orgId" = ${orgId} AND "task" = ${taskKey} AND "op" = 'create'
                 AND "recordType" = ${FACT_RECORD_TYPE} AND ${within('"scopePath"')}
             )
             AND NOT EXISTS (
               SELECT 1 FROM "fact_edges" e
               WHERE e."orgId" = c."orgId" AND e."toId" = c."id" AND e."kind" = 'supersedes'
             )
           ORDER BY c."createdAt" DESC, c."id" COLLATE "C" DESC
           LIMIT ${MAX_TASK_CAPTURES + 1}
         ) k) AS "taskCaptures"
    `,
  };
}

/** A task fact as the statement returns it, with when it was written and whether the task wrote it. */
interface TaskFactRow extends Omit<ServedFact, "ofTask" | "retired" | "partner"> {
  writtenAt: string;
  erasureCheckDue: boolean;
  ofTask: boolean;
  /** Absent on a captured session state, which is read without them. */
  retired?: boolean;
  partner?: boolean;
}

/** A task decision as the statement returns it, with whether the task wrote the version in force. */
interface TaskDecisionRow extends Omit<ServedRule, "ofTask"> {
  ofTask: boolean;
}

/** A recent write as the statement returns it, with the fact version it created when it matched the task. */
interface WriteRow extends Omit<ServedWrite, "summaryCheckDue" | "ofTask" | "writtenAt"> {
  /** Whether the write was recorded for the task the session names ({@link ServedWrite.ofTask}). */
  ofTask: boolean;
  supersededById: string | null;
  /** The date `supersededById` is served with, as an ISO instant ({@link TaskStartRead.replacementDatedAt}); null when nothing replaced it. */
  replacementDatedAt?: string | null;
  /** 1 for the scope's newest write, counting every write the read considered. */
  recency: number;
  /** The created version's text, up to {@link FACT_TEXT_SERVED_CHARS} characters; null for any other write. */
  factContent: string | null;
  /** Whether the created version is due the erased-person check ({@link erasureCheckDueSql}). */
  erasureCheckDue: boolean;
  /** Whether the write's own summary is due the erased-person check ({@link ServedWrite.summaryCheckDue}). */
  summaryCheckDue: boolean;
  /** When the write was recorded, as an ISO instant. */
  writtenAt: string;
}

/** A record as ranked: what is served, and how often each term occurs in what it is ranked by (services/memory/relevance.ts). */
interface Candidate<T> {
  item: T;
  terms: TermCounts;
}

/** A rule, its text cut to {@link FACT_TEXT_SERVED_CHARS} characters, ranked by its subject and that text. */
function ruleCandidate(rule: ServedRule): Candidate<ServedRule> {
  const text = rankedText(rule.text);
  return { item: { ...rule, text }, terms: termCountsOf(`${rule.subject} ${text}`) };
}

/** The task's facts in the order read, each cut to {@link FACT_TEXT_SERVED_CHARS} characters. */
function taskFactsOf(rows: TaskFactRow[]): ServedFact[] {
  return rows.map((row) => ({
    id: row.id,
    entityName: row.entityName,
    role: row.role,
    content: rankedText(row.content),
    writtenAt: row.writtenAt,
    ...(row.erasureCheckDue ? { erasureCheckDue: true } : {}),
    ...(row.ofTask ? { ofTask: true as const } : {}),
    ...(row.by === undefined ? {} : { by: row.by, sessionKey: row.sessionKey ?? null }),
    ...(row.scopePath === undefined ? {} : { scopePath: row.scopePath }),
    ...(row.writer === undefined ? {} : { writer: row.writer }),
    ...(row.writtenBy === undefined ? {} : { writtenBy: row.writtenBy }),
    ...(row.retired ? { retired: true as const } : {}),
    ...(row.partner ? { partner: true as const } : {}),
  }));
}

/**
 * The task's facts as the writes that stored them: runs of facts stored at the same instant,
 * under the same name and role by the same writer, the parts one long write was split into. Two
 * writers' versions stored in one millisecond are two writes, never one. `facts` arrive with
 * the parts of one write next to each other, in the order they were written. A fact whose time
 * is unknown is a write of its own.
 */
export function writesOf(facts: readonly ServedFact[]): ServedFact[][] {
  const writes: ServedFact[][] = [];
  for (const fact of facts) {
    const current = writes.at(-1);
    const first = current?.[0];
    const samePart =
      first !== undefined &&
      first.writtenAt !== undefined &&
      fact.writtenAt === first.writtenAt &&
      fact.entityName === first.entityName &&
      fact.role === first.role &&
      fact.writer?.actorType === first.writer?.actorType &&
      // A version with no recorded writer is a write of its own: nothing shows two share one.
      (fact.writer === undefined || (fact.writer.actorId ?? null) !== null) &&
      fact.writer?.actorId === first.writer?.actorId;
    if (samePart) current!.push(fact);
    else writes.push([fact]);
  }
  return writes;
}

/** The term counts of a write's text, all its parts together. */
function writeTermsOf(write: readonly ServedFact[]): TermCounts {
  return termCountsOf(write.map((fact) => fact.content).join("\n"));
}

/** The task's writes whose text may decide how the others are weighed: none due the erased-person check. */
function weighableWrites(facts: readonly ServedFact[]): TermCounts[] {
  return writesOf(facts.filter((fact) => !fact.erasureCheckDue)).map(writeTermsOf);
}

/**
 * How much each term of `taskText` counts in ranking the task's own facts, and in cutting their
 * excerpts: weighed among the task's writes ({@link writesOf}), each by all its parts' text, as
 * {@link weighTaskTerms} weighs the scope's other records. A write due the erased-person check
 * takes no part, so a fact the check later withholds cannot change how the others are ranked or
 * cut. `taskKey` is the task's name within `taskText`.
 */
export function weighTaskFacts(taskText: string, facts: readonly ServedFact[], taskKey = ""): TermWeights {
  return weighTaskTerms(taskText, weighableWrites(facts), { name: taskKey });
}

/**
 * `weights` without the terms every one of two or more of the task's writes holds: such a term
 * says nothing about which write the session needs, and weighed at all, the repository and pull
 * request a whole import repeats would order the writes by their length. Only for ranking; an
 * excerpt is still cut around every term.
 */
function tellingWeights(facts: readonly ServedFact[], weights: TermWeights): TermWeights {
  const counts = weighableWrites(facts);
  // With fewer than two writes to compare, no term can be shown to say nothing.
  if (counts.length < 2) return weights;
  const telling = [...weights.byTerm].filter(([term]) => !counts.every((write) => write.has(term)));
  return telling.length === weights.byTerm.size ? weights : { ...weights, byTerm: new Map(telling) };
}

/** The first link a text cites: what every part of one source split into several writes repeats. */
const SOURCE_LINK = /https?:\/\/[^\s<>()[\]"'`]+/;

function sourceLinkOf(write: readonly ServedFact[]): string | undefined {
  return SOURCE_LINK.exec(write[0]!.content)?.[0];
}

/**
 * `writes` (newest first) cut into sources: each write, with the writes just before it under the
 * same name that cite the same first link. Those are the parts one long source (a review comment,
 * a document) was written in, one write after another; a write that cites no link is a source of
 * its own.
 */
function sourcesOf<T extends { write: readonly ServedFact[] }>(writes: readonly T[]): T[][] {
  const sources: T[][] = [];
  for (const write of writes) {
    const source = sources.at(-1);
    const head = source?.[0]!.write;
    const link = sourceLinkOf(write.write);
    if (
      head !== undefined &&
      link !== undefined &&
      head[0]!.entityName === write.write[0]!.entityName &&
      sourceLinkOf(head) === link
    ) {
      source!.push(write);
    } else {
      sources.push([write]);
    }
  }
  return sources;
}

/** A clause of the session's text this short ("## Summary", a task key) is not a quote of it. */
const MIN_QUOTED_WORDS = 4;

/** `text` as lower-case words between single spaces, padded, so a phrase is found only whole. */
const phraseOf = (text: string) =>
  ` ${text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()} `;

/** Where a clause of the session's text ends: a line, a colon, a semicolon, a sentence's end. */
const CLAUSE_END = /\n|[:;!?]|\.(?=\s|$)/;

/** A clause of the session's text, as a phrase and as the terms a write must hold to quote it. */
interface Quotable {
  phrase: string;
  terms: string[];
}

/**
 * The clauses of the session's text a write can quote: its title, a sentence of its
 * description. A write that holds one whole restates what the session was just told.
 */
function quotableClausesOf(sessionText: string): Quotable[] {
  return sessionText
    .split(CLAUSE_END)
    .filter((clause) => phraseOf(clause).trim().split(" ").length >= MIN_QUOTED_WORDS)
    .map((clause) => ({ phrase: phraseOf(clause), terms: [...termsOf(clause)] }));
}

/**
 * Whether a write quotes one of `quotable` whole. Its terms are checked first, so the text of a
 * write that cannot hold the clause is never normalized.
 */
function quotesSession(quotable: readonly Quotable[], text: string, terms: TermCounts): boolean {
  let phrase: string | undefined;
  return quotable.some(
    (clause) => clause.terms.every((term) => terms.has(term)) && (phrase ??= phraseOf(text)).includes(clause.phrase),
  );
}

/**
 * The task's facts in the order the block serves them, by the tier of the role their writer
 * declared (services/memory/fact-roles.ts), and within a tier:
 * - first, the newest source ({@link sourcesOf}) on the session's subject that quotes none of
 *   the session's text, its parts in the order written: it is where the task stands now, the
 *   latest review or progress. On the subject means it holds a term of the session's text that
 *   tells the writes apart. A newer source on something else (an acknowledgement, a bot's note)
 *   or one quoting the session does not take the lead, and does not stop an older one taking it;
 * - then every other write by its relevance to the session (BM25 over `weights`,
 *   services/memory/relevance.ts), newest first among equals;
 * - last, a write that quotes a clause of `sessionText` whole: the pull request or brief the
 *   session was started from, which holds every term of the session and tells it nothing.
 * The parts of a write stay together, in the order they were written. This orders the task's
 * facts; it never decides which facts are the task's.
 */
export function rankTaskFacts(facts: readonly ServedFact[], weights: TermWeights, sessionText = ""): ServedFact[] {
  const ranking = tellingWeights(facts, weights);
  const quotable = quotableClausesOf(sessionText);
  const scored = writesOf(facts).map((write, read) => {
    const terms = writeTermsOf(write);
    const echo = quotesSession(quotable, write.map((fact) => fact.content).join("\n"), terms);
    return { write, read, tier: factRoleTier(write[0]!.role), score: relevanceOf(ranking, terms), echo };
  });
  const tiers = [...new Set(scored.map(({ tier }) => tier))].sort((a, b) => a - b);
  return tiers.flatMap((tier) => {
    // Facts are read newest first within a tier, so its writes arrive newest first too.
    const writes = scored.filter((write) => write.tier === tier);
    const lead =
      sourcesOf(writes).find((source) => source.some(({ score }) => score > 0) && !source.some(({ echo }) => echo)) ??
      [];
    const rest = writes
      .filter((write) => !lead.includes(write))
      .sort((a, b) => Number(a.echo) - Number(b.echo) || b.score - a.score || a.read - b.read);
    return [...lead.reverse(), ...rest].flatMap(({ write }) => write);
  });
}

/** The task's decisions in the order read, each marked when the task wrote the version in force. */
function taskDecisionsOf(rows: TaskDecisionRow[]): ServedRule[] {
  return rows.map(({ ofTask, ...decision }) => (ofTask ? { ...decision, ofTask: true as const } : decision));
}

/** A recent write as ranked, with the terms of its record id and summary alone, and how recent it is. */
interface WriteCandidate extends Candidate<ServedWrite> {
  labelTerms: ReadonlySet<string>;
  recency: number;
}

/**
 * A recent write, ranked by its record id and summary. A write that created a fact version
 * also carries that version's text, cut to {@link FACT_TEXT_SERVED_CHARS} characters, and is
 * ranked by it too, and whether that version is due the erased-person check.
 */
function writeCandidate(row: WriteRow): WriteCandidate {
  const { factContent } = row;
  const write: ServedWrite = {
    id: row.id,
    recordType: row.recordType,
    recordId: row.recordId,
    op: row.op,
    actorId: row.actorId,
    summary: row.summary,
    writtenAt: row.writtenAt,
    ...(row.erasureCheckDue ? { erasureCheckDue: true } : {}),
    ...(row.summaryCheckDue ? { summaryCheckDue: { writtenAt: row.writtenAt } } : {}),
    ...(row.ofTask ? { ofTask: true as const } : {}),
  };
  const label = `${write.recordId} ${write.summary}`;
  const labelTerms = termsOf(label);
  const { recency } = row;
  if (factContent === null) return { item: write, terms: termCountsOf(label), labelTerms, recency };
  const content = rankedText(factContent);
  return { item: { ...write, content }, terms: termCountsOf(`${label} ${content}`), labelTerms, recency };
}

/**
 * The recent writes to serve. A task that names nothing is served its newest few as they
 * came. Otherwise a write is served when it is about the task ({@link isAboutTheTask}), or,
 * among the scope's {@link MAX_RECENT_WRITES} newest, when its summary or record id holds a
 * task term. One passing mention of one of the task's words, deep in a long text, is not
 * enough to spend the block on. Only a write about the task keeps its text, to be served by
 * its passage; any other is served by its summary. The served writes come most relevant
 * first, and the newest first among equals: `writes` arrive newest first.
 */
function rankWrites(writes: WriteCandidate[], weights: TermWeights): ServedWrite[] {
  if (weights.byTerm.size === 0) return writes.map(({ item }) => item);
  const about = ({ terms }: WriteCandidate) => isAboutTheTask(weights, terms);
  const mentions = (write: WriteCandidate) =>
    about(write) || (write.recency <= MAX_RECENT_WRITES && holdsATaskTerm(weights, write.labelTerms));
  return rankByRelevance(writes.filter(mentions), weights, ({ terms }) => terms).map((write) => {
    if (about(write) || write.item.content === undefined) return write.item;
    const { content: _passingMention, ...summaryOnly } = write.item;
    return summaryOnly;
  });
}

/**
 * A Postgres regular expression matching any of `terms` as a whole term: not preceded or
 * followed by a letter or digit. Every character that is not a letter or digit is escaped,
 * so a term is always matched literally. Matched with `~*`, which ignores case without
 * copying the text the way lower() does.
 */
function wholeTermPattern(terms: readonly string[]): string {
  const literal = (term: string) => term.replace(/[^\p{L}\p{N}]/gu, "\\$&");
  return `(^|[^[:alnum:]])(${terms.map(literal).join("|")})($|[^[:alnum:]])`;
}

/** The most names of the task's own records that widen its query ({@link relatedNamesOf}). */
const MAX_RELATED_NAMES = 40;

/**
 * The names ({@link namesIn}) the task's own records hold, the first {@link MAX_RELATED_NAMES}
 * in the order written, as one text: the files, ids and keys earlier sessions of the task wrote
 * down, which a rule or write about the same work is likely to name too.
 */
function relatedNamesOf(texts: readonly string[]): string {
  const names = new Set<string>();
  for (const text of texts) {
    for (const name of namesIn(rankedText(text))) {
      if (names.size === MAX_RELATED_NAMES) return [...names].join(" ");
      names.add(name);
    }
  }
  return [...names].join(" ");
}

/**
 * What a session starting work within `scopePath` could be served, for a task described by
 * `taskText`, all in one statement: the scope's rules, in the order {@link orderRules} gives
 * them; its recent writes that mention the task, or, when the task names nothing, the few
 * newest; its newest stale flags; which of the served writes announced a fact version a
 * conflict has since retired; and what earlier sessions of the task named `taskKey` left.
 * An empty `taskKey` names no task.
 *
 * Unchecked: what this returns may include records an erasure withholds. The caller must
 * already have been allowed to read `scopePath`, since this function reads but does not
 * authorize, and it does not run the erased-person check: a fact naming a person erased from
 * the org, put back by a restored backup, comes back here like any other. Anything shown to
 * an agent or measured as what an agent sees is read with {@link readServableTaskStart},
 * which runs that check on what is served.
 *
 * A task's writes are matched by the exact key, inside `scopePath` only: the same key on
 * a write in a sibling scope or another org is a different task's as far as this reader
 * is concerned.
 */
export async function readTaskStartUnchecked(
  ctx: AccessContext,
  scopePath: string,
  taskText: string,
  taskKey = "",
): Promise<TaskStartRead> {
  const terms = [...termsOf(taskText)];
  const namedByTask = [...namesIn(taskText)];
  const wholeTerms = wholeTermPattern(terms);
  // The terms that decide what is about the task (ownTermsOf): its name's, when it is named.
  const wholeOwnTerms = wholeTermPattern([...ownTermsOf(taskText, taskKey)]);
  const checkDue = erasureCheckDueSql(ctx.orgId);
  const within = (column: string) =>
    scopeContainsSql(Prisma.raw(column), scopePath, { relation: "within", mode: "ltree" });
  // The same test, for the walks of an index that is not by scope: the org's events by seq and
  // by task, its rules by createdAt. Why, and where not to use it: scopeWithinWalkedSql.
  const walked = (column: string) => scopeWithinWalkedSql(Prisma.raw(column), scopePath);

  // One statement, so the block needs one pooled connection and one round trip. Three
  // queries in parallel take one round trip on a warm pool, but a pool holding fewer
  // idle connections (a new serverless instance, or one idle past the pool's timeout)
  // first opens a connection for each extra query, and opening one costs more than the
  // reads. Each section keeps its own ORDER BY and LIMIT, and json_agg is ordered the
  // same way, so every list arrives exactly as a separate query returned it
  // (mcp/task-start-latency.realdb.test.ts compares the two). The one more read is the
  // org's erasure suppression list, and only when there is fact text to check. The counts of
  // what changed since the agent's last session ride in the same statement, as one column
  // (services/memory/since-last-session.ts).
  //
  // Rules in force only: a rule some other row supersedes is history, a rule that lost
  // a race to replace one was never in force, and a retired rule left service. A rule the
  // task names by its id or subject is read however old it is; the rest, newest first, by
  // index (rulesInForce below).
  // A task that names nothing is served only the newest few writes, so only those are read.
  //
  // A task that names terms is served the writes that hold one. They are looked for among
  // the scope's newest MAX_CANDIDATE_WRITES events, walked by the (orgId, seq) index, and a
  // write among the newest MAX_RECENT_WRITES that created a fact version is matched on
  // that version's text as well as its summary, the version read by its primary key, one
  // candidate at a time (LATERAL, so no plan filters the org's whole fact table), and only
  // inside the scope being read. A
  // term matches whole, bounded by characters that are not letters or digits, so "rota" does
  // not match "rotation" and "fix" does not match "prefix"; and the text is matched only on
  // its first FACT_TEXT_SERVED_CHARS characters, all the ranking reads, so a large fact costs
  // no more to match than a small one. The newest MAX_RECENT_WRITES come first, as the ranking
  // serves a passing mention only from them; within them, writes whose summary or record id
  // matches come before writes matched by their text alone, and the newest first within each;
  // MAX_MATCHING_WRITES of them are read back with their text. Before all of that, a write that
  // holds one of the task's own terms (ownTermsOf) comes before one matched only by the rest
  // of the ranking text, ordered among themselves exactly as the task's own terms alone would
  // order them: what the session is doing can add writes to the candidates, never push out
  // one the task's name finds.
  //
  // Each write that announced a fact version carries the version that retired it, if a
  // conflict has since: the first `supersedes` edge recorded against it, the same lookup
  // as supersedingVersions (services/memory/superseded-facts.ts). It is looked up after
  // the LIMIT, so at most the served candidates are checked, each by the
  // (orgId, toId, kind) index.
  //
  // A write about a fact version a later removal took out of storage is left out: its
  // create would announce a fact that does not exist. A removal is a delete, or a
  // supersede of a version that is no longer stored: a person's correction or a
  // connector item's upstream edit, each of which removes the old version (a connector
  // item is never a `memory_chunks` row at all) and writes its replacement as a create of
  // its own. Both record a `supersedes` edge to the old version too, so the edge alone
  // does not tell them apart from a conflict's supersede, which keeps the losing version
  // stored: its create stays, served marked as above. The removal's own event never
  // ranks beside the create (a delete carries no summary), and it may be recorded in a
  // scope above this one, so it is looked up across the org, among events newer than the
  // write, by the partial (orgId, recordId) index on delete and supersede events, and
  // only for the served candidates; the stored row by its primary key.
  //
  // The task's own sections are described at taskSectionsSql. A session that names no
  // task skips them, so it costs what the block cost before tasks were read.
  const recentWrites = Prisma.sql`
    SELECT "id", "seq", "recordType", "recordId", "op", "actorId", "summary",
           ("summary" <> '' AND ${checkDue('"createdAt"')}) AS "summaryCheckDue",
           ${taskKey === "" ? Prisma.sql`false` : Prisma.sql`COALESCE("task" = ${taskKey}, false)`} AS "ofTask",
           -- Stored as UTC without a zone, spelled out so it parses back to the same instant.
           to_char("createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "writtenAt",
           row_number() OVER (ORDER BY "seq" DESC) AS "recency"
    FROM "change_events"
    WHERE "orgId" = ${ctx.orgId}
      AND "recordType" NOT IN (${CONVENTION_RECORD_TYPE}, ${WORKING_NOTE_RECORD_TYPE})
      AND ${walked('"scopePath"')}
    ORDER BY "seq" DESC
    LIMIT ${terms.length === 0 ? WRITES_WITHOUT_TASK_TERMS : MAX_CANDIDATE_WRITES}
  `;
  const matchingWrites =
    terms.length === 0
      ? Prisma.sql`
        SELECT p.*, NULL::text AS "factContent", false AS "erasureCheckDue"
        FROM (${recentWrites}) p`
      : Prisma.sql`
        SELECT p.*, ${firstCharsSql('m."content"')} AS "factContent", ${checkDue('m."createdAt"')} AS "erasureCheckDue"
        FROM (${recentWrites}) p
        LEFT JOIN LATERAL (
          SELECT "content", "entityName", "createdAt" FROM "memory_chunks"
          WHERE p."recordType" = ${FACT_RECORD_TYPE} AND p."op" IN ('create', 'update')
            AND "orgId" = ${ctx.orgId} AND "id" = p."recordId" AND ${within('"scopePath"')}
          -- At most one row by the primary key; the LIMIT also keeps the planner from turning
          -- this lookup into a join over every fact in the org.
          LIMIT 1
        ) m ON true
        CROSS JOIN LATERAL (
          SELECT (p."recordId" || ' ' || p."summary") ~* ${wholeTerms} AS "labelMatches",
                 (p."recordId" || ' ' || p."summary") ~* ${wholeOwnTerms} AS "labelHoldsOwn"
        ) l
        WHERE l."labelMatches"
           OR (p."recency" <= ${MAX_RECENT_WRITES} AND ${firstCharsSql('m."content"')} ~* ${wholeTerms})
        ORDER BY (l."labelHoldsOwn"
                  OR (p."recency" <= ${MAX_RECENT_WRITES} AND ${firstCharsSql('m."content"')} ~* ${wholeOwnTerms})) DESC,
                 p."recency" <= ${MAX_RECENT_WRITES} DESC, l."labelHoldsOwn" DESC, l."labelMatches" DESC, p."seq" DESC
        LIMIT ${MAX_MATCHING_WRITES}`;
  // A note is live until it expires or is released, decided here at read time; recent
  // writes leave out the change events notes write, so an ended note is never served
  // as run state.
  const liveNoteInScope = Prisma.sql`
    "orgId" = ${ctx.orgId} AND "releasedAt" IS NULL AND "expiresAt" > ${sqlUtcNow} AND ${within('"scopePath"')}
  `;
  // The scope's rules in force, those `which` admits, newest first: a walk of the
  // (orgId, createdAt) index that stops at MAX_CANDIDATE_RULES.
  const rulesInForce = (which: Prisma.Sql) => Prisma.sql`
    SELECT c."id", c."kind", c."subject", c."text", c."createdAt", w."by", ${RULE_WRITTEN_BY_SQL} AS "writtenBy"
    FROM "conventions" c
    ${writtenBySql(ctx.orgId, CONVENTION_RECORD_TYPE, 'c."id"')}
    WHERE c."orgId" = ${ctx.orgId}
      AND ${walked('c."scopePath"')}
      AND c."supersededById" IS NULL
      AND c."retiredAt" IS NULL
      AND NOT EXISTS (SELECT 1 FROM "conventions" s WHERE s."supersedesId" = c."id")
      AND ${which}
    ORDER BY c."createdAt" DESC, c."id" COLLATE "C" DESC
    LIMIT ${MAX_CANDIDATE_RULES}
  `;
  // A rule the task names is looked for only when the task names one, since no index finds
  // it: the scope's rules are read once to match it, and the newest are still an index walk.
  const namedRule = Prisma.sql`(lower(c."id") = ANY (${namedByTask}::text[]) OR lower(btrim(c."subject")) = ANY (${namedByTask}::text[]))`;
  const candidateRules =
    namedByTask.length === 0
      ? rulesInForce(Prisma.sql`true`)
      : Prisma.sql`
        SELECT "id", "kind", "subject", "text", "createdAt", "by", "writtenBy" FROM (
          SELECT *, true AS "named" FROM (${rulesInForce(namedRule)}) n
          UNION ALL
          SELECT *, false AS "named" FROM (${rulesInForce(Prisma.sql`${namedRule} IS NOT TRUE`)}) o
        ) u
        ORDER BY "named" DESC, "createdAt" DESC, "id" COLLATE "C" DESC
        LIMIT ${MAX_CANDIDATE_RULES}`;
  const taskSections =
    taskKey === "" ? NO_TASK_SECTIONS : taskSectionsSql(ctx.orgId, taskKey, within, walked, checkDue);
  const query = Prisma.sql`
    ${taskSections.with}
    SELECT
      ${taskSections.columns},
      (SELECT COALESCE(json_agg(json_build_object(
                'id', r."id", 'kind', r."kind", 'subject', r."subject", 'text', r."text", 'by', r."by",
                'writtenBy', r."writtenBy", 'writtenAt', to_char(r."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
              ) ORDER BY r."createdAt" DESC, r."id" COLLATE "C" DESC), '[]'::json)
         FROM (${candidateRules}) r) AS "rules",
      (SELECT COALESCE(json_agg(json_build_object(
                'id', w."id", 'recordType', w."recordType", 'recordId', w."recordId",
                'op', w."op", 'actorId', w."actorId", 'summary', w."summary", 'recency', w."recency",
                'factContent', w."factContent", 'erasureCheckDue', w."erasureCheckDue",
                'summaryCheckDue', w."summaryCheckDue", 'writtenAt', w."writtenAt", 'ofTask', w."ofTask",
                'supersededById', CASE
                  WHEN w."recordType" = ${FACT_RECORD_TYPE} AND w."op" IN ('create', 'update') THEN (
                    SELECT e."fromId" FROM "fact_edges" e
                    WHERE e."orgId" = ${ctx.orgId} AND e."kind" = 'supersedes' AND e."toId" = w."recordId"
                    ORDER BY e."createdAt" ASC, e."id" ASC
                    LIMIT 1
                  )
                END,
                'replacementDatedAt', CASE
                  WHEN w."recordType" = ${FACT_RECORD_TYPE} AND w."op" IN ('create', 'update') THEN (
                    SELECT to_char(COALESCE(r."occurredAt", r."createdAt", e."createdAt"), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                    FROM "fact_edges" e
                    LEFT JOIN "memory_chunks" r ON r."orgId" = e."orgId" AND r."id" = e."fromId"
                    WHERE e."orgId" = ${ctx.orgId} AND e."kind" = 'supersedes' AND e."toId" = w."recordId"
                    ORDER BY e."createdAt" ASC, e."id" ASC
                    LIMIT 1
                  )
                END
              ) ORDER BY w."seq" DESC), '[]'::json)
         FROM (${matchingWrites}) w
         WHERE NOT EXISTS (
           SELECT 1 FROM "change_events" d
           WHERE d."orgId" = ${ctx.orgId} AND d."seq" > w."seq"
             AND d."recordType" = ${FACT_RECORD_TYPE} AND d."recordId" = w."recordId"
             AND d."op" IN ('delete', 'supersede')
             AND (d."op" = 'delete' OR NOT EXISTS (
               SELECT 1 FROM "memory_chunks" kept
               WHERE kept."id" = w."recordId" AND kept."orgId" = ${ctx.orgId}
             ))
         )) AS "writes",
      (SELECT COALESCE(json_agg(json_build_object(
                'id', n."id", 'agentId', n."agentId", 'scopePath', n."scopePath", 'task', n."task", 'kind', n."kind", 'body', n."body",
                'expiresAt', to_char(n."expiresAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'ofTask', n."ofTask"
              ) ORDER BY n."position"), '[]'::json)
         FROM (
           SELECT "id", "agentId", "scopePath", "task", "kind", "body", "expiresAt", "ofTask",
                  row_number() OVER (ORDER BY "ofTask" DESC, "createdAt" DESC, "id" COLLATE "C" DESC) AS "position"
           FROM (
             SELECT *, (${noteTaskKey(taskKey)} <> '' AND lower("task") = lower(${noteTaskKey(taskKey)})) AS "ofTask"
             FROM "working_notes"
             WHERE ${liveNoteInScope}
           ) live
           ORDER BY "position"
           LIMIT ${MAX_LIVE_NOTES}
         ) n) AS "notes",
      (SELECT count(*)::int FROM "working_notes" WHERE ${liveNoteInScope}) AS "liveNoteCount",
      (SELECT COALESCE(json_agg(json_build_object(
                'id', f."id", 'scopePath', f."scopePath", 'graphitiFactUuid', f."graphitiFactUuid", 'sourceType', f."sourceType",
                'sourceRef', f."sourceRef", 'flaggedAt', f."flaggedAt"
              ) ORDER BY f."position"), '[]'::json)
         FROM (
           SELECT "id", "scopePath", "graphitiFactUuid", "sourceType"::text AS "sourceType", "sourceRef",
                  -- Stored as UTC without a zone (Prisma's convention); spelled out to the
                  -- millisecond the column holds, so it parses back to the same instant.
                  to_char("flaggedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "flaggedAt",
                  row_number() OVER (ORDER BY "flaggedAt" DESC) AS "position"
           FROM "fact_provenance"
           WHERE "orgId" = ${ctx.orgId}
             AND "status" = 'potentially_stale'
             AND ${within('"scopePath"')}
             -- On a tier whose reads do not include the graph, only a flag on a raw row.
             AND ${servedAnchorSql(ctx.orgId, Prisma.raw('"fact_provenance"."graphitiFactUuid"'))}
           ORDER BY "flaggedAt" DESC
           LIMIT ${MAX_STALE_FLAGS}
         ) f) AS "stale",
      (SELECT to_char(max("createdAt"), 'YYYY-MM-DD"T"HH24:MI:SS.US') || ' ' || count(*)
         FROM "erasure_suppressions" WHERE "orgId" = ${ctx.orgId}) AS "erasureMark",
      ${sinceLastSessionSql(ctx, scopePath, taskKey, SESSION_IDLE_MS)} AS "since"
  `;
  const [row] = await db.$queryRaw<
    {
      taskDecisions: TaskDecisionRow[];
      taskFacts: TaskFactRow[];
      taskCaptures: { read: TaskFactRow[]; all: boolean };
      notes: (Omit<ServedNote, "expiresAt"> & { expiresAt: string })[];
      liveNoteCount: number;
      rules: ServedRule[];
      writes: WriteRow[];
      stale: (Omit<StaleFlag, "flaggedAt"> & { flaggedAt: string | null })[];
      erasureMark: string | null;
      since: SinceLastSessionRow | null;
    }[]
  >(...flattenSql(query));
  const { rules, taskFacts } = row!;
  const taskDecisions = taskDecisionsOf(row!.taskDecisions);
  const recorded = new Map<string, string>();
  const replacementDatedAt = new Map<string, string>();
  for (const write of row!.writes) {
    if (write.supersededById !== null) recorded.set(write.recordId, write.supersededById);
    if (write.supersededById !== null && write.replacementDatedAt)
      replacementDatedAt.set(write.recordId, write.replacementDatedAt);
  }
  // A replacement that reads as erased is neither named nor dated, as on memory_version and the
  // change feed (services/memory/superseded-facts.ts withoutErasedWinners): the write is still
  // served marked as superseded.
  const winners = await withoutErasedWinners(ctx.orgId, recorded);
  for (const [loser, winner] of winners) if (winner === null) replacementDatedAt.delete(loser);
  // JSON carries the instant as text. A missing one stays missing, as the column read
  // it before the fold: new Date(null) would invent 1970 and serve it.
  const stale = row!.stale.map((flag) => ({
    ...flag,
    flaggedAt: (flag.flaggedAt === null ? null : new Date(flag.flaggedAt)) as Date,
  }));

  // The task's own decisions are served in their own section, ahead of the scope's rules, and
  // left out of those (mcp/task-start-notice.ts). They are usually the scope's newest rules, so
  // left in here they would take places in the newest tier that the block then leaves empty.
  const taskDecisionIds = new Set(taskDecisions.map((decision) => decision.id));
  const ruleCandidates = rules.filter((rule) => !taskDecisionIds.has(rule.id)).map(ruleCandidate);
  const writeCandidates = row!.writes.map(writeCandidate);
  // A retired version, and one read only for its name, is served only inside a conflict.
  const facts = servedConflicts(taskFactsOf(taskFacts)).facts;
  // What the task's sessions wrote. A fact due the erased-person check is left out, since its
  // text may be withheld (readServableTaskStart) and must not decide what is served in its place.
  const taskRecordTexts = [
    ...taskDecisions.map((decision) => `${decision.subject} ${decision.text}`),
    ...facts.filter((fact) => !fact.erasureCheckDue).map((fact) => fact.content),
  ];
  // Weighed over every record ranked by relevance, so a term they all share weighs almost
  // nothing. The task's own records are not ranked by relevance and take no part, but the names
  // they hold widen the query, below the task's own words.
  const weights = weighTaskTerms(
    taskText,
    [...ruleCandidates.map(({ terms }) => terms), ...writeCandidates.map(({ terms }) => terms)],
    { related: relatedNamesOf(taskRecordTexts), name: taskKey },
  );
  // The task's own facts are ranked among themselves: a term only they share says nothing here.
  const factWeights = weighTaskFacts(taskText, facts, taskKey);
  // What the task cites: its own text, and what its sessions wrote.
  const cited = citedNames([taskText, ...taskRecordTexts]);

  return {
    // Every candidate list arrives newest first and the ranking is stable, so the newest
    // comes first among equals.
    context: {
      rules: orderRules(ruleCandidates, weights, cited),
      writes: rankWrites(writeCandidates, weights),
      stale,
      weights,
    },
    task: {
      decisions: taskDecisions,
      facts: rankTaskFacts(facts, factWeights, taskText),
      factWeights,
      captures: { read: taskFactsOf(row!.taskCaptures.read), all: row!.taskCaptures.all },
    },
    notes: {
      served: row!.notes.map((note) => ({ ...note, expiresAt: new Date(note.expiresAt) })),
      total: row!.liveNoteCount,
    },
    winners,
    replacementDatedAt,
    erasureMark: row!.erasureMark,
    since: sinceLastSessionOf(row!.since),
  };
}

/**
 * The erased-person verdicts reached lately, true for a fact version the check withheld. The
 * key is the org, the version and the org's erasure mark ({@link TaskStartRead.erasureMark}):
 * a version's text never changes, and its verdict can change only when the suppression list
 * does, which changes the mark, so a remembered verdict is the one the check would reach
 * again. It is held in this process, at most {@link MAX_REMEMBERED_VERDICTS} of them, the
 * least recently used forgotten first: a new serverless instance, or a new erasure, starts
 * with none and pays the check once per fact it serves. The verdicts hold no text.
 */
const rememberedVerdicts = new Map<string, boolean>();
const MAX_REMEMBERED_VERDICTS = 20_000;

function verdictKey(orgId: string, versionId: string, erasureMark: string): string {
  return `${orgId}\u0000${versionId}\u0000${erasureMark}`;
}

function rememberedVerdict(key: string): boolean | undefined {
  const verdict = rememberedVerdicts.get(key);
  if (verdict !== undefined) {
    rememberedVerdicts.delete(key);
    rememberedVerdicts.set(key, verdict);
  }
  return verdict;
}

function rememberVerdict(key: string, erased: boolean): void {
  rememberedVerdicts.set(key, erased);
  if (rememberedVerdicts.size > MAX_REMEMBERED_VERDICTS) {
    rememberedVerdicts.delete(rememberedVerdicts.keys().next().value!);
  }
}

/**
 * {@link readTaskStartUnchecked}, with the erased-person check run on the records `served` picks and on
 * no others. `served` is given what may be served and names the fact versions whose text, or
 * whose writes, it would show: the block renders it ({@link renderTaskStartBlock}). A picked
 * record due the check whose whole text names a person erased from the org, written at or
 * before that erasure, is dropped, and `served` picks again from what is left, until every
 * record it picks has passed. A write whose own summary names such a person, recorded at or
 * before that erasure, is dropped before any pick. Nothing an erasure removed is served, and a
 * large fact the block would not serve is never read whole.
 */
export async function readServableTaskStart(
  ctx: AccessContext,
  scopePath: string,
  taskText: string,
  taskKey: string,
  served: (read: TaskStartRead) => readonly string[],
): Promise<TaskStartRead> {
  let read = await readTaskStartUnchecked(ctx, scopePath, taskText, taskKey);
  let erased: ErasedContentFilter | null = null;
  // A write's summary is shown as it was read, so a summary due the check is checked here,
  // before `served` picks: the text is already in hand, and only the suppression list is read.
  if (read.context.writes.some((write) => write.summaryCheckDue)) {
    const filter = await loadErasedContentFilter(ctx.orgId);
    erased = filter;
    const restored = new Set(
      read.context.writes.flatMap(({ id, recordId, summary, summaryCheckDue }) =>
        summaryCheckDue && filter(summary, new Date(summaryCheckDue.writtenAt), null, recordId) ? [id] : [],
      ),
    );
    read = {
      ...read,
      context: { ...read.context, writes: read.context.writes.filter((write) => !restored.has(write.id)) },
    };
  }
  const passed = new Set<string>();
  for (;;) {
    const due = new Set([
      ...read.task.facts.filter((fact) => fact.erasureCheckDue).map((fact) => fact.id),
      ...(read.task.captures?.read ?? []).filter((fact) => fact.erasureCheckDue).map((fact) => fact.id),
      ...read.context.writes.filter((write) => write.erasureCheckDue).map((write) => write.recordId),
    ]);
    const toCheck = [...new Set(served(read))].filter((id) => due.has(id) && !passed.has(id));
    if (toCheck.length === 0) return read;
    const mark = read.erasureMark ?? "";
    const removed = new Set<string>();
    const unknown: string[] = [];
    for (const id of toCheck) {
      const verdict = rememberedVerdict(verdictKey(ctx.orgId, id, mark));
      if (verdict === undefined) unknown.push(id);
      else if (verdict) removed.add(id);
    }
    if (unknown.length > 0) {
      erased ??= await loadErasedContentFilter(ctx.orgId);
      const found = await erasedAmong(ctx.orgId, unknown, erased);
      for (const id of unknown) {
        rememberVerdict(verdictKey(ctx.orgId, id, mark), found.has(id));
        if (found.has(id)) removed.add(id);
      }
    }
    for (const id of toCheck) if (!removed.has(id)) passed.add(id);
    if (removed.size === 0) return read;
    read = {
      ...read,
      task: {
        ...read.task,
        facts: read.task.facts.filter((fact) => !removed.has(fact.id)),
        ...(read.task.captures
          ? {
              captures: {
                ...read.task.captures,
                read: read.task.captures.read.filter((fact) => !removed.has(fact.id)),
              },
            }
          : {}),
      },
      context: { ...read.context, writes: read.context.writes.filter((write) => !removed.has(write.recordId)) },
    };
  }
}

/** Which of the fact versions `ids` the erased-person check `erased` removes, reading each one's whole text. */
async function erasedAmong(orgId: string, ids: readonly string[], erased: ErasedContentFilter): Promise<Set<string>> {
  const rows = await db.$queryRaw<{ id: string; content: string; entityName: string | null; writtenAt: string }[]>`
    SELECT "id", "content", "entityName",
           -- Stored as UTC without a zone, spelled out so it parses back to the same instant.
           to_char("createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "writtenAt"
    FROM "memory_chunks"
    WHERE "orgId" = ${orgId} AND "id" = ANY (${[...ids]}::text[])
  `;
  return new Set(
    rows.filter((row) => erased(row.content, new Date(row.writtenAt), row.entityName, row.id)).map((row) => row.id),
  );
}

/**
 * What one task-start delivery is told once to: a session of the agent, reading one
 * scope for one task. Keyed on the session alone, a block served for one task would
 * silence the next task's block, and an agent's token on one scope would use up the
 * block its token on another scope is owed, since a client that names no session and
 * sends no connection id gives each agent a single one.
 */
export interface TaskStartDeliveryKey {
  /** The session (mcp/task-start-notice.ts, sessionKeyOf): the caller-named one, else the MCP connection's, or "" when neither names one. */
  sessionKey: string;
  /** The scope the block is read for. */
  scopePath: string;
  /** The task the session names, or "" when it names none. */
  taskKey: string;
}

/**
 * The revision a delivery row holds once a compaction has made its block due again
 * ({@link markTaskStartDue}). A revision token is 16 hex digits (services/memory/revision.ts),
 * so no served block can ever hold this one.
 */
const DUE_AGAIN = "due-again";

/**
 * The instant a block is delivered, as `deliveredAt` stores it: the database's UTC now cut down
 * to the millisecond. {@link markTaskStartDue} orders it against a compaction instant that is a
 * JavaScript Date, whole milliseconds rounded down. Left to the column, now()'s microseconds
 * would be rounded to the nearest millisecond, so a block delivered half a millisecond before
 * the compaction could be stored a millisecond after it and never be told to the new context.
 * Cut down, a delivery before the compaction is stored at or before its millisecond.
 */
const deliveredNow = Prisma.sql`date_trunc('milliseconds', ${sqlUtcNow})`;

/**
 * Whether `key` of `ctx`'s agent was already served and is still live, marking this
 * call as its latest. The hot path: one indexed update, no read of any content. A row a
 * compaction made due again is not served, whatever its last call.
 */
export async function sessionAlreadyServed(ctx: AccessContext, key: TaskStartDeliveryKey): Promise<boolean> {
  const idleSince = new Date(Date.now() - SESSION_IDLE_MS);
  const touched = await db.$executeRaw`
    UPDATE "task_start_deliveries" SET "lastCallAt" = ${sqlUtcNow}
    WHERE "orgId" = ${ctx.orgId} AND "agentId" = ${ctx.actor.id} AND "sessionKey" = ${key.sessionKey}
      AND "scopePath" = ${key.scopePath} AND "taskKey" = ${key.taskKey}
      AND "lastCallAt" >= ${idleSince} AND "revision" <> ${DUE_AGAIN}
  `;
  return touched === 1;
}

/**
 * Make `key`'s block due once more for `ctx`'s agent: the session's context was compacted at
 * `compactedAt`, so the model no longer holds the block it was told. The next call for the key,
 * this one or a later one, then claims it as a first call would, and the claim makes it served
 * again, so the session is told the block once per context, never twice. A block delivered after
 * `compactedAt` was told to the new context already, by a call that overtook the request
 * reporting the compaction, so it is left served.
 *
 * Both instants are whole milliseconds ({@link deliveredNow}), so a delivery in the compaction's
 * own millisecond cannot be ordered against it. It counts as before: counted as after, a session
 * that called just before the compaction would never be told the block in its new context
 * (route.boundary.realdb.test.ts flaked on exactly this), while counted as before, the rarer call
 * that overtook the compaction inside that millisecond is told the block once more. This orders
 * the two instants only as far as the app server's clock (`compactedAt`) and the database's
 * (`deliveredAt`) agree; skew between them still misorders a delivery that close to a compaction.
 *
 * Only the revision changes. `lastCallAt` stays as it was, since it says when the agent last
 * called (services/memory/since-last-session.ts), and a compaction is not a gap.
 */
export async function markTaskStartDue(
  ctx: AccessContext,
  key: TaskStartDeliveryKey,
  compactedAt: Date,
): Promise<void> {
  await db.$executeRaw`
    UPDATE "task_start_deliveries" SET "revision" = ${DUE_AGAIN}
    WHERE "orgId" = ${ctx.orgId} AND "agentId" = ${ctx.actor.id} AND "sessionKey" = ${key.sessionKey}
      AND "scopePath" = ${key.scopePath} AND "taskKey" = ${key.taskKey}
      AND "deliveredAt" <= ${compactedAt}
  `;
}

/**
 * What a claimed block showed an agent, recorded by the claim's own statement: the fact versions
 * its lines show, each a sighting (services/memory/fact-reads.ts), and the scopes of what it
 * showed with no stored version behind it (services/access/derived-writes.ts).
 */
export interface TaskStartShown {
  agentId: string;
  versionIds: readonly string[];
  scopePaths: readonly string[];
}

/**
 * Claim the delivery of `revision` to `key` of `ctx`'s agent: the delivered_to edge.
 * True for exactly one caller per key: a row that is new, whose session went idle, or that
 * a compaction made due again ({@link markTaskStartDue}). A concurrent claim for the same key waits on the row lock, then finds it freshly
 * claimed and gets false.
 *
 * The same statement logs what the block served, `lines` holding each item line's revision
 * keys in order (services/memory/task-start-served.ts), so the log costs no round trip and
 * holds a serving exactly when the claim succeeded. It records `shown` the same way: the
 * sightings and the derived-write scopes go in with the claim, never without it, and cost no
 * round trip of their own. Each was its own statement until 2026-10-28; at a hosted database's
 * round trip, those three statements were a quarter of the latency the task-start block adds
 * to a session's first call.
 */
export async function claimTaskStartDelivery(
  ctx: AccessContext,
  key: TaskStartDeliveryKey,
  revision: string,
  lines: readonly (readonly string[])[] = [],
  shown?: TaskStartShown,
): Promise<boolean> {
  const idleSince = new Date(Date.now() - SESSION_IDLE_MS);
  const ifClaimed = Prisma.sql`EXISTS (SELECT 1 FROM claimed)`;
  const recorded = shown
    ? [
        versionsSightedCte(
          "sighted",
          { orgId: ctx.orgId, agentId: shown.agentId, versionIds: shown.versionIds },
          ifClaimed,
        ),
        scopesShownCte(
          "scopes_shown",
          { orgId: ctx.orgId, agentId: shown.agentId },
          shown.versionIds,
          shown.scopePaths,
          ifClaimed,
        ),
      ].filter((cte): cte is Prisma.Sql => cte !== null)
    : [];
  const alsoRecorded = recorded.length > 0 ? Prisma.sql`, ${Prisma.join(recorded, ", ")}` : Prisma.empty;
  const [{ claimed }] = await db.$queryRaw<{ claimed: number }[]>`
    WITH claimed AS (
    INSERT INTO "task_start_deliveries"
      ("id", "orgId", "agentId", "sessionKey", "scopePath", "taskKey", "revision", "deliveredAt", "lastCallAt")
    VALUES (gen_random_uuid()::text, ${ctx.orgId}, ${ctx.actor.id}, ${key.sessionKey}, ${key.scopePath},
      ${key.taskKey}, ${revision}, ${deliveredNow}, ${sqlUtcNow})
    ON CONFLICT ("orgId", "agentId", "sessionKey", "scopePath", "taskKey") DO UPDATE SET
      "revision" = EXCLUDED."revision",
      "deliveredAt" = ${deliveredNow},
      "lastCallAt" = ${sqlUtcNow}
    WHERE "task_start_deliveries"."lastCallAt" < ${idleSince} OR "task_start_deliveries"."revision" = ${DUE_AGAIN}
    RETURNING ${CLAIM_RETURNING}
    ), ${servedLogInsert(ctx, key, lines)}${alsoRecorded}
    SELECT count(*)::int AS "claimed" FROM claimed
  `;
  return claimed === 1;
}

/**
 * How long a delivery row is kept after its session's last call, unless it is its agent's
 * newest in the org. Past {@link SESSION_IDLE_MS} a row no longer decides whether a session is
 * served: {@link sessionAlreadyServed} and {@link claimTaskStartDelivery} treat an idle row as
 * absent. The agent's newest row still says when it last called, which is what the line on
 * what changed since its last session is measured from (services/memory/since-last-session.ts),
 * so that one row is kept. A connection's session key (mcp/connection-session.ts) is never sent
 * again once its connection closes, so without this every connection would leave a row for
 * good. A day is a wide margin over the idle window.
 */
export const IDLE_DELIVERY_RETENTION_HOURS = 24;

/** Rows deleted per statement, so one prune never holds a long lock. */
const DELIVERY_PRUNE_BATCH = 5000;

/**
 * Delete the delivery rows of sessions idle longer than {@link IDLE_DELIVERY_RETENTION_HOURS},
 * in every org, judged on the database's clock, except each agent's newest row in each org,
 * so an agent holds at most one row past the retention. Lossless: a later call of such a
 * session is told the block again whether its row is there or not, and the agent's last call
 * is still known. Returns how many rows went.
 *
 * Each batch is two statements. The first ranks every row within its org and agent in one scan
 * of the table (newest first, ties broken by id) and picks idle rows that are not first. The
 * second deletes those ids. Neither joins the table to itself, so neither can become a loop over
 * the table per row, whatever the planner's statistics say. A single
 * `DELETE ... WHERE "id" IN (<a search>)` can: with statistics taken while the table held one
 * row, Postgres re-ran the search once per row, and on 10,000 idle rows of one agent the prune
 * ran past a minute.
 *
 * The idle test is on the DELETE as well as on the search: a claim can refresh a row after the
 * search picked it. The DELETE then either sees the refreshed row, or waits on the claim's lock
 * and rechecks its own condition once the claim commits. Without the test there, the fresh
 * claim would be deleted and the session told the block a second time.
 */
export async function pruneIdleTaskStartDeliveries(): Promise<number> {
  const idleBefore = Prisma.sql`${sqlUtcNow} - make_interval(hours => ${IDLE_DELIVERY_RETENTION_HOURS}::int)`;
  let pruned = 0;
  for (;;) {
    const idle = await db.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM (
        SELECT "id", "lastCallAt",
          row_number() OVER (PARTITION BY "orgId", "agentId" ORDER BY "lastCallAt" DESC, "id" DESC) AS "rank"
        FROM "task_start_deliveries"
      ) ranked
      WHERE "rank" > 1 AND "lastCallAt" < ${idleBefore}
      LIMIT ${DELIVERY_PRUNE_BATCH}`;
    if (idle.length === 0) return pruned;
    const n = await db.$executeRaw`
      DELETE FROM "task_start_deliveries"
      WHERE "id" = ANY(${idle.map((row) => row.id)}::text[]) AND "lastCallAt" < ${idleBefore}`;
    pruned += n;
    if (n < DELIVERY_PRUNE_BATCH) return pruned;
  }
}
