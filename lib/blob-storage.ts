// The only module in this repository that is allowed to import `@vercel/blob`.
//
// The rules it enforces:
//
// - A blob holds customer memory content, so it must never be stored with
//   public access. A public Vercel Blob URL is unauthenticated, permanent and
//   guessable from ids that are not secret (an org id is returned by
//   /api/contacts and friends), so one `access: "public"` anywhere would make
//   every document stored through it world-readable forever.
// - A blob is a copy of a source file, kept no longer than its owner needs it. A
//   Drive file's blob is transient: Drive holds the file, so the blob is deleted
//   with `deletePrivateBlob` as soon as extraction ends. An upload's blob is the
//   file's only home, so it is kept until the upload is removed
//   (services/memory/uploads.ts).
// - Two stores never land on one pathname. Every blob gets a random suffix, so a
//   second upload of `notes.pdf` or a re-synced edit of a Drive file is a new
//   blob, not an overwrite the SDK refuses.
//
// This file makes the first and last rules impossible to break rather than
// merely detected: `access` and the suffix are not parameters, they are written
// once, here. Every other module goes through these functions, and
// `eslint.blob-access.mjs` fails the build on any other import of the storage SDK.

/** What a caller needs back from a stored blob: where to read it again. */
export interface StoredBlob {
  /** The blob's URL, readable server-side with the Blob read-write token. */
  url: string;
}

/** One stored blob, as `listPrivateBlobs` reports it. */
export interface ListedBlob {
  url: string;
  pathname: string;
  size: number;
  uploadedAt: Date;
}

/**
 * Store `body` under `pathname` in Vercel Blob with private access. The stored
 * pathname carries a random suffix, so the caller never collides with an
 * earlier blob of the same name; the returned URL is the only way back to it.
 *
 * Reading it back needs the Blob read-write token, which the server-side
 * extractor already uses (see memory-service/app/extractor.py's `_download`),
 * so private storage does not break ingestion. A stream body is sent as it is
 * read, so a large file never sits in memory here.
 */
export async function putPrivateBlob(
  pathname: string,
  body: Buffer | File | ReadableStream<Uint8Array>,
): Promise<StoredBlob> {
  // Imported here rather than at module scope, as both call sites did before
  // this wrapper existed: the SDK is only needed on the upload path, which a
  // deployment without a Blob token never takes.
  const { put } = await import("@vercel/blob");
  const { url } = await put(pathname, body, { access: "private", addRandomSuffix: true });
  return { url };
}

/**
 * Delete the blob at `url`. Deleting a blob that is already gone succeeds, so a
 * retried cleanup is safe to repeat.
 */
export async function deletePrivateBlob(url: string): Promise<void> {
  const { del } = await import("@vercel/blob");
  await del(url);
}

/**
 * The body of the blob at `url`, or null when no blob is stored there. Read from
 * origin storage, not the CDN cache, so a blob deleted a moment ago is not served.
 */
export async function readPrivateBlob(url: string): Promise<ReadableStream<Uint8Array> | null> {
  const { get } = await import("@vercel/blob");
  const result = await get(url, { access: "private", useCache: false });
  return result?.statusCode === 200 ? result.stream : null;
}

/**
 * Bytes `start` up to (not including) `end` of the blob at `url`, or null when no blob
 * is stored there. Asked for as an HTTP byte range, so only that slice is sent. A
 * store that ignores the range and sends the whole body is read only as far as `end`,
 * and the rest is not downloaded.
 *
 * Always exactly `end - start` bytes: a blob that ends before `end` throws a RangeError
 * rather than return a short slice.
 */
export async function readPrivateBlobRange(url: string, start: number, end: number): Promise<Buffer | null> {
  if (!(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start)) {
    throw new RangeError(`bad byte range ${start}-${end}`);
  }
  const { get } = await import("@vercel/blob");
  const result = await get(url, {
    access: "private",
    useCache: false,
    headers: { Range: `bytes=${start}-${end - 1}` },
  });
  if (result?.statusCode !== 200) return null;
  // A 206 answer carries Content-Range and holds the slice; a 200 holds the whole blob.
  const ranged = result.headers.get("content-range") !== null;
  const slice = await readSlice(result.stream, ranged ? 0 : start, ranged ? end - start : end);
  if (slice.length !== end - start) {
    throw new RangeError(`blob ends before byte ${end}: read ${slice.length} of bytes ${start}-${end}`);
  }
  return slice;
}

/** Bytes `from` up to `to` of `stream`, which is cancelled once `to` bytes have arrived. */
async function readSlice(stream: ReadableStream<Uint8Array>, from: number, to: number): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let read = 0;
  try {
    while (read < to) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      const lo = Math.max(from - read, 0);
      const hi = Math.min(to - read, chunk.length);
      if (hi > lo) chunks.push(chunk.subarray(lo, hi));
      read += chunk.length;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks);
}

/** Every stored blob whose pathname starts with `prefix`, across all result pages. */
export async function listPrivateBlobs(prefix: string): Promise<ListedBlob[]> {
  const { list } = await import("@vercel/blob");
  const listed: ListedBlob[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix, cursor });
    for (const { url, pathname, size, uploadedAt } of page.blobs) listed.push({ url, pathname, size, uploadedAt });
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return listed;
}
