// Memory layer entry point. Import the singleton `memory` (a MemoryStore) and use
// `memory.ingest(...)` / `memory.retrieve(...)`. The concrete implementation is a
// HybridMemoryStore (Graphiti + pgvector) behind the interface and is swappable.
export type { MemoryStore } from "./memory-store";
export { GraphitiMemoryStore, MemoryServiceError } from "./graphiti-store";
export { PgvectorMemoryStore, pgvectorStore } from "./pgvector-store";
export { HybridMemoryStore } from "./hybrid-store";
export type {
  IngestInput,
  IngestResult,
  SearchInput,
  SearchResult,
  MemoryFact,
  MemoryEntity,
  EntityLookup,
  MemoryGraph,
  MemoryNode,
  MemoryEdge,
  GraphInput,
  RemoveFactInput,
  RemoveFactResult,
} from "@/types/memory";

// The raw singleton (its own module — see ./store for the why). For trusted
// server-side writes (the Inngest ingest worker).
export { memory, graphitiStore } from "./store";

// Access-enforced facade. Request paths read through this (check() + audit on
// every read); the raw `memory` above is for trusted server-side writes only.
export { GuardedMemoryStore, guardedMemory } from "./guarded-store";
