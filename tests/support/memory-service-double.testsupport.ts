// A fake for the memory service's `/embed` endpoint, for a suite that drives the real
// write and read paths against a real Postgres (test-only; not collected by vitest, whose
// include is `**/*.test.ts`, and not reachable from the served application).
//
// Why a second double beside services/memory/embedding-service-double.testsupport.ts: that
// one answers with a FIXED vector, which is right for a suite that resolves chunks by id and
// wrong for one that asks a question and checks which fact comes back. A suite that asks
// memory_query for a write's own summary and requires that write's line in the answer needs
// an embedding that varies with the text, or the ranking is arbitrary and the suite is
// reading noise.
//
// The vector is a deterministic function of the text — hashed character trigrams, L2
// normalized — so two similar texts are close and two unrelated ones are not. No model runs,
// nothing is random, and the same text always embeds the same way.
//
// Every other URL is refused, so an unexpected network call in the suite surfaces as a
// failure instead of a silently empty answer.
import { type MockInstance, expect, vi } from "vitest";
import type { RemoveChunkFactsInput, RemoveChunkFactsResult } from "@/types/memory";

/** The embedding width the `memory_chunks.embedding` column declares. */
const EMBEDDING_DIMENSIONS = 384;

/** A deterministic unit vector for `text`: hashed character trigrams, L2 normalized. */
export function textEmbedding(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  for (let i = 0; i + 3 <= normalized.length; i++) {
    const trigram = normalized.slice(i, i + 3);
    let hash = 2_166_136_261;
    for (const char of trigram) {
      hash ^= char.codePointAt(0)!;
      hash = Math.imul(hash, 16_777_619);
    }
    vector[Math.abs(hash) % EMBEDDING_DIMENSIONS]! += 1;
  }
  const length = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return length === 0 ? vector.map(() => 1 / Math.sqrt(EMBEDDING_DIMENSIONS)) : vector.map((value) => value / length);
}

/**
 * Replace global `fetch` with one that answers the memory service's `/embed` endpoint from
 * the text it is given, and refuses everything else.
 *
 * Call it in `beforeAll`; pair it with `vi.unstubAllGlobals()` in `afterAll`. Leave
 * `GRAPHITI_SERVICE_URL` unset alongside it: the graph store then refuses before it reaches
 * the network, and the hybrid read carries on with the vector leg alone
 * (services/memory/hybrid-store.ts), which is the path this double is for. A suite that
 * also deletes facts needs `stubGraphChunkRetirement` below, because a delete does not
 * carry on without the graph.
 */
export function stubMemoryService(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.endsWith("/embed")) {
      throw new Error(`unexpected fetch to ${url}: this suite only stands in for the memory service's /embed`);
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
    return new Response(JSON.stringify({ embedding: textEmbedding(body.text ?? "") }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

/**
 * Stand in for the graph leg of the product's fact delete, for a suite with no graph service.
 *
 * `HybridMemoryStore.removeFact` retires a chunk's graph facts before it deletes the chunk,
 * and fails closed when the graph cannot be reached, so without this every delete in such a
 * suite answers 502. The returned spy records each retirement; assert it with
 * `expectGraphRetiredAtChunkScope` so the suite checks the graph was asked at the scope the
 * chunk was stored in, not the caller's. Restored by `vi.restoreAllMocks()`.
 *
 * Call it after the suite has set `DATABASE_URL`: the store is imported here, not at the
 * top of this file, because importing it opens the database client.
 */
export async function stubGraphChunkRetirement(): Promise<
  MockInstance<(input: RemoveChunkFactsInput) => Promise<RemoveChunkFactsResult>>
> {
  const { graphitiStore } = await import("@/services/memory/store");
  return vi.spyOn(graphitiStore, "removeChunkFacts").mockResolvedValue({ episodeIds: [] });
}

/**
 * Every removed chunk had its graph facts retired at the scope it was stored in, twice:
 * before its row was deleted and again after (`HybridMemoryStore.removeFact`), and no other
 * chunk was. `removed` is each chunk's id and stored scope, read from the product's own record
 * of the delete (its `delete` or `supersede` change events), never from the calls being checked.
 */
export function expectGraphRetiredAtChunkScope(
  retire: Awaited<ReturnType<typeof stubGraphChunkRetirement>>,
  removed: { recordId: string; scopePath: string }[],
): void {
  const asked = retire.mock.calls.map(([input]) => `${input.chunkId} @ ${input.groupId}`).sort();
  const expected = removed.map((r) => `${r.recordId} @ ${r.scopePath}`);
  expect(asked).toEqual([...expected, ...expected].sort());
}
