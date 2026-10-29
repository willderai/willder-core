/**
 * Splitting a list into pages, kept free of React like `list-query.ts`. A list's
 * page lives in the URL beside its view (`sources.page=2`), so a link reopens
 * the same page; page 1 is the default and is left out of the URL.
 */
import { writeListState, type ListConfig, type ListState } from "./list-query";

/** Rows per page for the lists that page in the browser. */
export const PAGE_SIZE = 10;

/** How many pages `total` rows fill. An empty list still has one (empty) page. */
export function pageCount(total: number, pageSize: number = PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/** `page` moved into 1..count, so a list that shrank shows its last page instead of nothing. */
export function clampPage(page: number, count: number): number {
  return Math.min(Math.max(1, page), Math.max(1, count));
}

/** The rows on `page` (1-based). */
export function pageRows<T>(rows: ReadonlyArray<T>, page: number, pageSize: number = PAGE_SIZE): T[] {
  const start = (page - 1) * pageSize;
  return rows.slice(start, start + pageSize);
}

/** The URL parameter holding a list's page. */
export function pageParam(prefix: string): string {
  return `${prefix}page`;
}

/** The page a query string asks for; anything but a positive whole number reads as page 1. */
export function parsePage(params: URLSearchParams, prefix: string): number {
  const value = params.get(pageParam(prefix));
  return value !== null && /^[1-9]\d{0,5}$/.test(value) ? Number(value) : 1;
}

/** Writes a list's page into a copy of `params`, leaving page 1 out of the URL. */
export function writePage(params: URLSearchParams, prefix: string, page: number): URLSearchParams {
  const next = new URLSearchParams(params);
  if (page <= 1) next.delete(pageParam(prefix));
  else next.set(pageParam(prefix), String(page));
  return next;
}

/**
 * A key that changes whenever a list's search, filters or order change, and only
 * then. A list goes back to page 1 when its key changes.
 */
export function listViewKey<T>(config: ListConfig<T>, state: ListState): string {
  return writeListState(new URLSearchParams(), config, state).toString();
}
