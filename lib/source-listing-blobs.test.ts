// A connector listing too large for one Inngest step goes through the private blob store
// (lib/inngest/connector-listing-pages.ts). These tests drive that path end to end through
// the real store wrapper (lib/blob-storage.ts) against an in-memory Vercel Blob that answers
// byte ranges as the service does, with runs that finish and runs that die.
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => {
  type Stored = { pathname: string; body: Buffer; uploadedAt: Date };
  const blobs = new Map<string, Stored>();
  let n = 0;
  return {
    blobs,
    /** Range headers each read asked for, and whether the store answered with the range. */
    reads: [] as { range: string | null }[],
    honorRange: true,
    reset() {
      blobs.clear();
      this.reads.length = 0;
      this.honorRange = true;
    },
    pathnames: () => [...blobs.values()].map((b) => b.pathname).sort(),
    async put(pathname: string, body: Buffer, opts: { access: string; addRandomSuffix: boolean }) {
      expect(opts).toMatchObject({ access: "private", addRandomSuffix: true });
      const url = `https://s.blob.vercel-storage.com/${pathname.replace(/\.json$/, "")}-${(n += 1)}.json`;
      blobs.set(url, { pathname, body: Buffer.from(body), uploadedAt: new Date() });
      return { url };
    },
  };
});

vi.mock("@vercel/blob", () => ({
  put: (pathname: string, body: Buffer, opts: { access: string; addRandomSuffix: boolean }) =>
    store.put(pathname, body, opts),
  del: async (url: string) => void store.blobs.delete(url),
  list: async ({ prefix }: { prefix: string }) => ({
    blobs: [...store.blobs.entries()]
      .filter(([, b]) => b.pathname.startsWith(prefix))
      .map(([url, b]) => ({ url, pathname: b.pathname, size: b.body.length, uploadedAt: b.uploadedAt })),
    hasMore: false,
  }),
  get: async (url: string, opts: { access: string; headers?: Record<string, string> }) => {
    expect(opts.access).toBe("private");
    const blob = store.blobs.get(url);
    if (!blob) return null;
    const range = opts.headers?.Range ?? null;
    store.reads.push({ range });
    const match = range && store.honorRange ? /^bytes=(\d+)-(\d+)$/.exec(range) : null;
    if (!match)
      return { statusCode: 200, stream: new Response(new Uint8Array(blob.body)).body, headers: new Headers() };
    const [start, last] = [Number(match[1]), Number(match[2])];
    const headers = new Headers({ "content-range": `bytes ${start}-${last}/${blob.body.length}` });
    return { statusCode: 200, stream: new Response(new Uint8Array(blob.body.subarray(start, last + 1))).body, headers };
  },
}));

/** Source rows, filtered by the `where` the code passes, which each read records. */
const sources = vi.hoisted(() => ({
  rows: [] as { id: string; orgId: string; status: string; meta: unknown }[],
  wheres: [] as unknown[],
  /** Runs while the sources are read, after the blobs were listed. */
  onRead: null as null | (() => Promise<void>),
}));
vi.mock("@/lib/db", () => ({
  db: {
    source: {
      findMany: async ({ where }: { where: { orgId: string; status: { not: string } } }) => {
        sources.wheres.push(where);
        await sources.onRead?.();
        return sources.rows.filter((r) => r.orgId === where.orgId && r.status !== where.status.not);
      },
    },
  },
}));

import { readPrivateBlobRange } from "./blob-storage";
import { EXISTING_FILES_PAGE_BYTES } from "./inngest/connector-existing-files";
import { listInPages } from "./inngest/connector-listing-pages";
import {
  blobListingStash,
  dropIdleListings,
  dropRunListings,
  dropSourceBlobs,
  listingPathname,
} from "./source-listing-blobs";

const ORG = "org-1";
const SRC = "src-1";

/** A large repository's listing, past the step budget, with multi-byte text. */
function bigListing() {
  return {
    items: Array.from({ length: 600 }, (_, i) => ({
      id: `issue-${i}`,
      checksum: `c${i}`,
      text: `Body ${i}: ${"ünïcødé — {x} ".repeat(120)}`,
    })),
    gone: [],
  };
}

/** Steps run in order and their outputs pass through JSON, as Inngest stores them. */
const steps = async <R>(_id: string, fn: () => Promise<R>): Promise<R> => {
  const json = JSON.stringify(await fn());
  return JSON.parse(json ?? "null") as R;
};

/** A run that dies at step `diesAt`: the platform killed it and nothing after runs. */
class Died extends Error {}
const dyingAt =
  (diesAt: string) =>
  async <R>(id: string, fn: () => Promise<R>): Promise<R> => {
    if (id === diesAt) throw new Died(id);
    return steps(id, fn);
  };

const sync = (runId: string, run = steps, list = async () => bigListing()) =>
  listInPages(run, "list-items", listingPathname(ORG, SRC, runId, "items"), list, async () =>
    blobListingStash(ORG, SRC, runId),
  );

beforeEach(() => {
  store.reset();
  sources.rows = [];
  sources.wheres = [];
  sources.onRead = null;
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "blob_test_token");
});

describe("the stash path, end to end", () => {
  it("a run that finishes reads its listing back in byte ranges and leaves nothing stored", async () => {
    const listing = bigListing();
    const bytes = Buffer.byteLength(JSON.stringify(listing));
    expect(bytes).toBeGreaterThan(EXISTING_FILES_PAGE_BYTES);

    expect(await sync("run-a")).toEqual(listing);

    expect(store.reads.length).toBeGreaterThan(1);
    // every read asked for one bounded range, and no read asked for the whole blob
    for (const { range } of store.reads) expect(range).toMatch(/^bytes=\d+-\d+$/);
    const spans = store.reads.map(({ range }) => range!.slice(6).split("-").map(Number) as [number, number]);
    expect(spans.reduce((sum, [a, b]) => sum + b - a + 1, 0)).toBe(bytes);
    expect(store.blobs.size).toBe(0);
  });

  it("stores the listing under the source's prefix and the run's own", async () => {
    let seen: string[] = [];
    await sync("run-a", async (id, fn) => {
      if (id === "list-items-page-0") seen = store.pathnames();
      return steps(id, fn);
    });
    expect(seen).toEqual([`sources/${ORG}/${SRC}/listing-run-a/items.json`]);
  });

  it("a run that dies mid-listing leaves its listing; the failure report deletes it and no other run's", async () => {
    await expect(sync("run-dead", dyingAt("list-items-page-1"))).rejects.toThrow(Died);
    expect(store.pathnames()).toEqual([`sources/${ORG}/${SRC}/listing-run-dead/items.json`]);
    // the next run is mid-listing when the dead one is reported
    await expect(sync("run-live", dyingAt("list-items-page-0"))).rejects.toThrow(Died);

    expect(await dropRunListings({ orgId: ORG, sourceId: SRC }, "run-dead")).toBe(1);

    expect(store.pathnames()).toEqual([`sources/${ORG}/${SRC}/listing-run-live/items.json`]);
  });

  it("a listing step retried after its store succeeded: the finished run's drop deletes both copies", async () => {
    let attempt = 0;
    const listing = await sync("run-r", async (id, fn) => {
      if (id === "list-items" && attempt++ === 0) await fn(); // stored, then the attempt failed
      return steps(id, fn);
    });
    expect(listing).toEqual(bigListing());
    expect(store.blobs.size).toBe(0);
  });

  it("a run dies after reading every page but before its drop step: the failure report deletes it", async () => {
    await expect(sync("run-d", dyingAt("list-items-drop"))).rejects.toThrow(Died);
    expect(store.blobs.size).toBe(1);
    await dropRunListings({ orgId: ORG, sourceId: SRC }, "run-d");
    expect(store.blobs.size).toBe(0);
  });

  it("without Blob storage configured, the cleanups touch nothing", async () => {
    await expect(sync("run-dead", dyingAt("list-items-page-1"))).rejects.toThrow(Died);
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    expect(await dropRunListings({ orgId: ORG, sourceId: SRC }, "run-dead")).toBe(0);
    expect(await dropSourceBlobs(ORG, SRC)).toBe(0);
    expect(await dropIdleListings(ORG)).toBe(0);
    expect(store.blobs.size).toBe(1);
  });
});

describe("cleanups beyond the run", () => {
  it("source removal deletes everything under the source's prefix, Drive file blobs too, and nothing of another source", async () => {
    await expect(sync("run-dead", dyingAt("list-items-page-1"))).rejects.toThrow(Died);
    await store.put(`sources/${ORG}/${SRC}/file-1-notes.pdf`, Buffer.from("raw"), {
      access: "private",
      addRandomSuffix: true,
    });
    await store.put(`sources/${ORG}/src-2/listing-run-x/items.json`, Buffer.from("x"), {
      access: "private",
      addRandomSuffix: true,
    });
    // a source id that starts with this one's is not under its prefix
    await store.put(`sources/${ORG}/${SRC}0/listing-run-y/items.json`, Buffer.from("y"), {
      access: "private",
      addRandomSuffix: true,
    });

    expect(await dropSourceBlobs(ORG, SRC)).toBe(2);

    expect(store.pathnames()).toEqual([
      `sources/${ORG}/${SRC}0/listing-run-y/items.json`,
      `sources/${ORG}/src-2/listing-run-x/items.json`,
    ]);
  });

  it("erasure deletes every listing in the org but a syncing source's current run's, and no Drive file blob", async () => {
    await expect(sync("run-dead", dyingAt("list-items-page-1"))).rejects.toThrow(Died);
    await expect(sync("run-live", dyingAt("list-items-page-0"))).rejects.toThrow(Died);
    await store.put(`sources/${ORG}/src-2/listing-run-x/items.json`, Buffer.from("x"), {
      access: "private",
      addRandomSuffix: true,
    });
    await store.put(`sources/${ORG}/src-2/file-1-notes.pdf`, Buffer.from("raw"), {
      access: "private",
      addRandomSuffix: true,
    });
    await store.put(`sources/org-2/src-9/listing-run-z/items.json`, Buffer.from("z"), {
      access: "private",
      addRandomSuffix: true,
    });
    sources.rows = [
      { id: SRC, orgId: ORG, status: "syncing", meta: { syncRunId: "run-live" } },
      // another org's source naming the same run id keeps nothing here
      { id: "src-2", orgId: "org-2", status: "syncing", meta: { syncRunId: "run-x" } },
    ];

    expect(await dropIdleListings(ORG)).toBe(2);
    expect(sources.wheres).toEqual([{ orgId: ORG, status: { not: "disconnected" } }]);

    expect(store.pathnames()).toEqual([
      `sources/${ORG}/${SRC}/listing-run-live/items.json`,
      `sources/${ORG}/src-2/file-1-notes.pdf`,
      `sources/org-2/src-9/listing-run-z/items.json`,
    ]);
  });

  it("erasure keeps the listing of a run its reconnected source still names, and none of a disconnected one", async () => {
    await expect(sync("run-live", dyingAt("list-items-page-0"))).rejects.toThrow(Died);
    await store.put(`sources/${ORG}/src-2/listing-run-x/items.json`, Buffer.from("x"), {
      access: "private",
      addRandomSuffix: true,
    });
    sources.rows = [
      { id: SRC, orgId: ORG, status: "active", meta: { syncRunId: "run-live" } },
      { id: "src-2", orgId: ORG, status: "disconnected", meta: { syncRunId: "run-x" } },
    ];
    expect(await dropIdleListings(ORG)).toBe(1);
    expect(store.pathnames()).toEqual([`sources/${ORG}/${SRC}/listing-run-live/items.json`]);
  });

  it("erasure never deletes a listing stored after it listed the blobs, whatever the clocks say", async () => {
    await store.put(`sources/${ORG}/${SRC}/listing-run-dead/items.json`, Buffer.from("x"), {
      access: "private",
      addRandomSuffix: true,
    });
    // the Blob service's clock runs ahead of the app's: no timestamp decides anything
    for (const blob of store.blobs.values()) blob.uploadedAt = new Date(Date.now() + 60_000);
    // a run stores its listing while the sources are read, before the row names it
    sources.onRead = async () => {
      await store.put(`sources/${ORG}/${SRC}/listing-run-new/items.json`, Buffer.from("y"), {
        access: "private",
        addRandomSuffix: true,
      });
    };
    expect(await dropIdleListings(ORG)).toBe(1);
    expect(store.pathnames()).toEqual([`sources/${ORG}/${SRC}/listing-run-new/items.json`]);
  });
});

describe("readPrivateBlobRange", () => {
  const body = Buffer.from("0123456789abcdef");
  let url = "";
  beforeEach(async () => {
    ({ url } = await store.put("sources/o/s/listing-r/items.json", body, { access: "private", addRandomSuffix: true }));
  });

  it("asks for the byte range and returns that slice", async () => {
    expect((await readPrivateBlobRange(url, 3, 9))!.toString()).toBe("345678");
    expect(store.reads).toEqual([{ range: "bytes=3-8" }]);
  });

  it("a store that ignores the range and sends the whole blob still yields only the slice", async () => {
    store.honorRange = false;
    expect((await readPrivateBlobRange(url, 10, 16))!.toString()).toBe("abcdef");
    expect((await readPrivateBlobRange(url, 0, 4))!.toString()).toBe("0123");
  });

  it("throws rather than return a short slice past the blob's end, ranged or not", async () => {
    await expect(readPrivateBlobRange(url, 10, 20)).rejects.toThrow(RangeError);
    store.honorRange = false;
    await expect(readPrivateBlobRange(url, 10, 20)).rejects.toThrow(RangeError);
  });

  it("returns null for a blob that is gone, and refuses an empty or negative range", async () => {
    expect(await readPrivateBlobRange(`${url}-gone`, 0, 4)).toBeNull();
    await expect(readPrivateBlobRange(url, 4, 4)).rejects.toThrow(RangeError);
    await expect(readPrivateBlobRange(url, -1, 4)).rejects.toThrow(RangeError);
  });
});
