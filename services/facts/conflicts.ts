// UC9 contradiction detection (docs/willder_conflict_resolution.md). Three things
// live here: (1) broad-semantic contradiction detection for a new assertion (the
// locked decision — retrieve broadly, then LLM-judge), used by the human-correction
// path; (2) graph-edge helpers that recover a fact's provenance (actor_type) by
// uuid/text, because the /search retrieval path drops actor_type but the /graph
// edges carry it — provenance is what the human>agent>extraction ranking needs to
// pick auto-merge vs dispute, so it MUST come from the graph, not from search; (3)
// a bounded scope-level contradiction scan (Gate C.2, item
// handoff-gate-c2-contradiction-detection-20260919) — same retrieve-then-LLM-flag
// shape, generalized from "one new assertion vs existing facts" to "any genuine
// pairwise contradiction among a scope's current facts", for a caller (the Handoff
// staleness read) that has no single new assertion to check, only a scope that
// picked up new memory since a brief was generated.
import { createLLMClient, LLM_MODEL_ORCHESTRATOR } from "@/lib/llm";
import { guardedMemory } from "@/services/memory";
import { excerptMarker } from "@/services/memory/query-excerpt";
import { rawRowAuthorship } from "@/services/memory/raw-rows";
import type { AccessContext } from "@/services/access";
import type { ActorType, MemoryEdge, MemoryFact, MemoryGraph } from "@/types/memory";

export interface ContradictionResult {
  fact: string;
  uuid: string;
  /** Provenance of the contradicted (existing) fact. Defaults to "human" when the
   *  graph can't tell us — the conservative choice, since it opens a dispute rather
   *  than destructively auto-merging over something we can't rank. */
  actorType: ActorType;
  actorName?: string | null;
  note: string;
}

/** What a contradiction check found, and whether it looked everywhere it should have. */
export interface ContradictionCheck {
  /** The existing fact the assertion contradicts, or null when none was found. */
  contradiction: ContradictionResult | null;
  /**
   * False when the read behind the check did not search everything (scopes below the
   * granted one left unsearched, or a store that did not answer): a null
   * `contradiction` then means none was found in what was searched, not that none exists.
   */
  complete: boolean;
}

/** Load the granted scope's graph edges (they carry actor_type; search results don't). */
async function loadScopeEdges(ctx: AccessContext, orgId: string, scopePath?: string): Promise<MemoryEdge[]> {
  try {
    const graph = await guardedMemory.graph(ctx, { groupId: orgId, limit: 500 }, scopePath);
    return graph.edges;
  } catch {
    return [];
  }
}

const norm = (s: string) => s.trim().toLowerCase();

/** Match a fact string to a graph edge — exact (normalized) first, then substring. */
function matchEdgeByFact(edges: MemoryEdge[], factText: string): MemoryEdge | null {
  const want = norm(factText);
  return (
    edges.find((e) => norm(e.fact) === want) ??
    edges.find((e) => {
      const have = norm(e.fact);
      return have.includes(want) || want.includes(have);
    }) ??
    null
  );
}

/**
 * Broad-semantic contradiction detection (locked decision): retrieve broadly from the
 * granted scope, then let the LLM judge which retrieved fact — if any — the assertion
 * contradicts. Provenance is joined in from the graph edges by uuid. `contradiction` is
 * null when no genuine contradiction is found; `complete` says whether the read behind
 * that answer searched everything.
 */
export async function findContradiction(
  ctx: AccessContext,
  orgId: string,
  scopePath: string | undefined,
  assertion: string,
): Promise<ContradictionCheck> {
  const read = await guardedMemory.retrieve(ctx, { groupId: orgId, query: assertion, limit: 20 }, scopePath);
  const complete = !read.partialScopeCoverage && !read.degraded?.length;
  return {
    contradiction: await judgeContradiction(ctx, orgId, scopePath, assertion, read.facts),
    complete,
  };
}

/** The fact in `facts` the assertion contradicts, as the model judges it, or null. */
async function judgeContradiction(
  ctx: AccessContext,
  orgId: string,
  scopePath: string | undefined,
  assertion: string,
  facts: MemoryFact[],
): Promise<ContradictionResult | null> {
  if (facts.length === 0) return null;

  const numbered = facts.map((f, i) => `${i + 1}. ${f.fact}${excerptMarker(f)}`).join("\n");
  const llm = createLLMClient();
  let judged: { index: number; note: string } | null = null;
  try {
    const resp = await llm.chat.completions.create({
      model: LLM_MODEL_ORCHESTRATOR,
      messages: [
        {
          role: "system",
          content:
            "You detect factual contradictions. Given a NEW assertion and a numbered list of EXISTING facts, " +
            "identify the single existing fact the new assertion most directly contradicts (same subject, incompatible claim). " +
            'Return JSON {"index": <1-based index, or 0 if none genuinely contradicts>, "note": "<one line why>"}.',
        },
        { role: "user", content: `NEW assertion:\n${assertion}\n\nEXISTING facts:\n${numbered}` },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: 300,
    });
    const raw = resp.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw) as { index?: number; note?: string };
    if (parsed.index && parsed.index >= 1 && parsed.index <= facts.length) {
      judged = { index: parsed.index - 1, note: parsed.note ?? "" };
    }
  } catch {
    return null;
  }
  if (!judged) return null;

  const hit = facts[judged.index];
  const edges = await loadScopeEdges(ctx, orgId, scopePath);
  const edge = edges.find((e) => e.uuid === hit.uuid) ?? matchEdgeByFact(edges, hit.fact);
  // With no edge to say who wrote the hit (a row the graph has not absorbed: pending, a
  // failed extraction, or a tier that does not read the graph), its author is the one its own
  // row records in Postgres. Only a hit that names no raw row of the org defaults to "human".
  // A hit with a matching edge is answered from the edge, exactly as before.
  if (!edge) {
    const author = await rawRowAuthorship(orgId, hit.uuid);
    if (author) {
      return {
        fact: hit.fact,
        uuid: hit.uuid,
        actorType: author.actorType,
        actorName: author.actorName ?? undefined,
        note: judged.note,
      };
    }
  }

  return {
    fact: hit.fact,
    uuid: edge?.uuid ?? hit.uuid,
    actorType: edge?.actorType ?? "human",
    actorName: edge?.actorName ?? undefined,
    note: judged.note,
  };
}

/** Bound on how many current facts a scope-level contradiction scan retrieves —
 *  matches `MAX_CHANGES` (app/api/briefs/[id]/staleness/route.ts), so a scan never
 *  costs more than the staleness banner it backs already reads. */
const SCOPE_SCAN_LIMIT = 20;

export interface ScopeContradiction {
  factA: string;
  factB: string;
  note: string;
}

/**
 * Bounded
 * same-tier contradiction scan over a scope's CURRENT facts, used READ-TIME by
 * GET /api/briefs/:id/staleness, gated on that route's own `changed` flag so this
 * never runs on ordinary ingest (Slack/Drive/Figma syncs, agent facts, etc.) —
 * only when the scope a brief was drawn from has actually picked up new memory
 * since it was generated. Cost is bounded two ways: SCOPE_SCAN_LIMIT caps the
 * graph read, and the caller only invokes this when `changed` is true.
 *
 * Same "retrieve, then let an LLM flag genuine pairwise contradictions" shape
 * services/agents/runner.ts's ARCHITECTURE_OUTPUT_SCHEMA already uses during an
 * architecture-plan generation run — reused here as a standalone check instead of
 * only as a side effect of a full agent run, since the Handoff agent's own output
 * schema (HANDOFF_OUTPUT_SCHEMA) never asks the model to flag contradictions and a
 * handoff brief has no generation-time analysis pass to hang one off of.
 */
export async function findScopeContradictions(
  ctx: AccessContext,
  orgId: string,
  scopePath: string,
): Promise<ScopeContradiction[]> {
  return (await findScopeContradictionsChecked(ctx, orgId, scopePath)).found;
}

/** What a scope scan found, and, when it did not read the graph, why. */
export interface ScopeContradictionScan {
  found: ScopeContradiction[];
  /**
   * Set when the scan did not read the graph because the org's tier does not: `found` is
   * then empty without anything having been judged, and no model call was made.
   */
  notRead?: MemoryGraph["notRead"];
}

/** {@link findScopeContradictions}, saying when the graph it scans was not read. */
export async function findScopeContradictionsChecked(
  ctx: AccessContext,
  orgId: string,
  scopePath: string,
): Promise<ScopeContradictionScan> {
  let notRead: MemoryGraph["notRead"];
  const found = await scanScopeEdges(ctx, orgId, scopePath, (why) => {
    notRead = why;
  });
  return notRead ? { found, notRead } : { found };
}

async function scanScopeEdges(
  ctx: AccessContext,
  orgId: string,
  scopePath: string,
  onNotRead: (why: NonNullable<MemoryGraph["notRead"]>) => void,
): Promise<ScopeContradiction[]> {
  let edges: MemoryEdge[];
  try {
    const graph = await guardedMemory.graph(ctx, { groupId: orgId, limit: SCOPE_SCAN_LIMIT }, scopePath);
    if (graph.notRead) {
      onNotRead(graph.notRead);
      return [];
    }
    // Current facts only. The graph view keeps a superseded version, marked by
    // `invalidAt`, so its history stays visible; judged here it would turn a conflict
    // the product already decided into a live contradiction between two current facts.
    edges = graph.edges.filter((edge) => !edge.invalidAt);
  } catch {
    return [];
  }
  if (edges.length < 2) return [];

  const numbered = edges.map((e, i) => `${i + 1}. ${e.fact}`).join("\n");
  const llm = createLLMClient();
  try {
    const resp = await llm.chat.completions.create({
      model: LLM_MODEL_ORCHESTRATOR,
      messages: [
        {
          role: "system",
          content:
            "You detect factual contradictions. Given a numbered list of facts, find every genuine PAIRWISE " +
            "contradiction among them (same subject, incompatible claims). Do not manufacture conflicts — omit " +
            "anything that is merely a different topic or a plausible refinement, not a real contradiction. " +
            'Return JSON {"contradictions": [{"a": <1-based index>, "b": <1-based index>, "note": "<one line why>"}]}. ' +
            'Return {"contradictions": []} if none are found.',
        },
        { role: "user", content: `FACTS:\n${numbered}` },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: 400,
    });
    const raw = resp.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw) as { contradictions?: { a?: number; b?: number; note?: string }[] };
    const found: ScopeContradiction[] = [];
    for (const c of parsed.contradictions ?? []) {
      if (!c.a || !c.b || c.a < 1 || c.a > edges.length || c.b < 1 || c.b > edges.length || c.a === c.b) continue;
      found.push({ factA: edges[c.a - 1].fact, factB: edges[c.b - 1].fact, note: c.note ?? "" });
    }
    return found;
  } catch {
    return [];
  }
}

export interface ResolvedContradiction {
  factA: string;
  factB: string;
  note: string;
  /** The existing edge the dispute is filed against (factA). Null if unmatchable. */
  existing: { uuid: string; actorType: ActorType; actorId: string } | null;
  /** The conflicting side (factB)'s own edge, if matchable in the graph. `uuid` is
   *  what lets a caller de-dupe on the unordered PAIR rather than just `existing` —
   *  see scope-dispute-scan.ts's fileSameTierScopeDisputes for why that matters. */
  proposer: { uuid: string; actorType: ActorType; actorId: string } | null;
}

/**
 * Resolve the Architecture agent's flagged contradictions (factA/factB text only) to
 * real graph edges + provenance, using one graph fetch. Only contradictions whose
 * factA matches a real edge can back a dispute row (graphiti_fact_uuid is NOT NULL and
 * must reference a real Neo4j edge).
 */
export async function resolveContradictions(
  ctx: AccessContext,
  orgId: string,
  scopePath: string | undefined,
  contradictions: { factA: string; factB: string; note: string }[],
): Promise<ResolvedContradiction[]> {
  if (contradictions.length === 0) return [];
  const edges = await loadScopeEdges(ctx, orgId, scopePath);
  return contradictions.map((c) => {
    const edgeA = matchEdgeByFact(edges, c.factA);
    const edgeB = matchEdgeByFact(edges, c.factB);
    return {
      factA: c.factA,
      factB: c.factB,
      note: c.note,
      existing: edgeA
        ? { uuid: edgeA.uuid, actorType: edgeA.actorType ?? "human", actorId: edgeA.actorName ?? "unknown" }
        : null,
      proposer: edgeB
        ? { uuid: edgeB.uuid, actorType: edgeB.actorType ?? "human", actorId: edgeB.actorName ?? "unknown" }
        : null,
    };
  });
}
