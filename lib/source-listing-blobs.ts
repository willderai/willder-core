// The blobs a connector sync leaves under its source's prefix, and who deletes them.
//
// A sync run stores a listing too large for one Inngest step as a private blob at
// `sources/<org>/<source>/listing-<run id>/<kind>.json` (lib/inngest/connector-listing-pages.ts)
// and deletes it once read. That listing is the source's text: Slack messages, GitHub
// issue and pull request bodies. A run that dies between storing and deleting it
// leaves it behind, so it is also deleted:
//
//  - when Inngest reports the run failed (`dropRunListings`, from sourceSync's
//    `onFailure`): everything under that run's own prefix, which no other run reads;
//  - when the source is removed for good (`dropSourceBlobs`): everything under the
//    source's prefix, its Drive file blobs too;
//  - when a person is erased (`dropIdleListings`): every listing in the org but the
//    one a source's current run is reading, since a listing can hold the person's
//    words and is not searched for them. That run deletes its own when it ends, and
//    the suppression list already keeps it from writing the person back.
//
// A run's own drop step also deletes everything under its prefix, so a listing step
// retried after its store succeeded leaves nothing behind. Org deletion sweeps all of
// `sources/<org>/`, and scripts/blob-orphans.ts anything older than a day.
//
// A deployment without Blob storage stores no listing (the listing step fails
// instead), so each of these is then a no-op.
import { deletePrivateBlob, listPrivateBlobs, putPrivateBlob, readPrivateBlobRange } from "@/lib/blob-storage";
import { db } from "@/lib/db";
import type { ListingStash } from "@/lib/inngest/connector-listing-pages";

/** Every blob a source's syncs store lives under this prefix. */
export function sourceBlobPrefix(orgId: string, sourceId: string): string {
  return `sources/${orgId}/${sourceId}/`;
}

/** Every listing sync run `runId` of the source stores lives under this prefix. */
export function runListingPrefix(orgId: string, sourceId: string, runId: string): string {
  return `${sourceBlobPrefix(orgId, sourceId)}listing-${encodeURIComponent(runId)}/`;
}

/** Where run `runId` stores a listing too large for one step. The stored pathname gets a random suffix. */
export function listingPathname(orgId: string, sourceId: string, runId: string, kind: "items" | "files"): string {
  return `${runListingPrefix(orgId, sourceId, runId)}${kind}.json`;
}

/**
 * The private blob store as a listing step uses it. Dropping a read listing also
 * deletes anything else under the run's prefix: a copy an earlier attempt of the
 * listing step stored before it failed.
 */
export function blobListingStash(orgId: string, sourceId: string, runId: string): ListingStash {
  return {
    put: putPrivateBlob,
    read: readPrivateBlobRange,
    del: async (url) => {
      await deletePrivateBlob(url);
      await dropRunListings({ orgId, sourceId }, runId);
    },
  };
}

/** `listing-<run id>` of `sources/<org>/<source>/listing-<run id>/...`, or null for another blob (a Drive file). */
function listingRunOf(pathname: string): { sourceId: string; runId: string } | null {
  const match = /^sources\/[^/]+\/([^/]+)\/listing-([^/]+)\//.exec(pathname);
  if (!match) return null;
  try {
    return { sourceId: match[1]!, runId: decodeURIComponent(match[2]!) };
  } catch {
    return { sourceId: match[1]!, runId: match[2]! };
  }
}

/** Delete the blobs under `prefix` that `drop` picks. @returns how many were deleted. */
async function deleteBlobs(
  prefix: string,
  drop: (blob: { pathname: string }) => boolean = () => true,
): Promise<number> {
  if (!blobStorageConfigured()) return 0;
  return deleteListed(await listPrivateBlobs(prefix), drop);
}

async function deleteListed<B extends { url: string; pathname: string }>(
  blobs: B[],
  drop: (blob: B) => boolean,
): Promise<number> {
  let deleted = 0;
  for (const blob of blobs) {
    if (!drop(blob)) continue;
    await deletePrivateBlob(blob.url);
    deleted++;
  }
  return deleted;
}

/** Delete every listing sync run `runId` of the source stored. @returns how many blobs were deleted. */
export function dropRunListings(input: { orgId: string; sourceId: string }, runId: string): Promise<number> {
  return deleteBlobs(runListingPrefix(input.orgId, input.sourceId, runId));
}

/** Delete everything a removed source's syncs stored. @returns how many blobs were deleted. */
export function dropSourceBlobs(orgId: string, sourceId: string): Promise<number> {
  return deleteBlobs(sourceBlobPrefix(orgId, sourceId));
}

/**
 * Delete every listing in the org except one a source's current run stored: the run
 * its `meta.syncRunId` names. A run stamps that id (`load-source`,
 * lib/inngest/connector-sync.ts) before it stores a listing, and its terminal write
 * clears it. A reconnect keeps it (app/api/sources/route.ts), so a run that is
 * mid-page when its source is reconnected keeps its listing too, though the source
 * no longer reads "syncing".
 *
 * The blobs are listed before the sources are read, so every blob considered was
 * stored by a run that had already stamped its id: one still running is named by
 * its source here. A blob stored after the listing is not considered at all. No
 * timestamp is compared, so the app's clock and the Blob service's need not agree.
 * @returns how many blobs were deleted.
 */
export async function dropIdleListings(orgId: string): Promise<number> {
  if (!blobStorageConfigured()) return 0;
  const blobs = await listPrivateBlobs(`sources/${orgId}/`);
  const named = await db.source.findMany({
    where: { orgId, status: { not: "disconnected" } },
    select: { id: true, meta: true },
  });
  const current = new Set(
    named.flatMap((s) => {
      const runId = syncRunIdOf(s.meta);
      return typeof runId === "string" ? [`${s.id}/${runId}`] : [];
    }),
  );
  return deleteListed(blobs, ({ pathname }) => {
    const run = listingRunOf(pathname);
    return run !== null && !current.has(`${run.sourceId}/${run.runId}`);
  });
}

/** Whether this deployment stores files in Vercel Blob (the upload route asks the same). */
function blobStorageConfigured(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

function syncRunIdOf(meta: unknown): unknown {
  return typeof meta === "object" && meta !== null && !Array.isArray(meta)
    ? (meta as Record<string, unknown>).syncRunId
    : undefined;
}
