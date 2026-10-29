"use client";

/**
 * Holds which page of a list is showing, seeded from the URL and written back
 * to it, beside the view `useListState` keeps there.
 *
 * The rules: a new search, filter or order starts again at page 1; a list that
 * shrinks under the current page (a row disconnected, a sync that removed rows)
 * shows its last page instead of an empty one.
 */
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { clampPage, pageCount, pageRows, parsePage, writePage, PAGE_SIZE } from "./list-page";

export type ListPage<T> = {
  /** The rows on the page showing. */
  rows: T[];
  /** The page showing, 1-based, always within 1..pageCount. */
  page: number;
  pageCount: number;
  /** Every row across all pages. */
  total: number;
  pageSize: number;
  setPage: (page: number) => void;
};

function replacePageInUrl(prefix: string, page: number) {
  const next = writePage(new URLSearchParams(window.location.search), prefix, page).toString();
  const { pathname, search, hash } = window.location;
  if (`?${next}` === search || (next === "" && search === "")) return;
  // Next.js syncs useSearchParams with replaceState without a server round trip.
  window.history.replaceState(window.history.state, "", `${pathname}${next ? `?${next}` : ""}${hash}`);
}

/**
 * The page of `rows` to show. `prefix` is the list's `paramPrefix`, so two lists
 * on one page keep separate pages, and `viewKey` is `listViewKey(config, state)`
 * for a list with search and filters (or any string that changes when the rows'
 * selection or order does).
 */
export function useListPage<T>(
  rows: ReadonlyArray<T>,
  { prefix, viewKey, pageSize = PAGE_SIZE }: { prefix: string; viewKey: string; pageSize?: number },
): ListPage<T> {
  // Null outside the App Router (an isolated render): the list starts on page 1.
  const params: URLSearchParams | null = useSearchParams();
  const [paging, setPaging] = useState(() => ({
    viewKey,
    page: parsePage(new URLSearchParams(params?.toString() ?? ""), prefix),
  }));
  // A changed view resets the stored page, not just the page shown: deriving page 1
  // while keeping the old page would bring that page back when the view returns
  // (page 3, search, clear the search, and the list would reopen on page 3).
  let requested = paging.page;
  if (paging.viewKey !== viewKey) {
    setPaging({ viewKey, page: 1 });
    requested = 1;
  }
  const count = pageCount(rows.length, pageSize);
  const page = clampPage(requested, count);

  // The URL keeps the page asked for, not the clamped one: before the rows load the
  // list has one page, and clamping then would drop the page a link asked for.
  useEffect(() => {
    replacePageInUrl(prefix, requested);
  }, [prefix, requested]);

  return {
    rows: pageRows(rows, page, pageSize),
    page,
    pageCount: count,
    total: rows.length,
    pageSize,
    setPage: (next) => setPaging({ viewKey, page: clampPage(next, count) }),
  };
}

/**
 * The page of a list the server pages: the page number in the URL, kept like
 * `useListPage`'s, and the `ListPage` the pagination control reads, built from the
 * page of rows and the total the server returned. A new `viewKey` starts again at
 * page 1. `rows` and `total` describe the page asked for; pass empty and 0 while it loads.
 * `inUrl: false` keeps the page out of the URL, as `useListState`'s option does.
 */
export function useServerListPage<T>({
  prefix,
  viewKey,
  pageSize,
  inUrl = true,
}: {
  prefix: string;
  viewKey: string;
  pageSize: number;
  inUrl?: boolean;
}): { page: number; paging: (rows: T[], total: number) => ListPage<T> } {
  const urlParams: URLSearchParams | null = useSearchParams();
  const params = inUrl ? urlParams : null;
  const [paging, setPaging] = useState(() => ({
    viewKey,
    page: parsePage(new URLSearchParams(params?.toString() ?? ""), prefix),
  }));
  if (paging.viewKey !== viewKey) setPaging({ viewKey, page: 1 });
  const page = paging.viewKey === viewKey ? paging.page : 1;

  useEffect(() => {
    if (inUrl) replacePageInUrl(prefix, page);
  }, [prefix, page, inUrl]);

  return {
    page,
    paging: (rows, total) => {
      const count = pageCount(total, pageSize);
      return {
        rows,
        page,
        pageCount: count,
        total,
        pageSize,
        setPage: (next) => setPaging({ viewKey, page: clampPage(next, count) }),
      };
    },
  };
}
