// The embedding client (services/memory/embedding-service.ts): how many requests a batch
// of texts becomes, how many are in flight at once, and what a failure looks like. The
// memory service is a fetch stub.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMBED_BATCHES_IN_FLIGHT, EMBED_BATCH_SIZE, embedTexts, getEmbedding } from "./embedding-service";
import { StoreRefusedError } from "./memory-store";

/** A vector that names its text, so order is checkable. */
const vectorOf = (text: string) => [Number(text.slice(1))];
const texts = (n: number, prefix = "t") => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

let requests: { path: string; texts: string[] }[];
let inFlight: number;
let maxInFlight: number;

function stubService(answer: (path: string, texts: string[]) => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body: string }) => {
      const path = new URL(url).pathname;
      const body = JSON.parse(init.body) as { text?: string; texts?: string[] };
      const asked = body.texts ?? [body.text!];
      requests.push({ path, texts: asked });
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return answer(path, asked);
    }),
  );
}

const batchAnswer = (_path: string, asked: string[]) =>
  new Response(JSON.stringify({ embeddings: asked.map(vectorOf) }), { status: 200 });

beforeEach(() => {
  requests = [];
  inFlight = 0;
  maxInFlight = 0;
});

afterEach(() => vi.unstubAllGlobals());

describe("embedTexts", () => {
  it("sends EMBED_BATCH_SIZE texts per /embed-batch request and returns one vector per text, in order", async () => {
    stubService(batchAnswer);
    const asked = texts(2 * EMBED_BATCH_SIZE + 11);

    const vectors = await embedTexts(asked);

    expect(vectors).toEqual(asked.map(vectorOf));
    expect(requests.map((r) => [r.path, r.texts.length])).toEqual([
      ["/embed-batch", EMBED_BATCH_SIZE],
      ["/embed-batch", EMBED_BATCH_SIZE],
      ["/embed-batch", 11],
    ]);
  });

  it("never has more than EMBED_BATCHES_IN_FLIGHT requests in flight, across every caller", async () => {
    stubService(batchAnswer);

    // 300 rows' passages, asked for at once, as an ingest of a large file does.
    await Promise.all(Array.from({ length: 300 }, () => embedTexts(texts(8))));

    expect(requests).toHaveLength(300);
    expect(maxInFlight).toBe(EMBED_BATCHES_IN_FLIGHT);
  });

  it("embeds one text at a time through /embed when the memory service has no /embed-batch", async () => {
    stubService((path, asked) =>
      path === "/embed-batch"
        ? new Response("not found", { status: 404 })
        : new Response(JSON.stringify({ embedding: vectorOf(asked[0]!) }), { status: 200 }),
    );

    expect(await embedTexts(texts(3))).toEqual(texts(3).map(vectorOf));
    expect(requests.map((r) => r.path)).toEqual(["/embed-batch", "/embed", "/embed", "/embed"]);
  });

  it("throws a refusal asking again cannot fix, and refuses an answer that is not one vector per text", async () => {
    stubService(() => new Response("bad key", { status: 401 }));
    await expect(embedTexts(texts(2))).rejects.toBeInstanceOf(StoreRefusedError);

    stubService(() => new Response(JSON.stringify({ embeddings: [[1]] }), { status: 200 }));
    await expect(embedTexts(texts(2))).rejects.toThrow(/did not return one embedding per text/);
  });
});

describe("a caller's signal: a memory service that never answers", () => {
  /** Requests the stub holds open, each answered when the test releases it. */
  let held: (() => void)[];

  /** A memory service that accepts every request and answers none until released; an aborted request rejects. */
  function stubHungService() {
    held = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: { body: string; signal?: AbortSignal }) =>
          new Promise<Response>((resolve, reject) => {
            const { texts: asked = [] } = JSON.parse(init.body) as { texts?: string[] };
            init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
            held.push(() => resolve(batchAnswer("/embed-batch", asked)));
          }),
      ),
    );
  }

  it("getEmbedding rejects with the signal's reason once the signal aborts", async () => {
    stubHungService();
    const controller = new AbortController();

    const pending = getEmbedding("t1", controller.signal);
    controller.abort(new Error("write-through deadline"));

    await expect(pending).rejects.toThrow("write-through deadline");
  });

  it("embedTexts gives up waiting for a batch slot once the signal aborts, and leaves the slots it never took", async () => {
    stubHungService();
    // Every slot held by a request that has no deadline, as a background job's is.
    const occupying = Array.from({ length: EMBED_BATCHES_IN_FLIGHT }, () => embedTexts(texts(1)));
    await vi.waitFor(() => expect(held).toHaveLength(EMBED_BATCHES_IN_FLIGHT));
    const controller = new AbortController();

    const waiting = embedTexts(texts(1), controller.signal);
    controller.abort(new Error("write-through deadline"));
    await expect(waiting).rejects.toThrow("write-through deadline");

    // The abandoned wait was handed no slot: releasing the holders frees every slot, so
    // as many new callers as there are slots are all sent at once.
    for (const release of held.splice(0)) release();
    await Promise.all(occupying);
    const next = Array.from({ length: EMBED_BATCHES_IN_FLIGHT }, () => embedTexts(texts(1)));
    await vi.waitFor(() => expect(held).toHaveLength(EMBED_BATCHES_IN_FLIGHT));
    for (const release of held.splice(0)) release();
    expect(await Promise.all(next)).toEqual(next.map(() => [vectorOf("t0")]));
  });
});
