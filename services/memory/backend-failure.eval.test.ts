// Backend-failure eval — what willder's memory layer reports to its callers
// when Graphiti or Neon is slow, down, or answers "nothing happened".
//
// The store tests (graphiti-store.test.ts, hybrid-store.test.ts,
// pgvector-store.test.ts) exercise the HAPPY path — a backend that answers
// correctly. Production is where a store times out mid-request, where Neon
// drops the connection, where a delete reaches one store and not the other.
// The question in those moments is not "does it crash" but "does it tell the
// truth about what happened": a delete that reports success without deleting,
// or a read that quietly returns half the graph, is a false statement to a
// customer who is relying on it as proof.
//
// Seam under test: the real (unmocked) HybridMemoryStore, PgvectorMemoryStore
// and GraphitiMemoryStore. Only the outermost I/O is stubbed — `fetch` for the
// memory-service and `@/lib/db` for Neon — so every merge, catch, and return
// path in the stores themselves runs for real.
//
// ─────────────────────────────────────────────────────────────────────────────
// READ THIS BEFORE "FIXING" A FAILURE IN THIS FILE.
//
// Cases tagged `GAP:` assert willder's CURRENT behavior, and that behavior is a
// BUG. Each says what the correct behavior would be. A `GAP:` case failing
// means someone fixed the bug — flip the assertion and drop the tag; do not
// weaken it.
// ─────────────────────────────────────────────────────────────────────────────
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: { $queryRaw: vi.fn(), $executeRaw: vi.fn() },
}));

import { db } from "@/lib/db";
import { GraphitiMemoryStore, MemoryServiceError } from "./graphiti-store";
import { HybridMemoryStore } from "./hybrid-store";
import { PgvectorMemoryStore } from "./pgvector-store";
import type { MemoryStore } from "./memory-store";
import type { RemoveFactInput, SearchInput } from "@/types/memory";

/** A store whose every method is controllable per-test. */
function stubStore(over: Partial<Record<keyof MemoryStore, unknown>> = {}): MemoryStore {
  return {
    ingest: vi.fn().mockResolvedValue({ episodeId: "ep-1" }),
    retrieve: vi.fn().mockResolvedValue({ facts: [] }),
    entity: vi.fn().mockResolvedValue(null),
    graph: vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
    removeFact: vi.fn().mockResolvedValue({ removed: true }),
    removeEntity: vi.fn().mockResolvedValue({ removed: false }),
    transferEntity: vi.fn().mockResolvedValue({ transferred: 0 }),
    ...over,
  } as unknown as MemoryStore;
}

const fact = (uuid: string, text: string) => ({ uuid, fact: text, validAt: null });
const removeInput: RemoveFactInput = { groupId: "org_1", factId: "fact_gone" };

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(db.$queryRaw).mockReset();
  vi.mocked(db.$executeRaw).mockReset();
});

// ---------------------------------------------------------------------------
// "removed: true" must be falsifiable.
//
// PgvectorMemoryStore.removeFact reports `removed` from the rows its DELETE actually
// returned, never unconditionally. HybridMemoryStore.removeFact ORs
// the two legs together, so without that a fact id that does not exist
// anywhere, or a delete where the Graphiti leg timed out and deleted nothing,
// could never come back `removed: false`.
//
// The caller that believes it: app/api/memory/facts/[id]/route.ts's DELETE,
// whose own comment promises "Returns 404 if the fact isn't in this tenant".
//
// The still-open half of this gap — the hybrid store folding a REJECTED leg
// into a plain boolean OR instead of surfacing "unknown" — is untouched here,
// see the BOTH-legs-failing case below.
// ---------------------------------------------------------------------------

describe("backend failure — removeFact row-count fidelity", () => {
  it("PgvectorMemoryStore.removeFact returns removed:false when the DELETE matched zero rows", async () => {
    // The DELETE returns the rows it removed. None = the fact was not in pgvector at all.
    vi.mocked(db.$queryRaw).mockResolvedValue([] as never);

    const res = await new PgvectorMemoryStore().removeFact(removeInput);

    expect(res).toEqual({ removed: false });
    await expect(vi.mocked(db.$queryRaw).mock.results[0].value).resolves.toEqual([]);
  });

  it("PgvectorMemoryStore.removeFact returns removed:true when the DELETE actually matched a row", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValue([{ scopePath: null }] as never);

    const res = await new PgvectorMemoryStore().removeFact(removeInput);

    expect(res).toEqual({ removed: true, storedScopePath: null });
  });

  it("the hybrid delete truthfully reports removed:false when the Graphiti leg TIMED OUT and pgvector deleted nothing either", async () => {
    const graphiti = stubStore({
      removeFact: vi
        .fn()
        .mockRejectedValue(new MemoryServiceError("memory service /facts timed out after 8000ms", 504)),
    });
    // The real pgvector leg — now truthful, and it genuinely has nothing to delete.
    vi.mocked(db.$queryRaw).mockResolvedValue([] as never);
    const store = new HybridMemoryStore(graphiti, new PgvectorMemoryStore());

    const res = await store.removeFact(removeInput);

    expect(res).toEqual({ removed: false });
    expect(graphiti.removeFact).toHaveBeenCalledOnce();
  });

  it("GAP (still open, not this fix): even with BOTH legs failing, the caller gets a plain removed:false, not an error", async () => {
    // A total memory-layer outage is reported as "that fact wasn't there",
    // which the DELETE route turns into a 404 — indistinguishable, to the
    // customer, from a fact that was already gone.
    const graphiti = stubStore({
      removeFact: vi.fn().mockRejectedValue(new MemoryServiceError("connection refused", 502)),
    });
    const pgvector = stubStore({
      removeFact: vi.fn().mockRejectedValue(new Error("Neon: connection terminated unexpectedly")),
    });

    const res = await new HybridMemoryStore(graphiti, pgvector).removeFact(removeInput);

    // Correct behavior would be to propagate the failure so the route answers
    // 502, not 404.
    expect(res).toEqual({ removed: false });
  });

  it("control: when the Graphiti leg genuinely deletes, removed:true is truthful", async () => {
    // Without this control, the three cases above could be read as "the hybrid
    // store is just broken", rather than "it cannot distinguish a real delete
    // from a failed one".
    const graphiti = stubStore({ removeFact: vi.fn().mockResolvedValue({ removed: true }) });
    const pgvector = stubStore({ removeFact: vi.fn().mockResolvedValue({ removed: false }) });

    const res = await new HybridMemoryStore(graphiti, pgvector).removeFact(removeInput);

    expect(res).toEqual({ removed: true });
    expect(graphiti.removeFact).toHaveBeenCalledWith(removeInput);
  });
});

// ---------------------------------------------------------------------------
// A degraded read says which store failed.
//
// The tradeoff is unchanged (a slow graph must never wall the whole request):
// the read still answers from pgvector alone. What changed is that the result
// now names the failed store in `storesRead`, so the Ask page's breakdown shows
// "graph unavailable" instead of a smaller answer that reads like a complete
// one. The audit row from recordReadFactIds still records only the facts that
// came back, which is a truthful record of what was read.
// ---------------------------------------------------------------------------

describe("backend failure — a Graphiti outage narrows the answer, and says so", () => {
  it("returns pgvector-only facts, and marks the graph leg failed on the result", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const graphiti = stubStore({
      retrieve: vi.fn().mockRejectedValue(new MemoryServiceError("timed out after 8000ms", 504)),
    });
    const pgvector = stubStore({
      retrieve: vi.fn().mockResolvedValue({ facts: [fact("c1", "Acme renewal chunk")] }),
    });

    const res = await new HybridMemoryStore(graphiti, pgvector).retrieve({
      groupId: "org_1",
      query: "recent notes on the Acme renewal negotiation",
    } as SearchInput);

    expect(res.facts.map((f) => f.fact)).toEqual(["Acme renewal chunk"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("graphiti retrieve failed"), expect.anything());
    expect(res.storesRead).toEqual([{ store: "graph", failed: true }, { store: "semantic" }]);
  });

  it("an entity-shaped query during that outage falls back to pgvector too, and marks the graph leg failed", async () => {
    // Entity lookups (who/what is X) ask both stores like any other read, so with
    // Graphiti down the query a user is most likely to type still answers from pgvector.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const graphiti = stubStore({
      retrieve: vi.fn().mockRejectedValue(new MemoryServiceError("timed out after 8000ms", 504)),
    });
    const pgvector = stubStore({
      retrieve: vi.fn().mockResolvedValue({ facts: [fact("c1", "Jane Doe is the CTO at Acme")] }),
    });

    const res = await new HybridMemoryStore(graphiti, pgvector).retrieve({
      groupId: "org_1",
      query: "who is Jane Doe",
    } as SearchInput);

    expect(res.facts.map((f) => f.fact)).toEqual(["Jane Doe is the CTO at Acme"]);
    expect(res.storesRead).toEqual([{ store: "graph", failed: true }, { store: "semantic" }]);
  });
});

// ---------------------------------------------------------------------------
// A Neon failure during ingest must not be reported as a successful write.
//
// PgvectorMemoryStore.ingest must not swallow its INSERT's failure and return
// `{ episodeId: id }` for a row that was never written: the request path
// announces the pgvector row on the change feed, so the INSERT has to surface
// its failure. One layer up, HybridMemoryStore.ingest still downgrades a
// pgvector rejection to console.warn (the GAP below).
// ---------------------------------------------------------------------------

describe("backend failure — a Neon outage during ingest", () => {
  it("pgvector ingest rejects when Neon rejects the INSERT, instead of returning an id for a missing row", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ embedding: [0.1, 0.2, 0.3] }) }));
    vi.mocked(db.$queryRaw).mockRejectedValue(new Error("Neon: Can't reach database server at ep-x.neon.tech:5432"));

    await expect(
      new PgvectorMemoryStore().ingest({
        groupId: "org_1",
        content: "The Acme floor price is $80k",
        actorType: "human",
        origin: "app",
        actorId: "user_1",
      }),
    ).rejects.toThrow("Can't reach database server");
    expect(db.$queryRaw).toHaveBeenCalled();
  });

  it("GAP: the hybrid store downgrades that same failure to a log line and returns Graphiti's success", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const graphiti = stubStore({ ingest: vi.fn().mockResolvedValue({ episodeId: "ep-graph" }) });
    const pgvector = stubStore({
      ingest: vi.fn().mockRejectedValue(new Error("Neon: connection terminated unexpectedly")),
    });

    const res = await new HybridMemoryStore(graphiti, pgvector).ingest({
      groupId: "org_1",
      content: "The Acme floor price is $80k",
      actorType: "human",
      origin: "app",
      actorId: "user_1",
    });

    expect(res).toEqual({ episodeId: "ep-graph" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("pgvector ingest failed"), expect.anything());
  });

  it("control: a Graphiti ingest failure DOES propagate — so the silence above is pgvector-specific", async () => {
    const graphiti = stubStore({
      ingest: vi.fn().mockRejectedValue(new MemoryServiceError("ingest failed", 500)),
    });
    const store = new HybridMemoryStore(graphiti, stubStore());

    await expect(
      store.ingest({ groupId: "org_1", content: "x", actorType: "human", origin: "app", actorId: "user_1" }),
    ).rejects.toThrow(MemoryServiceError);
  });
});

// ---------------------------------------------------------------------------
// GAP — three Graphiti calls have no timeout at all.
//
// graphiti-store.ts opens with "Hard timeouts on every Graphiti HTTP call",
// and fetchWithTimeout() delivers exactly that for ingest/retrieve/graph/entity.
// removeEntity, removeFact and transferEntity call bare `fetch()` instead, with
// no AbortSignal — so against a hung memory-service they wait forever (in
// practice, until the platform's own request ceiling kills the whole request).
//
// Asserted structurally, on whether a signal is passed, because a test that
// actually waited out a hang would be a test that hangs.
//
// CORRECT behavior: route those three through fetchWithTimeout() like every
// other call, or drop the "every" from the file's opening comment.
// ---------------------------------------------------------------------------

describe("backend failure — GAP: three Graphiti calls ship without the documented timeout", () => {
  /** Capture the RequestInit each call passes, so we can look for a signal. */
  function captureFetch(response: Record<string, unknown> = { removed: true }) {
    const f = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => response });
    vi.stubGlobal("fetch", f);
    return f;
  }

  it("control: retrieve() DOES pass an AbortSignal, proving the check below is meaningful", async () => {
    const f = captureFetch({ facts: [] });
    await new GraphitiMemoryStore("http://svc", "k").retrieve({ groupId: "org_1", query: "q" });
    expect(f.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("control: entity() DOES pass an AbortSignal", async () => {
    const f = captureFetch({ uuid: "e1", name: "Acme", type: "company", summary: "", facts: [] });
    await new GraphitiMemoryStore("http://svc", "k").entity({ groupId: "org_1", entityId: "e1" });
    expect(f.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("GAP: removeFact() sends no AbortSignal — a hung memory-service hangs the request", async () => {
    const f = captureFetch();
    await new GraphitiMemoryStore("http://svc", "k").removeFact(removeInput);
    expect(f.mock.calls[0][1].signal).toBeUndefined();
  });

  it("GAP: removeEntity() sends no AbortSignal", async () => {
    const f = captureFetch();
    await new GraphitiMemoryStore("http://svc", "k").removeEntity({ groupId: "org_1", entityId: "e1" });
    expect(f.mock.calls[0][1].signal).toBeUndefined();
  });

  it("GAP: transferEntity() sends no AbortSignal", async () => {
    const f = captureFetch({ transferred: 1 });
    await new GraphitiMemoryStore("http://svc", "k").transferEntity({
      groupId: "org_1",
      entityId: "e1",
      toGroupId: "org_1.dealA",
    } as never);
    expect(f.mock.calls[0][1].signal).toBeUndefined();
  });

  it("control: a timed-out search surfaces as MemoryServiceError(504), not a hang", async () => {
    // The behavior the three cases above are missing, working correctly on the
    // path that does have it.
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValue(Object.assign(new DOMException("The operation was aborted due to timeout", "TimeoutError"))),
    );

    const store = new GraphitiMemoryStore("http://svc", "k");
    await expect(store.retrieve({ groupId: "org_1", query: "q" })).rejects.toMatchObject({
      name: "MemoryServiceError",
      status: 504,
    });
  });
});
