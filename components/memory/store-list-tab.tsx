"use client";

// One paged store list on the Explore page, with the shared list toolbar, and the
// pieces the page's tabs share with it: the URL-held parameter, the JSON fetch and
// the empty and error states.
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { AlertCircle } from "lucide-react";
import type { StoreBrief, StoreChunk, StoreFile, StoreNote, StorePage, StoreRecord, StoreRule } from "@/types/memory";
import {
  MAX_STORE_PAGE,
  STORE_LISTS,
  STORE_LIST_FILTERS,
  STORE_LIST_SORTS,
  STORE_PAGE_SIZE,
  type StoreList,
} from "@/lib/memory-store-lists";
import { ListControls, ListNoMatch, ListPagination } from "@/components/list-controls/list-controls";
import { isNarrowed, showsListControls, type ListConfig, type ListState } from "@/components/list-controls/list-query";
import { useListState } from "@/components/list-controls/use-list-state";
import { Card } from "@/components/ui";

/** Fired after useUrlParam writes the URL, since pushState and replaceState fire no event. */
const URL_PARAM_WRITTEN = "willder:url-param-written";

function subscribeToUrl(onChange: () => void) {
  window.addEventListener("popstate", onChange);
  window.addEventListener(URL_PARAM_WRITTEN, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(URL_PARAM_WRITTEN, onChange);
  };
}

/**
 * One query parameter, read from the address bar and written back to it, so a link,
 * reload, back and forward all show the value the URL holds. `push` adds a history
 * entry, so back returns to the previous value; `replace` does not. The server render
 * reads the request's parameters, so a deep link renders its own value from the start.
 */
export function useUrlParam(name: string, mode: "push" | "replace"): [string | null, (value: string | null) => void] {
  // Null outside the App Router (an isolated render).
  const params: URLSearchParams | null = useSearchParams();
  const value = useSyncExternalStore(
    subscribeToUrl,
    () => new URLSearchParams(window.location.search).get(name),
    () => params?.get(name) ?? null,
  );

  const set = (next: string | null) => {
    const query = new URLSearchParams(window.location.search);
    if (next === null) query.delete(name);
    else query.set(name, next);
    const search = query.toString();
    const url = `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`;
    if (mode === "push") window.history.pushState(window.history.state, "", url);
    else window.history.replaceState(window.history.state, "", url);
    window.dispatchEvent(new Event(URL_PARAM_WRITTEN));
  };
  return [value, set];
}

/**
 * Drops each named list's page (`records.page`) from the URL at once, so each starts
 * again at page 1; by default every store list's.
 */
export function clearListPages(lists: readonly string[] = STORE_LISTS) {
  const query = new URLSearchParams(window.location.search);
  for (const list of lists) query.delete(`${list}.page`);
  const search = query.toString();
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`,
  );
  window.dispatchEvent(new Event(URL_PARAM_WRITTEN));
}

export async function fetchJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  const body = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(
      res.status === 403 ? "You don't have access to this scope." : (body.error ?? "Could not load memory."),
    );
  return body as T;
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-2xl border border-danger/30 px-5 py-4 text-sm text-danger"
    >
      <AlertCircle size={16} aria-hidden="true" className="mt-0.5 shrink-0" /> {message}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <Card className="px-6 py-12 text-center text-sm leading-relaxed text-fg-muted">{children}</Card>;
}

type StoreItems = {
  records: StoreRecord;
  briefs: StoreBrief;
  rules: StoreRule;
  notes: StoreNote;
  chunks: StoreChunk;
  files: StoreFile;
};
type StoreItem<L extends StoreList> = StoreItems[L];

/**
 * The request for one page of a store, or null when the overview already carries the
 * whole view: the default order, nothing narrowed, and a store that fits on one page.
 * A larger store takes page 1 from the server too, so the pages after it continue
 * the same ordered list instead of another query's.
 */
function storePageUrl(
  scope: string | null,
  list: StoreList,
  view: ListState,
  page: number,
  total: number,
): string | null {
  const defaultView = !isNarrowed(view) && view.sort === STORE_LIST_SORTS[list][0] && view.direction === "desc";
  if (defaultView && page === 1 && total <= STORE_PAGE_SIZE) return null;
  const params = new URLSearchParams({ list, sort: view.sort, order: view.direction, page: String(page) });
  if (scope) params.set("scope", scope);
  const query = view.query.trim();
  if (query !== "") params.set("q", query);
  const filter = STORE_LIST_FILTERS[list].param;
  if (view.filters[filter]) params.set(filter, view.filters[filter]);
  return `/api/memory/stores?${params}`;
}

type LoadedPage = { url: string; page: StorePage } | { url: string; error: string };

/** A list's page from its URL parameter (`<list>.page`): a whole number the server accepts, else 1. */
function readPage(value: string | null): number {
  const page = Number(value ?? "1");
  return Number.isInteger(page) && page >= 1 && page <= MAX_STORE_PAGE ? page : 1;
}

/**
 * One store's list with the shared toolbar and pages. A store that fits on one page
 * lists the overview's rows in the default view; any other view, and every page of a
 * larger store, asks the server for that page. While a page loads, or after it
 * failed, the list says so and claims no count. The page is kept in the URL.
 */
export function StoreListTab<L extends StoreList>({
  scope,
  list,
  config,
  newest,
  total,
  empty,
  render,
  before,
}: {
  scope: string | null;
  list: L;
  config: ListConfig<StoreItem<L>>;
  /** The overview's newest rows: the default view of a store that fits on one page. */
  newest: StoreItem<L>[];
  /** How many rows the store holds in this scope, before any narrowing. */
  total: number;
  empty: string;
  render: (items: StoreItem<L>[]) => ReactNode;
  /** Shown between the toolbar and the list, such as another way to search. */
  before?: ReactNode;
}) {
  const listView = useListState(config);
  const [pageParam, setPageParam] = useUrlParam(`${config.paramPrefix}page`, "replace");
  // useListState drops `<list>.page` from the URL whenever the view changes, so a new
  // search, filter or order starts again at page 1.
  const page = readPage(pageParam);
  const goToPage = (next: number) => setPageParam(next <= 1 ? null : String(next));

  const url = storePageUrl(scope, list, listView.committed, page, total);
  const [loaded, setLoaded] = useState<LoadedPage | null>(null);

  useEffect(() => {
    if (url === null) return;
    const controller = new AbortController();
    fetchJson<StorePage>(url, controller.signal).then(
      (answer) => {
        if (!controller.signal.aborted) setLoaded({ url, page: answer });
      },
      (e: Error) => {
        if (!controller.signal.aborted) setLoaded({ url, error: e.message });
      },
    );
    return () => controller.abort();
  }, [url]);

  const current = url !== null && loaded?.url === url ? loaded : null;
  const answer = current && "page" in current ? current.page : null;
  const items = (url === null ? newest : (answer?.items ?? [])) as StoreItem<L>[];
  const matching = url === null ? total : (answer?.total ?? null);
  const narrowed = isNarrowed(listView.state);

  if (total === 0 && !narrowed) return <Empty>{empty}</Empty>;

  return (
    <div className="flex flex-col gap-3">
      {showsListControls(total, listView.state) && (
        <ListControls config={config} controls={listView} total={total} shown={matching} />
      )}
      {before}
      {url !== null && current === null ? (
        <p role="status" className="py-10 text-center text-sm text-fg-muted">
          Loading {config.noun.many}…
        </p>
      ) : current && "error" in current ? (
        <ErrorState message={current.error} />
      ) : items.length === 0 ? (
        page > 1 ? (
          <Empty>
            No {config.noun.many} on this page.{" "}
            <button type="button" className="underline" onClick={() => goToPage(1)}>
              Back to the first page
            </button>
          </Empty>
        ) : isNarrowed(listView.committed) ? (
          <ListNoMatch config={config} controls={listView} />
        ) : (
          <Empty>{empty}</Empty>
        )
      ) : (
        render(items)
      )}
      {answer?.capped && (
        <p className="text-sm text-fg-subtle">
          Counting stopped at {answer.total.toLocaleString()} matches. Narrow the search for an exact count.
        </p>
      )}
      {matching !== null && (url === null || answer !== null) && (
        <ListPagination
          noun={config.noun}
          paging={{
            rows: items,
            page,
            pageCount: Math.max(1, Math.ceil(matching / STORE_PAGE_SIZE)),
            total: matching,
            pageSize: STORE_PAGE_SIZE,
            setPage: goToPage,
          }}
        />
      )}
    </div>
  );
}
