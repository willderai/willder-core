// Renders memory_query's answer lines with a citation on each fact, so an agent
// can say where a fact came from: the connected source that ingested it, or the
// actor who asserted it.
//
// The one rule: a source is named only when a `Source` row with that id belongs
// to the caller's own org. The source id on a fact is ingest-time provenance, not
// ownership evidence, so it is resolved against the caller's tenant here and an
// id that does not resolve (another org's, or a source since disconnected) is
// never echoed back.
//
// A graph fact derived from one stored version is cited to that version's writer, read
// from the caller's own org: the graph stamps an entity definition it seeds from a write
// as "extraction" and an edge its extractor creates not at all, so its own stamp is not
// who wrote the version the line names. Any graph fact is dated the same way, by the newest
// stored version it was derived from (`servedDate`); the graph's own date, an extraction's
// clock, is served only when none of those versions is the caller's.
//
// A fact a connected source synced also names the item it came from, `· item <id>`: the
// graph episode the sync wrote for that item, which is the `recordId` its change event names.
//
// A line's citation, item and version are the product's alone. Stored text (a fact, an
// actor or source name) is printed with the separators those use, " — " and " · ",
// replaced, and a fact with no citation says "uncited", so stored text can never end a line
// with a citation, an item or a version this file did not print.
import { db } from "@/lib/db";
import { excerptMarker } from "@/services/memory/query-excerpt";
import { ruleLabelOf } from "@/services/memory/rule-copies";
import { readVersionStamps, type VersionStamp, type VersionWriter } from "@/services/memory/versions";
import type { MemoryFact } from "@/types/memory";

/** Printed after a fact that carries neither a source nor an actor, so absence is visible. */
const UNCITED = "uncited";

/**
 * Stored text as it may appear on a bullet: on one line, with the separators the line's
 * own citation, item and version use (" — " and " · ") replaced by " – " and " - ".
 */
function inlineText(text: string): string {
  return text.replace(/\s+/g, " ").trim().replaceAll(" — ", " – ").replaceAll(" · ", " - ");
}

/** The name a fact's source is cited by, when it is a source of the caller's org. */
function citedSource(fact: MemoryFact, sourceNames: Map<string, string>): string | null {
  return fact.sourceId ? (sourceNames.get(fact.sourceId) ?? null) : null;
}

function citation(fact: MemoryFact, sourceNames: Map<string, string>, writer: VersionWriter | null): string | null {
  if (fact.sourceId) {
    const source = citedSource(fact, sourceNames);
    return source ? `source: ${source}` : null;
  }
  const actorName = writer?.actorName ?? fact.actorName;
  const actorType = writer?.actorType ?? fact.actorType;
  const actor = actorName ? inlineText(actorName) : "";
  if (actor && actorType) return `from: ${actor} (${actorType})`;
  if (actor) return `from: ${actor}`;
  return actorType ? `from: ${actorType}` : null;
}

/** Every stored version a served graph fact was derived from. */
function graphFactVersions(facts: MemoryFact[]): string[] {
  return [...new Set(facts.flatMap((f) => (f.store === "graph" ? storedVersionsBehind(f) : [])))];
}

/**
 * The date a fact is served with. A stored version is dated by its own row, which the read
 * already did (pgvector-store.ts). A graph fact is dated by the newest stored version it
 * was derived from, read from the caller's own org: the graph's own date for it is the
 * extraction's clock, or a date the extractor read in the text, and either can make a
 * restatement of an old write look newer than the writes that replaced it. A graph fact
 * none of whose versions is the caller's keeps the graph's date.
 */
function servedDate(fact: MemoryFact, stamps: Map<string, VersionStamp>): string | null {
  if (fact.store !== "graph") return fact.validAt;
  const dates = storedVersionsBehind(fact).flatMap((id) => {
    const stamp = stamps.get(id);
    return stamp ? [stamp.datedAt] : [];
  });
  if (dates.length === 0) return fact.validAt;
  return dates.reduce((newest, date) => (Date.parse(date) > Date.parse(newest) ? date : newest));
}

/**
 * The stored version a fact answers from, when exactly one is known: a vector-store
 * fact is a stored version itself, and a graph fact names the versions it was derived
 * from. This is the id a writer passes back as `baseVersion` to update the fact.
 */
function versionOf(fact: MemoryFact): string | null {
  if (fact.store === "semantic") return fact.uuid;
  return fact.chunkIds?.length === 1 ? fact.chunkIds[0] : null;
}

/**
 * The synced item a fact came from, when exactly one is known and the fact cites the
 * source that synced it: the episode the sync wrote for the item, which its change event
 * names.
 *
 * A graph fact names it when the graph records one episode behind it, and that episode
 * states the fact. It need not be the only one: a bulk ingest (a Drive file's passages) can
 * fold a passage's restatement of a fact into the edge another passage of the same file
 * created without recording the second episode, so the item named is one that states the
 * fact, not proof that no other does. A fact the graph records several episodes behind
 * came from several items, or from an item and another writer, and names none rather than
 * pick one. A passage served from its own stored row names the item its file's sync
 * recorded beside it (`passageItems`), and keeps its version too: the row is a version of
 * its own, which the item's change event does not name.
 */
function itemOf(fact: MemoryFact, sourceNames: Map<string, string>, passageItems: Map<string, string>): string | null {
  if (!citedSource(fact, sourceNames)) return null;
  const oneEpisode = fact.sourceEventIds?.length === 1 ? fact.sourceEventIds[0] : null;
  if (fact.store === "semantic") return passageItems.get(fact.uuid) ?? oneEpisode;
  return oneEpisode;
}

/**
 * The episode each served passage of a connected file was synced as, by the passage's
 * stored row id.
 *
 * A file's sync record lists the file's episodes and its stored rows as two lists, not as
 * pairs: the rows are recorded as their concurrent writes finish
 * (lib/inngest/connector-drive-files.ts), so the n-th row is not the n-th episode. Only a
 * file of one passage pairs its row with its episode, so a passage of a longer file names
 * no item.
 */
async function onePassageItems(sourceIds: string[], rowIds: string[]): Promise<Map<string, string>> {
  if (rowIds.length === 0) return new Map();
  const files = await db.sourceFile.findMany({
    where: { sourceId: { in: sourceIds }, chunkIds: { hasSome: rowIds } },
    select: { chunkIds: true, episodeIds: true },
  });
  return new Map(
    files
      .filter((f) => f.chunkIds.length === 1 && f.episodeIds.length === 1)
      .map((f) => [f.chunkIds[0], f.episodeIds[0]]),
  );
}

/**
 * Every stored version a served fact's text came from: the vector-store row itself, or
 * every version a graph fact was derived from. Serving the fact counts as reading each.
 */
export function storedVersionsBehind(fact: MemoryFact): string[] {
  if (fact.store === "semantic") return [fact.uuid];
  return fact.chunkIds ? [...fact.chunkIds] : [];
}

/**
 * The mark on an answer's first line when later records on the same thing were served above it
 * (services/memory/update-links.ts). It states what is known, that a later record about this is
 * shown above, and not that it replaced this line: the link is read from words, not settled.
 * The records are the lines directly above, so the mark names no record and no id.
 */
function laterRecordsMarker(fact: MemoryFact): string {
  const later = fact.laterRecordsAbove ?? 0;
  if (later <= 0) return "";
  return later === 1 ? " · a later record on this is shown above" : ` · ${later} later records on this are shown above`;
}

/**
 * One bullet per fact: `• <rule> <fact> (as of <date>) — <citation> · <shared> · <later> · item <id> · version <id>`.
 * `<rule>` says which rule in force the fact's text copies and whether it is settled or a lead
 * (services/memory/rule-copies.ts `ruleLabelOf`), and is left off a fact on no settled rule's subject that copies none.
 * `<later>` says that the lines above this one are later records on the same thing
 * (`laterRecordsMarker`), and is left off otherwise.
 * `<shared>` is the derived-write marker of a fact stored as a declared share, from
 * `sharedMarkers` keyed by version id (mcp/derived-write.ts derivedMarkersFor): "shared from
 * <scope>", or "shared from a restricted scope" for a reader who may not read the source.
 * The citation is `source: <name> (<type>)` for a fact a connected source ingested,
 * `from: <actor> (<actorType>)` for a directly asserted fact, and `uncited` when the fact
 * carries neither. The item is left off unless the fact came from one synced item of a
 * cited source (`itemOf`), and the version when no single stored version is known.
 *
 * A fact's text is collapsed onto its one line, so its citation and version stay on the
 * bullet an agent reads the fact from, and no line inside a fact (a connector item's
 * body, say) can start a bullet of its own. Its " — " and " · " are replaced, so the
 * last " — " on a line always starts the product's own citation and a trailing
 * " · item" or " · version" is always the product's.
 */
export async function formatCitedFacts(
  orgId: string,
  facts: MemoryFact[],
  sharedMarkers: ReadonlyMap<string, string> = new Map(),
): Promise<string> {
  return (await formatCitedFactLines(orgId, facts, sharedMarkers)).join("\n");
}

/** {@link formatCitedFacts}, one line per fact in the order given, for a caller that lays the lines out itself. */
export async function formatCitedFactLines(
  orgId: string,
  facts: MemoryFact[],
  sharedMarkers: ReadonlyMap<string, string> = new Map(),
): Promise<string[]> {
  const sourceIds = [...new Set(facts.map((f) => f.sourceId).filter((id): id is string => Boolean(id)))];
  const sources = sourceIds.length
    ? await db.source.findMany({
        where: { orgId, id: { in: sourceIds } },
        select: { id: true, name: true, type: true },
      })
    : [];
  const sourceNames = new Map(sources.map((s) => [s.id, `${inlineText(s.name)} (${s.type})`]));
  // Only the sources of served passages are read, and each was resolved to the caller's org
  // above: an answer that also cites a large text source does not read that source's files.
  const passages = facts.filter((f) => f.store === "semantic" && citedSource(f, sourceNames));
  const passageSourceIds = [...new Set(passages.map((f) => f.sourceId!))];
  const passageItems = await onePassageItems(
    passageSourceIds,
    passages.map((f) => f.uuid),
  );
  const versionStamps = await readVersionStamps(orgId, graphFactVersions(facts));

  return facts.map((f) => {
    const date = servedDate(f, versionStamps);
    const asOf = date ? ` (as of ${date})` : "";
    const version = versionOf(f);
    // A copy of a person's rule is credited to that person (services/memory/rule-copies.ts), not
    // to the agent whose version stored its text.
    const personsRule = f.rule?.settled === true && f.rule.by === "person";
    const writer = f.store === "graph" && version && !personsRule ? (versionStamps.get(version)?.writer ?? null) : null;
    const cited = citation(f, sourceNames, writer) ?? UNCITED;
    const item = itemOf(f, sourceNames, passageItems);
    const shared = [...new Set(storedVersionsBehind(f).flatMap((id) => sharedMarkers.get(id) ?? []))];
    const label = ruleLabelOf(f);
    const rule = label ? `${label} ` : "";
    return `• ${rule}${inlineText(f.fact)}${excerptMarker(f)}${asOf} — ${cited}${shared.length ? ` · ${shared.join("; ")}` : ""}${laterRecordsMarker(f)}${item ? ` · item ${item}` : ""}${version ? ` · version ${version}` : ""}`;
  });
}
