// Which stored versions of a fact are no longer current, read from the one place that
// knows, so every read path can leave them out.
//
// A conflict's outcome is recorded in Postgres: the winner gets a `supersedes` edge in
// `fact_edges` pointing at each version it beat (services/memory/conflict.ts). The vector
// leg of a read filters on that edge in SQL (services/memory/pgvector-store.ts). The graph
// leg cannot: a Graphiti fact is an edge in Neo4j with its own uuid and nothing pointing
// back at the `memory_chunks` row the same ingest wrote, so the relation is invisible
// there and the graph answers with the loser.
//
// The one rule this file enforces: `fact_edges` is the only source of truth for whether a
// version is current. Nothing about supersession is copied into the graph, so the two
// stores cannot drift apart; instead the graph returns candidates and they are checked
// here, against the record, before a result is assembled. Change-log entries that
// announced a version are marked against the same record (`markSupersededWrites`).
//
// A candidate is matched to stored versions by the most exact link it carries:
//
// - A vector-leg fact (`store: "semantic"`) is a `memory_chunks` row, so its id is the key
//   the record is written in and decides alone. Text never overrules it: the same sentence
//   stored current in another scope is a different version.
// - A graph fact is matched by the chunk ids the write path stamped on its episodes
//   (`MemoryFact.chunkIds`): Graphiti rewrites the sentence it distils, so its text rarely
//   equals any stored version, and the stamp is the only exact link.
// - A graph fact with no stamp (an episode written before the stamp existed) is matched by
//   its normalized text (services/memory/fact-text.ts), but only against versions stored
//   in the same Graphiti group the fact was read from — the group a version's own scope
//   writes to. A match across groups would hide a current fact elsewhere and would tell a
//   reader of one scope what lost a race in another. Without a known group there is no
//   text match at all. Text a still-current version in that group also carries is never
//   hidden: two writers who stored the same sentence are one answer after deduplication
//   anyway, and hiding that text would hide the winner with it.
import { db } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { normalizeFactText } from "./fact-text";
import { toGid } from "./graphiti-store";
import { FACT_RECORD_TYPE } from "./change-events";
import { versionsReadingAsErased } from "./versions";
import type { RetrievalBackend } from "@/types/memory";

/**
 * Most superseded-or-superseding versions loaded for one read. A `supersedes` edge is
 * written for a conflict, an update based on a version, a stale write, a person's
 * correction and a connector item's upstream edit. Only versions stored as
 * `memory_chunks` rows are loaded, and a connector item is never one, so the rows loaded
 * grow with an org's conflicts, updates and corrections, not with its connector edits.
 * The bound keeps a pathological org from turning every read into an unbounded scan,
 * and truncation is logged rather than silently narrowing the filter.
 */
export const MAX_SUPERSESSION_ROWS = 5_000;

/**
 * The supersession record for one org, in the form a read filters with: a version id, or
 * a normalized fact text within one Graphiti group, maps to when it was superseded.
 */
export interface SupersededVersions {
  /** Version id → ISO timestamp of the `supersedes` edge that retired it. */
  readonly byId: ReadonlyMap<string, string>;
  /**
   * Graphiti group id → normalized fact text carried only by superseded versions stored
   * in that group → that same timestamp.
   */
  readonly byText: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

interface SupersessionRow {
  id: string;
  content: string;
  /** The version's scope; null for a version written with no scope, stored under the bare org. */
  scopePath: string | null;
  supersededAt: Date | null;
}

/**
 * Every version of a fact in `orgId` that a `supersedes` edge touches, resolved into the
 * id and text lookups a read filters with.
 *
 * One query, over the versions named by this org's `supersedes` edges only — never the
 * whole chunk table. An org with no conflicts gets two empty maps for the cost of an
 * index scan.
 */
export async function loadSupersededVersions(orgId: string): Promise<SupersededVersions> {
  const rows = await db.$queryRaw<SupersessionRow[]>(Prisma.sql`
    SELECT c."id", c."content", c."scopePath",
      (
        SELECT e."createdAt" FROM "fact_edges" e
        WHERE e."orgId" = c."orgId" AND e."toId" = c."id" AND e."kind" = 'supersedes'
        ORDER BY e."createdAt" ASC
        LIMIT 1
      ) AS "supersededAt"
    FROM "memory_chunks" c
    WHERE c."orgId" = ${orgId}
      AND c."id" IN (
        SELECT e."fromId" FROM "fact_edges" e WHERE e."orgId" = ${orgId} AND e."kind" = 'supersedes'
        UNION
        SELECT e."toId" FROM "fact_edges" e WHERE e."orgId" = ${orgId} AND e."kind" = 'supersedes'
      )
    LIMIT ${MAX_SUPERSESSION_ROWS}
  `);
  if (rows.length === MAX_SUPERSESSION_ROWS) {
    console.warn(
      `[memory] org ${orgId} has at least ${MAX_SUPERSESSION_ROWS} versions in supersede edges; a superseded version beyond that bound can still be read`,
    );
  }
  return indexSupersession(orgId, rows);
}

/**
 * Build the lookups from the rows. Separate from the query so the rule — a text is hidden
 * only in its own group, and only when no current version there carries it — is testable
 * without a database.
 */
export function indexSupersession(orgId: string, rows: readonly SupersessionRow[]): SupersededVersions {
  const byId = new Map<string, string>();
  const byText = new Map<string, Map<string, string>>();
  const currentText = new Set<string>();
  // A group id and a normalized text, as one key for the current-text set.
  const groupText = (group: string, text: string) => `${group}\u0000${text}`;
  for (const row of rows) {
    const group = toGid(row.scopePath ?? orgId);
    const text = normalizeFactText(row.content);
    if (row.supersededAt) {
      const at = new Date(row.supersededAt).toISOString();
      byId.set(row.id, at);
      if (!byText.has(group)) byText.set(group, new Map());
      byText.get(group)!.set(text, at);
    } else {
      currentText.add(groupText(group, text));
    }
  }
  for (const [group, texts] of byText) {
    for (const text of texts.keys()) if (currentText.has(groupText(group, text))) texts.delete(text);
  }
  return { byId, byText };
}

/** The minimum a candidate must carry to be checked against the record. */
interface FactLike {
  uuid: string;
  fact: string;
  /** The stored versions the fact was derived from, when the write path stamped them. */
  chunkIds?: readonly string[];
  /** The store that returned the fact; absent on facts from the graph's entity and graph views. */
  store?: RetrievalBackend;
}

/**
 * When `candidate` is a version the record says was superseded, the ISO timestamp it was
 * superseded at; null when it is current or unknown to the record.
 *
 * A stamped candidate is decided by its chunks alone. Several ingests can assert one
 * graph fact, and the fact is current while any of them is, so it is retired only when
 * every chunk behind it was — at the moment the last of them was.
 *
 * `graphGroup` is the Graphiti group the candidate was read from. Only an unstamped graph
 * fact with a known group falls back to a text match, and only within that group.
 */
export function supersededAt(candidate: FactLike, record: SupersededVersions, graphGroup?: string): string | null {
  if (candidate.chunkIds?.length) {
    let lastRetired = "";
    for (const id of candidate.chunkIds) {
      const at = record.byId.get(id);
      if (at === undefined) return null;
      if (at > lastRetired) lastRetired = at;
    }
    return lastRetired;
  }
  const byId = record.byId.get(candidate.uuid);
  if (byId !== undefined) return byId;
  const isGraphFact = candidate.store === undefined || candidate.store === "graph";
  if (!isGraphFact || graphGroup === undefined) return null;
  return record.byText.get(graphGroup)?.get(normalizeFactText(candidate.fact)) ?? null;
}

/**
 * `facts` without the versions the record retired, for facts read from `graphGroup` (see
 * `supersededAt`). Call it before a page is cut to the caller's limit, so a hidden loser
 * never costs the page a slot.
 */
export function dropSupersededFacts<T extends FactLike>(
  facts: readonly T[],
  record: SupersededVersions,
  graphGroup?: string,
): T[] {
  if (record.byId.size === 0) return [...facts];
  return facts.filter((fact) => supersededAt(fact, record, graphGroup) === null);
}

/**
 * For each of `versionIds` a `supersedes` edge retired, the version that retired it; ids
 * the record says nothing about are absent. When more than one edge points at a version,
 * the first recorded wins, as `loadSupersededVersions` dates it.
 *
 * Callers hand the winner's id to anyone who can read the loser, without a check of
 * their own. That is safe because every `supersedes` edge between fact versions joins two
 * versions stored in one scope: a fact contends only with versions in its own scope
 * (services/memory/conflict.ts), and a correction or an upstream edit is recorded only
 * when its replacement is in the replaced version's scope (services/memory/edges.ts). So
 * the winner is always as readable as the loser. A winner that reads as erased is still
 * returned; a caller serving the id leaves it out first ({@link withoutErasedWinners}).
 */
export async function supersedingVersions(orgId: string, versionIds: readonly string[]): Promise<Map<string, string>> {
  const winners = new Map<string, string>();
  if (versionIds.length === 0) return winners;
  const edges = await db.factEdge.findMany({
    where: { orgId, kind: "supersedes", toId: { in: [...new Set(versionIds)] } },
    select: { fromId: true, toId: true },
    // Same-millisecond edges are ordered by id, so every reader names the same winner.
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  for (const edge of edges) if (!winners.has(edge.toId)) winners.set(edge.toId, edge.fromId);
  return winners;
}

/** The slice of a change event this file reads to tell whether it announced a now-retired version. */
interface FactWriteEvent {
  recordType: string;
  recordId: string;
  op: string;
}

/**
 * Whether `event` announced a version of a fact being written — the kind of event that,
 * read alone, presents that version's text as what the fact says. A `supersede` event
 * is the outcome itself and already names the winner.
 */
function announcesFactVersion(event: FactWriteEvent): boolean {
  return event.recordType === FACT_RECORD_TYPE && (event.op === "create" || event.op === "update");
}

/**
 * The events in `events` with each write of a since-superseded fact version marked, so a
 * change log can keep listing that write as history without presenting its text as the
 * fact's current value. Each marked event gets `supersededById` and a summary that starts
 * with the same statement in words; every other event gets `supersededById: null` and is
 * otherwise returned as it was. A replacement that reads as erased
 * (services/memory/versions.ts versionsReadingAsErased) is not named, as memory_version does
 * not name it: the write is still marked, `[superseded]`, with `supersededUnnamed` and no id.
 * One query for the record, one erasure check when it names a replacement, and none when no
 * event announces a fact write.
 */
export async function markSupersededWrites<T extends FactWriteEvent & { summary: string }>(
  orgId: string,
  events: readonly T[],
): Promise<(T & SupersededMarking)[]> {
  const ids = events.filter(announcesFactVersion).map((event) => event.recordId);
  return markWritesAgainst(events, await withoutErasedWinners(orgId, await supersedingVersions(orgId, ids)));
}

/**
 * `winners` with each replacement that reads as erased replaced by null: the version is still
 * superseded, by a version no reader is told of. Reads nothing when `winners` is empty.
 */
export async function withoutErasedWinners(
  orgId: string,
  winners: ReadonlyMap<string, string | null>,
): Promise<Map<string, string | null>> {
  const named = [...new Set([...winners.values()].filter((id): id is string => id !== null))];
  const gone = named.length ? await versionsReadingAsErased(orgId, named) : new Set<string>();
  return new Map([...winners].map(([loser, winner]) => [loser, winner !== null && gone.has(winner) ? null : winner]));
}

/** What marking adds to an event: the replacement, when one is named, and when it took over. */
export interface SupersededMarking {
  /** The version that superseded the write's version; null when none did, or when it reads as erased. */
  supersededById: string | null;
  /** Set when the write's version was superseded by a version that reads as erased, which is not named. */
  supersededUnnamed?: true;
  /** With `replacementDatedAt`: the date the replacement is served with, as an ISO instant; null when not known. */
  replacementDatedAt?: string | null;
}

/**
 * `markSupersededWrites` for a caller that already read the record: `winners` maps a
 * retired version's id to the version that retired it, as `supersedingVersions` returns
 * it, or to null when that version reads as erased ({@link withoutErasedWinners}). Lets a
 * reader fetch the record in the same statement as the events themselves
 * (services/memory/task-start.ts) and still mark them exactly as the change feed does. Given
 * `replacementDatedAt` (by retired version, the date its replacement is served with), the mark
 * also says that date ({@link supersededMark}); the change feed's summaries stay undated, since
 * memory_changes dates each line itself.
 */
export function markWritesAgainst<T extends FactWriteEvent & { summary: string }>(
  events: readonly T[],
  winners: ReadonlyMap<string, string | null>,
  replacementDatedAt?: ReadonlyMap<string, string>,
): (T & SupersededMarking)[] {
  return events.map((event) => {
    const winnerId = announcesFactVersion(event) ? winners.get(event.recordId) : undefined;
    if (winnerId === undefined) return { ...event, supersededById: null };
    if (winnerId === null)
      return {
        ...event,
        supersededById: null,
        supersededUnnamed: true as const,
        summary: `${supersededMark(null)} ${event.summary}`,
      };
    const at = replacementDatedAt?.get(event.recordId) ?? null;
    return {
      ...event,
      supersededById: winnerId,
      ...(replacementDatedAt ? { replacementDatedAt: at } : {}),
      summary: `${supersededMark(winnerId, at)} ${event.summary}`,
    };
  });
}

/**
 * The mark a write of a since-superseded version carries: `[superseded by <id>]`, and with the
 * date its replacement is served with, the day in UTC, `[superseded by <id> (as of 2026-10-01)]`:
 * the date belongs to the replacement, as on memory_version's `superseded by:` line, so history
 * imported out of order never reads as replaced before it was written. `[superseded]` when the
 * replacement is not named. An instant that does not parse is left off, never guessed.
 */
export function supersededMark(winnerId: string | null, at?: string | null): string {
  if (winnerId === null) return "[superseded]";
  const time = at ? Date.parse(at) : Number.NaN;
  return Number.isNaN(time)
    ? `[superseded by ${winnerId}]`
    : `[superseded by ${winnerId} (as of ${new Date(time).toISOString().slice(0, 10)})]`;
}
