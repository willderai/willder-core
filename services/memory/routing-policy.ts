// The routing policy: which stores a read asks and what a write absorbs, per content shape,
// query shape and account tier. One module, so the read router and the write router can
// never carry rules of their own that drift apart.
//
// The one rule this file enforces: with the flags off, nothing here changes behaviour. The
// legs a read asks (`readLegs`, which the hybrid read follows) are today's stores,
// `ALLOWED_STORES` filtered through the read router's order (`readStores`), unless
// WRITE_ROUTING_POLICY is on and `ROUTING_DECISIONS.D6` has made the tier active. The absorb
// table and the recorded decisions (`ROUTING_DECISIONS`) are data no caller acts on yet: the
// ingest job is meant to follow `absorb` behind the same flag once it is wired in.
//
// Like account-tiers.ts, a tier only ever NARROWS what is read. Access is decided before any
// of this runs and is identical on every tier.
//
// This file must stay free of runtime imports beyond pure helpers: account-tiers.ts imports
// it, and both are read by code that must not open a database connection.

import type { AccountTier, IngestInput, RetrievalBackend } from "@/types/memory";
import { quotedTextPattern } from "./text-match-fusion";

/** Bumped whenever a plan in {@link ABSORB_TABLE} widens or narrows; a bump is meant to queue a replay of stored rows. */
export const POLICY_VERSION = 1;

// --- The store table (moved here from account-tiers.ts) -------------------------------------

/**
 * Stores each tier may query. Anything else is never called. `TIER_LIMITS.allowedStores`
 * (account-tiers.ts) is these same arrays.
 */
export const ALLOWED_STORES: Readonly<Record<AccountTier, readonly RetrievalBackend[]>> = {
  starter: ["source", "files"],
  team: ["source", "files", "semantic"],
  enterprise: ["source", "files", "semantic", "graph"],
};

/** The read router's store preference order (services/memory/hybrid-store.ts): graph first. */
export const HYBRID_READ_ORDER: readonly RetrievalBackend[] = ["graph", "semantic"];

/**
 * Filters a router's store preference order down to what the tier allows, keeping
 * the router's order. An empty result means the tier allows none of the stores
 * this query would use; the caller answers with nothing rather than a disallowed store.
 */
export function allowedOrder(tier: AccountTier, order: readonly RetrievalBackend[]): RetrievalBackend[] {
  const allowed = ALLOWED_STORES[tier];
  return order.filter((backend) => allowed.includes(backend));
}

/**
 * Whether a read on this tier may ask the graph: the store table's own answer, the rule
 * `GuardedMemoryStore.retrieve` already applies to its graph leg. Every other graph reader
 * asks this too (see {@link GRAPH_CALL_SITES}), so the graph is read on a tier exactly where
 * a retrieve reads it. Every org is enterprise today (`ROUTING_DECISIONS.D6`), where this is
 * true and nothing changes.
 */
export function graphReadAllowed(tier: AccountTier): boolean {
  return ALLOWED_STORES[tier].includes("graph");
}

/** The tiers whose reads ask the graph, for a reader that decides in SQL. */
export const GRAPH_READING_TIERS: readonly AccountTier[] = (Object.keys(ALLOWED_STORES) as AccountTier[]).filter(
  graphReadAllowed,
);

// --- Graph call sites ---------------------------------------------------------------------

/**
 * How one call site that reaches the graph, or a Postgres row anchored on a graph uuid,
 * answers a tier whose reads do not include the graph:
 *
 * - `tier-gated`: it asks {@link graphReadAllowed} and, where that is false, never reads the
 *   graph; `gated` says what it answers instead (a raw-row fallback, a label, or nothing).
 * - `every-tier`: maintenance that must reach graph data written under any plan, such as
 *   erasure, deletion, retirement, residue counts or a merge. It never serves graph text to
 *   a reader, so a tier does not narrow it (`ROUTING_DECISIONS.D3`: erasure works either way).
 * - `write`: it absorbs into the graph. What a write absorbs is `absorb`'s to decide, not a
 *   read's.
 */
export type GraphCallPolicy = "tier-gated" | "every-tier" | "write";

export interface GraphCallSite {
  /** The calls this entry covers, as the structural scan names them (`receiver.method`, or `sql:table`). */
  calls: readonly string[];
  policy: GraphCallPolicy;
  /** For a `tier-gated` site: what it answers when the tier does not read the graph. Otherwise why it is not gated. */
  gated: string;
}

/**
 * Every call site outside the graph store itself that reads or writes the graph, or reads a
 * row anchored on a graph uuid (`fact_disputes`, `fact_provenance`), by file. The structural
 * scan (services/memory/graph-call-sites.scan.test.ts) fails when a call site is missing here
 * or an entry names a call its file no longer makes, so a new graph reader cannot ship
 * without saying how it answers a tier that does not read the graph.
 */
export const GRAPH_CALL_SITES: Readonly<Record<string, readonly GraphCallSite[]>> = {
  // The gate itself, and the store behind it.
  "services/memory/guarded-store.ts": [
    {
      calls: ["this.reads.retrieve"],
      policy: "tier-gated",
      gated: "The read carries the org's tier; the hybrid store asks the graph only where the tier allows it.",
    },
    {
      calls: ["this.reads.entity"],
      policy: "tier-gated",
      gated: 'Not called: the raw-row entity fallback answers, labelled `matchedBy: "raw-name"`.',
    },
    {
      calls: ["this.reads.graph"],
      policy: "tier-gated",
      gated: 'Not called: an empty graph labelled `notRead: "account-tier"`.',
    },
    {
      calls: ["this.reads.findFactById"],
      policy: "tier-gated",
      gated: "Asked with `rawOnly`: only the raw rows answer, and the bare-org graph leg is skipped.",
    },
    {
      calls: ["this.store.removeEntity", "this.store.transferEntity"],
      policy: "every-tier",
      gated: "A delete or merge of entities already in the graph; it serves no graph text.",
    },
  ],
  // The guarded store's only way to the graph: each read of the store, its graph answers
  // checked against their stored sources. The tier gate stays in the guarded store, before these.
  "services/memory/source-checked-reads.ts": [
    {
      calls: ["store.retrieve", "store.entity", "store.graph", "store.findFactById"],
      policy: "tier-gated",
      gated:
        "Reached only through the guarded store's `this.reads`, which does not call entity or graph on such a tier and asks retrieve and findFactById with the tier's leg order or `rawOnly`.",
    },
  ],
  "services/memory/hybrid-store.ts": [
    {
      calls: ["this.graphiti.retrieve"],
      policy: "tier-gated",
      gated: "Asked only when `allowedOrder` keeps the graph for the read's tier.",
    },
    {
      calls: ["this.graphiti.findFactById"],
      policy: "tier-gated",
      gated:
        "Skipped for a `rawOnly` lookup, which the guarded store sets on a tier that does not read the graph; a removal's description lookup runs on every tier.",
    },
    {
      calls: ["this.graphiti.entity", "this.graphiti.graph"],
      policy: "tier-gated",
      gated: "Reached only through the guarded store, which does not call them on such a tier.",
    },
    {
      calls: ["this.graphiti.removeEntity", "this.graphiti.transferEntity"],
      policy: "every-tier",
      gated: "A delete or merge of entities already in the graph.",
    },
  ],
  // Readers through the guarded store.
  "app/api/memory/chat/route.ts": [
    {
      calls: ["guardedMemory.retrieve"],
      policy: "tier-gated",
      gated: "The guarded read: the graph leg only where the tier allows it.",
    },
  ],
  "app/api/memory/query/route.ts": [
    {
      calls: ["guardedMemory.retrieve"],
      policy: "tier-gated",
      gated: "The guarded read: the graph leg only where the tier allows it.",
    },
  ],
  "mcp/tools/memory-query.ts": [
    {
      calls: ["guardedMemory.retrieve"],
      policy: "tier-gated",
      gated: "The guarded read: the graph leg only where the tier allows it.",
    },
  ],
  "mcp/prompts.ts": [
    {
      calls: ["guardedMemory.retrieve"],
      policy: "tier-gated",
      gated: "start_task reads as memory_query does: the guarded read, the graph leg only where the tier allows it.",
    },
  ],
  "services/agents/tools.ts": [
    {
      calls: ["guardedMemory.retrieve"],
      policy: "tier-gated",
      gated: "The guarded read: the graph leg only where the tier allows it.",
    },
  ],
  "mcp/tools/memory-entity.ts": [
    {
      calls: ["guardedMemory.entity"],
      policy: "tier-gated",
      gated: "The raw-row entity fallback, and the answer says it matched by name in stored memory.",
    },
  ],
  "app/api/memory/entities/[id]/route.ts": [
    {
      calls: ["guardedMemory.entity"],
      policy: "tier-gated",
      gated: 'The raw-row entity fallback, with `matchedBy: "raw-name"` in the JSON.',
    },
    {
      calls: ["guardedMemory.removeEntity"],
      policy: "every-tier",
      gated: "A delete of an entity already in the graph.",
    },
  ],
  "app/api/memory/graph/route.ts": [
    { calls: ["guardedMemory.graph"], policy: "tier-gated", gated: 'An empty graph with `notRead: "account-tier"`.' },
  ],
  "services/facts/conflicts.ts": [
    {
      calls: ["guardedMemory.graph"],
      policy: "tier-gated",
      gated: "No edges: the scope scan says `notRead` and spends no model call; authorship is read from the raw row.",
    },
    {
      calls: ["guardedMemory.retrieve"],
      policy: "tier-gated",
      gated: "The guarded read: the graph leg only where the tier allows it.",
    },
  ],
  "services/memory/fact-provenance.ts": [
    {
      calls: ["guardedMemory.findFact"],
      policy: "tier-gated",
      gated: "Resolves against the raw rows only, so provenance attaches only to a fact the tier serves.",
    },
    {
      calls: ["db.factProvenance.findMany"],
      policy: "tier-gated",
      gated:
        "The list for one fact keeps only rows anchored on one of the org's raw rows; the staleness report is a write and matches every row.",
    },
  ],
  "services/memory/fact-disputes.ts": [
    {
      calls: ["db.factDispute.findMany"],
      policy: "tier-gated",
      gated: "Keeps only disputes anchored on one of the org's raw rows.",
    },
    {
      calls: ["db.factDispute.findFirst"],
      policy: "every-tier",
      gated: "Loads one dispute by id to decide its resolution; resolving a dispute serves no graph text.",
    },
  ],
  "services/memory/scope-dispute-scan.ts": [
    {
      calls: ["db.factDispute.findFirst"],
      policy: "every-tier",
      gated:
        "De-duplicates a dispute about to be filed; its edges come from the gated graph read, so a tier that does not read the graph files none.",
    },
  ],
  "services/memory/brief-citations.ts": [
    {
      calls: ["guardedMemory.resolveFacts"],
      policy: "tier-gated",
      gated: "A cited fact the raw rows do not hold reads `unknown`, not `gone`: the graph was not asked.",
    },
  ],
  "services/memory/task-start.ts": [
    {
      calls: ["sql:fact_provenance"],
      policy: "tier-gated",
      gated:
        "A source-moved flag is served only when the tier reads the graph or the flag is anchored on one of the org's raw rows.",
    },
  ],
  "services/memory/task-start-served.ts": [
    {
      calls: ["sql:fact_provenance"],
      policy: "every-tier",
      gated: "Joins the items a session was already served, by their own ids; it serves nothing new.",
    },
  ],
  "lib/inngest/enrichment.ts": [
    {
      calls: ["memory.graph"],
      policy: "tier-gated",
      gated: "No entity link: the CRM record keeps no graph entity id.",
    },
  ],
  // Merges and renames of entities already in the graph.
  "app/api/memory/entities/merge/route.ts": [
    {
      calls: ["guardedMemory.transferEntity"],
      policy: "every-tier",
      gated: "A merge of entities already in the graph.",
    },
  ],
  "app/api/settings/org-roles/route.ts": [
    {
      calls: ["memory.transferEntity"],
      policy: "every-tier",
      gated: "A role rename carried onto the entity already in the graph.",
    },
  ],
  "services/memory/entity-scope.ts": [
    {
      calls: ["graphitiStore.groupsHoldingEntity"],
      policy: "every-tier",
      gated: "Finds the scope a merge writes in; it serves no graph text.",
    },
  ],
  // Erasure, deletion, retirement and residue counts.
  "services/memory/erasure-lineage.ts": [
    {
      calls: ["graphitiStore.erasePerson", "graphitiStore.removeChunkFacts", "graphitiStore.removeEpisode"],
      policy: "every-tier",
      gated: "Erasure must reach graph data written under any plan.",
    },
  ],
  "services/memory/person-erasure.ts": [
    {
      calls: ["graphitiStore.erasePerson", "graphitiStore.planPersonErasure"],
      policy: "every-tier",
      gated: "Erasure must reach graph data written under any plan.",
    },
  ],
  "services/memory/org-deletion/run.ts": [
    {
      calls: ["graphitiStore.orgResidue", "graphitiStore.purgeOrg"],
      policy: "every-tier",
      gated: "Org deletion must reach graph data written under any plan.",
    },
  ],
  "services/memory/scope-deletion.ts": [
    {
      calls: ["graphitiStore.groupResidue"],
      policy: "every-tier",
      gated: "Scope deletion counts graph residue written under any plan.",
    },
  ],
  "services/memory/uploads.ts": [
    {
      calls: ["graphitiStore.removeChunkFacts"],
      policy: "every-tier",
      gated: "A removed upload's passages retire their graph episodes written under any plan; it serves no graph text.",
    },
  ],
  "services/memory/source-retirement.ts": [
    {
      calls: ["graphitiStore.removeGroupFacts"],
      policy: "every-tier",
      gated: "A disconnect retires graph data written under any plan.",
    },
  ],
  "services/memory/source-records.ts": [
    {
      calls: ["graphitiStore.sourceRecords"],
      policy: "every-tier",
      gated: "Counts only, so a person can check a disconnect removed what it brought in.",
    },
  ],
  "lib/inngest/connector-records.ts": [
    {
      calls: ["graphitiStore.removeEpisode"],
      policy: "every-tier",
      gated: "Retires an edited or deleted connector item's episode.",
    },
  ],
  // Writes: what is absorbed is absorb()'s to decide.
  "lib/inngest/memory-ingest.ts": [
    { calls: ["graphitiStore.ingest", "graphitiStore.ingestBulk"], policy: "write", gated: "Absorbs a stored row." },
    {
      calls: ["graphitiStore.removeChunkFacts"],
      policy: "every-tier",
      gated: "Retires the episodes of a row deleted while its job ran.",
    },
  ],
  "lib/inngest/file-ingest.ts": [
    {
      calls: ["graphitiStore.dedupeNodes", "graphitiStore.extractFile", "graphitiStore.ingestBulk"],
      policy: "write",
      gated: "Absorbs an upload's passages.",
    },
  ],
  "lib/inngest/connector-drive-files.ts": [
    {
      calls: ["graphitiStore.extractFile", "graphitiStore.ingestBulk"],
      policy: "write",
      gated: "Absorbs a Drive file's passages.",
    },
  ],
  "lib/inngest/connector-sync.ts": [
    { calls: ["graphitiStore.dedupeNodes"], policy: "write", gated: "Merges the nodes a sync just absorbed." },
  ],
  "app/api/memory/upload/route.ts": [
    {
      calls: ["graphitiStore.extractBytes"],
      policy: "write",
      gated: "Extracts an upload's text before it is stored; it reads no graph data.",
    },
  ],
  "app/api/agents/attachments/extract/route.ts": [
    {
      calls: ["graphitiStore.extractBytes"],
      policy: "write",
      gated: "Extracts an attachment's text; it reads no graph data.",
    },
  ],
};

// --- Shapes ----------------------------------------------------------------------------------

export const CONTENT_SHAPES = ["fact", "conversation", "document", "handoff", "seed"] as const;
export type ContentShape = (typeof CONTENT_SHAPES)[number];

export const QUERY_SHAPES = ["entity", "relation", "general", "quote"] as const;
export type QueryShape = (typeof QUERY_SHAPES)[number];

/** Content above this many characters is a document: the distiller reads only the first 6,000. */
export const DOCUMENT_MIN_CHARS = 6_000;

/**
 * What `shapeOfContent` reads of a write: fields of the ingest envelope. `conversation` is
 * not on the envelope yet. Until it is, fact and conversation share every plan, so telling
 * them apart changes nothing.
 */
export type ContentRow = Pick<
  IngestInput,
  "content" | "recordType" | "skipGraphExtraction" | "sessionStateCapture" | "uploadId"
> & {
  conversation?: boolean;
};

/** The shape of one write, which with the tier picks its absorb plan. */
export function shapeOfContent(row: ContentRow): ContentShape {
  // A handoff or session capture is never extracted today (skipGraphExtraction), whatever else it is.
  if (row.skipGraphExtraction || row.sessionStateCapture) return "handoff";
  if (row.recordType === "decision") return "seed";
  if (row.recordType === "document" || row.uploadId !== undefined || row.content.length > DOCUMENT_MIN_CHARS)
    return "document";
  return row.conversation ? "conversation" : "fact";
}

/** Where a read came in: a memory read, the `memory_entity` lookup, or the graph tab. */
export type ReadEntry = "retrieve" | "entity" | "graph";

const RELATION_WORDS =
  /\b(related|relates|relation|relationship|between|depends?|dependenc(?:y|ies)|connect(?:ed|s|ion)?|link(?:ed|s)?)\b/i;

/** The shape of one read. Today every shape reads the same stores; see {@link readStores}. */
export function shapeOfQuery(input: { query: string; entry?: ReadEntry }): QueryShape {
  if (input.entry === "entity" || input.entry === "graph") return "entity";
  if (RELATION_WORDS.test(input.query)) return "relation";
  if (quotedTextPattern(input.query) !== null) return "quote";
  return "general";
}

// --- Reads -----------------------------------------------------------------------------------

/**
 * The stores a read asks with the flags off: today's routing, for every query shape. The
 * shape is taken so the call sites are already the policy's; it does not change the answer.
 */
export function readStores(tier: AccountTier, _shape: QueryShape): RetrievalBackend[] {
  return allowedOrder(tier, HYBRID_READ_ORDER);
}

/** The legs a read is split into: the raw text leg, the raw vector leg, and the graph. */
export type ReadLeg = "text" | "semantic" | "graph";

/**
 * The target legs per tier, in force where {@link readPolicyInForce} says. Starter reads the text leg
 * (`ROUTING_DECISIONS.D1`). The raw legs
 * are never dropped; the graph is asked only where {@link ABSORB_TABLE} can put something.
 */
export const READ_LEGS: Readonly<Record<AccountTier, readonly ReadLeg[]>> = {
  starter: ["text"],
  team: ["text", "semantic"],
  enterprise: ["text", "semantic", "graph"],
};

/** The policy's own legs for a read of this shape on this tier, where it is in force. Every shape reads the same legs in v1. */
export function targetReadLegs(_shape: QueryShape, tier: AccountTier): ReadLeg[] {
  return [...READ_LEGS[tier]];
}

/**
 * Whether the policy's own legs and absorb plans are in force for this tier: the
 * write-routing flag is on, and `ROUTING_DECISIONS.D6` has made the tier active. One switch for reads and
 * writes, so a tier never reads by one policy and absorbs by another.
 */
export function readPolicyInForce(
  tier: AccountTier,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return writeRoutingPolicyEnabled(env) && routingTierActive(tier);
}

/** The order legs are named in: the raw legs, then the graph. */
const READ_LEG_ORDER: readonly ReadLeg[] = ["text", "semantic", "graph"];

/**
 * Today's routing written as legs. The vector store's read runs the text leg inside it
 * (pgvector-store.ts, `retrieve`), so a tier that reads `semantic` reads both raw legs,
 * and a tier that reads neither store (starter) reads no leg at all.
 */
function legsOfStores(stores: readonly RetrievalBackend[]): ReadLeg[] {
  return READ_LEG_ORDER.filter((leg) => (leg === "graph" ? stores.includes("graph") : stores.includes("semantic")));
}

/**
 * The legs a read of this shape asks on this tier. Where the policy is not in force this is
 * exactly today's routing ({@link readStores}); where it is, the policy's own legs.
 */
export function readLegs(
  shape: QueryShape,
  tier: AccountTier,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ReadLeg[] {
  return readPolicyInForce(tier, env) ? targetReadLegs(shape, tier) : legsOfStores(readStores(tier, shape));
}

/**
 * The stores a set of legs asks, in the read router's order. Both raw legs read the chunk
 * store (`semantic`): the text leg is its trigram match, the vector leg its embedding search.
 */
export function storesOfLegs(legs: readonly ReadLeg[]): RetrievalBackend[] {
  return HYBRID_READ_ORDER.filter((store) =>
    store === "graph" ? legs.includes("graph") : legs.some((leg) => leg !== "graph"),
  );
}

// --- Writes ----------------------------------------------------------------------------------

export type GraphPlan = "none" | "full" | "summary" | "facts-only";

/**
 * The target absorb plan per tier and content shape (inert until the ingest job reads it).
 * Enterprise keeps full extraction everywhere it is full today (`ROUTING_DECISIONS.D2`). A
 * handoff is never extracted, as today.
 */
export const ABSORB_TABLE: Readonly<Record<AccountTier, Readonly<Record<ContentShape, GraphPlan>>>> = {
  starter: { fact: "none", conversation: "none", document: "none", seed: "none", handoff: "none" },
  team: { fact: "none", conversation: "none", document: "none", seed: "none", handoff: "none" },
  enterprise: { fact: "full", conversation: "full", document: "full", seed: "full", handoff: "none" },
};

/** Whether a tier's own plans are in force. None below enterprise yet (`ROUTING_DECISIONS.D6`). */
export function routingTierActive(tier: AccountTier): boolean {
  return ROUTING_DECISIONS.D6.activeTiers.includes(tier);
}

export interface AbsorbPlan {
  graph: GraphPlan;
  version: number;
  shape: ContentShape;
  /** The tier whose plan this is: the write's own tier when active, else enterprise, today's. */
  tier: AccountTier;
}

/** The absorb plan for one write. An inactive tier gets enterprise's plan, which is today's write path. */
export function absorb(row: ContentRow, tier: AccountTier): AbsorbPlan {
  const shape = shapeOfContent(row);
  const planTier: AccountTier = routingTierActive(tier) ? tier : "enterprise";
  return { graph: ABSORB_TABLE[planTier][shape], version: POLICY_VERSION, shape, tier: planTier };
}

/**
 * The stores one write lands in under the tier's plan: the chunk store (`semantic`) always,
 * the graph exactly when the absorb plan extracts into it. Code that needs to know where a
 * write landed asks this instead of keeping its own list of stores.
 */
export function storesWritten(row: ContentRow, tier: AccountTier): RetrievalBackend[] {
  const plan = absorb(row, tier);
  return HYBRID_READ_ORDER.filter((store) => store === "semantic" || plan.graph !== "none");
}

// --- Decisions and flag ----------------------------------------------------------------------

/**
 * The six product decisions the routing policy is built on, recorded as data so that code
 * and tests read them instead of restating them.
 */
export const ROUTING_DECISIONS = {
  /** Starter reads the text leg; it absorbs nothing into the graph. */
  D1: { starterLegs: ["text"] as readonly ReadLeg[] },
  /** Long documents stay `full` on enterprise for v1; a reduced plan needs a paid A/B test and an explicit product decision first. */
  D2: { enterpriseDocumentPlan: "full" as GraphPlan },
  /** A downgrade hides edges, disputes, provenance and task-start flags; it never orphans or purges. */
  D3: { downgrade: "hide" as const },
  /** Replay: a dry-run estimate, a cap per org of the estimate × 1.5, batched; no lazy fill, no spend in a read. */
  D4: { capMultiplier: 1.5, lazyFill: false },
  /** Human resolver writes stay as today (asynchronous, not readable at once). */
  D5: { humanWrites: "as-today" as const },
  /**
   * Only enterprise is active. What lower tiers need is in place (every graph reader is
   * tier-gated, entity lookups fall back to raw rows, contradiction checks read authorship
   * from raw rows); activating one is a separate product decision, made by adding it here.
   * The tier is derived from Org.plan.
   */
  D6: { activeTiers: ["enterprise"] as readonly AccountTier[], tierSource: "Org.plan" as const },
} as const;

/**
 * The write-routing flag. Not a secret: a plain environment variable, so deployment checks
 * can compare its value directly; it must never be stored as a sensitive variable.
 */
export const WRITE_ROUTING_POLICY_FLAG = "WRITE_ROUTING_POLICY";

/** True when WRITE_ROUTING_POLICY is 1, true, on or yes. Off by default. */
export function writeRoutingPolicyEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const value = env[WRITE_ROUTING_POLICY_FLAG]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "on" || value === "yes";
}
