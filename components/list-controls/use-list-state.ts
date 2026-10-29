"use client";

/**
 * Holds one list's search, order and filters, seeded from the URL and written
 * back to it, so reload, back and a shared link all reopen the same view.
 *
 * A list whose rows only exist for something that never enters a URL (the
 * repositories a pasted token can read) passes `inUrl: false`: its view lives in
 * this hook alone, and nothing it is typed into reaches history or a Referer.
 *
 * The rule: typing never waits on the URL. The view updates on every keystroke;
 * the query string, and `committed` (what a server-backed list should fetch),
 * follow after a short pause. A URL change that did not come from this hook,
 * such as a link to a filtered view while the page is open, replaces the view.
 */
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  defaultListState,
  initialDirection,
  parseListState,
  writeListState,
  type ListConfig,
  type ListState,
} from "./list-query";

/** How long typing pauses before the URL and `committed` catch up. */
export const SEARCH_DEBOUNCE_MS = 250;

export type ListStateControls = {
  /** The view on screen, current with every keystroke. */
  state: ListState;
  /** The view after the search debounce: what the URL holds and what a server list fetches. */
  committed: ListState;
  setQuery: (query: string) => void;
  /** Chooses an order, starting in that order's own default direction. */
  setSort: (sortKey: string) => void;
  reverseDirection: () => void;
  /** Sets one filter; the empty string turns it off. */
  setFilter: (filterKey: string, value: string) => void;
  /** Clears the search and every filter, keeping the chosen order. */
  clear: () => void;
};

function ownedKey<T>(config: ListConfig<T>, state: ListState): string {
  return writeListState(new URLSearchParams(), config, state).toString();
}

function replaceUrl<T>(config: ListConfig<T>, state: ListState) {
  const params = new URLSearchParams(window.location.search);
  // A paged list keeps its page in `<prefix>page`; a new view starts again at page 1.
  params.delete(`${config.paramPrefix ?? ""}page`);
  const next = writeListState(params, config, state).toString();
  const { pathname, hash } = window.location;
  // Next.js syncs useSearchParams with replaceState without a server round trip.
  window.history.replaceState(window.history.state, "", `${pathname}${next ? `?${next}` : ""}${hash}`);
}

/**
 * The view state for one list. `config` should be a module-level constant: its
 * sorts and filters decide which URL values are accepted.
 */
export function useListState<T>(
  config: ListConfig<T>,
  { debounceMs = SEARCH_DEBOUNCE_MS, inUrl = true }: { debounceMs?: number; inUrl?: boolean } = {},
): ListStateControls {
  // Null outside the App Router (an isolated render): the list starts at its defaults.
  const urlParams: URLSearchParams | null = useSearchParams();
  const params = inUrl ? urlParams : null;
  const urlState = parseListState(new URLSearchParams(params?.toString() ?? ""), config);
  const urlKey = ownedKey(config, urlState);

  const [state, setState] = useState<ListState>(urlState);
  const [committed, setCommitted] = useState<ListState>(urlState);
  const [seenUrlKey, setSeenUrlKey] = useState(urlKey);
  const [writtenKey, setWrittenKey] = useState<string | null>(null);

  // A URL this hook did not write (a link, back/forward) replaces the view.
  if (urlKey !== seenUrlKey) {
    setSeenUrlKey(urlKey);
    if (urlKey !== writtenKey) {
      setState(urlState);
      setCommitted(urlState);
    }
  }

  const configRef = useRef(config);
  useEffect(() => {
    configRef.current = config;
  });

  useEffect(() => {
    if (state === committed) return;
    const delay = state.query === committed.query ? 0 : debounceMs;
    const timer = setTimeout(() => {
      setCommitted(state);
      const key = ownedKey(configRef.current, state);
      setWrittenKey(key);
      if (inUrl) replaceUrl(configRef.current, state);
    }, delay);
    return () => clearTimeout(timer);
  }, [state, committed, debounceMs, inUrl]);

  return {
    state,
    committed,
    setQuery: (query) => setState((s) => ({ ...s, query })),
    setSort: (sort) => setState((s) => ({ ...s, sort, direction: initialDirection(config, sort) })),
    reverseDirection: () => setState((s) => ({ ...s, direction: s.direction === "asc" ? "desc" : "asc" })),
    setFilter: (key, value) =>
      setState((s) => {
        const filters = { ...s.filters };
        if (value === "") delete filters[key];
        else filters[key] = value;
        return { ...s, filters };
      }),
    clear: () => setState((s) => ({ ...defaultListState(config), sort: s.sort, direction: s.direction })),
  };
}

/**
 * The same controls with the search held by the page instead of the list, for
 * a page whose one search box filters whichever list is showing (the Access
 * tabs). Clearing clears that search too, so "Clear all" empties what it counts.
 */
export function withPageQuery(
  controls: ListStateControls,
  query: string,
  setQuery: (query: string) => void,
): ListStateControls {
  return {
    ...controls,
    state: { ...controls.state, query },
    committed: { ...controls.committed, query },
    setQuery,
    clear: () => {
      controls.clear();
      setQuery("");
    },
  };
}
