/**
 * The rules every list in the app sorts, filters and searches by, kept free of
 * React so they can be tested on their own and reused by a server route.
 *
 * A list describes itself once with a `ListConfig`: which text a search looks
 * at, which orders it offers and which filters apply. Its view is a `ListState`
 * that round-trips through the URL query string, so a filtered view is a link
 * someone else can open. Values that do not belong to the config (a stale link,
 * a hand-edited URL) fall back to the defaults instead of failing.
 */
import { matchesQuery } from "@/components/access-search/match";
import { MAX_LIST_SEARCH_LENGTH } from "@/lib/list-search";

export type SortDirection = "asc" | "desc";

/** One way the list can be ordered. `compare` sorts ascending; descending reverses it. */
export type SortOption<T> = {
  key: string;
  label: string;
  compare: (a: T, b: T) => number;
  /** The direction this order starts in, e.g. "desc" for "newest first". Defaults to "asc". */
  defaultDirection?: SortDirection;
  /** What each direction means to a reader, e.g. { asc: "Oldest first", desc: "Newest first" }. */
  directionLabels?: Record<SortDirection, string>;
};

export type FilterOption = { value: string; label: string };

/** A single-choice filter. The empty value means "no filter" and is never one of `options`. */
export type ListFilter<T> = {
  key: string;
  label: string;
  options: ReadonlyArray<FilterOption>;
  matches: (item: T, value: string) => boolean;
};

export type ListConfig<T> = {
  /** Singular and plural nouns for counts and messages: { one: "agent", many: "agents" }. */
  noun: { one: string; many: string };
  /** The text a search matches against, case-insensitively, as a substring. */
  searchText: (item: T) => ReadonlyArray<string | null | undefined>;
  /** The orders offered; the first is the default. Must not be empty. */
  sorts: ReadonlyArray<SortOption<T>>;
  filters?: ReadonlyArray<ListFilter<T>>;
  /**
   * Prepended to every query parameter this list owns, so two lists on one page
   * keep separate views (`runs.q`, `runs.sort`). Empty for a page's main list.
   */
  paramPrefix?: string;
};

export type ListState = {
  query: string;
  sort: string;
  direction: SortDirection;
  /** Filter key to chosen value; a filter that is off is absent. */
  filters: Readonly<Record<string, string>>;
};

const DEFAULT_DIRECTION: SortDirection = "asc";

function sortOption<T>(config: ListConfig<T>, key: string): SortOption<T> {
  return config.sorts.find((s) => s.key === key) ?? config.sorts[0];
}

/** The direction a sort starts in when it is chosen. */
export function initialDirection<T>(config: ListConfig<T>, sortKey: string): SortDirection {
  return sortOption(config, sortKey).defaultDirection ?? DEFAULT_DIRECTION;
}

/** The view with no search, no filter and the default order. */
export function defaultListState<T>(config: ListConfig<T>): ListState {
  const sort = config.sorts[0].key;
  return { query: "", sort, direction: initialDirection(config, sort), filters: {} };
}

/** True when a search or a filter is narrowing the list. Order alone never hides a row. */
export function isNarrowed(state: ListState): boolean {
  return state.query.trim() !== "" || Object.keys(state.filters).length > 0;
}

/**
 * Whether a list shows its controls: not over a single row, where they would
 * only add noise, but always while narrowed, so a filtered view can be cleared.
 */
export function showsListControls(total: number, state: ListState): boolean {
  return total > 1 || isNarrowed(state);
}

function param<T>(config: ListConfig<T>, name: string): string {
  return `${config.paramPrefix ?? ""}${name}`;
}

/**
 * Reads a list's view from a query string, ignoring values the config does not offer.
 * A search from a link is cut to what a list route accepts and loses any NUL, so a
 * shared link can never make a server list refuse its own request.
 */
export function parseListState<T>(params: URLSearchParams, config: ListConfig<T>): ListState {
  const fallback = defaultListState(config);
  const sortParam = params.get(param(config, "sort"));
  const sort = config.sorts.some((s) => s.key === sortParam) ? (sortParam as string) : fallback.sort;
  const dirParam = params.get(param(config, "dir"));
  const direction: SortDirection =
    dirParam === "asc" || dirParam === "desc" ? dirParam : initialDirection(config, sort);
  const filters: Record<string, string> = {};
  for (const filter of config.filters ?? []) {
    const value = params.get(param(config, filter.key));
    if (value && filter.options.some((o) => o.value === value)) filters[filter.key] = value;
  }
  const query = (params.get(param(config, "q")) ?? "").replace(/\u0000/g, "").slice(0, MAX_LIST_SEARCH_LENGTH);
  return { query, sort, direction, filters };
}

/**
 * Writes a list's view into a copy of `params`, leaving every parameter the list
 * does not own untouched. Defaults are left out so an unchanged view keeps a clean URL.
 */
export function writeListState<T>(params: URLSearchParams, config: ListConfig<T>, state: ListState): URLSearchParams {
  const next = new URLSearchParams(params);
  const set = (name: string, value: string | null) => {
    if (value === null) next.delete(param(config, name));
    else next.set(param(config, name), value);
  };
  const query = state.query.trim();
  set("q", query === "" ? null : query);
  set("sort", state.sort === config.sorts[0].key ? null : state.sort);
  set("dir", state.direction === initialDirection(config, state.sort) ? null : state.direction);
  for (const filter of config.filters ?? []) set(filter.key, state.filters[filter.key] ?? null);
  return next;
}

/**
 * The rows a view shows: those matching the search and every active filter, in
 * the chosen order. Equal rows keep their incoming order in both directions.
 */
export function applyListState<T>(items: ReadonlyArray<T>, config: ListConfig<T>, state: ListState): T[] {
  const filters = (config.filters ?? []).filter((f) => state.filters[f.key] !== undefined);
  const kept = items.filter(
    (item) =>
      matchesQuery(state.query, config.searchText(item)) && filters.every((f) => f.matches(item, state.filters[f.key])),
  );
  const { compare } = sortOption(config, state.sort);
  const sign = state.direction === "asc" ? 1 : -1;
  return kept
    .map((item, index) => ({ item, index }))
    .sort((a, b) => sign * compare(a.item, b.item) || a.index - b.index)
    .map(({ item }) => item);
}

/** Ascending comparison of two optional strings, case-insensitive; missing values sort last. */
export function compareText(a: string | null | undefined, b: string | null | undefined): number {
  if (a == null || a === "") return b == null || b === "" ? 0 : 1;
  if (b == null || b === "") return -1;
  return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
}

/** Ascending comparison of two optional ISO timestamps or dates; missing or invalid values sort first. */
export function compareTime(a: string | Date | null | undefined, b: string | Date | null | undefined): number {
  const time = (v: string | Date | null | undefined) => {
    const ms = v == null ? Number.NaN : new Date(v).getTime();
    return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
  };
  const ta = time(a);
  const tb = time(b);
  return ta === tb ? 0 : ta < tb ? -1 : 1;
}
