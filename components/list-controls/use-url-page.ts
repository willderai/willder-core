"use client";

/**
 * The page a server-paged list shows, kept in the URL (`usage.page=3`), so a
 * link, reload and back reopen the same page. The server owns the rows; this
 * hook owns only the page number.
 *
 * The rule: a new search, filter or order starts again at page 1. `viewKey`
 * changes exactly when one of those does; the old page is dropped from the URL
 * and page 1 shows at once, before the URL catches up.
 */
import { useEffect, useState } from "react";
import { useUrlParam } from "@/components/memory/store-list-tab";
import type { ListPage } from "./use-list-page";

function readPage(value: string | null, maxPage: number): number {
  const page = Number(value ?? "1");
  return Number.isInteger(page) && page >= 1 && page <= maxPage ? page : 1;
}

/**
 * `param` is the page's query parameter (`page`, `members.page`); `maxPage` is the
 * highest page the list's route accepts (`lib/page-limits.ts`). A value that is not a
 * whole number from 1 to `maxPage` reads as page 1, so a hand-edited link never asks
 * for a page the route refuses.
 */
export function useUrlPage(param: string, viewKey: string, maxPage: number): [number, (page: number) => void] {
  const [pageParam, setPageParam] = useUrlParam(param, "replace");
  // A changed view shows page 1 at once and drops the old page from the URL; once
  // the URL no longer holds it, the URL is the page's source again.
  const [view, setView] = useState({ key: viewKey, resetting: false });
  if (view.key !== viewKey) setView({ key: viewKey, resetting: true });
  else if (view.resetting && pageParam === null) setView({ key: viewKey, resetting: false });
  const resetting = view.key !== viewKey || view.resetting;

  useEffect(() => {
    if (resetting) setPageParam(null);
  }, [resetting, setPageParam]);

  const page = resetting ? 1 : readPage(pageParam, maxPage);
  const setPage = (next: number) => setPageParam(next <= 1 ? null : String(next));
  return [page, setPage];
}

/**
 * One server page in the shape `ListPagination` draws: `total` rows across every
 * page, `pageSize` per page, and the page the server answered.
 */
export function serverListPage<T>(
  { rows, page, pageSize, total }: { rows: T[]; page: number; pageSize: number; total: number },
  setPage: (page: number) => void,
): ListPage<T> {
  return { rows, page, pageSize, total, pageCount: Math.max(1, Math.ceil(total / pageSize)), setPage };
}
