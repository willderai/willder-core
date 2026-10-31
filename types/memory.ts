// Memory + agent vocabulary. Single source of truth for both the frontend
// (Contacts "what we know", Memory page, agent state chips) and the `MemoryStore`
// interface in services/memory/. Frontend-safe.
import type { FactRole } from "@/lib/generated/prisma/enums";
import type { AuditOrigin } from "@/services/access/origin";

/** A paid account tier. Its retrieval limits live in services/memory/account-tiers.ts. */
export type AccountTier = "starter" | "team" | "enterprise";

/**
 * A store a read can ask: `source` is typed records, `files` is full-text over
 * original files, `semantic` is vector search over chunks, `graph` is the entity graph.
 */
export type RetrievalBackend = "source" | "files" | "semantic" | "graph";

/** Who asserted a fact/entity. Human-asserted visibly outranks auto-extracted. */
export type ActorType = "human" | "agent" | "extraction";

/** A retrieved fact, as shown in the product. Bi-temporal + provenance-aware. */
export interface MemoryFact {
  uuid: string;
  fact: string;
  /** Real-world validity start (ISO); null if unknown. */
  validAt: string | null;
  actorType?: ActorType;
  /** Who asserted the fact, as stamped at ingest. A connector stamps its source's display name. */
  actorName?: string;
  /** The connected source (`Source.id`) that ingested the fact; absent for a manual assertion. */
  sourceId?: string;
  /**
   * The `memory_chunks` rows this fact was derived from. The write path stamps the chunk
   * id on every graph episode it creates, and a graph fact names every episode that
   * asserts it, so this is how a graph fact is resolved back to the stored versions it
   * belongs to (services/memory/superseded-facts.ts). More than one when several ingests
   * asserted the same fact. Empty for episodes written before the stamp existed, and for
   * ingests the request path never stored as a chunk.
   */
  chunkIds?: string[];
  /**
   * The graph episodes recorded as asserting this fact, in its own group. A connector sync
   * writes one episode per synced item (one per passage for a Drive file) and names it as the
   * `recordId` of the item's change event, so each is an item the fact came from. The list
   * can be short: a bulk ingest can merge a restatement into an existing edge without
   * recording its episode. Absent when the memory service did not report them.
   */
  sourceEventIds?: string[];
  /**
   * Set by HybridMemoryStore's exact-text dedup on a graph copy it kept over vector-store rows
   * of the same text (services/memory/hybrid-store.ts): those rows. When the graph copy may not
   * be served (its sources are gone or suppressed, services/memory/graph-fact-sources.ts), the
   * read serves the first of them in its place, so a stale graph copy never hides a live row.
   * GuardedMemoryStore strips it: no fact a guarded read returns carries it.
   */
  displacedCopies?: MemoryFact[];
  confidence?: number;
  /** The store that returned this fact on a read. */
  store?: RetrievalBackend;
  /**
   * The graph partition the fact is stored in (a scope path with its dots as dashes, or
   * the bare org id), as the memory service reports it. Set on graph facts from a search
   * over several partitions, where the partition asked does not say which one answered.
   */
  graphGroupId?: string;
  /** Cosine similarity between the fact's embedding and the query (1 is identical). Set by vector search only. */
  similarity?: number;
  /**
   * This fact's place, from 1, among the stored rows whose text holds the query's own words
   * (the text leg, services/memory/text-match-fusion.ts). Set by vector search only, on a row
   * the text leg found.
   */
  textMatchRank?: number;
  /**
   * Set when `fact` is an excerpt cut to fit a read's token budget: the full text's
   * length in characters. The excerpt keeps the sentences that best match the query,
   * in written order, with an ellipsis at every gap (services/memory/query-excerpt.ts).
   */
  excerptOfChars?: number;
  /**
   * Set on a read's first line when later records of the same page state a new value of the
   * same thing: how many, all served directly above it (services/memory/update-links.ts). The
   * line is kept, and the answer marks it "a later record on this is shown above".
   */
  laterRecordsAbove?: number;
  /**
   * Set on a vector-store row a `supersedes` edge has retired, by a read that asked for
   * retired rows (`SearchInput.withRetired`). GuardedMemoryStore.retrieve gives its place
   * to its current successor or drops it (services/memory/current-versions.ts), so no
   * fact a guarded read returns carries it.
   */
  retired?: boolean;
  /**
   * The fact a stored chunk is a version of: its scope and the entity name its writer gave
   * (the contention key, services/memory/conflict.ts). Chunks that share it are versions
   * of one fact, and a read serves the newest of them first. Absent on graph facts and on
   * chunks whose writer named no entity.
   */
  subject?: string;
  /**
   * The scope a stored chunk was written in; absent or null for an untagged chunk, and
   * absent on graph facts. A read links a later record to an earlier one only within one
   * scope (services/memory/update-links.ts).
   */
  scopePath?: string | null;
  /**
   * Where `validAt` came from, for a stored chunk: "occurred" when its writer stated when the
   * content happened (memory_ingest `occurredAt`), "stored" when it is the moment the chunk
   * was written. Absent on graph facts.
   */
  validAtSource?: "occurred" | "stored";
  /**
   * Set when the fact copies the text of a rule in force (memory_ingest stores a rule's text as
   * a fact too): which rule, and whether it is settled or a lead to verify
   * (services/memory/rule-copies.ts).
   */
  rule?: RuleCopyStanding;
  /**
   * Set when the fact shares the subject of a settled rule served on the same page and is not a
   * copy of a settled rule: that rule. The fact is served after it, as a lead to verify
   * when an agent wrote it, or labelled by its writer when `byPerson` (services/memory/rule-copies.ts).
   */
  contradicts?: { ruleId: string; kind: "convention" | "decision"; byPerson?: true };
  /**
   * Set on the first fact served on a subject with a person's rule in force and no copy of it on
   * the page: each such rule, as a read may serve it (services/memory/rule-copies.ts).
   */
  standingRules?: StandingRule[];
}

/** A person's rule in force, as a read names it when no copy of it is on the page. */
export interface StandingRule {
  ruleId: string;
  kind: "convention" | "decision";
  /** The rule's text as a served line may carry it, within the page's budget; empty when none is left. */
  text: string;
  /** Set when `text` is not the whole rule. */
  cut?: true;
}

/** How the rule a fact copies stands, by the task-start block's rule (services/memory/claim-status.ts). */
export interface RuleCopyStanding {
  ruleId: string;
  kind: "convention" | "decision";
  /** Who recorded the rule, as its create event says. */
  by: "person" | "agent" | "unknown";
  /** Settled, or a lead to verify. */
  settled: boolean;
}

/** A memory entity (person / company / deal) surfaced in Contacts / Memory. */
export interface MemoryEntity {
  uuid: string;
  name: string;
  type: string;
  summary?: string;
  actorType?: ActorType;
  facts?: MemoryFact[];
  /** The graph partition the entity was found in, when the lookup asked several. */
  graphGroupId?: string;
  /**
   * Set when the graph was not asked (the org's tier does not read it) and the entity
   * was matched by its name in the raw rows instead: `facts` are the stored facts whose
   * text names it, and `uuid` is the id the lookup gave. Absent on the graph's own entity.
   */
  matchedBy?: "raw-name";
}

export interface EntityLookup {
  groupId: string;
  entityId: string;
  /**
   * Look in these graph partitions instead of `groupId`, all in one call. Set by the
   * access-checked lookup to the scopes below the authorized one; do not set from callers.
   */
  groupIds?: string[];
}

// --- MemoryStore I/O contract (mirrors memory-service/app/schemas.py) ---
// group_id (= tenant orgId / Neo4j group_id) isolates every read and write.

export interface IngestInput {
  groupId: string;
  content: string;
  source?: string;
  name?: string;
  /** ISO-8601; service defaults to now if omitted. */
  referenceTime?: string;
  /**
   * When the content happened, as its writer stated it on memory_ingest, already validated
   * (services/memory/occurred-at.ts). Stored on the chunk's vector row only, never later
   * than the moment the row is written, and used to date and order the chunk on reads. It
   * is not the graph's reference time: that stays the server clock, so a writer's stated
   * time never decides which of two contradicting graph edges is retired.
   */
  occurredAt?: string;
  /**
   * When the server received this write, on the database's clock, as an ISO-8601 instant
   * (services/memory/received-at.ts): taken at the request's entry, before the embedding
   * call and every other wait. Stored on a fact version's row (`memory_chunks.receivedAt`),
   * never later than the row's own `createdAt`, and the time the conflict rule judges
   * contention by (services/memory/conflict.ts), so a slow embedding cannot move a write
   * out of another's contention window. Set by the server only: the write path stamps it
   * itself and never takes it from a caller. Absent on a write accepted before the field
   * existed; the row then falls back to `createdAt`.
   */
  receivedAt?: string;
  /**
   * Who asserted this content (provenance). Stamped onto the Graphiti episode so
   * facts inherit their actor via the source episode. Foundation for provenance
   * ranking (human > agent > extraction) and conflict resolution. The API route
   * derives these from context — never the client.
   */
  actorType: ActorType;
  /** Clerk user id, agent id, or a system source id for passive extraction. */
  actorId: string;
  actorName?: string;
  /**
   * The entry point this ingest came in through (services/access/origin.ts): the
   * caller's `AccessContext.origin`, or `connector-sync` / `job` for a write no request
   * is behind. Recorded on the ingest's audit row and change event as their source.
   */
  origin: AuditOrigin;
  /** ltree scope path to tag this episode's entities with. Defaults to org root
   *  when omitted. Write-side only — read-side enforcement is a separate build. */
  scopePath?: string;
  /**
   * Item sources-delete-retention-provenance-marker-20260919: the connector
   * Source.id that produced this episode, stamped by every connector-sync
   * ingest path (Slack/Figma `buildConnectorIngestInput`, Drive `fileIngest`)
   * -- never by chat, manual facts, or a document upload. Threaded into both
   * stores' write calls so `DELETE /api/sources/:id` can purge exactly one
   * source's own content (`removeGroupFacts`'s `sourceId`, `MemoryChunk.sourceId`)
   * even when it shares `scopePath` with another producer, instead of purging
   * or refusing the whole scope. Omit for any non-connector ingest.
   */
  sourceId?: string;
  /**
   * The upload (`UploadedFile.id`) a document passage was extracted from, set by the
   * file-ingest job for a direct upload only. Stored on the pgvector row, so removing the
   * upload removes exactly its passages (services/memory/uploads.ts); the graph store
   * does not record it.
   */
  uploadId?: string;
  /**
   * Store and announce the write, but run no graph extraction for it: no distillation, no
   * Graphiti episode. Set for a session-state capture (mcp/session-capture.ts), whose text
   * only says where one session stopped and is read through pgvector and the task-start
   * block, never the graph. A write stored on the request path then queues no job at all.
   */
  skipGraphExtraction?: boolean;
  /**
   * A session-state capture by the willder init hook (mcp/session-capture.ts). One that names a
   * `baseVersion` replaces its own session's earlier capture, so it is not a new episode toward
   * the free plan's cap: a session's captures count as one (lib/inngest/memory-ingest.ts).
   */
  sessionStateCapture?: boolean;
  /**
   * A declared share (services/access/derived-writes.ts): what each `derivedFrom` edge from
   * the stored version names, a scope row id or a scope path. The edges are written in the
   * statement that stores the version, so a shared fact is never stored unmarked. Omit for
   * any other write.
   */
  derivedFromTargets?: string[];
  /** Run the entity resolver before ingest. Defaults to true for human actors,
   *  false for agent/extraction (already structured). Pass false to skip. */
  resolve?: boolean;
  /**
   * When set, the ingest pipeline marks this record delivered once the write
   * actually lands (not merely enqueued/dispatched) — see
   * lib/inngest/memory-ingest.ts's `markContactIngestDelivered`. The agent-API
   * contact upsert is the first caller. Stamping
   * `ContactIdempotencyKey.ingestedAt` when the *enqueue* resolves is not
   * enough: a queued job that later exhausts its retries (or
   * an `after()` run whose failure a `.catch` swallowed) would leave the
   * ledger claiming a delivery that never happened, and a subsequent replay
   * would see "already ingested" and skip the repair. Only the caller that
   * actually reaches this line, after the real ingest step succeeds, may
   * mark the ledger — never the caller of `ingestMemory` itself.
   */
  confirmDelivery?: { kind: "contact-idempotency-key"; orgId: string; key: string };
  /**
   * The `req.target` tag a
   * caller's own `check()` call used to gate this write (e.g. persist/correct's
   * `brief:${id}`), so the confirmed-applied audit_log row
   * `lib/inngest/memory-ingest.ts` writes once this ingest's store write
   * actually succeeds (see `services/access/check.ts`'s `recordAppliedChange`)
   * carries the identical
   * target string `recordAudit()` would have used. `auditChangesUnderScope()`'s
   * self-write exclusion matches on that exact string, so a caller relying on
   * it (persist/correct excluding their own brief's accepted content from its
   * own staleness flag) must set this to keep matching after the switch away
   * from authorization-time rows. Optional and safe to omit: an un-migrated or
   * ordinary caller with nothing to self-exclude still gets a correct
   * confirmed-applied row, just tagged with the bare scope path.
   */
  auditTag?: string;
  /**
   * The `audit_log` id of the visible `memory.write` allow row that authorized this
   * ingest — `AccessDecision.auditLogId`, returned by the caller's own `check()`.
   *
   * It is carried onto this ingest's change event (`services/memory/change-events.ts`),
   * and `GET /api/audit` renders it back as that row's `changeId`. That is the only
   * place the audit trail names the change an authorization produced: the
   * confirmed-applied rows carry `visibility: "never"`
   * (`services/audit/audit-actions.ts`), so a reader of the visible log has nothing
   * else to bind a change to its author with.
   *
   * Optional. Connector sync leaves it out of the ingest input: its writes run no
   * `check()` of their own, and the sync records the person's `sources:connect` row on
   * its change events itself (`source.connectAuthorizationId`, through
   * `recordSourceItemChange` in `lib/inngest/connector-text-items.ts` and
   * `connector-drive-files.ts`). A caller whose write is part of a request another
   * `check()` already decided (a rule's text stored as a fact, by `memory_ingest`)
   * passes that decision's row.
   */
  authorizedById?: string;
  /**
   * What kind of record `content` is, when the pipeline already knows. `"decision"`
   * makes the memory service store `content` verbatim as a Decision fact, in
   * addition to what its extractor derives from it, so the decision reads back
   * word for word. Set by the ingest distiller (lib/inngest/memory-ingest.ts).
   * `"document"` marks a connected source's item: each passage stating a
   * number the extracted facts dropped is also stored verbatim. Set by connector sync
   * (`buildConnectorIngestInput`). Omit otherwise.
   */
  recordType?: "decision" | "document";
  /**
   * The line that names a connected source's item, which its change event is titled by
   * ("Document docs/setup.md in acme/app (<link>)"). With `recordType: "document"` the
   * memory service also stores it verbatim, linked to the item's episode: extraction keeps
   * what an item says and drops what it is called, so without it the item cannot be found
   * by its name. Set by connector sync (`buildConnectorIngestInput`). Omit otherwise.
   */
  heading?: string;
  /**
   * The id `content` is stored under in pgvector, already announced on the change
   * feed. Set by `ingestMemory` (lib/inngest/memory-ingest.ts) when the request path
   * stored it before queueing graph extraction, and by the ingest job once it stored
   * it itself, before its graph steps. The graph steps then write only the graph,
   * stamped with this id: they must not store a second pgvector row or announce the fact again.
   * Never set by a caller of `ingestMemory`.
   */
  readableId?: string;
  /**
   * The id of the stored version of this fact (same `name`, same scope) the writer read
   * and is replacing. With it the ingest is an update: it supersedes that version, and is
   * refused when a newer version has replaced it since (services/memory/fact-update.ts).
   * Requires `name`. Omit for an ordinary write, which replaces nothing.
   */
  baseVersion?: string;
  /**
   * The fact this ingest corrects, as `guardedMemory.removeFact` removed it for this
   * correction (`GuardedRemoveFactResult.removedVersion`): its id, the `supersede` change
   * event that announced the removal, and the scope the fact was stored in. Set by
   * PATCH /api/memory/facts/:id and by a brief correction that overrules an agent's fact,
   * only once the removal has happened. When this ingest's version is announced, it is
   * recorded as that fact's replacement (services/memory/fact-change-event.ts), so the audit
   * Timeline's "what replaced it" and "what it replaced" name each other.
   *
   * Unlike `baseVersion`, it never refuses the write and needs no `name`. Omit for any other
   * write.
   */
  correctionOf?: { factId: string; removalId: string; scopePath: string };
  /**
   * True when the server tracks which versions `actorId` (an agent) has been served, as
   * it does for memory_ingest over MCP. A write without `baseVersion` is then refused
   * when its writer has not read the fact's newest version (services/memory/fact-reads.ts).
   * Omit for writers whose reads the server does not see.
   */
  readsTracked?: boolean;
  /**
   * The task the writer's session named (`willder/task` on an MCP call), recorded on the
   * ingest's change event so a later session of the same task is served this write
   * (services/memory/task-start.ts). Omit when the writer named none.
   */
  task?: string;
  /**
   * The session the writer's call was made in (`willder/session`, else its MCP connection's),
   * recorded on the ingest's change event so the write is judged by what its own session
   * captured (services/memory/claim-status.ts). Omit when there is none.
   */
  sessionKey?: string;
  /**
   * What this fact is to the writer's task, as the writer declared it
   * (services/memory/fact-roles.ts). Stored on the version's pgvector row; a later session
   * of the task is served deciding facts ahead of progress notes. Omit when the writer
   * declared none, which ranks the fact as before roles existed.
   */
  role?: FactRole;
}

export interface IngestResult {
  episodeId: string;
}

export interface SearchInput {
  groupId: string;
  query: string;
  limit?: number;
  /**
   * More graph partitions searched in the same call, beside `groupId`: the scopes below
   * the authorized one, each its own partition. Set by GuardedMemoryStore.retrieve's
   * descendant leg; do not set from callers. The graph store fails the call rather than
   * answer from fewer of them.
   */
  groupIds?: string[];
  /**
   * ltree scope for scoped retrieval. Graphiti uses `groupId` as its (scope-encoded)
   * group_id, but pgvector stores the bare tenant id in `orgId` and the scope in a
   * separate column — so a scoped read must carry the scope here for pgvector's
   * prefix filter. Set by GuardedMemoryStore.retrieve; do not set from callers.
   */
  scopePath?: string;
  /**
   * Bare tenant org id for pgvector's tenant isolation. `groupId` may be overwritten
   * with the scope path (Graphiti needs that), so pgvector reads the real tenant id
   * from here. Set by GuardedMemoryStore.retrieve.
   */
  tenantId?: string;
  /**
   * Set by GuardedMemoryStore.retrieve's own bare-org-group Graphiti fallback (the
   * scope-encoded and bare-org partitions are exact-match-only in Graphiti, so a
   * scoped read re-queries the store under the bare org id to also catch episodes
   * ingested with no scopePath at all). That retry only exists to recover
   * Graphiti's leg — pgvector's scopePath/tenantId filter already returned every
   * row it will ever return on the first call, since neither changes between the
   * two calls — so a pgvector-aware store skips its own query entirely when this
   * is set, instead of running the identical SELECT twice. Graphiti-only stores
   * ignore it.
   */
  skipPgvector?: boolean;
  /**
   * Return rows a `supersedes` edge retired too, marked `retired`, in the places they rank,
   * instead of leaving them out. Set by GuardedMemoryStore.retrieve, which hands each
   * retired row's place to its current successor (services/memory/current-versions.ts);
   * do not set from callers.
   */
  withRetired?: boolean;
  /**
   * Stores that already failed earlier in the same read, after their retry. The hybrid
   * store asks them once on this call instead of twice, so an outage does not double
   * every later call of the read. Set by GuardedMemoryStore; do not set from callers.
   */
  noRetry?: RetrievalBackend[];
  /**
   * The account tier whose limits this read runs under (services/memory/
   * account-tiers.ts): which stores may be asked and how long each may take.
   * Set by GuardedMemoryStore.retrieve from the org's settings; do not set from
   * callers. Absent means the default tier.
   */
  accountTier?: AccountTier;
  /**
   * Does the caller's own checked scope for THIS leg genuinely
   * cover org root (`orgRootPath(orgId)` itself, or a real ancestor of it —
   * see services/access/check.ts's `pathCovers`)? Untagged content
   * (`scopePath IS NULL`) is the bare-org dumping ground six real ingest
   * paths write to with no scope at all (guarded-store.ts's own comment on
   * the org-wide fallback leg) — ordinary org content that happens to be
   * untagged, not a deliberately-public bucket. A narrow-scoped caller must
   * never see it just because they hold SOME grant; only a genuine
   * org-root-or-above grant justifies it. Set by GuardedMemoryStore.retrieve
   * from a pure containment check (no extra DB round trip) alongside the
   * scope it already asks check() to authorize; do not set from callers.
   */
  includeUntagged?: boolean;
}

export interface SearchResult {
  facts: MemoryFact[];
  /**
   * Set by the access-checked read when it could not search every registered
   * scope below the authorized one: there are more than
   * MAX_SEARCHED_DESCENDANT_SCOPES of them, or the scope lookup failed. `facts` is
   * still correct for what was searched; absence of a fact is not evidence that
   * none exists.
   */
  partialScopeCoverage?: true;
  /**
   * With `partialScopeCoverage`, the scopes below the authorized one that this read
   * did not search, in path order. Absent when the scope lookup failed, so which ones
   * were missed is not known.
   */
  unsearchedScopes?: string[];
  /**
   * Set by the access-checked read when a store failed to answer part of it even
   * after one retry: each store that failed, in the order first asked. `facts` holds
   * what the other calls returned; absence of a fact is not evidence that none exists.
   */
  degraded?: RetrievalBackend[];
  /** The stores this read asked, as each backend reports them. */
  storesRead?: StoreRead[];
  /** Where the returned facts came from. Set by the access-checked read. */
  breakdown?: RetrievalBreakdown;
  /**
   * Set by the access-checked read when asked to check the specific values its query
   * names (services/memory/specific-values.ts): the 0-based positions of those that no
   * memory the caller can read holds, empty when every one is held or none is named.
   * Absent when the check was not asked for or could not be complete, which claims nothing.
   */
  unheldValues?: number[];
}

/** One store a read asked. A failed store returned nothing, which is not the same as having nothing. */
export interface StoreRead {
  store: RetrievalBackend;
  failed?: true;
  /** Set when only the store's text leg was asked (services/memory/routing-policy.ts, `readLegs`). */
  leg?: "text";
  /**
   * Set when the store answered but has not absorbed every row the reader could read yet:
   * the graph is behind the raw rows, so it may lack paraphrases and links of the newest.
   * The raw legs still hold every row; nothing is missing from them.
   */
  partial?: true;
  /** With `partial`: how many readable rows the store still owes absorbing, at least. */
  pendingRows?: number;
}

/** Which stores answered a read, and what the answer cost in context. */
export interface RetrievalBreakdown {
  /**
   * Each store asked, in the order first asked, with how many of the returned
   * facts it supplied. A fact two stores both returned counts once, for the
   * copy that was kept.
   */
  stores: (StoreRead & { hits: number })[];
  /** Estimated tokens of the returned facts' text: the context an answer is built from. */
  contextTokens: number;
}

// --- Graph (the "node lookup" explorer) ---
// Entities are nodes; facts are the edges between them. Tenant-scoped by groupId.

export interface MemoryNode {
  uuid: string;
  name: string;
  type: string;
}

export interface MemoryEdge {
  uuid: string;
  /** source / target entity uuids (match MemoryNode.uuid). */
  source: string;
  target: string;
  fact: string;
  /** ISO-8601; when this fact became valid (null = unknown). */
  validAt?: string | null;
  /** ISO-8601; when this fact was superseded (null = still valid). */
  invalidAt?: string | null;
  /** Who asserted this fact. */
  actorType?: ActorType | null;
  actorName?: string | null;
  /** The scope this fact was written in (null = pre-scope or org root). */
  scopePath?: string | null;
  /** Raw Graphiti group_id for this edge (dashes = scope depth). */
  graphGroupId?: string | null;
  /**
   * The `memory_chunks` rows this edge was derived from, as on `MemoryFact.chunkIds`: how
   * the graph view tells a version that lost a write race from the one that won.
   */
  chunkIds?: string[];
  /** The connected source that ingested this edge and the episodes asserting it, as on `MemoryFact`. */
  sourceId?: string;
  sourceEventIds?: string[];
}

export interface MemoryGraph {
  nodes: MemoryNode[];
  edges: MemoryEdge[];
  /**
   * Set by the access-checked read when it did not ask the graph, and why: the org's account
   * tier does not read it. An empty view with this set says nothing about what the
   * graph holds. Absent whenever the graph was asked.
   */
  notRead?: "account-tier";
}

export interface GraphInput {
  groupId: string;
  /** For org-root aggregation: pass all scope group_ids to fetch across. */
  groupIds?: string[];
  /** Optional: seed the graph from a query's neighborhood; omit for the org graph. */
  query?: string;
  /** Max entity nodes to return (the graph stays legible). */
  limit?: number;
  /** Kept for backward compat; unused after per-scope group_id change. */
  scopePath?: string;
}

export interface RemoveFactInput {
  groupId: string;
  factId: string;
  /**
   * Bare tenant org id for pgvector's tenant isolation, same split as
   * SearchInput.tenantId above. `groupId` may be overwritten with the scope
   * path (Graphiti's removeFact wants that), so pgvector's DELETE reads the
   * real org id from here instead. Forwarding the scope path as pgvector's
   * `orgId` filter too matches zero rows there, which leaves a real fact
   * stored while the caller is told it was removed. Set by
   * GuardedMemoryStore.removeFact; do not set from callers.
   */
  tenantId?: string;
}

export interface RemoveEntityInput {
  groupId: string;
  entityId: string;
}

export interface TransferEntityInput {
  groupId: string;
  oldName: string;
  newName: string;
}

export interface TransferEntityResult {
  transferred: number;
}

export interface RemoveFactResult {
  removed: boolean;
  /**
   * The scope the removed chunk was stored in, null for an untagged chunk. Set only by the
   * chunk store, and only when it removed one: its delete reaches every chunk within the
   * scope asked, so the chunk's own scope can be narrower. The graph store deletes in the
   * one partition it is asked for, so a graph fact's scope is that partition.
   */
  storedScopePath?: string | null;
  /**
   * The entity name the removed chunk was filed under, null when it had none. Set with
   * `storedScopePath`, by the chunk store only. A correction's announcement names it, so a
   * person erasure can find the correction of a fact filed under that person
   * (services/memory/fact-change-event.ts, `correctionTitle`).
   */
  storedEntityName?: string | null;
  /**
   * The text of the graph fact removed, when the id named a graph fact rather than a stored
   * chunk, as the graph answered for it just before. A correction's announcement names it, as it
   * names a chunk's entity, since a graph fact is filed under no name.
   */
  removedFactText?: string;
}

/** What retiring one chunk's graph facts removed: the episodes, so records pointing at them can drop the pointer. */
export interface RemoveChunkFactsResult {
  episodeIds: string[];
}

/** One stored chunk whose graph facts are retired (`MemoryStore.removeChunkFacts`). */
export interface RemoveChunkFactsInput {
  /** The scope path the chunk was stored in, or the bare org id for an untagged chunk:
   *  the partition ingest wrote the chunk's episodes to. Never a caller-supplied value. */
  groupId: string;
  chunkId: string;
}

/** Exact-name existence lookup within one Graphiti partition (`groupId`), used to
 * resolve which real scope an entity actually lives in server-side, never to
 * return anything to a caller directly — see services/memory/entity-scope.ts. */
export interface FindFactByIdInput {
  /** Scope-encoded group to look in. Set by GuardedMemoryStore.findFact from the
   *  scope it just authorized; never a caller-supplied value. */
  groupId: string;
  /** Bare tenant org id, for the backend that stores the scope in its own column
   *  rather than in `groupId` — same split SearchInput/RemoveFactInput use. */
  tenantId?: string;
  factId: string;
  /**
   * Ask the raw rows alone, never the graph. Set by GuardedMemoryStore when the org's
   * account tier does not read the graph; do not set from callers.
   */
  rawOnly?: true;
}

export interface FindFactByIdResult {
  uuid: string;
  fact: string;
  /** ISO time a newer graph edge invalidated this fact; null while it is in force.
   *  Undefined when the backend cannot say (a memory service older than the field). */
  invalidAt?: string | null;
  /** The scope the stored row itself lives in, which can be a descendant of the
   *  partition asked; null for an untagged row. Set only by the chunk store. */
  scopePath?: string | null;
  /** Set to "graph" by the graph store; a chunk-store answer leaves it unset. */
  store?: "graph";
  /** The graph edge's stamps, as on `MemoryFact`. Set only by the graph store. */
  chunkIds?: string[];
  sourceId?: string;
  sourceEventIds?: string[];
}

// --- Stores overview (GET /api/memory/stores) ---

/** A typed Postgres record in a scope: a brief, a connected source, or (org root only) a contact. */
export type StoreRecord = {
  kind: "source" | "contact";
  id: string;
  title: string;
  detail: string;
  scopePath: string | null;
  /** The scope's display name, or null when no scope row names the path. */
  scopeName: string | null;
  updatedAt: string;
};

/** A generated brief: a handoff, architecture plan or QA review. Retired briefs are never listed. */
export type StoreBrief = {
  id: string;
  type: "handoff" | "architecture_plan" | "qa_review";
  title: string;
  scopePath: string;
  scopeName: string | null;
  createdAt: string;
};

/**
 * A standing rule (convention or decision), as stored. `status` says whether it is
 * still served: `replaced` when a later version superseded it or it lost a race to
 * replace one, `retired` when it was withdrawn without a replacement.
 */
export type StoreRule = {
  id: string;
  kind: "convention" | "decision";
  subject: string;
  text: string;
  status: "in_force" | "replaced" | "retired";
  scopePath: string;
  scopeName: string | null;
  createdAt: string;
};

/** A working note an agent posted. `live` until it expires or is released. */
export type StoreNote = {
  id: string;
  kind: "claim" | "intent" | "status" | "question";
  task: string;
  body: string;
  /** The posting agent's name, or null when the agent no longer exists. */
  agentName: string | null;
  status: "live" | "expired" | "released";
  scopePath: string;
  scopeName: string | null;
  createdAt: string;
  expiresAt: string;
};

/** A pgvector text chunk, trimmed to a snippet. */
export type StoreChunk = {
  id: string;
  snippet: string;
  source: string;
  author: string | null;
  scopePath: string | null;
  scopeName: string | null;
  createdAt: string;
  /** The version that superseded this one in a write race, or null while it is current. */
  supersededById: string | null;
};

/** A file a connected source synced, with how many chunks it produced. */
export type StoreFile = {
  id: string;
  sourceName: string;
  sourceType: string;
  externalFileId: string;
  chunkCount: number;
  syncedAt: string;
  scopePath: string;
  scopeName: string | null;
};

/**
 * GET /api/memory/stores?list=: one page of one store in one scope, searched,
 * filtered and ordered. `total` is how many rows match in all. `capped` is true
 * only for a searched or filtered chunk list that stopped counting at its scan
 * bound, when `total` is a lower bound.
 */
export type StorePage =
  | StorePageOf<"records", StoreRecord>
  | StorePageOf<"briefs", StoreBrief>
  | StorePageOf<"rules", StoreRule>
  | StorePageOf<"notes", StoreNote>
  | StorePageOf<"chunks", StoreChunk>
  | StorePageOf<"files", StoreFile>;

type StorePageOf<L extends string, T> = {
  scope: string;
  list: L;
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  capped: boolean;
};

/** GET /api/memory/stores: exact counts plus the most recent rows of each store in one scope. */
export type StoresOverview = {
  scope: string;
  counts: { records: number; briefs: number; rules: number; notes: number; chunks: number; files: number };
  /** Lists whose count stopped at a scan bound, so it is a lower bound (rules in an org with erasures). */
  lowerBounds: "rules"[];
  records: StoreRecord[];
  briefs: StoreBrief[];
  rules: StoreRule[];
  notes: StoreNote[];
  chunks: StoreChunk[];
  files: StoreFile[];
};
