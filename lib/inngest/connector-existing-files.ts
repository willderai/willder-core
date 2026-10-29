// The rows a connector sync diffs against, read in bounded steps.
//
// Inngest persists every step's return value and refuses one over its size limit
// ("step output size is greater than the limit"). A source with many synced files,
// or Drive files each holding many chunk ids, made one step returning every row
// overflow, so every run of that source failed. The rows are therefore read a page
// at a time, each page its own step whose output stays under EXISTING_FILES_PAGE_BYTES,
// and joined in the job. The rows the run diffs against are the same as before.
import { db } from "@/lib/db";

/** Serialized size one page of rows may reach; far under Inngest's step output limit. */
export const EXISTING_FILES_PAGE_BYTES = 512 * 1024;
const PAGE_ROWS = 200;

export interface ExistingFilesPage<T> {
  rows: T[];
  /** `externalFileId` the next page continues after; absent on the last page. */
  next?: string;
}

/** Keep leading rows while their serialized size fits the budget (always at least one). */
export function boundedPage<T extends { externalFileId: string }>(
  rows: T[],
  hasMore: boolean,
  budget = EXISTING_FILES_PAGE_BYTES,
): ExistingFilesPage<T> {
  let bytes = 0;
  const kept: T[] = [];
  for (const row of rows) {
    bytes += JSON.stringify(row).length;
    if (kept.length > 0 && bytes > budget) break;
    kept.push(row);
  }
  const more = hasMore || kept.length < rows.length;
  return more ? { rows: kept, next: kept[kept.length - 1].externalFileId } : { rows: kept };
}

type RunStep = <R>(id: string, fn: () => Promise<R>) => Promise<R>;

/**
 * Read a source's synced files page by page, one step per page. The first page keeps
 * the id `load-existing-files`; a run replaying that step's older stored output (the
 * whole list as an array) reads it as the only page.
 */
export async function loadExistingFiles<T extends { externalFileId: string }>(
  runStep: RunStep,
  sourceId: string,
  shape: (row: Awaited<ReturnType<typeof readRows>>[number]) => T,
): Promise<T[]> {
  const all: T[] = [];
  let after: string | undefined;
  for (let n = 0; ; n++) {
    const page = await runStep<ExistingFilesPage<T> | T[]>(
      n === 0 ? "load-existing-files" : `load-existing-files-${n}`,
      async () => {
        const rows = await readRows(sourceId, after);
        return boundedPage(rows.slice(0, PAGE_ROWS).map(shape), rows.length > PAGE_ROWS);
      },
    );
    if (Array.isArray(page)) return page;
    all.push(...page.rows);
    if (page.next === undefined) return all;
    after = page.next;
  }
}

function readRows(sourceId: string, after: string | undefined) {
  return db.sourceFile.findMany({
    where: { sourceId, ...(after === undefined ? {} : { externalFileId: { gt: after } }) },
    orderBy: { externalFileId: "asc" },
    take: PAGE_ROWS + 1,
  });
}
