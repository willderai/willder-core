// An ingest whose embedding failed must fail, not report success.
//
// retrieve() here is cosine ANN search over `memory_chunks.embedding` and
// filters `embedding IS NOT NULL`; nothing in the codebase backfills that
// column. So a row written with a null embedding is unreadable from this store
// forever, while the write reported an episodeId and the caller recorded the
// content as synced. ingest() therefore writes no row without an embedding and
// lets the embed error reach the caller, which is what makes a retry possible.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    $executeRaw: vi.fn().mockResolvedValue(1),
    $queryRaw: vi.fn(),
    // retrieve() sends its SELECT in one transaction with the index settings.
    $executeRawUnsafe: vi.fn(),
    $transaction: (queries: Promise<unknown>[]) => Promise.all(queries),
  },
}));

import { db } from "@/lib/db";
import { PgvectorMemoryStore } from "./pgvector-store";
import { StoreRefusedError } from "./memory-store";
import type { IngestInput } from "@/types/memory";

const queryRaw = vi.mocked(db.$queryRaw);

/** Every INSERT the store issued, as SQL text. The INSERT returns the new id,
 * so it goes through `$queryRaw`, the same call retrieve() uses. */
function insertCalls(): [TemplateStringsArray, ...unknown[]][] {
  return queryRaw.mock.calls.filter((call) =>
    (call[0] as TemplateStringsArray).join("").includes("INSERT INTO memory_chunks"),
  ) as [TemplateStringsArray, ...unknown[]][];
}

const INPUT: IngestInput = {
  groupId: "org_1",
  content: "The pricing review moved to Friday",
  actorType: "human",
  origin: "app",
  actorId: "user_1",
};

beforeEach(() => {
  queryRaw.mockReset();
  queryRaw.mockResolvedValue([{ id: "chunk_1" }]);
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PgvectorMemoryStore.ingest — the embedding is not optional", () => {
  it("throws, and writes nothing, when the embed endpoint returns an error", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("upstream down", { status: 503 }));

    await expect(new PgvectorMemoryStore().ingest(INPUT)).rejects.toThrow(/embed failed: .*503/);
    expect(insertCalls()).toHaveLength(0);
  });

  it("throws, and writes nothing, when the embed request itself fails", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(new PgvectorMemoryStore().ingest(INPUT)).rejects.toThrow("ECONNREFUSED");
    expect(insertCalls()).toHaveLength(0);
  });

  it("names what to check and what to do in the embed error", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("nope", { status: 401 }));

    await expect(new PgvectorMemoryStore().ingest(INPUT)).rejects.toThrow(/GRAPHITI_SERVICE_API_KEY/);
    await expect(new PgvectorMemoryStore().ingest(INPUT)).rejects.toThrow(/retry/i);
  });

  it("writes exactly one row, always carrying the embedding, when the embed succeeds", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ embedding: [0.25, 0.5] }), { status: 200 }));

    const { episodeId } = await new PgvectorMemoryStore().ingest(INPUT);

    expect(episodeId).toBeTruthy();
    const inserts = insertCalls();
    expect(inserts).toHaveLength(1);
    expect(inserts[0][0].join("?")).toContain('"embedding"');
    expect(inserts[0]).toContain("[0.25,0.5]");
  });
});

describe("PgvectorMemoryStore.ingestOnce — a caller's signal bounds the embedding", () => {
  it("throws, and writes nothing, when the signal aborts while the memory service has not answered", async () => {
    // Accepts the request and never answers, as the memory service did on 2026-10-14.
    vi.mocked(fetch).mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        }),
    );
    const controller = new AbortController();
    // Long enough to be split into passages, so the passage requests carry the signal too.
    const longContent = "The pricing review moved to Friday. ".repeat(400);

    const pending = new PgvectorMemoryStore().ingestOnce(
      { ...INPUT, content: longContent },
      { signal: controller.signal },
    );
    controller.abort(new Error("write-through deadline"));

    await expect(pending).rejects.toThrow("write-through deadline");
    expect(insertCalls()).toHaveLength(0);
    const signals = vi.mocked(fetch).mock.calls.map(([, init]) => init?.signal);
    expect(signals.length).toBeGreaterThan(1);
    expect(signals.every((signal) => signal === controller.signal)).toBe(true);
  });
});

describe("PgvectorMemoryStore.retrieve — why a null embedding is unreadable", () => {
  it("asks only for rows that have an embedding, so a null-embedding row can never come back", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ embedding: [0.25, 0.5] }), { status: 200 }));
    queryRaw.mockResolvedValue([]);

    await new PgvectorMemoryStore().retrieve({ groupId: "org_1", query: "pricing review" });

    const search = queryRaw.mock.calls
      .map(([strings]) => (strings as TemplateStringsArray).join("?"))
      .find((sql) => sql.includes("FROM memory_chunks"));
    expect(search).toContain("embedding IS NOT NULL");
  });
});

describe("PgvectorMemoryStore.retrieve — a failure asking again can fix is reported, one it cannot is thrown", () => {
  const read = () => new PgvectorMemoryStore().retrieve({ groupId: "org_1", query: "pricing review" });
  const embedded = () => new Response(JSON.stringify({ embedding: [0.25, 0.5] }), { status: 200 });
  /** The error Prisma's pg adapter raised for a missing column, recorded from a real Postgres 17. */
  const missingColumn = Object.assign(
    new Error('Raw query failed. Code: `42703`. Message: `column "embedding" does not exist`'),
    {
      code: "P2010",
      meta: {
        driverAdapterError: {
          name: "DriverAdapterError",
          cause: { originalCode: "42703", kind: "ColumnNotFound", column: "embedding" },
        },
      },
    },
  );

  it("reports a failed read when the memory service is down", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("Application failed to respond", { status: 502 }));

    await expect(read()).resolves.toEqual({ facts: [], storesRead: [{ store: "semantic", failed: true }] });
  });

  it("reports a failed read when the database drops the query", async () => {
    vi.mocked(fetch).mockImplementation(async () => embedded());
    queryRaw.mockRejectedValue(new Error("Connection terminated unexpectedly"));

    await expect(read()).resolves.toEqual({ facts: [], storesRead: [{ store: "semantic", failed: true }] });
  });

  it("throws StoreRefusedError when the memory service refuses the key", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("nope", { status: 401 }));

    await expect(read()).rejects.toBeInstanceOf(StoreRefusedError);
    await expect(read()).rejects.toThrow(/GRAPHITI_SERVICE_API_KEY/);
  });

  it("throws StoreRefusedError when the column the search needs does not exist", async () => {
    vi.mocked(fetch).mockImplementation(async () => embedded());
    queryRaw.mockRejectedValue(missingColumn);

    await expect(read()).rejects.toBeInstanceOf(StoreRefusedError);
    await expect(read()).rejects.toThrow(/migrat/i);
  });

  it("gives the question's embedding a deadline, so a hung memory service cannot hold the read", async () => {
    vi.mocked(fetch).mockImplementation(async () => embedded());
    queryRaw.mockResolvedValue([]);

    await read();

    expect(vi.mocked(fetch).mock.calls[0]![1]!.signal).toBeInstanceOf(AbortSignal);
  });
});
