// A large source's listing must not make one Inngest step return it all: Inngest
// refuses a step output over its size limit and the whole sync run fails.
import { describe, expect, it, vi } from "vitest";

import { EXISTING_FILES_PAGE_BYTES } from "./connector-existing-files";
import { listInPages, type ListingStash } from "./connector-listing-pages";

const INNGEST_STEP_LIMIT = 4 * 1024 * 1024;

/** An in-memory stand-in for the private blob store. */
function memoryStash() {
  const blobs = new Map<string, Buffer>();
  const stash: ListingStash = {
    put: vi.fn(async (pathname: string, body: Buffer) => {
      const url = `blob://${pathname}#${blobs.size}`;
      blobs.set(url, body);
      return { url };
    }),
    read: vi.fn(async (url: string, start: number, end: number) => {
      const body = blobs.get(url);
      return body ? Buffer.from(body.subarray(start, end)) : null;
    }),
    del: vi.fn(async (url: string) => {
      blobs.delete(url);
    }),
  };
  return { blobs, stash, load: async () => stash };
}

/** A step runner that records each step's id and serialized output size, as Inngest stores it. */
function recordingSteps() {
  const steps: { id: string; bytes: number }[] = [];
  const run = async <R>(id: string, fn: () => Promise<R>): Promise<R> => {
    const out = await fn();
    const json = JSON.stringify(out) ?? "";
    steps.push({ id, bytes: Buffer.byteLength(json, "utf8") });
    return JSON.parse(json === "" ? "null" : json) as R;
  };
  return { steps, run };
}

/** A large repository's listing: 2000 items with long bodies, well past the step limit. */
function bigListing() {
  return {
    items: Array.from({ length: 2000 }, (_, i) => ({
      id: `issue-${i}`,
      checksum: "c".repeat(64),
      heading: `Issue ${i}`,
      // multi-byte text, so a page boundary can fall inside a character
      text: `Body ${i}: ${'ünïcødé — {braces} "quotes" '.repeat(120)}`,
    })),
    gone: Array.from({ length: 500 }, (_, i) => `gone-${i}`),
    cursor: { connection: "abc", value: { issues: { page: 3 } } },
  };
}

describe("listInPages", () => {
  it("returns the whole listing while no step output exceeds the page budget", async () => {
    const listing = bigListing();
    expect(Buffer.byteLength(JSON.stringify(listing))).toBeGreaterThan(INNGEST_STEP_LIMIT);
    const { steps, run } = recordingSteps();
    const { blobs, stash, load } = memoryStash();

    const got = await listInPages(run, "list-items", "sources/o/s/listing-items.json", async () => listing, load);

    expect(got).toEqual(listing);
    expect(steps[0]!.id).toBe("list-items");
    expect(steps.at(-1)!.id).toBe("list-items-drop");
    expect(steps.filter((s) => s.id.startsWith("list-items-page-")).length).toBeGreaterThan(1);
    expect(Math.max(...steps.map((s) => s.bytes))).toBeLessThanOrEqual(EXISTING_FILES_PAGE_BYTES);
    expect(stash.put).toHaveBeenCalledOnce();
    expect(vi.mocked(stash.put).mock.calls[0]![0]).toBe("sources/o/s/listing-items.json");
    // the stored copy is deleted once read
    expect(blobs.size).toBe(0);
  });

  it("reads each page as its own byte range, so the pages together read the listing once", async () => {
    const listing = bigListing();
    const bytes = Buffer.byteLength(JSON.stringify(listing));
    const { run } = recordingSteps();
    const { stash, load } = memoryStash();

    await listInPages(run, "list-items", "p", async () => listing, load);

    const ranges = vi.mocked(stash.read).mock.calls.map(([, start, end]) => [start, end] as const);
    const pageBytes = Math.floor((EXISTING_FILES_PAGE_BYTES - 8) / 4) * 3;
    expect(ranges[0]![0]).toBe(0);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i]![0]).toBe(ranges[i - 1]![1]);
    expect(ranges.at(-1)![1]).toBe(bytes);
    for (const [start, end] of ranges) expect(end - start).toBeLessThanOrEqual(pageBytes);
    expect(ranges.reduce((sum, [start, end]) => sum + end - start, 0)).toBe(bytes);
  });

  it("fails a page whose stored listing reads back short, rather than joining a broken listing", async () => {
    const { run } = recordingSteps();
    const { stash, load } = memoryStash();
    const read = stash.read;
    stash.read = async (url, start, end) => (await read(url, start, end))?.subarray(1) ?? null;
    await expect(listInPages(run, "list-items", "p", async () => bigListing(), load)).rejects.toThrow(/shorter/);
  });

  it("returns a listing that fits from the one step, as before, storing nothing", async () => {
    const { steps, run } = recordingSteps();
    const { stash, load } = memoryStash();
    const small = [
      { id: "f1", name: "a.pdf" },
      { id: "f2", name: "b.pdf" },
    ];
    expect(await listInPages(run, "list-files", "p", async () => small, load)).toEqual(small);
    expect(steps.map((s) => s.id)).toEqual(["list-files"]);
    expect(stash.put).not.toHaveBeenCalled();
  });

  it("reads an older stored output of the step, the whole listing, as it is", async () => {
    const ids: string[] = [];
    const legacy = { items: [{ id: "x", text: "t", checksum: "c" }] };
    const run = async <R>(id: string, _fn: () => Promise<R>): Promise<R> => {
      ids.push(id);
      return legacy as R;
    };
    const list = vi.fn();
    expect(await listInPages(run, "list-items", "p", list, memoryStash().load)).toEqual(legacy);
    expect(ids).toEqual(["list-items"]);
    expect(list).not.toHaveBeenCalled();
  });

  it("replays memoized pages without listing again", async () => {
    const listing = bigListing();
    const memo = new Map<string, string>();
    const run = async <R>(id: string, fn: () => Promise<R>): Promise<R> => {
      if (!memo.has(id)) memo.set(id, JSON.stringify(await fn()));
      return JSON.parse(memo.get(id)!) as R;
    };
    const list = vi.fn(async () => listing);
    const { load } = memoryStash();
    expect(await listInPages(run, "list-items", "p", list, load)).toEqual(listing);
    // a replay of the run reads every step's stored output, after the blob is gone
    expect(await listInPages(run, "list-items", "p", list, load)).toEqual(listing);
    expect(list).toHaveBeenCalledOnce();
  });

  it("fails the run when the stored listing is gone before its pages are read", async () => {
    const { run } = recordingSteps();
    const { blobs, stash } = memoryStash();
    const put = stash.put;
    stash.put = async (pathname, body) => {
      const stored = await put(pathname, body);
      blobs.clear();
      return stored;
    };
    await expect(
      listInPages(
        run,
        "list-files",
        "p",
        async () => bigListing(),
        async () => stash,
      ),
    ).rejects.toThrow(/gone/);
  });
});
