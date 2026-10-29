// GraphitiMemoryStore: HTTP client for the Python Graphiti memory service
// (../../memory-service), talking the contract in memory-service/app/schemas.py.
// Bearer-authed; maps camelCase <-> snake_case at the boundary.
//
// The one rule this file enforces: every failure the service itself reports
// leaves here as a `MemoryServiceError` carrying the HTTP status, so a caller
// never has to read the service's raw response to tell what went wrong. A
// transport failure is one too: a connection that fails before any response
// (refused, reset, DNS) leaves as a 502, a slow service as a 504, and the
// socket error stays on `cause`, off the message, since some routes return the
// message to the client. Calls routed through `call()` get the same mapping
// for a body that breaks off mid-read. removeEntity, removeFact, removeEpisode,
// removeGroupFacts and transferEntity still use a bare `fetch`, with neither the
// timeout nor this mapping.

import type {
  EntityLookup,
  FindFactByIdInput,
  FindFactByIdResult,
  GraphInput,
  IngestInput,
  IngestResult,
  MemoryEntity,
  MemoryFact,
  MemoryGraph,
  RemoveEntityInput,
  RemoveChunkFactsInput,
  RemoveChunkFactsResult,
  RemoveFactInput,
  RemoveFactResult,
  SearchInput,
  SearchResult,
  TransferEntityInput,
  TransferEntityResult,
} from "@/types/memory";
import { orgRootPath } from "@/services/access/org-root";
import type { MemoryStore } from "./memory-store";

/**
 * A failed memory-service call. `status` is the service's HTTP status, or 504 on a
 * timeout and 502 when the connection failed; undefined when the service is not
 * configured.
 */
export class MemoryServiceError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MemoryServiceError";
  }
}

/** A rejected fetch or body read as a MemoryServiceError: 504 for a timeout, 502 otherwise. */
function transportError(error: unknown, label: string, timeoutMs: number): MemoryServiceError {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return new MemoryServiceError(`memory service ${label} timed out after ${timeoutMs}ms`, 504, { cause: error });
  }
  return new MemoryServiceError(`memory service ${label} unreachable`, 502, { cause: error });
}

// Hard timeouts on every Graphiti HTTP call. The Python memory-service (Graphiti +
// Neo4j AuraDB free tier + RRF fusion) is sub-second when warm, but a cold
// container, a lazy model-load, or a stale AuraDB connection can take 25-30s+. With
// no timeout that would hang the whole /api/memory/query request. Because the hybrid
// store runs graphiti + pgvector under Promise.allSettled, a timed-out graph leg lets
// pgvector results still return — a slow graph can never wall the request. Tunable via
// env so ops can adjust without a redeploy.
const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};
const SEARCH_TIMEOUT_MS = num(process.env.GRAPHITI_SEARCH_TIMEOUT_MS, 8_000);
const GRAPH_TIMEOUT_MS = num(process.env.GRAPHITI_GRAPH_TIMEOUT_MS, 15_000);
const DEFAULT_TIMEOUT_MS = num(process.env.GRAPHITI_TIMEOUT_MS, 20_000);

// Raw service response shapes (snake_case), kept local to this client.
interface RawIngestResponse {
  episode_id: string;
}
/**
 * Graphiti's own retirement of an edge a newer one contradicted: `invalid_at` is when the
 * fact stopped being true, `expired_at` when the graph recorded that. A memory service
 * older than these fields omits them.
 */
interface RawRetirement {
  invalid_at?: string | null;
  expired_at?: string | null;
}
interface RawFact extends RawRetirement {
  uuid: string;
  fact: string;
  valid_at: string | null;
  actor_type?: string | null;
  actor_name?: string | null;
  source_id?: string | null;
  chunk_ids?: string[] | null;
  /** The episodes asserting the fact. A memory service older than this field omits it. */
  episode_ids?: string[] | null;
  /** The partition the fact is stored in. A memory service older than this field omits it. */
  group_id?: string | null;
}
interface RawSearchResponse {
  facts: RawFact[];
  /** Distinct partitions searched. A memory service that predates `group_ids` omits it. */
  groups_searched?: number;
}
interface RawEntityResponse {
  uuid: string;
  name: string;
  type: string;
  summary: string;
  facts: RawFact[];
}
interface RawGraphEdge extends RawRetirement {
  uuid: string;
  source: string;
  target: string;
  fact: string;
  valid_at?: string | null;
  actor_type?: string | null;
  actor_name?: string | null;
  scope_path?: string | null;
  group_id?: string | null;
  chunk_ids?: string[] | null;
  /** The connected source and episodes behind the edge. A memory service older than these fields omits them. */
  source_id?: string | null;
  episode_ids?: string[] | null;
}
interface RawGraphResponse {
  nodes: { uuid: string; name: string; type: string }[];
  edges: RawGraphEdge[];
}
interface RawRemoveResponse {
  removed: boolean;
}
interface RawExtractResponse {
  chunks: string[];
}

/** Result of `removeGroupFacts` — a count, not a boolean, since 0 (a group
 * with nothing ingested yet) is a normal outcome, not a "not found" case. */
export interface RemoveGroupFactsResult {
  removedCount: number;
}

/** One person to remove from an org's graph. Emails and names are matched as
 * case-insensitive substrings of episode, fact and summary text; entity ids and
 * exact names select the person's own entity nodes. */
export interface GraphPersonErasure {
  orgId: string;
  emails: string[];
  names: string[];
  entityIds: string[];
}

/** Counts of what one erasure removed from the graph; all zero on a repeat. */
export interface GraphPersonErasureResult {
  episodes: number;
  nodes: number;
  edges: number;
  summaries: number;
}

/** The counts, plus the ids of the erased episodes; empty on a repeat. */
export interface GraphPersonErasureResponse extends GraphPersonErasureResult {
  episodeIds: string[];
}

/** What one connected source has in the graph at one scope: counts only, never text. */
export interface GraphSourceRecords {
  /** The graph group the counts are for: {@link toGid} of a scope path, or the bare org id. */
  groupId: string;
  /** Ingested episodes stamped with the source. */
  episodes: number;
  /** Facts (relationships) stamped with the source or citing one of its episodes. */
  facts: number;
  /** Those facts that carry an embedding vector. */
  factEmbeddings: number;
  /** Verbatim Fact, Decision and Passage nodes behind those facts. */
  verbatimNodes: number;
  /** Entities at this scope that nothing links to; counted only for the scopes asked about. */
  orphans: number;
  /** Facts at this scope with no source stamp whose episodes are all gone; counted only for the scopes asked about. */
  danglingFacts: number;
}

interface RawSourceRecords {
  groups: {
    group_id: string;
    episodes: number;
    facts: number;
    fact_embeddings: number;
    verbatim_nodes: number;
    orphans: number;
    dangling_facts: number;
  }[];
}

const ERASE_TIMEOUT_MS = 60_000;

/** A person erasure as the memory service's `/people/erase` routes read it. */
function personErasureBody(input: GraphPersonErasure) {
  return { org_id: input.orgId, emails: input.emails, names: input.names, entity_uuids: input.entityIds };
}

/**
 * When Graphiti retired an edge, or null while it is current. An edge with an
 * `invalid_at` is retired once that time has passed; one still ahead is current, though
 * Graphiti sets `expired_at` as soon as it records any `invalid_at`. An edge with
 * `expired_at` alone is retired then. An edge from a memory service that predates these
 * fields reads as current, as it did before them.
 *
 * Answers (`retrieve`, `entity`) leave a retired fact out; the graph view marks it, and a
 * brief citation reads as superseded.
 */
export function retiredAt(edge: RawRetirement, now: number = Date.now()): string | null {
  if (edge.invalid_at) {
    const at = parseInstant(edge.invalid_at);
    // A mark that cannot be read is not evidence the fact is current.
    return Number.isNaN(at) || at <= now ? edge.invalid_at : null;
  }
  return edge.expired_at ?? null;
}

/** An ISO time as epoch ms. Graphiti reads a time without an offset as UTC, where Date.parse would use the local zone. */
function parseInstant(iso: string): number {
  const withoutOffset = /[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(iso);
  return Date.parse(withoutOffset ? `${iso}Z` : iso);
}

/** A label kept as it is in a group id: no dash and nothing Graphiti refuses. */
const PLAIN_LABEL = /^[A-Za-z0-9_]+$/;

/**
 * The Graphiti group a scope path or bare org id is stored under: the only way any code
 * names a graph partition. Group ids must match [A-Za-z0-9_-], and two different paths
 * must never share one, or a reader of one scope is served another's facts.
 *
 * Labels made of [A-Za-z0-9_] are kept and joined with dashes, so `org_x.eng.secrets` is
 * `org_x-eng-secrets`, the name every such scope has always had. Any other label, such as
 * one holding a dash, is written as a dash and then its escape (see {@link escapeLabel}):
 * `org_x.eng-secrets` is `org_x--eng_2Dsecrets`. A kept label is never empty and an escape
 * never holds a dash, so splitting a group id on dashes gives back the path: an empty
 * segment marks the next one as an escape. Every scope under an org keeps the `org_<id>-`
 * prefix the memory service's org purge matches. Throws on a path with an empty label,
 * which is not a scope path.
 */
/** An entity as the memory service answers it, without the facts Graphiti has retired. */
function toMemoryEntity(raw: RawEntityResponse): MemoryEntity {
  return {
    uuid: raw.uuid,
    name: raw.name,
    type: raw.type,
    summary: raw.summary,
    // The chunk stamps, as on `retrieve`: the guarded read drops a fact whose every
    // chunk lost a write race, and without them it could only match by text.
    facts: raw.facts
      .filter((f) => !retiredAt(f))
      // The source and episodes too, so the guarded read can check a stored source still
      // stands behind each fact (services/memory/graph-fact-sources.ts).
      .map((f) => ({
        uuid: f.uuid,
        fact: f.fact,
        validAt: f.valid_at,
        chunkIds: f.chunk_ids ?? undefined,
        sourceId: f.source_id ?? undefined,
        sourceEventIds: f.episode_ids ?? undefined,
      })),
  };
}

export function toGid(path: string): string {
  return path
    .split(".")
    .map((label) => {
      if (PLAIN_LABEL.test(label)) return label;
      if (label === "") throw new Error(`"${path}" has an empty label, so it names no graph partition.`);
      return `-${escapeLabel(label)}`;
    })
    .join("-");
}

/**
 * A label in [A-Za-z0-9_]: letters and digits kept, every other UTF-8 byte written as `_`
 * and two hex digits, so `eng-secrets` is `eng_2Dsecrets` and `a_b` is `a_5Fb`.
 * encodeURIComponent does the UTF-8 step and throws on a lone surrogate, which has none.
 */
function escapeLabel(label: string): string {
  return encodeURIComponent(label)
    .replace(/[^A-Za-z0-9%]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%/g, "_");
}

/** Nodes and relationships in one org's graph partitions. */
export interface OrgGraphCounts {
  nodes: number;
  relationships: number;
}

/** An org purge deletes in batches server-side; a large org takes longer than one read. */
const ORG_PURGE_TIMEOUT_MS = 300_000;

/** The Graphiti-backed MemoryStore, plus the connector-sync and erasure calls only the concrete client offers. */
/** A file episode without a chunk stamp, as the file-episode backfill matches it: never its text or name. */
interface UnstampedFileEpisode {
  uuid: string;
  /** Hex SHA-256 of `salt + ":" + text`: the passage it was extracted from. */
  contentDigest: string;
  /** Hex SHA-256 of `salt + ":" + filename`, the file it is named for (`notes.pdf` for `notes.pdf (part 2/5)`). */
  fileNameDigest: string;
  /** Marked an orphan by an earlier backfill run that did not get to retire it. */
  pendingRetirement: boolean;
}

export interface UnstampedFileEpisodePage {
  episodes: UnstampedFileEpisode[];
  /** Episodes of the partition this page read, listed or not. */
  scanned: number;
  /** The `after` of the next page; null once the partition is read through. */
  nextAfter: string | null;
}

export type EpisodeStampOutcome = "stamped" | "already" | "refused" | "missing";

export class GraphitiMemoryStore implements MemoryStore {
  constructor(
    private readonly baseUrl = process.env.GRAPHITI_SERVICE_URL ?? "",
    private readonly apiKey = process.env.GRAPHITI_SERVICE_API_KEY ?? "",
  ) {}

  // Fetch with a hard timeout. A timeout or a failed connection surfaces as a
  // MemoryServiceError (504 or 502) so callers (and Promise.allSettled) treat an
  // unreachable service the same as any other failure instead of hanging or
  // leaking fetch's own TypeError.
  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, label: string): Promise<Response> {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw transportError(e, label, timeoutMs);
    }
  }

  private async call<T>(path: string, body: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    if (!this.baseUrl) {
      throw new MemoryServiceError("GRAPHITI_SERVICE_URL is not set");
    }
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}${path}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      },
      timeoutMs,
      path,
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new MemoryServiceError(`memory service ${path} failed: ${detail}`, res.status);
    }
    try {
      return (await res.json()) as T;
    } catch (e) {
      throw transportError(e, path, timeoutMs);
    }
  }

  async ingest(input: IngestInput): Promise<IngestResult> {
    const res = await this.call<RawIngestResponse>("/ingest", {
      group_id: toGid(input.scopePath ?? input.groupId),
      content: input.content,
      source: input.source ?? "message",
      name: input.name,
      reference_time: input.referenceTime,
      actor_type: input.actorType,
      actor_id: input.actorId,
      actor_name: input.actorName,
      scope_path: input.scopePath,
      source_id: input.sourceId,
      // The `memory_chunks` row the request path already stored this content as
      // (`readableId`). The service stamps it on the episode, /search hands it back on
      // every fact the episode produced, and the read uses it to tell a superseded
      // version from a current one (services/memory/superseded-facts.ts). Undefined on
      // the paths that store no chunk; see `IngestInput.readableId`.
      chunk_id: input.readableId,
      record_type: input.recordType,
      heading: input.heading,
    });
    return { episodeId: res.episode_id };
  }

  async ingestBulk(inputs: IngestInput[]): Promise<string[]> {
    if (inputs.length === 0) return [];
    const first = inputs[0];
    const groupId = toGid(first.scopePath ?? first.groupId);
    const res = await this.call<{ episode_ids: string[] }>("/ingest-bulk", {
      group_id: groupId,
      episodes: inputs.map((input) => ({
        group_id: toGid(input.scopePath ?? input.groupId),
        content: input.content,
        source: input.source ?? "message",
        name: input.name,
        reference_time: input.referenceTime,
        actor_type: input.actorType,
        actor_id: input.actorId,
        actor_name: input.actorName,
        scope_path: input.scopePath,
        source_id: input.sourceId,
        // Same chunk stamp as `ingest` above: every distilled fact of one ingest carries
        // the id of the chunk it was distilled from, so all of them hide together when
        // that chunk loses a race.
        chunk_id: input.readableId,
      })),
    });
    return res.episode_ids;
  }

  async retrieve(input: SearchInput): Promise<SearchResult> {
    const groupIds = (input.groupIds ?? []).map(toGid);
    const res = await this.call<RawSearchResponse>(
      "/search",
      {
        group_id: toGid(input.groupId),
        ...(groupIds.length > 0 ? { group_ids: groupIds } : {}),
        query: input.query,
        limit: input.limit ?? 10,
      },
      SEARCH_TIMEOUT_MS,
    );
    // A service older than `group_ids` ignores it and searches `group_id` alone, which
    // would read as "nothing in the other partitions". Fail the call instead, so the
    // read reports the graph store as failed.
    const expected = new Set([toGid(input.groupId), ...groupIds]).size;
    if (groupIds.length > 0 && res.groups_searched !== expected) {
      throw new MemoryServiceError(
        `memory service searched ${res.groups_searched ?? "an unknown number of"} of ${expected} partitions; it may predate multi-partition search`,
      );
    }
    const facts: MemoryFact[] = res.facts
      .filter((f) => !retiredAt(f))
      .map((f) => ({
        uuid: f.uuid,
        fact: f.fact,
        validAt: f.valid_at,
        // Provenance tier for GuardedMemoryStore's ranking. /search stamps this from
        // the edge's own source_description (same field /graph reads), so this is
        // real per-fact provenance, not a default.
        actorType: (f.actor_type ?? undefined) as MemoryFact["actorType"],
        // Citation: who asserted it, from the same stamped provenance, and which
        // connected source ingested it, which /search falls back to reading from
        // the fact's episode when the edge itself carries no stamp.
        actorName: f.actor_name ?? undefined,
        sourceId: f.source_id ?? undefined,
        // The chunks the fact's episodes were stamped with at write time. Empty when every
        // episode behind it predates the stamp; the supersede check then falls back to
        // matching by text (services/memory/superseded-facts.ts).
        chunkIds: f.chunk_ids ?? undefined,
        // The episodes asserting the fact: a connector sync writes one per synced item, so
        // this names the item a fact came from. Absent from a memory service older than the
        // field, and then the fact names no item.
        sourceEventIds: f.episode_ids ?? undefined,
        // A one-group search names its group even on a service older than `group_id`.
        graphGroupId: f.group_id ?? (groupIds.length === 0 ? toGid(input.groupId) : undefined),
        store: "graph",
      }));
    return { facts, storesRead: [{ store: "graph" }] };
  }

  async entity(input: EntityLookup): Promise<MemoryEntity | null> {
    if (input.groupIds) return this.entityInGroups(input.entityId, input.groupIds);
    if (!this.baseUrl) {
      throw new MemoryServiceError("GRAPHITI_SERVICE_URL is not set");
    }
    const url = `${this.baseUrl}/entities/${encodeURIComponent(input.entityId)}?group_id=${encodeURIComponent(toGid(input.groupId))}`;
    const res = await this.fetchWithTimeout(
      url,
      { headers: { authorization: `Bearer ${this.apiKey}` } },
      DEFAULT_TIMEOUT_MS,
      "entity lookup",
    );
    if (res.status === 404) return null;
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new MemoryServiceError(`memory service entity lookup failed: ${detail}`, res.status);
    }
    return toMemoryEntity((await res.json()) as RawEntityResponse);
  }

  async graph(input: GraphInput): Promise<MemoryGraph> {
    const groupIds = (input.groupIds ?? [input.groupId]).map(toGid);
    const raw = await this.call<RawGraphResponse>(
      "/graph",
      {
        group_ids: groupIds,
        query: input.query,
        limit: input.limit,
      },
      GRAPH_TIMEOUT_MS,
    );
    return {
      nodes: raw.nodes,
      edges: raw.edges.map((e) => ({
        uuid: e.uuid,
        source: e.source,
        target: e.target,
        fact: e.fact,
        validAt: e.valid_at ?? null,
        invalidAt: retiredAt(e),
        actorType: (e.actor_type ?? undefined) as "human" | "agent" | "extraction" | undefined,
        actorName: e.actor_name ?? null,
        scopePath: e.scope_path ?? null,
        graphGroupId: e.group_id ?? null,
        chunkIds: e.chunk_ids ?? undefined,
        sourceId: e.source_id ?? undefined,
        sourceEventIds: e.episode_ids ?? undefined,
      })),
    };
  }

  async removeEntity(input: RemoveEntityInput): Promise<RemoveFactResult> {
    if (!this.baseUrl) throw new MemoryServiceError("GRAPHITI_SERVICE_URL is not set");
    const url = `${this.baseUrl}/entities/${encodeURIComponent(input.entityId)}?group_id=${encodeURIComponent(toGid(input.groupId))}`;
    const res = await fetch(url, { method: "DELETE", headers: { authorization: `Bearer ${this.apiKey}` } });
    if (res.status === 404) return { removed: false };
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new MemoryServiceError(`memory service removeEntity failed: ${detail}`, res.status);
    }
    const raw = (await res.json()) as { removed: boolean };
    return { removed: raw.removed };
  }

  /**
   * Remove one fact from the Graphiti group of the scope the delete was authorized on.
   *
   * A fact ingested without a scope path lives in the bare org id's group, and an
   * org-root reader sees it (the guarded store's bare-org read leg). So a delete
   * authorized at org root that misses the org-root group also tries the bare-org
   * group, the same rule pgvector-store.ts applies to rows with no scope path. A
   * delete authorized below org root never reaches untagged facts.
   */
  async removeFact(input: RemoveFactInput): Promise<RemoveFactResult> {
    const result = await this.removeFactInGroup(input.factId, input.groupId);
    if (result.removed || !input.tenantId || input.groupId !== orgRootPath(input.tenantId)) {
      return result;
    }
    return this.removeFactInGroup(input.factId, input.tenantId);
  }

  private async removeFactInGroup(factId: string, groupId: string): Promise<RemoveFactResult> {
    if (!this.baseUrl) {
      throw new MemoryServiceError("GRAPHITI_SERVICE_URL is not set");
    }
    const url = `${this.baseUrl}/facts/${encodeURIComponent(factId)}?group_id=${encodeURIComponent(toGid(groupId))}`;
    const res = await fetch(url, {
      method: "DELETE",
      headers: { authorization: `Bearer ${this.apiKey}` },
    });
    if (res.status === 404) return { removed: false };
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new MemoryServiceError(`memory service removeFact failed: ${detail}`, res.status);
    }
    const raw = (await res.json()) as RawRemoveResponse;
    return { removed: raw.removed };
  }

  /**
   * Retire every fact one episode contributed. Not on the shared
   * `MemoryStore` interface — like `extractFile`, this is a
   * connector-sync-only concern, called directly on the concrete
   * `graphitiStore` singleton (see lib/inngest.ts's sourceSync), not through
   * every store implementation or the access-guarded facade: sourceSync is
   * already a trusted server-side background job operating on its own
   * source's scope, not a user-facing request.
   */
  async removeEpisode(input: { groupId: string; episodeId: string }): Promise<RemoveFactResult> {
    if (!this.baseUrl) {
      throw new MemoryServiceError("GRAPHITI_SERVICE_URL is not set");
    }
    const url = `${this.baseUrl}/episodes/${encodeURIComponent(input.episodeId)}?group_id=${encodeURIComponent(toGid(input.groupId))}`;
    const res = await fetch(url, {
      method: "DELETE",
      headers: { authorization: `Bearer ${this.apiKey}` },
    });
    if (res.status === 404) return { removed: false };
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new MemoryServiceError(`memory service removeEpisode failed: ${detail}`, res.status);
    }
    const raw = (await res.json()) as RawRemoveResponse;
    return { removed: raw.removed };
  }

  /**
   * Retire what one stored chunk left in the graph: the episodes ingest stamped with
   * its id (`chunk_id`, see `ingest`), the facts they created and what those leave
   * behind, through the same retirement a source disconnect uses. `groupId` is the
   * scope the chunk was stored in, which is where its episodes were written.
   */
  async removeChunkFacts(input: RemoveChunkFactsInput): Promise<RemoveChunkFactsResult> {
    if (!this.baseUrl) {
      throw new MemoryServiceError("GRAPHITI_SERVICE_URL is not set");
    }
    const url = `${this.baseUrl}/chunks/${encodeURIComponent(input.chunkId)}?group_id=${encodeURIComponent(toGid(input.groupId))}`;
    const res = await this.fetchWithTimeout(
      url,
      { method: "DELETE", headers: { authorization: `Bearer ${this.apiKey}` } },
      DEFAULT_TIMEOUT_MS,
      "removeChunkFacts",
    );
    // The endpoint answers an unknown chunk with zero counts, so a 404 means the
    // deployed service predates the route; reporting the fact deleted would be false.
    if (res.status === 404) {
      throw new MemoryServiceError(
        "The memory service has no DELETE /chunks endpoint; redeploy it from this repo's memory-service.",
        404,
      );
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new MemoryServiceError(`memory service removeChunkFacts failed: ${detail}`, res.status);
    }
    // A service older than the field names no episodes: nothing to drop pointers to then.
    const raw = (await res.json().catch(() => ({}))) as { removed_episode_ids?: string[] };
    return { episodeIds: raw.removed_episode_ids ?? [] };
  }

  /**
   * Retire facts in a whole scope, not just one episode's like `removeEpisode`
   * above. `DELETE /api/sources/:id` calls this with the disconnected source's
   * own `scopePath` and `sourceId` so that source's ingested content stops
   * being retrievable regardless of which sync path produced it: per-file
   * episode ids are not captured for every row (a Drive row synced before
   * `SourceFile.episodeIds` existed holds an Inngest event id, not a Graphiti
   * episode id), so a scope-wide purge is the only complete way to retire ALL
   * of a source's facts.
   *
   * `sourceId`, when given, scopes the purge to edges whose stamped provenance
   * carries a matching `source_id`. A `scopePath` is NOT guaranteed exclusive
   * to one source (`POST /api/sources` accepts a caller-supplied `scopePath`,
   * and ordinary org memory can share it), so a bare group-wide purge would
   * also destroy a co-located producer's facts. Omitting `sourceId` purges the
   * whole group (every edge, marked or not) and is only safe when the caller
   * has independently established the scope is exclusive to this source; the
   * sources route always passes `sourceId`.
   *
   * Not on the shared `MemoryStore` interface, same as `removeEpisode` and
   * `extractFile`: a source-lifecycle-only concern called directly on the
   * concrete `graphitiStore` singleton, not through the access-guarded facade,
   * because the caller (the sources route) has already authorized the
   * disconnect against this exact scope.
   */
  async removeGroupFacts(input: { groupId: string; sourceId?: string }): Promise<RemoveGroupFactsResult> {
    if (!this.baseUrl) {
      throw new MemoryServiceError("GRAPHITI_SERVICE_URL is not set");
    }
    const qs = input.sourceId ? `?source_id=${encodeURIComponent(input.sourceId)}` : "";
    const url = `${this.baseUrl}/groups/${encodeURIComponent(toGid(input.groupId))}${qs}`;
    const res = await fetch(url, {
      method: "DELETE",
      headers: { authorization: `Bearer ${this.apiKey}` },
    });
    // The endpoint never 404s on an unknown group (nothing to remove is a
    // count of 0), so a 404 means the deployed service predates the route.
    if (res.status === 404) {
      throw new MemoryServiceError(
        "The memory service has no DELETE /groups endpoint; redeploy it from this repo's memory-service.",
        404,
      );
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new MemoryServiceError(`memory service removeGroupFacts failed: ${detail}`, res.status);
    }
    const raw = (await res.json()) as { removed_count: number };
    return { removedCount: raw.removed_count };
  }

  /**
   * Count the facts and ingested episodes one scope's graph group still holds
   * (the memory service's `POST /groups/residue`). Scope deletion asks this
   * before removing a scope; `graph()` cannot answer it, because its `limit`
   * pages entities and returns only their outgoing edges. Any non-200,
   * including a service that predates the route, throws `MemoryServiceError`.
   */
  async groupResidue(input: { groupId: string }): Promise<{ facts: number; episodes: number }> {
    return this.call<{ facts: number; episodes: number }>("/groups/residue", {
      group_id: toGid(input.groupId),
    });
  }

  /**
   * One page of the file episodes in `groupId`'s partition that carry no chunk stamp,
   * written before file passages were stamped (the memory service's read-only
   * `POST /episodes/unstamped-files`). Each is named by its uuid and by digests of its text
   * and filename salted with `salt`, the run's own random value, never by the text or the
   * name. For the file-episode backfill only (services/memory/file-episode-stamps.ts).
   */
  async listUnstampedFileEpisodes(input: {
    groupId: string;
    salt: string;
    after?: string;
    limit: number;
  }): Promise<UnstampedFileEpisodePage> {
    const raw = await this.call<{
      episodes: { uuid: string; content_digest: string; file_name_digest: string; pending_retirement: boolean }[];
      scanned: number;
      next_after: string | null;
    }>("/episodes/unstamped-files", {
      group_id: toGid(input.groupId),
      salt: input.salt,
      after: input.after ?? null,
      limit: input.limit,
    });
    return {
      episodes: raw.episodes.map((e) => ({
        uuid: e.uuid,
        contentDigest: e.content_digest,
        fileNameDigest: e.file_name_digest,
        pendingRetirement: e.pending_retirement,
      })),
      scanned: raw.scanned,
      nextAfter: raw.next_after,
    };
  }

  /**
   * Stamp one unstamped file episode in `groupId`'s partition with `chunkId`, as ingest
   * stamps a new one (the memory service's `POST /episodes/stamp-chunk`). The service
   * stamps only an episode `listUnstampedFileEpisodes` would list, and answers "already"
   * when it carries this stamp, so a rerun writes nothing. For the file-episode backfill only.
   */
  async stampEpisodeChunk(input: {
    groupId: string;
    episodeUuid: string;
    chunkId: string;
  }): Promise<EpisodeStampOutcome> {
    const raw = await this.call<{ outcome: EpisodeStampOutcome }>("/episodes/stamp-chunk", {
      group_id: toGid(input.groupId),
      episode_uuid: input.episodeUuid,
      chunk_id: input.chunkId,
    });
    return raw.outcome;
  }

  /**
   * Remove everything one org holds in the graph: every node in its partitions (the
   * bare org id, its root scope and every scope under it) with all their relationships
   * (the memory service's `POST /orgs/purge`). Only the org deletion job calls it, once
   * the deletion is due; a second call removes nothing. Any non-200, including a service
   * that predates the route, throws `MemoryServiceError`.
   */
  async purgeOrg(orgId: string): Promise<OrgGraphCounts> {
    return this.call<OrgGraphCounts>("/orgs/purge", { org_id: orgId }, ORG_PURGE_TIMEOUT_MS);
  }

  /** What one org still holds in the graph (`POST /orgs/residue`): zero in both once purged. */
  async orgResidue(orgId: string): Promise<OrgGraphCounts> {
    return this.call<OrgGraphCounts>("/orgs/residue", { org_id: orgId });
  }

  /**
   * Count what one connected source has in the org's graph, by graph group (the memory
   * service's `POST /sources/records`). Its records are found by the source's stamp in
   * every scope of the org; `scopePaths` are where orphaned entities are counted as
   * well. Read-only, counts only. Any non-200, including a service that predates the
   * route, throws `MemoryServiceError`.
   */
  async sourceRecords(input: { orgId: string; sourceId: string; scopePaths: string[] }): Promise<GraphSourceRecords[]> {
    const raw = await this.call<RawSourceRecords>("/sources/records", {
      org_id: input.orgId,
      source_id: input.sourceId,
      group_ids: input.scopePaths.map(toGid),
    }).catch((e: unknown) => {
      // The route answers every org and source, so a 404 means the deployed service predates it.
      if (e instanceof MemoryServiceError && e.status === 404) {
        throw new MemoryServiceError(
          "The memory service has no POST /sources/records endpoint; redeploy it from this repo's memory-service.",
          404,
        );
      }
      throw e;
    });
    return raw.groups.map((g) => ({
      groupId: g.group_id,
      episodes: g.episodes,
      facts: g.facts,
      factEmbeddings: g.fact_embeddings,
      verbatimNodes: g.verbatim_nodes,
      orphans: g.orphans,
      danglingFacts: g.dangling_facts,
    }));
  }

  /**
   * The ids of the episodes {@link erasePerson} would remove now for the same
   * input, read without changing anything (the memory service's
   * `POST /people/erase/plan`).
   */
  async planPersonErasure(input: GraphPersonErasure): Promise<string[]> {
    if (!this.baseUrl) {
      throw new MemoryServiceError("GRAPHITI_SERVICE_URL is not set");
    }
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/people/erase/plan`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(personErasureBody(input)),
      },
      ERASE_TIMEOUT_MS,
      "planPersonErasure",
    );
    if (res.status === 404) {
      throw new MemoryServiceError(
        "The memory service has no POST /people/erase/plan endpoint; redeploy it from this repo's memory-service.",
        404,
      );
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new MemoryServiceError(`memory service planPersonErasure failed: ${detail}`, res.status);
    }
    return ((await res.json()) as { episode_ids: string[] }).episode_ids;
  }

  /**
   * Remove one person from every graph partition of `orgId` (the memory
   * service's `POST /people/erase`). The caller has already authorized and
   * audited the request; see services/memory/person-erasure.ts.
   */
  async erasePerson(input: GraphPersonErasure): Promise<GraphPersonErasureResponse> {
    if (!this.baseUrl) {
      throw new MemoryServiceError("GRAPHITI_SERVICE_URL is not set");
    }
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/people/erase`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(personErasureBody(input)),
      },
      ERASE_TIMEOUT_MS,
      "erasePerson",
    );
    if (res.status === 404) {
      throw new MemoryServiceError(
        "The memory service has no POST /people/erase endpoint; redeploy it from this repo's memory-service.",
        404,
      );
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new MemoryServiceError(`memory service erasePerson failed: ${detail}`, res.status);
    }
    const { episode_ids, ...counts } = (await res.json()) as GraphPersonErasureResult & { episode_ids?: string[] };
    // A memory service deployed before it reported episode ids sends none.
    return { ...counts, episodeIds: episode_ids ?? [] };
  }

  /**
   * Post-ingest dedup: finds nodes in the same group where one name is a
   * case-insensitive substring of another with the same type, then merges the
   * shorter into the longer via transferEntity. Handles "Marcus" → "Marcus Chen".
   * Returns the number of merges performed.
   */
  async dedupeNodes(groupId: string): Promise<number> {
    const graph = await this.graph({ groupId, limit: 500 });
    const nodes = graph.nodes;

    // Group by type so only same-type nodes are compared
    const byType = new Map<string, typeof nodes>();
    for (const n of nodes) {
      const bucket = byType.get(n.type) ?? [];
      bucket.push(n);
      byType.set(n.type, bucket);
    }

    let merged = 0;
    for (const bucket of byType.values()) {
      // Sort longest-first so short merges into long, not the reverse
      const sorted = [...bucket].sort((a, b) => b.name.length - a.name.length);
      const absorbed = new Set<string>();

      for (let i = 0; i < sorted.length; i++) {
        if (absorbed.has(sorted[i].uuid)) continue;
        const longer = sorted[i].name.toLowerCase();

        for (let j = i + 1; j < sorted.length; j++) {
          if (absorbed.has(sorted[j].uuid)) continue;
          const shorter = sorted[j].name.toLowerCase();
          // Plain substring, with a 3-character floor so an initial or a
          // two-letter acronym cannot absorb an unrelated longer name.
          if (longer.includes(shorter) && shorter.length >= 3) {
            await this.transferEntity({ groupId, oldName: sorted[j].name, newName: sorted[i].name });
            absorbed.add(sorted[j].uuid);
            merged++;
          }
        }
      }
    }
    return merged;
  }

  async transferEntity(input: TransferEntityInput): Promise<TransferEntityResult> {
    if (!this.baseUrl) {
      throw new MemoryServiceError("GRAPHITI_SERVICE_URL is not set");
    }
    const res = await fetch(`${this.baseUrl}/transfer-entity`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ group_id: toGid(input.groupId), old_name: input.oldName, new_name: input.newName }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new MemoryServiceError(`memory service transferEntity failed: ${detail}`, res.status);
    }
    const raw = (await res.json()) as { transferred: number };
    return { transferred: raw.transferred };
  }

  async findFactById(input: FindFactByIdInput): Promise<FindFactByIdResult | null> {
    if (!this.baseUrl) {
      throw new MemoryServiceError("GRAPHITI_SERVICE_URL is not set");
    }
    const url = `${this.baseUrl}/facts/${encodeURIComponent(input.factId)}/resolve?group_id=${encodeURIComponent(toGid(input.groupId))}`;
    const res = await this.fetchWithTimeout(
      url,
      { headers: { authorization: `Bearer ${this.apiKey}` } },
      DEFAULT_TIMEOUT_MS,
      "fact find-by-id",
    );
    if (res.status === 404 || res.status === 405) {
      // A memory service older than this route answers 404 (no such path), or
      // 405 if the path it is asked for is one `DELETE /facts/{uuid}` already
      // claims. Neither answer means "no such fact", so this must not return
      // null: a stale deployment would otherwise read as a resolved absence and
      // every provenance write would be refused as if the fact were unreal.
      // One message for both statuses, not the status interpolated: the door
      // returns it verbatim, and a body that differed by status would let a
      // caller tell an un-updated service from an unreachable route. The status
      // itself stays on the error for logs.
      throw new MemoryServiceError(
        "memory service does not serve the fact-resolve route; deploy memory-service before the Node app",
        res.status,
      );
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new MemoryServiceError(`memory service find-fact failed: ${detail}`, res.status);
    }
    const raw = (await res.json()) as
      | { found: false }
      | ({
          found: true;
          uuid: string;
          fact: string;
          chunk_ids?: string[] | null;
          source_id?: string | null;
          episode_ids?: string[] | null;
        } & RawRetirement);
    if (!raw.found) return null;
    // A service that predates both marks omits them; that stays undefined ("cannot
    // say"), never null ("still in force").
    const reportsRetirement = raw.invalid_at !== undefined || raw.expired_at !== undefined;
    return {
      uuid: raw.uuid,
      fact: raw.fact,
      invalidAt: reportsRetirement ? retiredAt(raw) : undefined,
      // The edge's stamps, so the guarded lookup can check a stored source still stands
      // behind it (services/memory/graph-fact-sources.ts). A service older than them omits them.
      chunkIds: raw.chunk_ids ?? undefined,
      sourceId: raw.source_id ?? undefined,
      sourceEventIds: raw.episode_ids ?? undefined,
      store: "graph",
    };
  }

  /**
   * The entity with this id in any of `groupIds`, in one call, with the partition it was
   * found in. A miss answers 200 with no entity, so a 404 here is a memory service
   * without the route, and fails rather than reading as "not found".
   */
  private async entityInGroups(entityId: string, groupIds: string[]): Promise<MemoryEntity | null> {
    if (groupIds.length === 0) return null;
    const raw = await this.call<{ entity: RawEntityResponse | null; group_id: string | null }>("/entities/lookup", {
      uuid: entityId,
      group_ids: groupIds.map(toGid),
    });
    if (!raw.entity) return null;
    return { ...toMemoryEntity(raw.entity), graphGroupId: raw.group_id ?? undefined };
  }

  /**
   * Which of `groupIds` hold an entity named exactly `name`, in the order given, asked in
   * one call. Server-side scope resolution only (services/memory/entity-scope.ts).
   */
  async groupsHoldingEntity(input: { name: string; groupIds: string[] }): Promise<string[]> {
    if (input.groupIds.length === 0) return [];
    const raw = await this.call<{ group_ids: string[] }>("/entities/groups", {
      name: input.name,
      group_ids: input.groupIds.map(toGid),
    });
    const holding = new Set(raw.group_ids);
    return input.groupIds.filter((groupId) => holding.has(toGid(groupId)));
  }

  async extractBytes(input: { contentB64: string; fileType: string; filename: string }): Promise<{ chunks: string[] }> {
    const raw = await this.call<RawExtractResponse>("/extract-bytes", {
      content_b64: input.contentB64,
      file_type: input.fileType,
      filename: input.filename,
    });
    return { chunks: raw.chunks };
  }

  async extractFile(input: { url: string; fileType: string; filename: string }): Promise<{ chunks: string[] }> {
    const raw = await this.call<RawExtractResponse>("/extract", {
      url: input.url,
      file_type: input.fileType,
      filename: input.filename,
    });
    return { chunks: raw.chunks };
  }
}
