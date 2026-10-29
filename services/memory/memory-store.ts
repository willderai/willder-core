// MemoryStore: the one interface the app uses for memory, implemented by the
// Graphiti, pgvector and hybrid stores. Every store partitions by `groupId`;
// none of them is the access gate (that is GuardedMemoryStore).
import type {
  EntityLookup,
  FindFactByIdInput,
  FindFactByIdResult,
  GraphInput,
  IngestInput,
  IngestResult,
  MemoryEntity,
  MemoryGraph,
  RemoveChunkFactsInput,
  RemoveChunkFactsResult,
  RemoveEntityInput,
  RemoveFactInput,
  RemoveFactResult,
  SearchInput,
  SearchResult,
  TransferEntityInput,
  TransferEntityResult,
} from "@/types/memory";

/**
 * The one interface the app uses for memory. Swappable by design: today it is the
 * Graphiti HTTP client (see ./graphiti-store), and the implementation can change
 * without touching callers. The Node app never imports Graphiti directly.
 *
 * Access control wraps `retrieve` — the `check()` gate runs before this is
 * called, and the service is also partitioned by `groupId`. Never bypass the gate
 * on memory reads.
 */
export interface MemoryStore {
  /** Write content for async extraction into the graph. Returns the episode id. */
  ingest(input: IngestInput): Promise<IngestResult>;

  /** Retrieve facts for a query within a tenant (`groupId`), access-scoped. */
  retrieve(input: SearchInput): Promise<SearchResult>;

  /** The text leg alone: the stored rows that hold the text the query quotes, with no
   *  embedding asked. Only the chunk store has it; the hybrid store calls it when the
   *  routing policy names the text leg without the vector leg. */
  retrieveText?(input: SearchInput): Promise<SearchResult>;

  /** How many rows the reader could read still owe the graph an absorption. Only the
   *  chunk store can count them; the hybrid store asks when the policy is in force. */
  pendingAbsorption?(input: SearchInput): Promise<number>;

  /** Fetch an entity + its facts ("what we know about X"). Null if not found. */
  entity(input: EntityLookup): Promise<MemoryEntity | null>;

  /** Entities + the facts linking them, as a node graph (the explorer view). */
  graph(input: GraphInput): Promise<MemoryGraph>;

  /** Remove a fact (privileged purge by an authorized human). Tenant-scoped. */
  removeFact(input: RemoveFactInput): Promise<RemoveFactResult>;

  /** Retire the graph facts distilled from one stored chunk, in the partition the chunk
   *  was stored in. Only a graph store has them, so only a graph store implements it;
   *  the hybrid store calls it from `removeFact` once it has found the chunk. Resolves to
   *  the episodes it retired, or nothing from a store that cannot say. */
  removeChunkFacts?(input: RemoveChunkFactsInput): Promise<RemoveChunkFactsResult | void>;

  /** Hard-delete an entity node and all its edges (DETACH DELETE). */
  removeEntity(input: RemoveEntityInput): Promise<RemoveFactResult>;

  /** Invalidate edges on oldName entity and recreate them on newName. Used when
   *  an org role mapping changes (e.g. CEO: Bob → Amy). */
  transferEntity(input: TransferEntityInput): Promise<TransferEntityResult>;

  /** Resolve one fact by its uuid within a single partition (`groupId`). Returns
   *  null when no such fact lives there — including when it exists in a
   *  different partition, so the answer never distinguishes "not yours" from
   *  "not real". Used server-side to bind a caller-supplied fact identifier to
   *  a scope that caller is authorized for, before anything referencing it is
   *  written (services/memory/fact-provenance.ts).
   *
   *  Throws rather than returning null when the backend cannot answer at all.
   *  Null is a resolved absence, and a backend that could not be reached has
   *  not resolved anything. */
  findFactById(input: FindFactByIdInput): Promise<FindFactByIdResult | null>;
}

/**
 * A store failure that asking again cannot fix: the store refused the request or its
 * credentials, or lacks the schema the call needs (a migration that has not run). A
 * read reports that store failed without asking it a second time.
 */
export class StoreRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreRefusedError";
  }
}
