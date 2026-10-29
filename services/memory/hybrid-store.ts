// HybridMemoryStore — queries Graphiti (graph facts) and pgvector (semantic chunks)
// in parallel and merges the results. Deduplication is by normalized exact match on
// the fact text (services/memory/fact-text.ts), so distilled facts and their source chunks
// don't double-count the same information; a graph copy that names its stored chunk by id
// (`chunkIds`) gives way to that chunk (`isBetterCopy`).
//
// The split at ingest time:
//   actorType=extraction → Graphiti only (already distilled, never stored twice)
//   empty content → Graphiti only (pgvector gets no row for a blank chunk)
//   everything else → Graphiti (distilled facts) + pgvector (raw chunks)
//
// At retrieval time callers get one unified SearchResult: graph facts, then vector hits,
// with the rows the vector store's text leg found fused in (text-match-fusion.ts), so a
// query that quotes a stored row serves that row high. Which of the legs a read asks is
// the routing policy's (`readLegs`); a tier whose legs are the text leg alone gets the
// vector store's text read on its own. Each fact still names the store it came from, and
// `storesRead` lists the stores this read asked, marking a graph read `partial` when the
// policy is in force and rows the reader could read still owe the graph their extraction.
//
// The one rule a read keeps: a store that fails is asked once more, inside the same
// latency ceiling and only while that ceiling has not passed, and a store that fails
// again is reported failed in `storesRead`, never left to look like a store that had
// nothing to say.

import { StoreRefusedError, type MemoryStore } from "./memory-store";
import { orgRootPath, removingFromGraph } from "@/services/access";
import { dropEpisodePointers } from "./episode-pointers";
import { MemoryServiceError } from "./graphiti-store";
import { normalizeFactText } from "./fact-text";
import { fuseTextRanking } from "./text-match-fusion";
import type {
  IngestInput,
  IngestResult,
  SearchInput,
  SearchResult,
  StoreRead,
  EntityLookup,
  MemoryEntity,
  GraphInput,
  MemoryGraph,
  RemoveFactInput,
  RemoveFactResult,
  MemoryFact,
  RemoveEntityInput,
  TransferEntityInput,
  TransferEntityResult,
  FindFactByIdInput,
  FindFactByIdResult,
} from "@/types/memory";
import { DEFAULT_ACCOUNT_TIER, TIER_LIMITS } from "./account-tiers";
// Which legs a read asks (the raw text leg, the raw vector leg, the graph) is the routing
// policy's (services/memory/routing-policy.ts), the same module that decides what a write absorbs.
import { readLegs, readPolicyInForce, shapeOfQuery } from "./routing-policy";
const NO_FACTS: SearchResult = { facts: [] };

/** Rejects if `leg` has not settled within `ms`, so one slow store cannot hold a read past the tier's ceiling. */
function withinCeiling<T>(leg: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ceiling = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`exceeded the account tier's ${ms}ms latency ceiling`)), ms);
  });
  return Promise.race([leg, ceiling]).finally(() => clearTimeout(timer));
}

/** True when a store answered but reported its own read as failed (it caught the error itself). */
function reportsFailure(result: SearchResult): boolean {
  return result.storesRead?.some((read) => read.failed) ?? false;
}

/**
 * Whether asking a store again could change the outcome of `error`. Not when the store
 * refused the request (a 4xx other than a timeout or a rate limit), is not configured
 * (a memory service error with no status), or lacks its schema (StoreRefusedError).
 */
function worthAskingAgain(error: unknown): boolean {
  if (error instanceof StoreRefusedError) return false;
  if (!(error instanceof MemoryServiceError)) return true;
  const { status } = error;
  if (status === undefined) return false;
  return status >= 500 || status === 408 || status === 429;
}

/**
 * Reads one store within `ms`, asking it once more when `retry` is set and the first
 * attempt throws something worth asking again about, or reports a failed read. Both
 * attempts share the one ceiling: once it has passed, the read has already returned
 * without this store, and no second attempt is made, however late the first one fails.
 * A healthy store is asked exactly once.
 */
function readWithOneRetry(
  name: string,
  read: () => Promise<SearchResult>,
  ms: number,
  retry: boolean,
): Promise<SearchResult> {
  const deadline = Date.now() + ms;
  const attempts = async () => {
    try {
      const first = await read();
      if (!retry || !reportsFailure(first) || Date.now() >= deadline) return first;
      console.warn(`[hybrid] ${name} retrieve reported a failed read, asking once more`);
    } catch (e) {
      if (!retry || !worthAskingAgain(e) || Date.now() >= deadline) throw e;
      console.warn(`[hybrid] ${name} retrieve failed, asking once more:`, e instanceof Error ? e.message : e);
    }
    return read();
  };
  return withinCeiling(attempts(), ms);
}

function dedup(graphitiFacts: MemoryFact[], pgFacts: MemoryFact[]): MemoryFact[] {
  // Exact-match dedup only: catches the same distilled sentence appearing in
  // both Graphiti and pgvector. Any fuzzy similarity collapses distinct facts
  // that share a sentence template ("meeting with Joey" vs "meeting with Zoe").
  //
  // Which copy is kept, in the first copy's place: see `isBetterCopy`.
  const indexByKey = new Map<string, number>();
  const kept: MemoryFact[] = [];
  for (const f of [...graphitiFacts, ...pgFacts]) {
    const key = normalizeFactText(f.fact);
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, kept.length);
      kept.push(f);
    } else {
      const existing = kept[existingIndex];
      let winner = existing;
      if (isBetterCopy(f, existing)) {
        // The synced item a graph copy names (`sourceEventIds`) is kept on a chunk of the same
        // source that replaces it, so the line still cites the item its text came from. An
        // item of another source would be cited under the wrong source.
        const carryItem = !f.sourceEventIds && existing.sourceEventIds && f.sourceId === existing.sourceId;
        winner = carryItem ? { ...f, sourceEventIds: existing.sourceEventIds } : f;
      }
      // The text leg found this text whichever copy is served, so the served copy keeps the
      // better of the two copies' text ranks.
      const textMatchRank = bestTextMatchRank(existing, f);
      let served = textMatchRank === winner.textMatchRank ? winner : { ...winner, textMatchRank };
      // A graph copy kept over a stored row keeps that row, so a read that may not serve the
      // graph copy (services/memory/graph-fact-sources.ts) serves the row in its place.
      if (winner === existing && f.store === "semantic" && existing.store !== "semantic") {
        served = { ...served, displacedCopies: [...(served.displacedCopies ?? []), f] };
      }
      kept[existingIndex] = served;
    }
  }
  return kept;
}

/** The better (lower) text rank of two copies of one text, or undefined when neither has one. */
function bestTextMatchRank(a: MemoryFact, b: MemoryFact): number | undefined {
  const ranks = [a.textMatchRank, b.textMatchRank].filter((rank) => rank !== undefined);
  return ranks.length === 0 ? undefined : Math.min(...ranks);
}

/**
 * Whether `candidate` should be served instead of `kept`, an earlier copy of the same text.
 *
 * A copy that carries a real actorType beats one that carries none: Graphiti's copy can
 * come back unstamped while pgvector's copy of the same claim knows the real tier, and
 * first-wins would throw that tier away.
 *
 * Between copies of the same provenance, the stored chunk beats the graph's copy. The
 * graph stores a write in its own words when extraction finds no relation in it, so it can
 * hold the exact text of a stored chunk. The chunk is the version itself: it carries the
 * date its writer gave it, and a read can serve it in place of the graph facts extracted
 * from it (`collapseIntoSourceChunks`). Served as the graph's copy, the same text comes
 * back beside its own paraphrases, stamped with the graph's clock.
 *
 * Copies of different provenance are never swapped here: which tier is served is the
 * ranker's decision, and swapping could serve the text below the tier it was asserted at.
 * Provenance is the tier and the source together. Every connector passage carries the
 * extraction tier, so two sources holding the same text share it; a swap between them
 * would carry one source's synced item onto a line that cites the other source.
 *
 * The one exception to "same source" is a graph copy that names the stored chunk itself as
 * the only row it was extracted from (`chunkIds`, stamped at write time): then they are one
 * piece of information, whatever the graph's own source stamp says (the memory service reads
 * it from an episode when the edge carries none, so it can be missing). The chunk is served,
 * under its own source; the tier must still match, and the graph's synced item is carried
 * only under the same source, as above. A graph copy is never relabelled as a stored row.
 */
function isBetterCopy(candidate: MemoryFact, kept: MemoryFact): boolean {
  if (kept.actorType == null) return candidate.actorType != null;
  return (
    candidate.actorType === kept.actorType &&
    (candidate.sourceId === kept.sourceId || isSourceChunkOf(candidate, kept)) &&
    candidate.store === "semantic" &&
    kept.store !== "semantic"
  );
}

/** Whether `chunk` is the one stored row the graph copy `graphCopy` was extracted from. */
function isSourceChunkOf(chunk: MemoryFact, graphCopy: MemoryFact): boolean {
  return graphCopy.chunkIds?.length === 1 && graphCopy.chunkIds[0] === chunk.uuid;
}

/** Fronts a graph store and a vector store as one MemoryStore. A read tolerates
 *  either leg failing; an ingest tolerates only the vector leg failing, because
 *  the graph result is what the caller gets back. */
export class HybridMemoryStore implements MemoryStore {
  constructor(
    private readonly graphiti: MemoryStore,
    private readonly pgvector: MemoryStore,
  ) {}

  async ingest(input: IngestInput): Promise<IngestResult> {
    // Ingest to graphiti always (caller decides what content arrives here).
    // pgvector receives ALL non-extraction content, short facts included, so a
    // fact is always semantically retrievable even when Graphiti's entity
    // extractor produces no graph nodes for it (e.g. a short technical decision
    // like "the job queue uses SQS"); a length gate here would make such facts
    // unretrievable. Extraction-tier content (entity seeds and distilled facts
    // already routed to Graphiti directly) is excluded so it is not stored twice.
    // BGE embedding is local/free, so embedding short facts is cheap.
    const shouldChunk = input.actorType !== "extraction" && input.content.trim().length > 0;
    if (!shouldChunk) return this.graphiti.ingest(input);

    // The row first, so the graph episode carries its id (`readableId`), as every write
    // stamps its episodes: deleting the row as a fact, or erasing a person it names, then
    // retires what the graph extracted from it (`removeChunkFacts`). The graph leg is what
    // this method returns, so a vector-leg failure is not fatal here, but the content is not
    // semantically retrievable until it is ingested again, and its episode is unstamped.
    const chunk = await this.pgvector.ingest(input).catch((e: unknown) => {
      console.warn(
        "[hybrid] pgvector ingest failed, content is not semantically retrievable:",
        e instanceof Error ? e.message : e,
      );
      return null;
    });
    if (!chunk) return this.graphiti.ingest(input);
    const graphitiResult = await this.graphiti.ingest({ ...input, readableId: chunk.episodeId });
    // A removal between the two writes retired nothing of the episode yet: it was not
    // written. Once it is, a row gone by then means its episode is retired here.
    await this.retireIfRemoved(input, chunk.episodeId);
    return graphitiResult;
  }

  /** Retire the graph episodes stamped with `chunkId` when its row is no longer stored. */
  private async retireIfRemoved(input: IngestInput, chunkId: string): Promise<void> {
    const removeChunkFacts = this.graphiti.removeChunkFacts?.bind(this.graphiti);
    if (!removeChunkFacts) return;
    const stored = await this.pgvector.findFactById({
      groupId: orgRootPath(input.groupId),
      tenantId: input.groupId,
      factId: chunkId,
    });
    if (stored) return;
    // Graph only: the removal epoch is moved around it (scopeCacheStamp()).
    await removingFromGraph(input.groupId, async () => {
      const retired = await removeChunkFacts({ groupId: input.scopePath ?? input.groupId, chunkId });
      await dropEpisodePointers(input.groupId, retired?.episodeIds ?? []);
    });
  }

  async retrieve(input: SearchInput): Promise<SearchResult> {
    // A read asks the legs the routing policy names for its tier, graph first, unless the
    // caller sets skipPgvector, which skips both raw legs. Entity lookups (who/what is X)
    // included: a new chunk is in pgvector as soon as ingest returns, but its extracted facts
    // reach the graph only later, so a graph-only read would answer from the state before the
    // change while extraction is behind. With the flags off the legs are exactly the stores
    // this read asked before the policy existed (routing-policy.read-legs.test.ts).
    const tier = input.accountTier ?? DEFAULT_ACCOUNT_TIER;
    const legs = readLegs(shapeOfQuery({ query: input.query }), tier);
    const askGraph = legs.includes("graph");
    // The vector store's read runs the text leg inside it and fuses the two rankings, so the
    // text leg alone is its own read only when the vector leg is not asked.
    const rawRead = legs.includes("semantic")
      ? () => this.pgvector.retrieve(input)
      : legs.includes("text") && this.pgvector.retrieveText
        ? () => this.pgvector.retrieveText!(input)
        : null;
    const askRaw = rawRead !== null && !input.skipPgvector;
    if (legs.length === 0) {
      console.warn(`[hybrid] account tier "${tier}" allows neither the graph nor vector store; returning no facts`);
    }

    const { latencyCeilingMs } = TIER_LIMITS[tier];
    // Where the policy is in force, a graph read says how far absorption is behind. The
    // count runs beside the reads, within the same ceiling; one that fails or is late claims nothing.
    const pending =
      askGraph && readPolicyInForce(tier) ? this.countPendingAbsorption(input, latencyCeilingMs) : Promise.resolve(0);
    const [graphitiResult, pgResult] = await Promise.allSettled([
      askGraph
        ? readWithOneRetry(
            "graphiti",
            () => this.graphiti.retrieve(input),
            latencyCeilingMs,
            !input.noRetry?.includes("graph"),
          )
        : Promise.resolve(NO_FACTS),
      askRaw
        ? readWithOneRetry("pgvector", rawRead, latencyCeilingMs, !input.noRetry?.includes("semantic"))
        : Promise.resolve(NO_FACTS),
    ]);
    const pendingRows = await pending;

    // A leg that still failed after its retry (timeout, the tier's latency ceiling,
    // cold service, AuraDB reconnect) is NOT fatal: the other leg still answers, and
    // `storesRead` below marks the failed one so the caller is told.
    for (const [name, leg] of [
      ["graphiti", graphitiResult],
      ["pgvector", pgResult],
    ] as const) {
      if (leg.status === "rejected") {
        console.warn(
          `[hybrid] ${name} retrieve failed, returning the other leg only:`,
          leg.reason instanceof Error ? leg.reason.message : leg.reason,
        );
      }
    }
    const graphitiFacts = graphitiResult.status === "fulfilled" ? graphitiResult.value.facts : [];
    const pgFacts = pgResult.status === "fulfilled" ? pgResult.value.facts : [];

    // Only the stores this read actually asked; a rejected leg is reported as failed.
    const storesRead: StoreRead[] = [];
    for (const [asked, store, leg] of [
      [askGraph, "graph", graphitiResult],
      [askRaw, "semantic", pgResult],
    ] as const) {
      if (!asked) continue;
      if (leg.status === "rejected") storesRead.push({ store, failed: true });
      else storesRead.push(...(leg.value.storesRead ?? [{ store }]));
    }
    if (pendingRows > 0) {
      for (const [i, read] of storesRead.entries()) {
        if (read.store === "graph" && !read.failed) storesRead[i] = { ...read, partial: true, pendingRows };
      }
    }

    const facts = dedup(graphitiFacts, pgFacts);
    const textRanking = facts
      .filter((f) => f.textMatchRank !== undefined)
      .sort((a, b) => a.textMatchRank! - b.textMatchRank!);
    return { facts: fuseTextRanking(facts, textRanking), storesRead };
  }

  /** Rows the reader could read that the graph has yet to absorb, or 0 when the count fails or misses the ceiling. */
  private async countPendingAbsorption(input: SearchInput, ms: number): Promise<number> {
    const count = this.pgvector.pendingAbsorption?.bind(this.pgvector);
    if (!count) return 0;
    try {
      return await withinCeiling(count(input), ms);
    } catch (e) {
      console.warn(
        "[hybrid] counting rows the graph has yet to absorb failed; the read does not say whether it is partial:",
        e instanceof Error ? e.message : e,
      );
      return 0;
    }
  }

  // Entity and graph lookups go to Graphiti alone — they are graph-native and
  // pgvector answers nothing for them. removeFact below asks both stores.
  async entity(input: EntityLookup): Promise<MemoryEntity | null> {
    return this.graphiti.entity(input);
  }

  async graph(input: GraphInput): Promise<MemoryGraph> {
    return this.graphiti.graph(input);
  }

  async removeFact(input: RemoveFactInput): Promise<RemoveFactResult> {
    const retireChunk = await this.chunkRetirement(input);
    if (retireChunk) await retireChunk();
    // An id that names no chunk may name a graph fact: its text is read before it goes, so the
    // removal can say what it removed (`RemoveFactResult.removedFactText`).
    const graphFact = retireChunk ? null : await this.graphFactText(input);
    // Try both — the fact might be in either store.
    const [g, p] = await Promise.allSettled([this.graphiti.removeFact(input), this.pgvector.removeFact(input)]);
    const removed = (g.status === "fulfilled" && g.value.removed) || (p.status === "fulfilled" && p.value.removed);
    // Only the chunk store's delete reaches below the scope asked, so only its answer says
    // where the fact was stored and under what name (`RemoveFactResult.storedScopePath`).
    const chunk = p.status === "fulfilled" && p.value.removed ? p.value : null;
    // A queued ingest job can write the chunk's episodes after the retirement above and
    // still find the row when it checks after writing (lib/inngest/memory-ingest.ts), if
    // the row was not deleted yet. Retiring again once the row is gone removes them; a
    // job that writes later finds the row gone and retires its own episodes. Once the row
    // is deleted, a failure here does not undo that: it is logged rather than thrown, so the
    // caller still records the removal, and a person's correction of the fact is still kept.
    if (retireChunk) {
      await retireChunk().catch((e: unknown) => {
        if (!chunk) throw e;
        console.error(
          `[memory] chunk ${input.factId} was deleted, but retiring its graph episodes again failed; episodes a job wrote meanwhile may remain:`,
          e,
        );
      });
    }
    if (chunk && chunk.storedScopePath !== undefined) {
      return { removed, storedScopePath: chunk.storedScopePath, storedEntityName: chunk.storedEntityName ?? null };
    }
    const graphRemoved = g.status === "fulfilled" && g.value.removed;
    return graphRemoved && graphFact !== null ? { removed, removedFactText: graphFact } : { removed };
  }

  /**
   * The text of the graph fact `input` names, or null when it names none or the graph cannot
   * say. A failed lookup is logged and costs only the removal's description, never the removal.
   */
  private async graphFactText(input: RemoveFactInput): Promise<string | null> {
    try {
      return (await this.graphiti.findFactById(input))?.fact ?? null;
    } catch (e) {
      console.error(
        `[memory] reading graph fact ${input.factId} before removing it failed; its removal will not name it:`,
        e,
      );
      return null;
    }
  }

  /**
   * A fact id that names a stored chunk also names the graph facts ingest distilled from
   * it: their episodes carry the chunk id. Deleting only the chunk would leave those
   * facts answering every graph read, so `removeFact` retires them, at the scope the chunk
   * itself is stored in, before the chunk goes: a graph failure throws while the chunk is
   * still there and a retry can find it again. The lookup is the chunk store's own scoped
   * one, so only a chunk the caller may delete reaches the graph. Returns the retirement,
   * or null when the id names no such chunk or the graph store cannot retire one.
   */
  private async chunkRetirement(input: RemoveFactInput): Promise<(() => Promise<void>) | null> {
    const removeChunkFacts = this.graphiti.removeChunkFacts?.bind(this.graphiti);
    if (!removeChunkFacts) return null;
    const tenantId = input.tenantId ?? input.groupId;
    const chunk = await this.pgvector.findFactById({ groupId: input.groupId, tenantId, factId: input.factId });
    if (!chunk) return null;
    return async () => {
      const retired = await removeChunkFacts({ groupId: chunk.scopePath ?? tenantId, chunkId: chunk.uuid });
      await dropEpisodePointers(tenantId, retired?.episodeIds ?? []);
    };
  }

  async removeEntity(input: RemoveEntityInput): Promise<RemoveFactResult> {
    return this.graphiti.removeEntity(input);
  }

  async transferEntity(input: TransferEntityInput): Promise<TransferEntityResult> {
    return this.graphiti.transferEntity(input);
  }

  async findFactById(input: FindFactByIdInput): Promise<FindFactByIdResult | null> {
    // A fact id can name either a Graphiti edge or a pgvector chunk (ingest
    // splits long human/document content across both), so resolution has to
    // ask both before concluding a uuid is unknown. Both sides are already
    // partitioned by the same scope, so neither can answer for content
    // outside it.
    //
    // A throw from either side is deliberately not caught: during a deployment
    // window where the memory-service cannot serve the lookup, a chunk that
    // pgvector alone could have resolved is refused rather than resolved on
    // half the evidence.
    //
    // A `rawOnly` lookup (set when the org's tier does not read the graph) asks the raw rows
    // alone, and the flag is not passed on.
    if (input.rawOnly) {
      const { rawOnly: _rawOnly, ...rawInput } = input;
      return this.pgvector.findFactById(rawInput);
    }
    return (await this.graphiti.findFactById(input)) ?? (await this.pgvector.findFactById(input));
  }
}
