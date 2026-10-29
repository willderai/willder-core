// Report the raw files in Vercel Blob that nothing keeps (lib/blob-storage.ts). A Drive
// blob (`sources/`) is deleted once extracted, and an upload blob (`memory/`) is kept only
// while its `uploaded_files` row is (services/memory/uploads.ts). So every blob under either
// prefix that is not a kept upload and is older than the grace window is an orphan: left by
// a sync or upload from before raw files were deleted or recorded, by a delete that failed,
// or by an org deleted with its records. Nothing will ever read it, and it may hold a file
// its owner since edited, removed, disconnected or had erased. Younger blobs may still be
// waiting for their job, so they are counted but never touched.
//
// Dry run (default, deletes nothing, prints counts per org and prefix):
//   BLOB_READ_WRITE_TOKEN=<token> DATABASE_URL=<url> npx tsx scripts/blob-orphans.ts
// Delete the orphans it reports (get the owner's go-ahead before running on production):
//   ... npx tsx scripts/blob-orphans.ts --delete
//
// Flags: --delete                 delete the orphans (default: dry run)
//        --older-than-hours <n>   grace window in hours (default 24)
//        --list                   also print each orphan's pathname, which carries the
//                                 original filename
import { pathToFileURL } from "node:url";
import { deletePrivateBlob, listPrivateBlobs, type ListedBlob } from "@/lib/blob-storage";
import { keptUploadBlobUrls } from "@/services/memory/uploads";

/** The pathname prefixes raw files are stored under: uploads, then connector syncs. */
export const RAW_FILE_PREFIXES = ["memory/", "sources/"] as const;

export interface BlobOrphanArgs {
  delete: boolean;
  list: boolean;
  graceHours: number;
}

/** Parse the command line, refusing anything it does not recognise. */
export function parseBlobOrphanArgs(argv: readonly string[]): BlobOrphanArgs {
  const args: BlobOrphanArgs = { delete: false, list: false, graceHours: 24 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--delete") args.delete = true;
    else if (arg === "--list") args.list = true;
    else if (arg === "--older-than-hours") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1) throw new Error("--older-than-hours must be a positive integer");
      args.graceHours = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

/**
 * The blobs no kept upload names (`kept`, by URL) that were stored before `now` minus the
 * grace window: no job can still need them.
 */
export function findOrphans(
  blobs: readonly ListedBlob[],
  now: Date,
  graceHours: number,
  kept: ReadonlySet<string>,
): ListedBlob[] {
  const cutoff = now.getTime() - graceHours * 3_600_000;
  return blobs.filter((blob) => blob.uploadedAt.getTime() < cutoff && !kept.has(blob.url));
}

/** Orphan count and bytes per `<prefix><org>`, the second pathname segment being the org id. */
export function summarizeByOrg(orphans: readonly ListedBlob[]): Map<string, { count: number; bytes: number }> {
  const summary = new Map<string, { count: number; bytes: number }>();
  for (const { pathname, size } of orphans) {
    const [prefix, org = "(none)"] = pathname.split("/");
    const key = `${prefix}/${org}`;
    const entry = summary.get(key) ?? { count: 0, bytes: 0 };
    entry.count += 1;
    entry.bytes += size;
    summary.set(key, entry);
  }
  return summary;
}

async function main(): Promise<void> {
  const args = parseBlobOrphanArgs(process.argv.slice(2));
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error("BLOB_READ_WRITE_TOKEN is not set");
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is not set: without it every kept upload would read as an orphan");
  // Read before listing, so an upload recorded after this read is younger than the grace window.
  const kept = await keptUploadBlobUrls();
  const all = (await Promise.all(RAW_FILE_PREFIXES.map(listPrivateBlobs))).flat();
  const orphans = findOrphans(all, new Date(), args.graceHours, kept);

  console.log(`${all.length} raw file blob(s); ${orphans.length} older than ${args.graceHours} h are orphans.`);
  for (const [key, { count, bytes }] of summarizeByOrg(orphans))
    console.log(`  ${key}: ${count} blob(s), ${bytes} bytes`);
  if (args.list) for (const { pathname } of orphans) console.log(`  ${pathname}`);

  if (!args.delete) {
    console.log("Dry run: nothing deleted. Pass --delete to delete the orphans above.");
    return;
  }
  for (const { url } of orphans) await deletePrivateBlob(url);
  console.log(`Deleted ${orphans.length} orphan blob(s).`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
