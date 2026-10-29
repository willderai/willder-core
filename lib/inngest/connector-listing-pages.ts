// A connector listing, carried out of its step in pieces Inngest accepts.
//
// Inngest persists every step's return value and refuses one over its size limit.
// The `list-items` step returned a whole text listing (a large GitHub repository's
// issues, comments and pull requests with their bodies) and `list-files` a whole
// Drive folder's file list, so a large enough source failed every run on the
// listing alone (connector-existing-files.ts bounds the other big step).
//
// The listing is read once, as before: re-listing a page at a time would repeat
// every provider call and could see a different listing on each. A listing that
// fits EXISTING_FILES_PAGE_BYTES is returned as it always was. A larger one is
// stored as a private blob under the source's prefix (swept by org deletion like a
// Drive file's), read back a bounded slice per step as a byte range (so a page
// step downloads its slice, not the whole listing), joined in the job, and the
// blob deleted at once: the same transient copy a Drive file's extraction makes.
// A run that dies before deleting it is cleaned up after (lib/source-listing-blobs.ts).
import { EXISTING_FILES_PAGE_BYTES } from "./connector-existing-files";

/** What the listing step returns in place of a listing too large for one step. */
export interface StashedListing {
  stashedListing: { url: string; bytes: number };
}

export interface ListingStash {
  put: (pathname: string, body: Buffer) => Promise<{ url: string }>;
  /** Bytes `start` up to (not including) `end` of the blob at `url`; null when it is gone. */
  read: (url: string, start: number, end: number) => Promise<Buffer | null>;
  del: (url: string) => Promise<void>;
}

type RunStep = <R>(id: string, fn: () => Promise<R>) => Promise<R>;

function isStashed(value: unknown): value is StashedListing {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "stashedListing" in value;
}

/**
 * Run `list` in the step `id` and return its value. The first step keeps the id
 * it always had, and a run replaying that step's older stored output (the whole
 * listing) reads it as it is. `pathname` is where an oversized listing is stored.
 */
export async function listInPages<T>(
  runStep: RunStep,
  id: string,
  pathname: string,
  list: () => Promise<T>,
  stash: () => Promise<ListingStash>,
  budget = EXISTING_FILES_PAGE_BYTES,
): Promise<T> {
  const first = await runStep<T | StashedListing>(id, async () => {
    const value = await list();
    const json = JSON.stringify(value);
    if (json === undefined) return value;
    const body = Buffer.from(json, "utf8");
    if (body.length <= budget) return value;
    const { url } = await (await stash()).put(pathname, body);
    return { stashedListing: { url, bytes: body.length } };
  });
  if (!isStashed(first)) return first;

  const { url, bytes } = first.stashedListing;
  // Bytes of the stored listing one page step carries: as base64 (4 characters per 3
  // bytes) in a JSON string, they stay within the budget.
  const pageBytes = Math.floor((budget - 8) / 4) * 3;
  const parts: Buffer[] = [];
  for (let n = 0; n * pageBytes < bytes; n++) {
    const page = await runStep(`${id}-page-${n}`, async () => {
      const start = n * pageBytes;
      const end = Math.min(start + pageBytes, bytes);
      const slice = await (await stash()).read(url, start, end);
      // The listing step has already run and is not run again: a lost blob ends this run.
      if (!slice) throw new Error(`the stored listing of step ${id} is gone`);
      if (slice.length !== end - start) throw new Error(`the stored listing of step ${id} is shorter than it was`);
      return slice.toString("base64");
    });
    parts.push(Buffer.from(page, "base64"));
  }
  await runStep(`${id}-drop`, async () => {
    await (await stash()).del(url);
    return null;
  });
  return JSON.parse(Buffer.concat(parts).toString("utf8")) as T;
}
