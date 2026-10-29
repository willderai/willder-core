// GuardedMemoryStore: the access-enforced facade over the raw MemoryStore. Every
// read and write passes check() first, is audited, and runs only against the
// partitions check() authorized.
//
// The one rule this file enforces: request paths never touch the raw `memory`
// singleton. Untagged (bare-org) content and descendant scopes are reached only
// when the checked scope covers org root or contains them.
//
// A read's page is chosen and ordered by provenance tier and relevance; recency only
// breaks the tie between versions of one fact on the chosen page, by a date no writer can
// set later than the moment it was stored. A graph fact is served as its source
// chunk when the same read returned that chunk, never by fetching one. The one row a read
// fetches beyond its search is the current successor of a retired version it ranked, in
// that version's place (services/memory/current-versions.ts).
import { db } from "@/lib/db";
import {
  AccessDeniedError,
  check,
  groupIdOutsideTenant,
  descendantScopePaths,
  orgRootPath,
  pathCovers,
  recordAppliedChange,
  recordReadFactIds,
  recordRefusal,
  recordWriteEffect,
  resolveExecutedPartition,
  type AccessAction,
  type AccessContext,
  type AccessDecision,
  type ExecutedPartition,
} from "@/services/access";
import type {
  EntityLookup,
  GraphInput,
  MemoryEntity,
  MemoryFact,
  MemoryGraph,
  FindFactByIdInput,
  FindFactByIdResult,
  RemoveEntityInput,
  RemoveFactInput,
  RemoveFactResult,
  SearchInput,
  SearchResult,
  TransferEntityInput,
  TransferEntityResult,
} from "@/types/memory";
import { memory } from "./store";
import { dropSupersededFacts, loadSupersededVersions, supersededAt } from "./superseded-facts";
import { inRetiredPlaces, loadCurrentSuccessors, retiredVersionsOf } from "./current-versions";
import { sourceCheckedReads, type SourceCheckedReads } from "./source-checked-reads";
import { toGid } from "./graphiti-store";
import { loadOwnPendingFacts } from "./own-pending-facts";
import { rawRowEntityName } from "./raw-rows";
import { graphReadAllowed } from "./routing-policy";
import {
  DEFAULT_ACCOUNT_TIER,
  loadAccountTier,
  packWithinTokenBudget,
  TIER_LIMITS,
  type AccountTier,
} from "./account-tiers";
import { recordFactRemoved, RemovalNotRecordedError } from "./fact-change-event";
import { currentReplacementWithin, FactAlreadyReplacedError } from "./fact-update";
import { failedStores, retrievalBreakdown } from "./retrieval-breakdown";
import { MemoryServiceError } from "./graphiti-store";
import type { MemoryStore } from "./memory-store";
import { specificValuesIn, textHoldsValue, type SpecificValue } from "./specific-values";
import { graphOnlyContentReachable, readableMemoryHolds, type ReadableRows } from "./readable-values";
import { aggregateCandidateLimit, compactAggregatePage, servedCharsOf } from "./query-shapes";
import { DIGEST_SNIPPET_POLICY, DIGEST_WIDEN } from "./aggregate-digest";

/** Interleave any number of fact lists ("legs") round-robin within each
 *  provenance tier, deduping by uuid (first occurrence wins).
 *
 *  takeWithTierFloor picks the page after this merge, tier by tier, keeping a
 *  prefix of each tier's list, so the fact that competes for a surviving slot
 *  is the same-tier one: whichever leg lists a tier's facts first wins every
 *  tie in that tier. A plain concatenation always lists the scoped leg first,
 *  so once that leg alone holds `limit` same-tier facts, the bare-org leg's
 *  same-tier facts lose every tie and never survive the cut.
 *
 *  Interleaving on absolute list index does not close that gap: legs rarely
 *  carry the same tier at the same index (pgvector's `actor_type` defaults to
 *  "extraction" while Graphiti facts carry human/agent), and once a tier's
 *  facts sit at different positions across legs, the tier-only sort collapses
 *  the interleave and one leg takes every contested slot again. Partitioning
 *  each leg by tier first (keeping that leg's own internal order) and
 *  round-robining the corresponding tiers across every leg at once makes the
 *  fairness hold where it is decided. Cross-tier priority is untouched: tiers
 *  are emitted in rank order and takeWithTierFloor fills the page best tier
 *  first, so a human fact still outranks every agent/extraction one.
 *
 *  Round-robin is the interim rule: neither backend exposes a comparable
 *  relevance/recency score, so a rank-by-score merge is not possible.
 *
 *  N-way, never a repeated binary fold. Folding an accumulator against one new
 *  leg at a time gives the most recently folded leg half of every tier's
 *  contested slots and halves each earlier leg's share with every fold: at 25
 *  descendant legs and limit 10, the first ~20 legs share 2 slots and the last
 *  leg alone takes 5. Taking every leg (the caller's own scope, the bare-org
 *  leg, and every descendant leg) as one flat list and round-robining one slot
 *  from each leg per pass gives every leg equal footing regardless of how many
 *  legs exist. */
function mergeFacts(...legs: MemoryFact[][]): MemoryFact[] {
  const seen = new Set<string>();
  const merged: MemoryFact[] = [];
  const take = (f: MemoryFact) => {
    if (!seen.has(f.uuid)) {
      seen.add(f.uuid);
      merged.push(f);
    }
  };
  const tiersPerLeg = legs.map(groupByProvenance);
  for (const rank of TIER_RANKS) {
    const tierLists = tiersPerLeg.map((tiers) => tiers.get(rank) ?? []);
    const longest = tierLists.reduce((max, list) => Math.max(max, list.length), 0);
    for (let i = 0; i < longest; i++) {
      for (const tierList of tierLists) {
        if (i < tierList.length) take(tierList[i]);
      }
    }
  }
  return merged;
}

/** One leg's facts bucketed by provenance rank, each bucket keeping that leg's
 *  own relevance/recency order. */
function groupByProvenance(facts: MemoryFact[]): Map<number, MemoryFact[]> {
  const tiers = new Map<number, MemoryFact[]>();
  for (const f of facts) {
    const rank = provenanceRank(f);
    const tier = tiers.get(rank);
    if (tier) tier.push(f);
    else tiers.set(rank, [f]);
  }
  return tiers;
}

/** Provenance tiers, lowest rank wins a limited slot first. Mirrors
 *  types/memory.ts's ActorType comment ("human-asserted visibly outranks
 *  auto-extracted") and memory-service's own ingest default (`actor_type:
 *  str = "extraction"`) — an unstamped/unrecognized fact is treated the same
 *  as the system's own lowest-trust default, not given a free pass above it.
 *  A Map rather than a plain object: `actorType` is free text from the store,
 *  and an object lookup on a key like `toString` or `constructor` returns an
 *  inherited function where the type claims a number. */
const EXTRACTION_RANK = 2;
const PROVENANCE_RANK = new Map<string, number>([
  ["human", 0],
  ["agent", 1],
  ["extraction", EXTRACTION_RANK],
]);
const UNRANKED = EXTRACTION_RANK;

/** Every distinct rank, best tier first — derived from the table above so a tier
 *  added there is interleaved by mergeFacts without a second edit here. */
const TIER_RANKS = [...new Set(PROVENANCE_RANK.values())].sort((x, y) => x - y);

/** A fact's tier, lower served first; always one of TIER_RANKS. */
export function provenanceRank(f: MemoryFact): number {
  return f.actorType ? (PROVENANCE_RANK.get(f.actorType) ?? UNRANKED) : UNRANKED;
}

/** How many candidates each backend leg is asked for before the page is cut to
 *  the caller's real limit. Both graphiti-store.ts and
 *  pgvector-store.ts cap their own query at whatever `limit` they are given
 *  (graphiti's `search(..., limit)`, pgvector's SQL `LIMIT`). Asking each leg
 *  for only the final `input.limit` would drop a human fact ranked below a
 *  leg's own relevance cutoff before it reached the ranker; ranking would only
 *  reorder whichever facts each leg's own cut let through. Overfetching per
 *  leg, then letting `takeWithTierFloor` cut to the real limit tier by tier,
 *  means a human fact loses its slot only to a more relevant same-tier fact,
 *  never to a lower tier that merely arrived inside a smaller per-leg cutoff.
 *  Bounded so this stays a cheap top-K search per leg, but never below the
 *  caller's own requested limit (`Math.max`): a caller that asks for a large
 *  limit needs at least that many candidates per leg, or the final cut hands
 *  back fewer facts than asked for. */
const OVERFETCH_MULTIPLIER = 4;
const OVERFETCH_CAP = 100;

function overfetchLimit(limit: number | undefined): number {
  const effective = limit ?? 10;
  return Math.max(effective, Math.min(effective * OVERFETCH_MULTIPLIER, OVERFETCH_CAP));
}

/** Share of a page each provenance tier is guaranteed for its most relevant
 *  facts, before the remaining slots go strictly by tier. At the default limit
 *  of 10 that is two slots per tier, so human facts still hold at least six. */
const TIER_FLOOR_SHARE = 0.2;

/**
 * Choose which of `merged` fill a page of `limit`, returned in `merged` order.
 *
 * Tier alone must not decide every slot: a connected source's content is
 * ingested at the extraction tier, and in a scope that also holds ten
 * agent-tier facts it would never reach a page however well it matched the
 * query, so a README synced into a busy scope could not answer a question only
 * the README answers. Each tier keeps `floor(limit * TIER_FLOOR_SHARE)` slots
 * for its own head (its most relevant facts, in merge order) and the rest are
 * filled best tier first.
 * A limit below five reserves nothing, so a small page stays strictly ranked.
 * Within a tier the survivors are always a prefix of that tier's list, so a
 * lower-relevance fact never displaces a higher-relevance one of its own tier.
 */
export function takeWithTierFloor(merged: MemoryFact[], limit: number): MemoryFact[] {
  const tiers = groupByProvenance(merged);
  const floor = Math.floor(limit * TIER_FLOOR_SHARE);
  const kept = new Map<number, number>();
  let remaining = limit;
  for (const rank of TIER_RANKS) {
    const take = Math.min(tiers.get(rank)?.length ?? 0, floor, remaining);
    kept.set(rank, take);
    remaining -= take;
  }
  for (const rank of TIER_RANKS) {
    const already = kept.get(rank) ?? 0;
    const take = Math.min((tiers.get(rank)?.length ?? 0) - already, remaining);
    kept.set(rank, already + take);
    remaining -= take;
  }
  const survivors = new Set<MemoryFact>();
  for (const [rank, count] of kept) {
    for (const f of (tiers.get(rank) ?? []).slice(0, count)) survivors.add(f);
  }
  return merged.filter((f) => survivors.has(f));
}

/** Share of a page held for vector hits when enough of them clear the floor:
 *  five of fifteen, three of the default ten. */
const VECTOR_RESERVE_SHARE = 1 / 3;

/** Cosine similarity a vector hit needs before it may claim a reserved slot. */
const VECTOR_SIMILARITY_FLOOR = 0.5;

/** How many facts of each tier `takeWithTierFloor` guaranteed on this page: its
 *  floor, or the whole tier when it has fewer. `reserveVectorSlots` may not take
 *  a tier below this. */
function tierFloorCounts(page: MemoryFact[], limit: number): Map<number, number> {
  const floor = Math.floor(limit * TIER_FLOOR_SHARE);
  const counts = new Map<number, number>();
  for (const [rank, facts] of groupByProvenance(page)) counts.set(rank, Math.min(floor, facts.length));
  return counts;
}

/**
 * Make room on `page` for the most similar vector hits among `candidates`.
 *
 * The hybrid store lists graph facts ahead of vector hits, so within a tier
 * every slot would go to a graph fact first, and a page can fill with graph
 * facts while chunks matching at 0.5 to 0.6 are left out. The
 * `floor(limit * VECTOR_RESERVE_SHARE)` most similar vector hits at or above
 * VECTOR_SIMILARITY_FLOOR are guaranteed a place. A weaker hit already on the
 * page (a chunk served in place of a graph fact extracted from it) does not
 * count toward the reserve: if it did, a fact asked for by its own text could
 * lose its place to chunks that merely rode in on their paraphrases. Each
 * reserved hit not yet on the page replaces the graph fact ranked last on the
 * page, so a human-asserted graph fact is the last to give way. A chunk in
 * `pulledUp` (collapseIntoSourceChunks) holds a graph fact's place and is asked to
 * give way as that fact would have been, after every graph fact on the page; the slot
 * is then taken from the least similar unreserved chunk of its tier, the last-ranked
 * among equals. Otherwise, once the graph holds a paraphrase of every earlier version of a fact but not yet of the version just written, the
 * paraphrases' chunks fill the page and the write is not served to the next read.
 * With no pulled-up chunk on the page, a vector hit never displaces another, and a
 * reserved hit never gives way. A hit that finds no slot does not stop the next one
 * from trying. Returned in `candidates` order, except that an admitted hit is placed
 * ahead of the less similar pulled-up chunks of its tier; the page never grows.
 *
 * The reserve comes out of a tier's surplus, never out of the floor
 * `takeWithTierFloor` just guaranteed it. Ranked last on the page means lowest
 * tier first, and the lowest tier is where a connected source's content lives
 * (hybrid-store.ts routes extraction-tier content to the graph alone, so it can
 * never be a vector hit itself); taking the reserve from there would undo the
 * floor in the one case it exists for, and a README synced into a busy scope
 * would stop answering the question only it answers. So a swap is made only
 * while it leaves every tier at its floor, counting the incoming hit's own tier:
 * a vector hit replacing a graph fact of the same tier always qualifies.
 */
export function reserveVectorSlots(
  page: MemoryFact[],
  candidates: MemoryFact[],
  limit: number,
  pulledUp: ReadonlySet<string> = new Set(),
): MemoryFact[] {
  const reserve = Math.floor(limit * VECTOR_RESERVE_SHARE);
  const qualifies = (f: MemoryFact) => f.store === "semantic" && (f.similarity ?? 0) >= VECTOR_SIMILARITY_FLOOR;
  const onPage = new Set(page.map((f) => f.uuid));
  const closest = candidates
    .filter(qualifies)
    .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))
    .slice(0, reserve);
  const reserved = new Set(closest.map((f) => f.uuid));
  const missing = closest.filter((f) => !onPage.has(f.uuid));
  if (missing.length === 0) return page;
  // Graph facts give way first. A pulled-up chunk holds a graph fact's place, so it is
  // then asked to give way as that fact would have been. The slot it frees is taken from
  // the least similar chunk of its tier that is not itself reserved (the last-ranked among
  // equals), which may be the chunk itself. Not simply the last-ranked: pulled-up chunks
  // hold graph ranks ahead of the tier's own vector hits, however weak their match.
  const ranked = rankByProvenance(page).reverse();
  const givesWayFirst = [
    ...ranked.filter((f) => f.store === "graph"),
    ...ranked.filter((f) => pulledUp.has(f.uuid) && !reserved.has(f.uuid)),
  ];

  const floors = tierFloorCounts(page, limit);
  const live = new Map([...groupByProvenance(page)].map(([rank, facts]) => [rank, facts.length]));
  const evicted = new Set<string>();
  const admitted = new Set<string>();
  for (const hit of missing) {
    const hitRank = provenanceRank(hit);
    const asked = givesWayFirst.find((f) => {
      if (evicted.has(f.uuid)) return false;
      const rank = provenanceRank(f);
      const after = (live.get(rank) ?? 0) - 1 + (rank === hitRank ? 1 : 0);
      return after >= (floors.get(rank) ?? 0);
    });
    // Another hit, of another tier, may still find a slot this one could not take.
    if (!asked) continue;
    const victimRank = provenanceRank(asked);
    const victim =
      asked.store === "graph"
        ? asked
        : (leastSimilar(
            ranked.filter(
              (f) =>
                f.store === "semantic" &&
                provenanceRank(f) === victimRank &&
                !reserved.has(f.uuid) &&
                !evicted.has(f.uuid),
            ),
          ) ?? asked);
    evicted.add(victim.uuid);
    admitted.add(hit.uuid);
    live.set(victimRank, (live.get(victimRank) ?? 0) - 1);
    live.set(hitRank, (live.get(hitRank) ?? 0) + 1);
  }
  if (admitted.size === 0) return page;

  const kept = new Set([...onPage].filter((uuid) => !evicted.has(uuid)));
  for (const uuid of admitted) kept.add(uuid);
  const result = candidates.filter((f) => kept.has(f.uuid) && !admitted.has(f.uuid));
  // An admitted hit is placed ahead of the first pulled-up chunk of its tier that is less
  // similar than it: those chunks hold the graph's ranks, and a hit closer to the query
  // than they are must not be the first fact the token budget cuts.
  for (const hit of missing.filter((f) => admitted.has(f.uuid))) {
    const before = result.findIndex(
      (f) =>
        pulledUp.has(f.uuid) &&
        provenanceRank(f) === provenanceRank(hit) &&
        (f.similarity ?? 0) < (hit.similarity ?? 0),
    );
    result.splice(before === -1 ? insertionPoint(result, candidates, hit) : before, 0, hit);
  }
  return result;
}

/** The least similar of `facts`; the first of them among equals. */
function leastSimilar(facts: MemoryFact[]): MemoryFact | undefined {
  return facts.reduce<MemoryFact | undefined>(
    (least, f) => (least === undefined || (f.similarity ?? 0) < (least.similarity ?? 0) ? f : least),
    undefined,
  );
}

/** Where `hit` falls in `page`, by its position among `candidates`. */
function insertionPoint(page: MemoryFact[], candidates: MemoryFact[], hit: MemoryFact): number {
  const at = candidates.indexOf(hit);
  const after = page.findIndex((f) => candidates.indexOf(f) > at);
  return after === -1 ? page.length : after;
}

/**
 * Order facts by provenance tier (human > agent > extraction). A stable sort on
 * tier alone — ties (same tier) keep each backend's own relevance/recency order,
 * so this only moves facts across tiers, never reorders within one.
 *
 * This orders a page; it does not choose one. By the time `retrieve()` calls it,
 * `takeWithTierFloor` has already decided which facts survive, and the only
 * other caller is `reserveVectorSlots`, which uses it to find the page's
 * lowest-ranked graph facts.
 *
 * It relies on `provenanceRank` returning a real tier for any `actorType`: a
 * non-numeric rank would make the comparator return NaN, and sort order under a
 * NaN comparator is unspecified.
 */
export function rankByProvenance(facts: MemoryFact[]): MemoryFact[] {
  return [...facts].sort((a, b) => provenanceRank(a) - provenanceRank(b));
}

/** What collapseIntoSourceChunks returns: the candidates, and the chunks served in a graph fact's place. */
interface SourceChunkCollapse {
  facts: MemoryFact[];
  pulledUp: ReadonlySet<string>;
}

/**
 * Serve a stored chunk in place of the graph facts extracted from it.
 *
 * Graph extraction distils each stored chunk into short facts, so one read can return a
 * chunk beside its own paraphrases: several slots for one piece of information, and the
 * paraphrases usually lack the chunk's date. A graph fact extracted from exactly one
 * stored chunk (`chunkIds`) that is itself among `candidates` is dropped, and that chunk
 * moves up to the place of the best-ranked fact extracted from it, so the information
 * keeps the rank the graph gave it. A fact several writes assert is kept: it can say what
 * no one of them says alone.
 *
 * Only chunks already among the candidates are used, and nothing is fetched: the swap
 * cannot bring in a chunk this read did not already return under its own access check,
 * and a chunk never brings in a fact. A fact that outranks its chunk's provenance tier is
 * kept, so collapsing never lowers the tier a piece of information is served at.
 * `candidates` are in tier order (mergeFacts' output), so every place a chunk can move up
 * to lies inside its own tier. `pulledUp` names the chunks that took a graph fact's place.
 */
export function collapseIntoSourceChunks(candidates: MemoryFact[]): SourceChunkCollapse {
  const chunks = new Map(candidates.filter((f) => f.store === "semantic").map((f) => [f.uuid, f]));
  if (chunks.size === 0) return { facts: candidates, pulledUp: new Set() };
  const sourceChunk = (f: MemoryFact): MemoryFact | undefined => {
    if (f.store !== "graph" || f.chunkIds?.length !== 1) return undefined;
    const chunk = chunks.get(f.chunkIds[0]);
    return chunk && provenanceRank(f) >= provenanceRank(chunk) ? chunk : undefined;
  };
  // Each chunk's place: the first of its own and its extracted facts' places.
  const placeOf = new Map<string, number>();
  candidates.forEach((f, i) => {
    const chunk = f.store === "semantic" ? f : sourceChunk(f);
    if (chunk && !placeOf.has(chunk.uuid)) placeOf.set(chunk.uuid, i);
  });
  const collapsed: MemoryFact[] = [];
  const pulledUp = new Set<string>();
  candidates.forEach((f, i) => {
    const chunk = f.store === "semantic" ? f : sourceChunk(f);
    if (!chunk) collapsed.push(f);
    else if (placeOf.get(chunk.uuid) === i) {
      collapsed.push(chunk);
      if (chunk !== f) pulledUp.add(chunk.uuid);
    }
  });
  return { facts: collapsed, pulledUp };
}

/**
 * A stored chunk's date in epoch milliseconds, or null when it is undated or unreadable.
 * Its `validAt` is never later than the moment it was stored: its writer's `occurredAt`,
 * clamped to that moment (services/memory/pgvector-store.ts), or that moment itself.
 */
function chunkTime(f: MemoryFact): number | null {
  const ms = f.validAt ? Date.parse(f.validAt) : Number.NaN;
  return Number.isNaN(ms) ? null : ms;
}

/** Newest first; undated after dated. A stable sort keeps relevance order among equals. */
function newerFirst(a: MemoryFact, b: MemoryFact): number {
  const at = chunkTime(a);
  const bt = chunkTime(b);
  if (at === bt) return 0;
  if (at === null) return 1;
  if (bt === null) return -1;
  return bt - at;
}

/**
 * Break ties in a chosen page by recency, and nothing more: the page stays in relevance
 * order, and recency decides only between versions of one fact, which relevance cannot
 * rank by how current they are. Versions of one fact are stored chunks in one tier that
 * share a `subject` (scope and entity name). The newest takes the best place any of them
 * holds, the next newest the next, so a value that was updated is read in its latest form
 * first; every other fact keeps its place.
 *
 * Two different facts are never reordered by date, however close their match: measured on
 * the retrieval lab, ordering near-equal vector matches newest first cost BEAM recall@1.
 * Graph facts carry no subject, so a date their text claims (the extractor's `valid_at`,
 * which can lie in the future) never moves them. This orders a page; it never chooses one.
 */
export function breakTiesByRecency(page: MemoryFact[]): MemoryFact[] {
  const ordered = [...page];
  const versions = new Map<string, number[]>();
  ordered.forEach((f, i) => {
    if (f.store !== "semantic" || !f.subject) return;
    const key = `${provenanceRank(f)}\u0000${f.subject}`;
    versions.set(key, [...(versions.get(key) ?? []), i]);
  });
  for (const places of versions.values()) {
    const newestFirst = places.map((i) => ordered[i]).sort(newerFirst);
    places.forEach((place, k) => (ordered[place] = newestFirst[k]));
  }
  return ordered;
}

/** What a caller of {@link GuardedMemoryStore.retrieve} may ask for beyond the facts. */
export interface RetrieveOptions {
  /** Also check the specific values the query names against all readable memory. */
  checkNamedValues?: boolean;
  /**
   * Serve an aggregate question's page (services/memory/query-shapes.ts): asked wider, served as
   * compact dated snippets in date order, in no more characters than the page of whole facts.
   * Set only by memory_query, when RETRIEVAL_QUERY_SHAPES or RETRIEVAL_AGGREGATE_DIGEST is on.
   */
  compactAggregate?: boolean;
  /**
   * With `compactAggregate`: choose the page the aggregate digest's way (services/memory/aggregate-digest.ts):
   * asked wider still, statements and quantities first, a restatement within a day served once.
   * Set only by memory_query, and only when RETRIEVAL_AGGREGATE_DIGEST is on.
   */
  aggregateDigest?: boolean;
}

/**
 * For each of `values`, whether some memory the read `rows` may see holds it; null when
 * the check cannot be complete, so the read makes no claim. It cannot be complete when
 * the read asks the graph store and could reach graph content that is not distilled from
 * searchable memory, or when the check itself fails: a note about what memory lacks is
 * never worth failing the read for, and never given on partial evidence.
 */
async function heldNamedValues(
  rows: ReadableRows,
  values: readonly SpecificValue[],
  graphAsked: boolean,
): Promise<boolean[] | null> {
  if (values.length === 0) return [];
  try {
    if (graphAsked && (await graphOnlyContentReachable(rows))) return null;
    return await readableMemoryHolds(rows, values);
  } catch (e) {
    console.warn(
      "[memory] the named-value check failed; the read makes no claim about them:",
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}

/**
 * The access-enforced facade over the raw MemoryStore. Every read passes through
 * check() (default deny) and is audited before any fact is returned; a denial
 * throws AccessDeniedError. Request paths use this — never the raw `memory`
 * singleton — so the gate cannot be bypassed.
 *
 * The raw `memory` store stays for trusted server-side writes (the Inngest ingest
 * worker), which run under their own actor and aren't a user-facing read.
 */
/**
 * What a guarded `removeFact` tells its caller: whether the store removed the fact, and the
 * visible `memory.delete` allow row that authorized it. A caller that re-ingests corrected
 * text carries that row onto the new version's change event, because the one delete
 * decision authorized both halves of the edit (app/api/memory/facts/[id]/route.ts).
 */
export interface GuardedRemoveFactResult extends RemoveFactResult {
  authorizedById?: string;
  /**
   * The removal as the change feed announced it, when the store really removed the fact:
   * the change event's id, and the scope the fact was stored and read in (the chunk's own
   * scope, the org root for an untagged one, or for a graph fact the scope it was removed
   * from). A correction names it to be recorded as the fact's replacement
   * (`IngestInput.correctionOf`).
   */
  removedVersion?: { changeId: string; scopePath: string };
}

/** What locateEntity answers when the org's tier does not read the graph. */
const GRAPH_NOT_READ = Symbol("graph not read");

/** Most facts the raw-row entity fallback reads for one entity. */
const RAW_ENTITY_FACTS = 20;

export class GuardedMemoryStore {
  /**
   * @param tierOf resolves the account tier whose limits a read runs under. It is
   *   consulted only after check() has allowed the read, and it can only narrow
   *   what the read returns (services/memory/account-tiers.ts).
   */
  /**
   * The only way this class reads the graph: every graph answer it hands out passes the
   * serve-time source check (services/memory/source-checked-reads.ts, graph-fact-sources.ts), so text whose stored
   * source was deleted, disconnected or erased is never served, whether or not the graph's
   * own cleanup reached it. guarded-store.sole-graph-path.test.ts fails on a read of
   * `this.store` that goes around it.
   */
  private readonly reads: SourceCheckedReads;

  constructor(
    private readonly store: MemoryStore = memory,
    private readonly tierOf: (orgId: string) => Promise<AccountTier> = async () => DEFAULT_ACCOUNT_TIER,
  ) {
    this.reads = sourceCheckedReads(store);
  }

  /**
   * Retrieve facts, gated by `memory.read` on the requested scope (org root by default).
   *
   * With `options.checkNamedValues`, the result also says which specific values the query
   * names (services/memory/specific-values.ts) no memory the caller can read holds
   * (`SearchResult.unheldValues`), checked over all of that memory, not the page.
   */
  async retrieve(
    ctx: AccessContext,
    input: SearchInput,
    scope?: string,
    options: RetrieveOptions = {},
  ): Promise<SearchResult> {
    await this.assertTenant(ctx, input.groupId, "memory.read");
    const decision = await check(ctx, {
      action: "memory.read",
      scope,
      target: `query:${input.query}`,
    });
    if (!decision.allowed) throw new AccessDeniedError(decision);
    // Does the scope check() just authorized (the same targetPath check() uses
    // internally, `req.scope ?? orgRootPath(ctx.orgId)`) itself cover org root?
    // A pure containment check (pathCovers, no extra DB round trip), not "does
    // this caller hold some grant somewhere," which check()'s ALLOW above already
    // answers for the narrower `scope`. Gates every place below that would
    // otherwise surface untagged/bare-org content to a caller whose checked
    // scope is narrower than org root.
    const hasOrgRootGrant = pathCovers(scope ?? orgRootPath(ctx.orgId), orgRootPath(ctx.orgId));
    // The tier limits which stores answer and how much evidence is kept. Resolved
    // only after the access decision above, and applied to every leg below, so a
    // caller cannot pick its own tier by setting `accountTier` on the input.
    const accountTier = await this.tierOf(ctx.orgId);
    // `groupIds` is this read's own to set, below, from the registry; a caller's is dropped.
    const tieredInput: SearchInput = { ...input, groupIds: undefined, accountTier };
    // Started here, after the access decision, so it overlaps the store reads below. It
    // reads only the rows this decision allows; see services/memory/readable-values.ts.
    const namedValues = options.checkNamedValues ? specificValuesIn(input.query) : [];
    const namedValuesHeld = options.checkNamedValues
      ? heldNamedValues(
          { orgId: ctx.orgId, scope, includeUntagged: hasOrgRootGrant },
          namedValues,
          TIER_LIMITS[accountTier].allowedStores.includes("graph"),
        )
      : null;
    // Which versions lost a write race is recorded in Postgres and nowhere else
    // (services/memory/superseded-facts.ts). Started here so the lookup overlaps the
    // store reads below, and awaited after the merge. A failure is not swallowed: a read
    // that cannot tell which version is current must not answer with both. The attached
    // no-op keeps a rejection from going unhandled if a store leg throws first; the real
    // failure still surfaces where it is awaited.
    const supersession = loadSupersededVersions(ctx.orgId);
    supersession.catch(() => {});
    // Two backends, opposite needs when a scope is set: Graphiti keys on `groupId`
    // (so it must be the scope-encoded path), while pgvector isolates tenants by the
    // bare org id and filters scope separately. Carry both so neither is starved:
    // `groupId` → scope path (Graphiti), `tenantId` → bare org id + `scopePath` → scope
    // (pgvector). With only one of them, a scoped read matches pgvector rows on
    // the scope string and silently returns zero document chunks.
    const target = resolveExecutedPartition(ctx.orgId, scope ?? input.groupId).groupId;
    // An aggregate read asks every leg as for its wider candidate page; any other read, as for its own.
    const widen = options.aggregateDigest ? DIGEST_WIDEN : undefined;
    const legLimit = options.compactAggregate ? aggregateCandidateLimit(input.limit, widen) : input.limit;
    // Overfetch each leg (see overfetchLimit's comment) so a candidate below this
    // leg's own relevance cutoff at the real limit can still reach
    // the tier-ordered page selection below — the cut to `input.limit` happens
    // there, not here.
    const result = await this.reads.retrieve(
      ctx.orgId,
      {
        ...tieredInput,
        groupId: target,
        tenantId: input.groupId,
        scopePath: scope,
        // Retired rows come back marked, in the places they rank, so each place can go to
        // the row's current successor below (services/memory/current-versions.ts).
        withRetired: true,
        // pgvector's `scopePath IS NULL` clause must not match for every scoped
        // caller: pass this through only when the leg's own checked scope covers
        // org root. See includeUntagged's doc comment on SearchInput.
        includeUntagged: hasOrgRootGrant,
        limit: overfetchLimit(legLimit),
      },
      target,
    );
    // A store that failed twice on the read above is down for this read: the calls below
    // ask it once each instead of twice, so an outage costs one call per scope, not two.
    const downStores = failedStores([result]);
    const laterInput: SearchInput = downStores.length > 0 ? { ...tieredInput, noRetry: downStores } : tieredInput;
    // Graphiti partitions by an EXACT groupId match, no ancestor/descendant
    // containment and no bare-org fallback (graphiti-store.ts retrieve()). Several
    // ingest paths (memory/upload, onboarding, accounts/[id], contacts/[id],
    // contacts/from-research, outbound/send) write with no scopePath at all, so
    // their episodes sit under the BARE org id, not under whatever scope a read
    // defaults to. When the read scope differs from the bare org id AND the
    // caller's checked scope genuinely covers org root, re-run the same read
    // against the bare-org group and merge it in — same `scopePath` both times, so
    // pgvector's containment filter (the actual leak boundary) never widens; only
    // Graphiti's partition gains the bare-org fallback. `skipPgvector` keeps this
    // second call from re-running pgvector's identical SELECT for nothing.
    //
    // graphiti-store.ts's retrieve() never forwards `scopePath` to the Graphiti
    // /search call (Graphiti has no scope_path filter; each scope is its own
    // Graphiti group at ingest, `toGid(input.scopePath ?? input.groupId)`), so
    // this leg does no filtering of its own: the bare-org GROUP it queries is the
    // only thing that bounds what it returns. Gating the leg on `hasOrgRootGrant`
    // is what bounds it, since Graphiti cannot filter this itself: a
    // narrow-scoped caller with no org-root grant never issues this query at all.
    const orgWide =
      target !== input.groupId && hasOrgRootGrant
        ? await this.reads.retrieve(
            ctx.orgId,
            {
              ...laterInput,
              groupId: input.groupId,
              tenantId: input.groupId,
              scopePath: scope,
              skipPgvector: true,
              limit: overfetchLimit(legLimit),
            },
            input.groupId,
          )
        : null;
    // Each leg was overfetched above (graphiti-store.ts's `limit: input.limit ??
    // 10`, pgvector-store.ts's `LIMIT ${limit}`, both given `overfetchLimit`), so
    // a merge of the legs can hand back well more than the caller asked for,
    // breaking memory_query's "Max facts to return" contract on a path that
    // feeds an LLM context window. Cut back to the real effective limit after
    // merging, matching each backend's own default when none is given. The cut
    // is takeWithTierFloor's: it fills the page by provenance tier (human >
    // agent > extraction), less the small per-tier floor it keeps, so the
    // lowest-trust facts are dropped first instead of whichever leg happened to
    // list them later. Within a tier, mergeFacts' per-tier round-robin gives
    // every leg a fair shot at a same-tier slot: the legs' relevance orders are
    // unrelated (scoped vs. bare-org), so concatenation order is not a priority
    // signal. Choosing the page by tier is what gives a human fact priority over
    // a same-slot agent/extraction fact; the per-leg overfetch only pushes each
    // leg's own cutoff out, it does not remove it.
    //
    // Authorized-descendant query: Graphiti has no ancestor/descendant
    // containment of its own (exact groupId match only, unlike pgvector's
    // `scopePath = X OR LIKE 'X.%'` predicate, which already sees descendant
    // content in the single call above). Every real, registered scope under
    // the authorized scope (`scope ?? orgRootPath(ctx.orgId)`, the same path
    // check() itself authorized above, not `target`, which stays the bare org
    // id for the Graphiti partition leg) is itself covered by that same grant
    // (descendantScopePaths mirrors evaluate()'s own `@>` containment one level
    // down — see its own doc comment), so this never surfaces anything the
    // caller isn't already entitled to; it only stops Graphiti's exact-match
    // partitioning from silently hiding a descendant scope's content (otherwise
    // Drive-sourced/extraction-tier facts, which hybrid-store.ts routes to
    // Graphiti only, are hidden, since pgvector's containment above never sees
    // them either). `skipPgvector` for the same reason as the bare-org leg:
    // pgvector's own containment already covered these rows.
    //
    // Every descendant scope is asked in ONE graph call (`groupIds`), so the number of
    // scopes no longer multiplies the calls a read makes. The graph store fails that
    // call rather than answer from fewer partitions than it was given, and a failed
    // graph call is reported as `degraded`. Scopes past the per-read bound are named
    // in `unsearchedScopes`.
    const descendantScopes = await descendantScopePaths(ctx.orgId, scope ?? orgRootPath(ctx.orgId));
    const [firstDescendant, ...otherDescendants] = descendantScopes.paths;
    const descendantLeg =
      firstDescendant === undefined
        ? null
        : await this.reads.retrieve(
            ctx.orgId,
            {
              ...laterInput,
              groupId: firstDescendant,
              groupIds: otherDescendants,
              tenantId: input.groupId,
              scopePath: scope,
              skipPgvector: true,
              limit: overfetchLimit(legLimit),
            },
            null,
          );
    // A fact the descendant leg names a partition for must come from one it asked. The
    // graph store names one on every fact (graphiti-store.ts).
    const askedPartitions = new Set(descendantScopes.paths.map(toGid));
    if (
      descendantLeg?.facts.some((fact) => fact.graphGroupId !== undefined && !askedPartitions.has(fact.graphGroupId))
    ) {
      throw new MemoryServiceError("graph search answered from a scope it was not asked", 502);
    }
    // One flat call over every real leg, never a repeated binary fold (see
    // mergeFacts' doc comment for why a fold starves every leg but the last). Each leg's
    // graph facts already passed the serve-time source check (`this.reads`).
    const legResults = [result, ...(orgWide ? [orgWide] : []), ...(descendantLeg ? [descendantLeg] : [])];
    // The partition each leg's graph read asked, in the same order as `legResults`. The
    // descendant leg asked many, so each of its facts carries its own (`graphGroupId`).
    const legPartitions: (string | null)[] = [
      target,
      ...(orgWide ? [input.groupId] : []),
      ...(descendantLeg ? [null] : []),
    ];
    // Superseded versions are replaced or dropped before the page is cut below. The vector
    // leg marks its own retired rows (`retired`); the record decides for the graph leg,
    // which has no link from a fact to the chunk the record is keyed on but the stamp.
    // Decided per leg, so an unstamped graph fact is only ever matched against versions in
    // its own group.
    const record = await supersession;
    const retiredByRecord = new Set(
      legResults.flatMap((leg, i) => {
        const partition = legPartitions[i];
        return leg.facts.filter(
          (fact) => supersededAt(fact, record, partition === null ? fact.graphGroupId : toGid(partition)) !== null,
        );
      }),
    );
    // A retired version's place goes to its current successor when the reader may read it,
    // and is dropped otherwise (services/memory/current-versions.ts). A successor is a
    // vector-store row, so a tier that may not read that store is served none.
    const retiredIds = legResults.flatMap((leg) =>
      leg.facts.flatMap((fact) => retiredVersionsOf(fact, retiredByRecord) ?? []),
    );
    const successors = TIER_LIMITS[accountTier].allowedStores.includes("semantic")
      ? await loadCurrentSuccessors(ctx.orgId, retiredIds, { scope, includeUntagged: hasOrgRootGrant })
      : new Map<string, MemoryFact>();
    // A graph fact whose source chunk this same read returned is served as that chunk
    // (collapseIntoSourceChunks), before the page is chosen, so a chunk and its
    // paraphrases never take several slots for one piece of information.
    const { facts: merged, pulledUp } = collapseIntoSourceChunks(
      mergeFacts(...legResults.map((leg) => inRetiredPlaces(leg.facts, retiredByRecord, successors))),
    );
    // Which facts survive is takeWithTierFloor's call (tier first, with a
    // per-tier floor so relevant lower-tier content is not starved), then
    // reserveVectorSlots gives close vector hits a share of the page that graph
    // facts, or chunks pulled up in their place, would otherwise fill; the page is then ordered best tier first, and
    // cut to the account tier's token budget from the bottom, so the budget
    // drops the lowest-ranked facts first; the first fact that does not fit is
    // served as an excerpt of its sentences that match the query. Recency then
    // only breaks ties on the surviving page (breakTiesByRecency): it never
    // decides what is kept.
    const limit = input.limit ?? 10;
    const wholePage = breakTiesByRecency(
      packWithinTokenBudget(
        rankByProvenance(reserveVectorSlots(takeWithTierFloor(merged, limit), merged, limit, pulledUp)),
        TIER_LIMITS[accountTier].tokenBudget,
        input.query,
      ),
    );
    // An aggregate page is chosen the same way from a wider page, then served as snippets in
    // no more characters than the page of whole facts above (services/memory/query-shapes.ts).
    const wide = aggregateCandidateLimit(input.limit, widen);
    const facts = options.compactAggregate
      ? packWithinTokenBudget(
          compactAggregatePage(
            rankByProvenance(reserveVectorSlots(takeWithTierFloor(merged, wide), merged, wide, pulledUp)),
            input.query,
            servedCharsOf(wholePage),
            limit,
            options.aggregateDigest ? DIGEST_SNIPPET_POLICY : {},
          ),
          TIER_LIMITS[accountTier].tokenBudget,
          input.query,
        )
      : wholePage;
    // check() already gated + audited this read before the store was ever called
    // (above); this writes a linked audit_log row recording which facts actually
    // came back, so the trail can show the exact record(s) read, not just the
    // query that ran.
    await recordReadFactIds(
      ctx,
      decision,
      facts.map((f) => f.uuid),
    );
    // Some descendant scopes may not have been searched (more than one read searches,
    // or the lookup failed), or a store may have failed to answer even after its
    // retry. Say so, and name the scopes when known, instead of letting a partial read
    // look complete.
    const breakdown = retrievalBreakdown(facts, legResults);
    const degraded = failedStores(legResults);
    // A value a fact this read returned holds counts as held whatever the search below
    // found, so the note can never contradict the page it is served with.
    const held = await namedValuesHeld;
    const unheldValues = held?.flatMap((isHeld, i) =>
      isHeld || merged.some((fact) => textHoldsValue(fact.fact, namedValues[i]!)) ? [] : [i],
    );
    return {
      facts,
      breakdown,
      ...(unheldValues ? { unheldValues } : {}),
      ...(descendantScopes.partial ? { partialScopeCoverage: true as const } : {}),
      ...(descendantScopes.unsearched.length > 0 ? { unsearchedScopes: descendantScopes.unsearched } : {}),
      ...(degraded.length > 0 ? { degraded } : {}),
    };
  }

  /**
   * Fetch an entity + its facts, gated by `memory.read` (entity view) on its scope.
   *
   * The second path that hands a reader fact text (mcp/tools/memory-entity.ts, GET
   * /api/memory/entities/[id]), and it asks the graph alone — so the version that lost a
   * write race has to be dropped here against the Postgres record, exactly as in
   * `retrieve` above, or this read answers with two versions of one fact.
   *
   * Graph extraction runs after a write returns, so the caller's own versions about the
   * entity that the graph does not hold yet are served beside its facts
   * (services/memory/own-pending-facts.ts): a writer's next read includes its write.
   */
  async entity(ctx: AccessContext, input: EntityLookup, scope?: string): Promise<MemoryEntity | null> {
    const found = await this.locateEntity(ctx, input, scope);
    if (found === GRAPH_NOT_READ) return this.rawRowEntity(ctx, input, scope);
    if (!found) return null;
    const { entity, partition } = found;
    const graphFacts = entity.facts?.length
      ? dropSupersededFacts(entity.facts, await loadSupersededVersions(ctx.orgId), toGid(partition))
      : [];
    const ownPending = await loadOwnPendingFacts(ctx, {
      entityName: entity.name,
      partition,
      alreadyHeld: new Set(graphFacts.flatMap((fact) => fact.chunkIds ?? [])),
    });
    if (!entity.facts?.length && ownPending.length === 0) return entity;
    return { ...entity, facts: [...graphFacts, ...ownPending] };
  }

  /**
   * The entity lookup on a tier whose reads do not include the graph. The graph is not
   * asked; the raw rows that name the entity answer instead, read through the guarded read
   * itself, so they are exactly what a memory read on this tier would serve: the same
   * access decision on the same scope, the same legs, erasure and supersession.
   *
   * The entity is named by the lookup: `entityId` is either one of the org's raw rows the
   * caller may read (a fact id a memory read served), whose entity name is taken, or the
   * entity's name itself. A fact is the entity's when its text names it. The answer is
   * labelled `matchedBy: "raw-name"`, so no reader takes it for the graph's entity, and is
   * null when no fact names it.
   */
  private async rawRowEntity(ctx: AccessContext, input: EntityLookup, scope?: string): Promise<MemoryEntity | null> {
    const asRow = await this.lookupFact(ctx, { groupId: input.groupId, factId: input.entityId }, scope, true);
    const name = (asRow ? await rawRowEntityName(ctx.orgId, asRow.uuid) : null) ?? input.entityId.trim();
    if (name === "") return null;
    const read = await this.retrieve(ctx, { groupId: input.groupId, query: name, limit: RAW_ENTITY_FACTS }, scope);
    const named = name.toLowerCase();
    const facts = read.facts.filter((fact) => fact.fact.toLowerCase().includes(named));
    if (facts.length === 0) return null;
    return { uuid: input.entityId, name, type: "entity", facts, matchedBy: "raw-name" };
  }

  /**
   * The entity as the stores hold it, over every partition this caller's grant reaches,
   * with the partition it was found in. {@link GRAPH_NOT_READ} when the org's tier does
   * not read the graph, decided after the access check.
   */
  private async locateEntity(
    ctx: AccessContext,
    input: EntityLookup,
    scope?: string,
  ): Promise<{ entity: MemoryEntity; partition: string } | typeof GRAPH_NOT_READ | null> {
    await this.assertTenant(ctx, input.groupId, "memory.entity");
    const decision = await check(ctx, {
      action: "memory.entity",
      scope,
      target: input.entityId,
    });
    if (!decision.allowed) throw new AccessDeniedError(decision);
    if (!graphReadAllowed(await this.tierOf(ctx.orgId))) return GRAPH_NOT_READ;
    const target = resolveExecutedPartition(ctx.orgId, scope ?? input.groupId).groupId;
    // Same containment check retrieve() uses: does the scope check() just
    // authorized cover org root? Gates the bare-org fallback below the same way
    // retrieve()'s bare-org leg is gated.
    const hasOrgRootGrant = pathCovers(scope ?? orgRootPath(ctx.orgId), orgRootPath(ctx.orgId));
    // `groupIds` is this lookup's own to set, below, from the registry; a caller's is dropped.
    const lookup: EntityLookup = { groupId: input.groupId, entityId: input.entityId };
    const hit = await this.reads.entity(ctx.orgId, { ...lookup, groupId: target });
    if (hit) return { entity: hit, partition: target };
    // Same bare-org Graphiti fallback as retrieve() above: entity() has no
    // pgvector leg at all (pgvector-store.ts's entity() is a hard `return null`),
    // so a scope-less entity seed (e.g. an account/contact created without a
    // scopePath) is only ever reachable under the bare org id, never under a
    // defaulted scope. Gated the same way as retrieve()'s leg: it fires only
    // when the caller's own checked scope covers org root, so a narrow-scoped
    // caller cannot retrieve a bare-org-seeded entity by id.
    if (target !== input.groupId && hasOrgRootGrant) {
      const bareOrgHit = await this.reads.entity(ctx.orgId, lookup);
      if (bareOrgHit) return { entity: bareOrgHit, partition: input.groupId };
    }
    // Authorized-descendant query: entity() is a single exact-groupId
    // lookup, same containment gap as retrieve()'s Graphiti leg above, and
    // memory_entity has no pgvector leg to fall back on at all — a broader/
    // ancestor-scoped grant that's fully authorized for a descendant-scoped
    // entity (e.g. one seeded from Drive-extracted content) otherwise gets
    // nothing back, no denial, silently. Every real, registered scope under
    // the authorized scope (`scope ?? orgRootPath(ctx.orgId)`, not `target`,
    // which stays the bare org id for the entity()'s own bare-org fallback
    // above) is already covered by the same grant (descendantScopePaths
    // mirrors evaluate()'s own containment), so trying each in turn never
    // surfaces anything the caller isn't already entitled to. All of them are asked in
    // one graph call (`groupIds`), past the per-read search bound too: a lookup by id is
    // one indexed match, whatever the number of scopes. An entity id is unique per node,
    // so at most one scope holds it. With no hit while the scope lookup failed, the
    // lookup says so rather than answering "not found".
    const descendantScopes = await descendantScopePaths(ctx.orgId, scope ?? orgRootPath(ctx.orgId));
    const everyDescendant = [...descendantScopes.paths, ...descendantScopes.unsearched];
    const found = await this.reads.entity(ctx.orgId, { ...lookup, groupId: target, groupIds: everyDescendant });
    if (found) {
      const partition = everyDescendant.find((path) => toGid(path) === found.graphGroupId);
      if (partition === undefined) {
        throw new MemoryServiceError("entity lookup answered from a scope it was not asked", 502);
      }
      const { graphGroupId: _graphGroupId, ...entity } = found;
      return { entity, partition };
    }
    if (descendantScopes.partial && descendantScopes.unsearched.length === 0) {
      throw new MemoryServiceError("entity lookup could not list the scopes below yours; ask again", 503);
    }
    return null;
  }

  /** Build the node graph, gated by `memory.read` on the requested scope. */
  async graph(ctx: AccessContext, input: GraphInput, scope?: string): Promise<MemoryGraph> {
    await this.assertTenant(ctx, input.groupId, "memory.read");
    const decision = await check(ctx, {
      action: "memory.read",
      scope,
      target: input.query ? `graph:${input.query}` : "graph",
    });
    if (!decision.allowed) throw new AccessDeniedError(decision);
    // A tier whose reads do not include the graph is not shown it. The view is empty
    // and says why, so no reader takes it for an empty graph.
    if (!graphReadAllowed(await this.tierOf(ctx.orgId))) return { nodes: [], edges: [], notRead: "account-tier" };
    const groupId = resolveExecutedPartition(ctx.orgId, scope ?? input.groupId).groupId;
    // check() above only evaluates `scope` (targetPath = scope ??
    // orgRootPath(ctx.orgId)); a caller-supplied `input.groupIds` has no
    // relationship to it until validated here, with the same containment check
    // (pathCovers) the other reads use. An entry survives only if it IS the
    // checked scope, a real descendant of it, or the bare org id itself when
    // the checked scope covers org root (the same untagged special case
    // hasOrgRootGrant gates elsewhere: the org-root aggregate view legitimately
    // includes untagged content alongside every real scope path). Anything else
    // is dropped before it reaches the store, not merely filtered out of what
    // comes back, so a caller cannot smuggle a sibling scope's content under an
    // audit row that only named `scope`.
    const authorizedScope = scope ?? orgRootPath(ctx.orgId);
    const hasOrgRootGrant = pathCovers(authorizedScope, orgRootPath(ctx.orgId));
    const requestedGroupIds = input.groupIds ?? [groupId];
    const validatedGroupIds = requestedGroupIds.filter(
      (gid) => pathCovers(authorizedScope, gid) || (hasOrgRootGrant && gid === input.groupId),
    );
    // Every caller-supplied id failed containment: behave exactly as if
    // `groupIds` had never been given, rather than issuing a query over an
    // empty partition set. This is a read path, so it degrades to the safe
    // default instead of refusing.
    const graph = await this.reads.graph(ctx.orgId, {
      ...input,
      groupId,
      groupIds: validatedGroupIds.length > 0 ? validatedGroupIds : [groupId],
    });
    if (graph.edges.length === 0) return graph;
    // This view keeps showing a superseded version — seeing the conflict is the point of
    // it — but it must not show one as still valid.
    // `invalidAt` already means "when this fact was superseded"; Graphiti does not know,
    // so it is filled in from the Postgres record. An edge Graphiti already invalidated
    // keeps its own timestamp.
    const record = await loadSupersededVersions(ctx.orgId);
    return {
      ...graph,
      edges: graph.edges.map((edge) => {
        const retiredAt = edge.invalidAt ? null : supersededAt(edge, record, edge.graphGroupId ?? undefined);
        return retiredAt ? { ...edge, invalidAt: retiredAt } : edge;
      }),
    };
  }

  /**
   * Resolve one fact by uuid inside `scope`, gated by `memory.read` — the
   * server-side answer to "is this identifier a real fact the caller is
   * allowed to act on here?"
   *
   * A caller-supplied fact uuid is not evidence of anything on its own: it is
   * an opaque string the client chose. Anything that persists a reference to
   * one resolves it through this first, so the reference is bound to a fact
   * that actually exists in the scope this caller was authorized for (the same
   * shape the fact-dispute writers get by taking their uuid out of a
   * scope-enforced read rather than off the request).
   *
   * Returns null both for a uuid that exists nowhere and for one that exists
   * in another scope or tenant, so the answer cannot be used to probe for
   * facts outside the caller's own grant.
   */
  async findFact(ctx: AccessContext, input: FindFactByIdInput, scope?: string): Promise<FindFactByIdResult | null> {
    await this.assertTenant(ctx, input.groupId, "memory.read");
    const decision = await check(ctx, {
      action: "memory.read",
      scope,
      target: `fact:${input.factId}`,
    });
    if (!decision.allowed) throw new AccessDeniedError(decision);
    return this.lookupFact(ctx, input, scope, !graphReadAllowed(await this.tierOf(ctx.orgId)));
  }

  /**
   * Resolve several facts by uuid inside `scope` under one `memory.read`
   * decision: the re-check a brief makes of the facts it cited
   * (services/memory/brief-citations.ts). One decision and one audit row for
   * the whole set, not one per fact, because the caller discloses one thing:
   * whether what it quoted is still current.
   *
   * Each uuid answers exactly as findFact() would: null both for a fact that is
   * gone and for one now outside `scope`. A lookup that throws is reported as
   * an Error for that uuid alone, so one unreachable backend does not hide the
   * answers the other one gave.
   */
  async resolveFacts(
    ctx: AccessContext,
    input: { groupId: string; factIds: string[]; target: string },
    scope: string,
  ): Promise<Map<string, FindFactByIdResult | null | Error>> {
    await this.assertTenant(ctx, input.groupId, "memory.read");
    const decision = await check(ctx, { action: "memory.read", scope, target: input.target });
    if (!decision.allowed) throw new AccessDeniedError(decision);
    const ids = [...new Set(input.factIds)];
    const rawOnly = !graphReadAllowed(await this.tierOf(ctx.orgId));
    const answers = await Promise.all(
      ids.map((factId) =>
        this.lookupFact(ctx, { groupId: input.groupId, factId }, scope, rawOnly)
          // With the graph not asked, a fact the raw rows do not hold may still be in
          // the graph, so its answer is "could not say", never "gone".
          .then((found) =>
            found === null && rawOnly ? new Error("the graph is not read on this account tier") : found,
          )
          .catch((error: unknown) => (error instanceof Error ? error : new Error(String(error)))),
      ),
    );
    return new Map(ids.map((factId, i) => [factId, answers[i]]));
  }

  /**
   * The store lookup behind findFact() and resolveFacts(); the caller has already decided
   * access. `rawOnly` (set when the org's tier does not read the graph) asks the raw rows
   * alone, and skips the bare-org leg below, which only the graph answers.
   */
  private async lookupFact(
    ctx: AccessContext,
    input: FindFactByIdInput,
    scope: string | undefined,
    rawOnly = false,
  ): Promise<FindFactByIdResult | null> {
    // Same (readGroupId, tenantId) split removeFact() uses below: `groupId`
    // carries the scope path the backends partition on, `tenantId` keeps the
    // bare org id for the backend that stores scope in its own column.
    const readGroupId = resolveExecutedPartition(ctx.orgId, scope ?? input.groupId).groupId;
    const found = await this.reads.findFactById(ctx.orgId, {
      ...input,
      groupId: readGroupId,
      tenantId: input.groupId,
      ...(rawOnly ? { rawOnly: true as const } : {}),
    });
    if (found || rawOnly) return found;

    // Same bare-org fallback retrieve() above carries, for the same reason:
    // Graphiti partitions on an exact groupId, and six ingest paths write with
    // no scopePath at all, so their facts sit under the bare org id rather than
    // under the scope a caller defaults to. Without this leg a perfectly
    // ordinary untagged fact would look unresolvable to an org-root caller —
    // and org root is exactly what the provenance route defaults to.
    //
    // Gated on the checked scope genuinely covering org root, the same
    // containment retrieve() uses, so a narrow-scoped caller never reaches the
    // untagged partition. pgvector needs no second pass: its own untagged rows
    // are already included in the first leg, under the identical org-root
    // condition (see its findFactById), so this leg is Graphiti's to answer and
    // pgvector simply matches nothing in it.
    const hasOrgRootGrant = pathCovers(scope ?? orgRootPath(ctx.orgId), orgRootPath(ctx.orgId));
    if (readGroupId === input.groupId || !hasOrgRootGrant) return null;
    return this.reads.findFactById(ctx.orgId, { ...input, groupId: input.groupId, tenantId: input.groupId });
  }

  /** Remove an entity node + all its edges, gated by `memory.delete`. */
  async removeEntity(ctx: AccessContext, input: RemoveEntityInput, scope?: string): Promise<RemoveFactResult> {
    await this.assertTenant(ctx, input.groupId, "memory.delete");
    const decision = await check(ctx, {
      action: "memory.delete",
      scope,
      target: `entity:${input.entityId}`,
    });
    if (!decision.allowed) throw new AccessDeniedError(decision);
    // check() only authorizes `scope`; the delete must run there too, against
    // the same resolved partition transferEntity() uses, not against the bare
    // org id `input.groupId` carries for assertTenant's tenant marker.
    // `executed` is the partition the delete really ran against, which is not
    // the path check() authorized when `scope` is absent. The applied row below
    // records the authorized path (auditChangesUnderScope() matches briefs on
    // it); the effect row records the executed one. Resolved before the
    // mutation so a partition in neither namespace fails while nothing has been
    // deleted yet.
    const executed = resolveExecutedPartition(ctx.orgId, scope ?? input.groupId);
    const result = await this.store.removeEntity({ ...input, groupId: executed.groupId });
    await recordWriteEffect(ctx, decision, "memory.delete", executed, `entity:${input.entityId}`);
    // auditChangesUnderScope() reads `.applied` rows, so an entity delete under
    // a brief's scope must record an applied counterpart to check()'s
    // authorization-time `memory.delete` row or it drops out of the staleness
    // signal. `scope ?? orgRootPath(ctx.orgId)` is the exact targetPath check()
    // just authorized.
    await recordAppliedChange({
      orgId: ctx.orgId,
      actorType: ctx.actor.type,
      actorId: ctx.actor.id,
      action: "memory.delete",
      scopePath: scope ?? orgRootPath(ctx.orgId),
      tag: `entity:${input.entityId}`,
      runId: ctx.runId,
      origin: ctx.origin,
    });
    return result;
  }

  /**
   * Remove a fact, gated by `memory.delete` (write+). Read-only members can't.
   *
   * @param scope the scope path the delete is authorized and executed at. Required:
   *   a delete never falls back to a default scope. Pass `orgRootPath(orgId)` to
   *   delete at org root, which is also the only scope that reaches untagged rows.
   * @param correction the corrected text, when the fact is being removed because a
   *   person corrected it. The change feed then reports the fact as superseded
   *   rather than deleted.
   * @throws TypeError when `scope` is empty, before any authorization or delete.
   * @throws FactAlreadyReplacedError for a correction of a version stored in `scope` that
   *   another version has already replaced, before anything is deleted: a version is
   *   replaced once (services/memory/edges.ts).
   */
  async removeFact(
    ctx: AccessContext,
    input: RemoveFactInput,
    scope: string,
    correction?: string,
  ): Promise<GuardedRemoveFactResult> {
    // Without a scope, check() would authorize org root while the delete ran
    // against the bare org id, a partition no pgvector row lives in, so the
    // call reported removed:false for a fact that stayed stored.
    if (!scope) {
      throw new TypeError(
        `removeFact(fact:${input.factId}) needs a scope; pass orgRootPath(orgId) to delete at org root`,
      );
    }
    await this.assertTenant(ctx, input.groupId, "memory.delete");
    const decision = await check(ctx, {
      action: "memory.delete",
      scope,
      target: `fact:${input.factId}`,
    });
    if (!decision.allowed) throw new AccessDeniedError(decision);
    // Checked after the decision, so a version the caller may not delete reads as absent.
    if (correction !== undefined) {
      const current = await currentReplacementWithin(db, {
        orgId: ctx.orgId,
        versionId: input.factId,
        scopePath: scope,
      });
      if (current !== null) throw new FactAlreadyReplacedError(input.factId, current);
    }
    // Same forwarding as removeEntity() above. `groupId` carries the scope path
    // for Graphiti; `tenantId` carries the bare org id separately (the split
    // retrieve() uses) so pgvector's DELETE filters on the tenant column it has,
    // not the scope path Graphiti wants; overwriting `groupId` alone leaves
    // pgvector's removeFact no field to fall back to. `executed` is recorded
    // the same way as in removeEntity().
    const executed = resolveExecutedPartition(ctx.orgId, scope);
    const result = await this.store.removeFact({ ...input, groupId: executed.groupId, tenantId: input.groupId });
    try {
      return await this.recordRemoval(ctx, decision, executed, input, scope, result, correction);
    } catch (e) {
      // The fact is gone whatever the recording did; a caller must not read this as a removal
      // that did not happen.
      if (result.removed) throw new RemovalNotRecordedError(input.factId, e, decision.auditLogId);
      throw e;
    }
  }

  /** The audit rows and change event of one fact delete `store.removeFact` has run. */
  private async recordRemoval(
    ctx: AccessContext,
    decision: AccessDecision,
    executed: ExecutedPartition,
    input: RemoveFactInput,
    scope: string,
    result: RemoveFactResult,
    correction: string | undefined,
  ): Promise<GuardedRemoveFactResult> {
    await recordWriteEffect(ctx, decision, "memory.delete", executed, `fact:${input.factId}`);
    // The confirmed-applied counterpart to the `memory.delete` authorization
    // row check() wrote above, recorded only after the real delete has
    // landed, with the same `fact:${factId}` tag so auditChangesUnderScope()
    // sees deletes the same way it sees applied writes. The change-feed event
    // for the delete commits with it.
    const changeId = await recordFactRemoved({
      orgId: ctx.orgId,
      actorType: ctx.actor.type,
      actorId: ctx.actor.id,
      scopePath: scope,
      factId: input.factId,
      removed: result.removed,
      correction,
      subject: result.storedEntityName,
      factText: result.removedFactText,
      authorizedById: decision.auditLogId,
      runId: ctx.runId,
      origin: ctx.origin,
    });
    if (changeId === null) return { ...result, authorizedById: decision.auditLogId };
    const storedScopePath =
      result.storedScopePath === undefined ? scope : (result.storedScopePath ?? orgRootPath(ctx.orgId));
    return { ...result, authorizedById: decision.auditLogId, removedVersion: { changeId, scopePath: storedScopePath } };
  }

  /** Invalidate edges on oldName and recreate them on newName, gated by
   * `memory.write` on `scope` — the entity's own resolved scope, never a
   * caller-supplied one (see services/memory/entity-scope.ts's
   * resolveEntityScope; app/api/memory/entities/merge/route.ts is the only
   * caller and always passes the scope it derived from `oldName` there, not
   * anything from the request body). `input.groupId` stays the bare org id
   * (assertTenant's tenant marker, same convention every other method here
   * uses); the real write runs against the executed partition below, the same
   * `scope ?? input.groupId` shape removeEntity() uses.
   *
   * The (checkScope, executed partition) split: the bare org id is the
   * untagged Graphiti partition, not an ltree scope path — every
   * real registered scope is `org_<orgId>[...]`, so checking the bare id
   * literally means no grant, not even an org-root admin one, can ever cover
   * it (check()'s targetPath === scope verbatim). resolveEntityScope's FIRST
   * candidate is exactly the bare `orgId`, so `scope === input.groupId`
   * precisely identifies that case; check at orgRootPath(ctx.orgId) instead —
   * the same relation retrieve()'s hasOrgRootGrant already gates bare-org
   * visibility on — while the actual write still lands in the resolved,
   * untagged partition it came from, never silently widened to org root. */
  async transferEntity(ctx: AccessContext, input: TransferEntityInput, scope?: string): Promise<TransferEntityResult> {
    await this.assertTenant(ctx, input.groupId, "memory.write");
    const checkScope = scope === input.groupId ? orgRootPath(ctx.orgId) : scope;
    const decision = await check(ctx, {
      action: "memory.write",
      scope: checkScope,
      target: `merge:${input.oldName}→${input.newName}`,
    });
    if (!decision.allowed) throw new AccessDeniedError(decision);
    // `executed` is deliberately not `checkScope`: this method is the clearest
    // case of the two diverging, since the org-root special case
    // authorizes orgRootPath() while the merge still lands in the bare,
    // untagged partition it came from. That divergence is exactly what this
    // row exists to make visible, and it survives into the audit target only
    // because resolveExecutedPartition() marks which namespace it is in.
    const executed = resolveExecutedPartition(ctx.orgId, scope ?? input.groupId);
    const result = await this.store.transferEntity({ ...input, groupId: executed.groupId });
    await recordWriteEffect(ctx, decision, "memory.write", executed, `merge:${input.oldName}→${input.newName}`);
    // Same applied counterpart as removeEntity() above: an entity merge under a
    // brief's scope must record one next to check()'s authorization-time
    // `memory.write` row. scopePath matches `checkScope` (the exact targetPath
    // check() just authorized), not the raw `scope` param, so the org-root
    // special case (`scope === input.groupId`) stays consistent between the
    // authorization and the applied row.
    await recordAppliedChange({
      orgId: ctx.orgId,
      actorType: ctx.actor.type,
      actorId: ctx.actor.id,
      action: "memory.write",
      scopePath: checkScope ?? orgRootPath(ctx.orgId),
      tag: `merge:${input.oldName}→${input.newName}`,
      runId: ctx.runId,
      origin: ctx.origin,
    });
    return result;
  }

  /** Tenant safety net on the bare `group_id` a request carries: it must be the
   * org id itself or a descendant of it, through the shared containment
   * predicate, not a hand-rolled prefix comparison. The partition a method
   * actually reads or writes (`scope ?? input.groupId`) is checked separately,
   * by resolveExecutedPartition() in services/access/check.ts. The refusal is
   * recorded under the action the method was asked for, since it never reaches
   * the check() that would otherwise record it. */
  private async assertTenant(ctx: AccessContext, groupId: string, action: AccessAction): Promise<void> {
    if (!pathCovers(ctx.orgId, groupId)) {
      const reasons = groupIdOutsideTenant(ctx.orgId, groupId);
      await recordRefusal(ctx, { action, target: groupId, auditReason: reasons.auditReason });
      throw new AccessDeniedError({ allowed: false, ...reasons });
    }
  }
}

/** The singleton request paths read through: the default hybrid store, with
 *  each org's account tier resolved from the database. */
export const guardedMemory = new GuardedMemoryStore(memory, loadAccountTier);
