// A source with many synced files must not make one Inngest step return them all:
// Inngest refuses a step output over its size limit and the whole sync run fails.
import { beforeEach, describe, expect, it, vi } from "vitest";

const rowsStore: Array<Record<string, unknown>> = [];
vi.mock("@/lib/db", () => ({
  db: {
    sourceFile: {
      findMany: vi.fn(async ({ where, take }: { where: { externalFileId?: { gt: string } }; take: number }) =>
        rowsStore
          .filter((r) => where.externalFileId === undefined || (r.externalFileId as string) > where.externalFileId.gt)
          .sort((a, b) => (a.externalFileId as string).localeCompare(b.externalFileId as string))
          .slice(0, take),
      ),
    },
  },
}));

import { EXISTING_FILES_PAGE_BYTES, boundedPage, loadExistingFiles } from "./connector-existing-files";

const INNGEST_STEP_LIMIT = 4 * 1024 * 1024;

beforeEach(() => {
  rowsStore.length = 0;
  // A Drive source far past the limit in total: 3000 files, each with 300 chunk ids.
  for (let i = 0; i < 3000; i++) {
    rowsStore.push({
      externalFileId: `file-${String(i).padStart(5, "0")}`,
      checksum: "c".repeat(64),
      episodeId: null,
      episodeIds: Array.from({ length: 300 }, (_, k) => `ep-${i}-${k}-${"x".repeat(20)}`),
      chunkIds: Array.from({ length: 300 }, (_, k) => `ck-${i}-${k}-${"y".repeat(20)}`),
      episodeScopePath: "org/x",
    });
  }
});

describe("loadExistingFiles", () => {
  it("returns every row while no step output exceeds the page budget", async () => {
    const outputs: number[] = [];
    const run = async <R>(_id: string, fn: () => Promise<R>): Promise<R> => {
      const out = await fn();
      outputs.push(JSON.stringify(out).length);
      return out;
    };
    const shape = (f: Record<string, unknown>) => ({
      externalFileId: f.externalFileId as string,
      chunkIds: f.chunkIds as string[],
      episodeIds: f.episodeIds as string[],
    });
    const all = await loadExistingFiles(run, "src", shape as never);
    expect(all.map((f) => f.externalFileId)).toEqual(rowsStore.map((r) => r.externalFileId));
    expect(outputs.length).toBeGreaterThan(1);
    expect(Math.max(...outputs)).toBeLessThan(INNGEST_STEP_LIMIT);
    // one row may exceed the budget only by itself
    expect(Math.max(...outputs)).toBeLessThanOrEqual(EXISTING_FILES_PAGE_BYTES + 40_000);
  });

  it("names the first step as before and reads an older stored array as the whole list", async () => {
    const ids: string[] = [];
    const run = async <R>(id: string, _fn: () => Promise<R>): Promise<R> => {
      ids.push(id);
      return [{ externalFileId: "legacy" }] as R;
    };
    expect(await loadExistingFiles(run, "src", ((f: never) => f) as never)).toEqual([{ externalFileId: "legacy" }]);
    expect(ids).toEqual(["load-existing-files"]);
  });
});

describe("boundedPage", () => {
  it("always keeps one row and continues after the last kept", () => {
    const rows = [{ externalFileId: "a" }, { externalFileId: "b" }];
    expect(boundedPage(rows, false, 1)).toEqual({ rows: [{ externalFileId: "a" }], next: "a" });
    expect(boundedPage(rows, false)).toEqual({ rows });
  });
});
