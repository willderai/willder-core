// A fake for the memory service's `/embed` endpoint, for suites that drive the
// real `PgvectorMemoryStore` against a real Postgres (test-only, not collected by
// vitest, whose include is `**/*.test.ts`; not reachable from the served application).
//
// Why this exists: the pgvector store writes no row without an embedding, and a
// failed embedding throws rather than storing an unreadable row
// (`PgvectorMemoryStore.insertRow`). A suite whose subject is something else --
// Drive retirement, write-through idempotency -- therefore needs the embedding
// call to SUCCEED, or it never reaches the behaviour it is testing.
//
// These suites used to point `GRAPHITI_SERVICE_URL` at a dead port instead, back
// when a failed embedding was swallowed and the row was stored with a NULL
// `embedding`. That made them pass on a path production cannot read from: the
// store's own `retrieve` filters on `embedding IS NOT NULL`. They were green
// because a real failure was hidden. Serving a real vector here is what lets
// them exercise the stored-and-readable path they claim to cover.
//
// The stub throws on any other URL rather than returning a blank answer, so an
// unexpected network call in one of these suites surfaces as a failure instead
// of a silently empty response.
import { vi } from "vitest";

/** The embedding width the `memory_chunks.embedding` column declares. */
const EMBEDDING_DIMENSIONS = 384;

/**
 * Replace global `fetch` with one that answers the memory service's `/embed`
 * endpoint and nothing else. Call it in `beforeAll`; pair it with
 * `vi.unstubAllGlobals()` in `afterAll`.
 *
 * The vector is fixed, so two chunks embed identically. Nothing here asserts on
 * similarity ranking -- these suites resolve chunks by id -- and a fixed vector
 * keeps the double deterministic.
 */
export function stubEmbeddingService(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.endsWith("/embed")) {
      throw new Error(`unexpected fetch to ${url}: this suite only stands in for the memory service's /embed`);
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ embedding: new Array(EMBEDDING_DIMENSIONS).fill(0.01) }),
    } as Response;
  });
}
