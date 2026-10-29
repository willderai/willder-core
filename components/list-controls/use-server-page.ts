"use client";

/**
 * Fetches one page of a server-paged list (the Access page's Grants and Tokens, the
 * Settings roles and aliases) and keeps its page number in the URL (`grants.page=3`),
 * so a link, reload and back reopen it.
 *
 * The rules: a new search, filter or order starts again at page 1; typing waits a
 * moment before it asks the server; an answer to an older request never replaces
 * the current one; and while the current page loads, or after it failed, the caller
 * is told so: the previous page stays available to show, marked as stale, never
 * passed off as the answer to the current request.
 */
import { useEffect, useMemo, useState } from "react";
import { useUrlPage } from "@/components/list-controls/use-url-page";
import type { ListState } from "@/components/list-controls/list-query";
import { accessListParams, type AccessListQuery, type AccessListSpec } from "@/lib/access-lists";
import { listSearchText } from "@/lib/list-search";

/**
 * One page as a paged list route answers it, with the rows under their own key, and
 * any other fields the route answers alongside them (`E`).
 */
export type ServerPage<R, E extends object = object> = E & {
  rows: R[];
  /** Rows matching the search and filters. */
  total: number;
  /** Rows before any narrowing. */
  count: number;
  page: number;
  pageSize: number;
};

/**
 * The request for page `page` of the list route `path`, in the view the toolbar holds,
 * with any parameters the screen always sends (`kind=connector`) in `fixed`.
 */
export function listPageUrl(path: string, view: ListState, page: number, fixed: Record<string, string> = {}): string {
  const query = {
    search: listSearchText(view.query),
    sort: view.sort,
    order: view.direction,
    filters: { ...view.filters, ...fixed },
    page,
  } as AccessListQuery<AccessListSpec>;
  return `${path}?${accessListParams(query)}`;
}

/** How long a typed search waits before it is sent, matching the Audit tab. */
const SEARCH_DEBOUNCE_MS = 250;

export type ServerPageState<R, E extends object = object> =
  /**
   * `previous` is the last page shown, kept on screen until this one arrives; null on
   * first load. `reloading` is true when `revision` asked for this load (after a write),
   * so what `previous` says about the whole list, its count or a status, may no longer
   * hold; a page turn or a new search changes only which rows show.
   */
  | { status: "loading"; previous: ServerPage<R, E> | null; reloading: boolean }
  | { status: "forbidden" }
  | { status: "failed" }
  | { status: "ready"; data: ServerPage<R, E> };

/**
 * The page a list draws from `state`. `fresh` is the server's answer to the current
 * request, or null until it arrives; `shown` is that answer or, while the current one
 * loads, the page shown before it (null on a first load, a refusal or a failure).
 *
 * The rule for a list: rows may come from `shown`, dimmed and marked busy while `fresh`
 * is null. Anything that claims what the list holds now (an empty or no-match message,
 * a count, a connected status) comes from `fresh` only, so a reload after a write never
 * shows the answer from before it.
 */
export function pageToShow<R, E extends object>(
  state: ServerPageState<R, E>,
): {
  fresh: ServerPage<R, E> | null;
  shown: ServerPage<R, E> | null;
  /**
   * The page whose list-wide fields (`count`, and what the route answers beside the
   * rows) still hold: the fresh page, or while a page turn or a new search loads, the
   * page before it. Null while a reload after a write is in flight.
   */
  settled: ServerPage<R, E> | null;
} {
  if (state.status === "ready") return { fresh: state.data, shown: state.data, settled: state.data };
  if (state.status !== "loading") return { fresh: null, shown: null, settled: null };
  return { fresh: null, shown: state.previous, settled: state.reloading ? null : state.previous };
}

/** The route's answer, `{ grants: [...], total, count, page, pageSize }`, as one page. */
function pageFrom<R, E extends object>(body: Record<string, unknown>, rowsKey: string): ServerPage<R, E> {
  const { [rowsKey]: rows, ...rest } = body;
  return { ...(rest as Omit<ServerPage<R, E>, "rows">), rows: rows as R[] } as ServerPage<R, E>;
}

/**
 * `prefix` is the list's URL prefix (`grants.`); `maxPage` is the highest page the
 * route accepts; `rowsKey` is the field of the answer holding the rows (`grants`,
 * `capabilities`); `viewKey` changes exactly when the
 * search, a filter or the order does; `urlFor(page)` is the request for one page;
 * `searching` is true while a search is on, so typing waits before it is sent; and
 * `revision` is bumped to reload after a create or revoke: until the fresh page
 * arrives the state is "loading", with the rows already shown as `previous`, so a
 * caller never presents the old answer as the answer to the reload.
 */
export function useServerPage<R, E extends object = object>({
  prefix,
  maxPage,
  rowsKey,
  viewKey,
  urlFor,
  searching,
  revision,
}: {
  prefix: string;
  maxPage: number;
  rowsKey: string;
  viewKey: string;
  urlFor: (page: number) => string;
  searching: boolean;
  revision: number;
}): { state: ServerPageState<R, E>; page: number; setPage: (page: number) => void } {
  const [page, setPage] = useUrlPage(`${prefix}page`, viewKey, maxPage);
  const url = urlFor(page);
  // Returning to an earlier URL starts a new read; its old answer remains stale.
  const request = useMemo(() => ({ url, revision, rowsKey, searching }), [url, revision, rowsKey, searching]);
  const [loaded, setLoaded] = useState<{ request: typeof request; state: ServerPageState<R, E> } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(
      async () => {
        let state: ServerPageState<R, E>;
        try {
          const res = await fetch(url, { signal: controller.signal });
          state =
            res.status === 403
              ? { status: "forbidden" }
              : res.ok
                ? { status: "ready", data: pageFrom<R, E>(await res.json(), rowsKey) }
                : { status: "failed" };
        } catch {
          state = { status: "failed" };
        }
        if (!controller.signal.aborted) setLoaded({ request, state });
      },
      searching ? SEARCH_DEBOUNCE_MS : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [url, rowsKey, revision, searching, request]);

  return {
    state:
      loaded?.request === request
        ? loaded.state
        : {
            status: "loading",
            previous: loaded?.state.status === "ready" ? loaded.state.data : null,
            reloading: loaded !== null && loaded.request.revision !== revision,
          },
    page,
    setPage,
  };
}
