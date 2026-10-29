# Willder — Hybrid Memory Store

## Overview

Willder uses a two-store memory architecture: **Graphiti** (Neo4j graph) for structured entity relationships and **pgvector** (Neon Postgres) for semantic chunk retrieval. Both sit behind the same `GuardedMemoryStore` / `check()` access gate so access control holds regardless of which store answers a query.

## The Problem It Solves

Graphiti's entity extractor (llama-4-scout) works well for concrete facts ("Dana Reyes built the billing service") but struggles with abstract concepts, mental models, and long-form narrative content. When a 5000-token document is ingested as one episode, the extractor picks up people and organizations but misses abstract relationships ("Dana Reyes applies the strangler-fig pattern to the billing migration"). That leaves the graph weak at reasoning over frameworks, design decisions, or shared mental models.

## Architecture

```
Upload / Chat Write / Agent
        │
        ▼
  Inngest memoryIngest
        │
        ├─ resolve-entities (human content only)
        │
        ├─ store-readable (pgvector row + change-feed announcement, before any graph
        │                  step, so a graph outage cannot lose the text)
        │
        ├─ distill-facts (long content > 300 chars, non-extraction)
        │       └─ LLM (llama-4-scout) → 3-10 declarative facts
        │               └─ each fact → graphiti-add-episode (clean entity extraction)
        │               └─ raw content → graphiti-add-raw-episode
        │
        └─ graphiti-add-episode (short/structured content, direct path)
                └─ HybridMemoryStore.ingest()
                        ├─ GraphitiMemoryStore → Neo4j (via memory-service)
                        └─ PgvectorMemoryStore → Neon memory_chunks (if > 300 chars)

Retrieval (search_memory tool):
  GuardedMemoryStore.retrieve()
        └─ check() gate (access control)
        └─ HybridMemoryStore.retrieve()
                ├─ GraphitiMemoryStore.retrieve() ── parallel ──┐
                └─ PgvectorMemoryStore.retrieve() ──────────────┘
                        └─ merge + deduplicate by content prefix
```

## Fact Distillation

**Trigger:** content length > 300 chars AND actorType ≠ "extraction"

**What it does:** Calls llama-4-scout with a structured prompt to extract 3-10 concrete declarative sentences from the content. Each sentence must:
- Be self-contained (makes sense without surrounding context)
- Be in subject-verb-object form
- Use no pronouns
- Be specific, not vague

**Example:**

Input (from meeting notes):
> "Talking about the strangler-fig pattern and how I applied it to the billing migration."

Distilled facts:
- "Dana Reyes applied the strangler-fig pattern to the billing migration."
- "The billing migration replaces the old billing service one endpoint at a time rather than in one cutover."

Each distilled fact becomes a separate Graphiti episode → cleaner entity extraction → better graph edges.

## pgvector Store

**Table:** `memory_chunks` in Neon  
**Embedding:** BGE-small (384 dims), obtained via memory-service `/embed` endpoint (same model as Graphiti, shared embedding space)  
**Index:** IVFFlat cosine (`embedding <=> query_vec`)  
**Scope filtering:** `scopePath IS NULL OR scopePath = $scope OR scopePath LIKE $scope || '.%'`

Rows without a scopePath are org-wide. Rows with a scopePath are only returned for queries on that scope or its children — mirroring Graphiti's ltree containment.

## Cost Model

| Operation | Cost |
|---|---|
| Distillation (per upload) | 1 LLM call (llama-4-scout, fast + cheap) |
| pgvector ingest (per chunk) | 1 HTTP call to memory-service /embed |
| Retrieval | Graphiti search + pgvector cosine ANN in parallel (both sub-second) |
| pgvector storage | Neon free tier covers ~500k rows; no new infrastructure cost |

## Why These Stores

Both stores are self-hosted, so the scoped, audited access gate stays in Willder's own code rather than in a hosted memory provider. pgvector runs in the existing Postgres, so it adds no new infrastructure.

## Files

| File | Purpose |
|---|---|
| `services/memory/pgvector-store.ts` | PgvectorMemoryStore implementation |
| `services/memory/hybrid-store.ts` | HybridMemoryStore (wraps both) |
| `services/memory/store.ts` | Singleton (now HybridMemoryStore) |
| `lib/inngest.ts` | distill-facts step in memoryIngest |
| `memory-service/app/main.py` | /embed endpoint |
| `prisma/migrations/20260616_memory_chunks/` | pgvector extension + table |
