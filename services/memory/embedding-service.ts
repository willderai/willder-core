// The memory service's embedding endpoints, as this app calls them.
//
// `getEmbedding` embeds one text with POST /embed: a read's query and a row's own
// embedding. `embedTexts` embeds many with POST /embed-batch, a bounded batch per request
// and a bounded number of requests in flight across the whole process, for a long row's
// passages. The memory service encodes on one model thread shared with every read
// (memory-service/app/model_work.py), so an ingest of many long rows must not arrive as
// thousands of concurrent requests.

import { StoreRefusedError } from "./memory-store";

const SERVICE_URL = process.env.GRAPHITI_SERVICE_URL ?? "http://localhost:8000";
const SERVICE_KEY = process.env.GRAPHITI_SERVICE_API_KEY ?? "";

/** Texts per /embed-batch request; the memory service accepts at most 64. */
export const EMBED_BATCH_SIZE = 32;

/** /embed-batch requests this process has in flight at once, at most. */
export const EMBED_BATCHES_IN_FLIGHT = 2;

/**
 * The error for a failed embedding request. A refusal asking again cannot fix (a 4xx
 * other than a timeout or a rate limit) is a StoreRefusedError.
 */
function embedFailure(path: string, status: number): Error {
  const message =
    `embed failed: ${SERVICE_URL}${path} returned ${status}. ` +
    `Check GRAPHITI_SERVICE_URL and GRAPHITI_SERVICE_API_KEY, then retry.`;
  const refused = status >= 400 && status < 500 && status !== 408 && status !== 429;
  return refused ? new StoreRefusedError(message) : new Error(message);
}

function post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  return fetch(`${SERVICE_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${SERVICE_KEY}`,
    },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });
}

/**
 * Embeds `text` through the memory service. A caller that answers someone passes a
 * `signal` with a deadline, so a hung service cannot hold it; a background job without
 * one waits as long as the service takes. An aborted signal rejects with its reason.
 */
export async function getEmbedding(text: string, signal?: AbortSignal): Promise<number[]> {
  const res = await post("/embed", { text }, signal);
  if (!res.ok) throw embedFailure("/embed", res.status);
  const body = (await res.json()) as { embedding: number[] };
  return body.embedding;
}

let batchesInFlight = 0;
const waitingForBatch: (() => void)[] = [];

/**
 * Run `work` once fewer than EMBED_BATCHES_IN_FLIGHT batches are in flight. A `signal`
 * that aborts while this waits for a slot rejects with its reason, and the wait leaves
 * the queue, so no slot is ever handed to a caller that stopped waiting.
 */
async function inBatchSlot<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (batchesInFlight < EMBED_BATCHES_IN_FLIGHT) batchesInFlight++;
  // A finishing batch hands its slot straight to the next waiter, so the count never
  // passes the bound between one batch ending and the next starting.
  else await waitForSlot(signal);
  try {
    return await work();
  } finally {
    const next = waitingForBatch.shift();
    if (next) next();
    else batchesInFlight--;
  }
}

/** Wait until a finishing batch hands this caller its slot, or until `signal` aborts. */
function waitForSlot(signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const take = () => {
      signal?.removeEventListener("abort", leave);
      resolve();
    };
    const leave = () => {
      waitingForBatch.splice(waitingForBatch.indexOf(take), 1);
      reject(signal!.reason);
    };
    waitingForBatch.push(take);
    signal?.addEventListener("abort", leave, { once: true });
  });
}

/**
 * Embeds one batch. A memory service that predates /embed-batch answers 404; the batch
 * is then embedded one text at a time through /embed, still inside its slot.
 */
async function embedBatch(texts: string[], signal?: AbortSignal): Promise<number[][]> {
  const res = await post("/embed-batch", { texts }, signal);
  if (res.status === 404) {
    const vectors: number[][] = [];
    for (const text of texts) vectors.push(await getEmbedding(text, signal));
    return vectors;
  }
  if (!res.ok) throw embedFailure("/embed-batch", res.status);
  const { embeddings } = (await res.json()) as { embeddings?: number[][] };
  if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
    throw new Error(`embed failed: ${SERVICE_URL}/embed-batch did not return one embedding per text`);
  }
  return embeddings;
}

/**
 * Embeds every text, EMBED_BATCH_SIZE per request and at most EMBED_BATCHES_IN_FLIGHT
 * requests at a time across the process. Throws if any batch fails, or with the
 * signal's reason once `signal` aborts, whether a batch is waiting for its slot or sent.
 */
export async function embedTexts(texts: string[], signal?: AbortSignal): Promise<number[][]> {
  const batches: string[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) batches.push(texts.slice(i, i + EMBED_BATCH_SIZE));
  const vectors = await Promise.all(batches.map((batch) => inBatchSlot(() => embedBatch(batch, signal), signal)));
  return vectors.flat();
}
