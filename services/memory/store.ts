// The concrete memory singleton. Hybrid: Graphiti (graph facts) + pgvector (semantic
// chunks) queried in parallel at retrieval time. Ingest routes by provenance, not by
// length: extraction-tier and empty content go to Graphiti only, everything else to
// both (see HybridMemoryStore.ingest).
//
// In its own module to avoid a circular import: the ./index barrel re-exports both
// `memory` and the guarded store, and the guarded store needs `memory` — importing
// from here keeps the dependency one-directional (index → store → graphiti/pgvector).
import { GraphitiMemoryStore } from "./graphiti-store";
import { PgvectorMemoryStore } from "./pgvector-store";
import { HybridMemoryStore } from "./hybrid-store";
import type { MemoryStore } from "./memory-store";

export const graphitiStore = new GraphitiMemoryStore();
export const memory: MemoryStore = new HybridMemoryStore(graphitiStore, new PgvectorMemoryStore());
