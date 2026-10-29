"use client";

/**
 * The toolbar every list shares, one compact row above the list: search on the
 * left, a Filters button whose panel holds each filter as a group of chips, the
 * active filters as removable chips, and the order on the right. Below `sm` the
 * row wraps and the filter panel spans the toolbar's width.
 *
 * It renders a `ListStateControls` from `useListState` and never filters rows
 * itself, so a server-backed list can use the same toolbar over rows the server
 * already narrowed. `SortHeader` sorts a table from its column headers,
 * `ListNoMatch` replaces a list that a search or filter emptied and
 * `ListPagination` steps through a list longer than one page.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { SearchField } from "@/components/access-search/search-field";
import { countOf } from "@/components/access-search/count-copy";
import { MAX_LIST_SEARCH_LENGTH } from "@/lib/list-search";
import { isNarrowed, type ListConfig, type ListState, type SortDirection } from "./list-query";
import type { ListStateControls } from "./use-list-state";
import type { ListPage } from "./use-list-page";

/** The pill every toolbar control shares, matching the audit log's pickers. */
const PILL =
  "inline-flex min-h-10 items-center gap-2 rounded-full border border-divider bg-fg/[0.03] px-3.5 text-sm text-fg-muted transition-colors hover:border-accent/40 hover:text-fg";

/** The sort select sits inside a pill, so it draws no box of its own. */
const SORT_SELECT = "cursor-pointer appearance-none bg-transparent text-fg [&>option]:bg-ink";

const DIRECTION_WORDS: Record<SortDirection, string> = { asc: "Ascending", desc: "Descending" };

/** What a direction means for the chosen order: "Newest first" when the order says so. */
function directionLabel<T>(config: ListConfig<T>, state: ListState, direction: SortDirection): string {
  const sort = config.sorts.find((s) => s.key === state.sort) ?? config.sorts[0];
  return sort.directionLabels?.[direction] ?? DIRECTION_WORDS[direction];
}

/**
 * The search, filter and order controls for one list. `total` is how many rows
 * the caller may see before narrowing and `shown` how many remain after; the
 * count appears only while a search or filter is on. A server list that does
 * not know its total before narrowing passes null, and the count reads
 * "12 matching records". A server list whose narrowed answer is still loading,
 * or failed, passes null as `shown`, so no count is shown or announced rather
 * than a zero that would read as "nothing matched". `children` are controls a list keeps outside the
 * Filters panel, such as the audit log's decision buttons; they sit in the same
 * row, after the Filters button.
 */
export function ListControls<T>({
  config,
  controls,
  total,
  shown,
  search = true,
  className = "",
  children,
}: {
  config: ListConfig<T>;
  controls: ListStateControls;
  total: number | null;
  shown: number | null;
  /** False when the page already has a search box feeding `controls.state.query`. */
  search?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const { state } = controls;
  const filters = config.filters ?? [];
  const active = filters.filter((f) => state.filters[f.key] !== undefined);
  const other: SortDirection = state.direction === "asc" ? "desc" : "asc";
  const current = directionLabel(config, state, state.direction);
  const DirectionIcon = state.direction === "asc" ? ArrowUpNarrowWide : ArrowDownWideNarrow;
  const countLine =
    shown === null
      ? ""
      : total === null
        ? countOf(shown, `matching ${config.noun.one}`, `matching ${config.noun.many}`)
        : `${shown.toLocaleString()} of ${countOf(total, config.noun.one, config.noun.many)}`;

  return (
    <div
      role="search"
      aria-label={`Search, filter and sort ${config.noun.many}`}
      className={`relative flex flex-col gap-2 ${className}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        {search && (
          <SearchField
            value={state.query}
            onChange={controls.setQuery}
            label={`Search ${config.noun.many}`}
            placeholder={`Search ${config.noun.many}`}
            maxLength={MAX_LIST_SEARCH_LENGTH}
            className="w-full sm:w-64 [&_input]:min-h-10 [&_input]:rounded-full"
          />
        )}
        {filters.length > 0 && <FilterMenu config={config} controls={controls} activeCount={active.length} />}
        {children}
        <div className="ml-auto flex items-center gap-2">
          {config.sorts.length > 1 && (
            <label className={`${PILL} relative pr-8`}>
              <span className="hidden text-fg-subtle sm:inline">Sort</span>
              <select
                aria-label="Sort by"
                value={state.sort}
                onChange={(event) => controls.setSort(event.target.value)}
                className={SORT_SELECT}
              >
                {config.sorts.map((sort) => (
                  <option key={sort.key} value={sort.key}>
                    {sort.label}
                  </option>
                ))}
              </select>
              <ChevronDown
                size={14}
                strokeWidth={1.8}
                aria-hidden
                className="pointer-events-none absolute right-3 text-fg-subtle"
              />
            </label>
          )}
          <button
            type="button"
            onClick={controls.reverseDirection}
            aria-label={`Order: ${current}. Switch to ${directionLabel(config, state, other).toLowerCase()}`}
            title={current}
            className={PILL}
          >
            <DirectionIcon size={16} strokeWidth={1.8} aria-hidden />
            <span className="hidden whitespace-nowrap sm:inline">{current}</span>
          </button>
        </div>
      </div>
      {/* Always in the tree, so a screen reader hears each new count; the visible copy below is for sighted readers. */}
      <p aria-live="polite" className="sr-only">
        {isNarrowed(state) ? countLine : ""}
      </p>
      {isNarrowed(state) && (
        <div className="flex flex-wrap items-center gap-2">
          {countLine !== "" && (
            <p aria-hidden className="mr-1 whitespace-nowrap text-sm text-fg-subtle">
              {countLine}
            </p>
          )}
          {active.map((filter) => {
            const value = state.filters[filter.key];
            const option = filter.options.find((o) => o.value === value);
            return (
              <button
                key={filter.key}
                type="button"
                onClick={() => controls.setFilter(filter.key, "")}
                aria-label={`Remove filter ${filter.label}: ${option?.label ?? value}`}
                className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 px-3 text-sm font-semibold text-fg transition-colors hover:bg-accent/20"
              >
                <span className="font-normal text-fg-muted">{filter.label}:</span> {option?.label ?? value}
                <X size={13} strokeWidth={2} aria-hidden />
              </button>
            );
          })}
          {/* With nothing left, ListNoMatch carries the one way back. */}
          {shown !== 0 && (
            <button
              type="button"
              onClick={controls.clear}
              className="min-h-8 rounded-full px-2 text-sm text-fg-muted underline-offset-4 transition-colors hover:text-fg hover:underline"
            >
              Clear all
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The Filters button and its panel. Each filter is a group of chips, one chip
 * pressed. Escape or a click outside closes the panel; Escape returns focus to
 * the button.
 */
function FilterMenu<T>({
  config,
  controls,
  activeCount,
}: {
  config: ListConfig<T>;
  controls: ListStateControls;
  activeCount: number;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  return (
    <div
      ref={root}
      className="sm:relative"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={activeCount > 0 ? `Filters, ${activeCount} on` : "Filters"}
        onClick={() => setOpen((o) => !o)}
        className={`${PILL} ${activeCount > 0 ? "border-accent/40 text-fg" : ""}`}
      >
        <SlidersHorizontal size={15} strokeWidth={1.8} aria-hidden />
        <span className="hidden sm:inline">Filters</span>
        {activeCount > 0 && (
          <span aria-hidden className="rounded-full bg-accent/15 px-1.5 text-xs font-semibold text-fg">
            {activeCount}
          </span>
        )}
      </button>
      {open && (
        <div
          id={panelId}
          role="group"
          aria-label={`Filter ${config.noun.many}`}
          className="absolute inset-x-0 top-full z-40 mt-2 flex flex-col gap-4 rounded-2xl border border-divider bg-[var(--overlay)] p-4 shadow-2xl sm:inset-x-auto sm:left-0 sm:w-80"
        >
          {(config.filters ?? []).map((filter) => {
            const chosen = controls.state.filters[filter.key] ?? "";
            const choices = [{ value: "", label: "All" }, ...filter.options];
            return (
              <fieldset key={filter.key} className="flex flex-col gap-2">
                <legend className="mb-2 text-eyebrow font-semibold uppercase text-fg-subtle">{filter.label}</legend>
                <div className="flex flex-wrap gap-1.5">
                  {choices.map((choice) => (
                    <button
                      key={choice.value}
                      type="button"
                      aria-pressed={chosen === choice.value}
                      onClick={() => controls.setFilter(filter.key, choice.value)}
                      className={`min-h-8 rounded-full border px-3 text-sm transition-colors ${
                        chosen === choice.value
                          ? "border-accent/50 bg-accent/10 font-semibold text-fg"
                          : "border-divider text-fg-muted hover:border-accent/40 hover:text-fg"
                      }`}
                    >
                      {choice.label}
                    </button>
                  ))}
                </div>
              </fieldset>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * A table column header that sorts by one of the list's orders. Activating the
 * current order's header reverses it; another header chooses that order in its
 * own default direction. `aria-sort` tells a screen reader which column leads.
 */
export function SortHeader<T>({
  config,
  controls,
  sortKey,
  className = "",
}: {
  config: ListConfig<T>;
  controls: ListStateControls;
  sortKey: string;
  className?: string;
}) {
  const sort = config.sorts.find((s) => s.key === sortKey);
  if (!sort) throw new Error(`SortHeader: "${sortKey}" is not one of this list's sorts; add it to the list config.`);
  const active = controls.state.sort === sortKey;
  const direction = controls.state.direction;
  const Icon = direction === "asc" ? ArrowUpNarrowWide : ArrowDownWideNarrow;
  return (
    <th
      scope="col"
      aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"}
      className={className}
    >
      <button
        type="button"
        onClick={() => (active ? controls.reverseDirection() : controls.setSort(sortKey))}
        className={`inline-flex items-center gap-1.5 uppercase tracking-widest transition-colors hover:text-fg ${active ? "text-fg" : ""}`}
      >
        {sort.label}
        {/* Reserves the icon's width on every header so choosing one never shifts the row. */}
        <Icon size={13} strokeWidth={1.8} aria-hidden className={active ? "" : "invisible"} />
      </button>
    </th>
  );
}

/**
 * The message in place of an empty list while a search or filter is on, with a
 * way back to the whole list. A list with no rows at all keeps its own empty state.
 */
export function ListNoMatch<T>({ config, controls }: { config: ListConfig<T>; controls: ListStateControls }) {
  const query = controls.state.query.trim();
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-divider px-6 py-10 text-center">
      <p className="text-sm text-fg-muted">
        {query !== "" ? (
          <>
            No {config.noun.many} match &ldquo;{query}&rdquo;
            {Object.keys(controls.state.filters).length > 0 ? " with these filters" : ""}.
          </>
        ) : (
          <>No {config.noun.many} match these filters.</>
        )}
      </p>
      <button type="button" onClick={controls.clear} className={PILL}>
        Clear search and filters
      </button>
    </div>
  );
}

/**
 * The page buttons: a pill like the toolbar's, square around its arrow. They are dimmed
 * with `aria-disabled`, never `disabled`: a disabled button loses keyboard focus, so
 * pressing Next onto the last page, or while the next page loads, would drop focus to
 * the top of the document.
 */
const PAGE_BUTTON = `${PILL} justify-center px-2.5 aria-disabled:cursor-not-allowed aria-disabled:opacity-40 aria-disabled:hover:border-divider aria-disabled:hover:text-fg-muted`;

/**
 * Previous and next under a list longer than one page, with which rows are
 * showing ("11–20 of 34 sources") and the page count. A list that fits on one
 * page shows nothing here.
 *
 * `loading` is set while the page asked for has not arrived: the pager stays where it
 * is, so focus stays on the button that was pressed, but it names the page it is loading
 * in place of the old counts and its buttons do nothing until the answer comes.
 */
export function ListPagination<T>({
  noun,
  paging,
  loading = false,
  unavailable = false,
  keepVisible = false,
  empty = false,
  className = "",
}: {
  noun: { one: string; many: string };
  paging: ListPage<T>;
  loading?: boolean;
  /** A failed page keeps focusable controls, but exposes no stale counts. */
  unavailable?: boolean;
  /** Keep an already displayed pager mounted when results shrink, preserving focus. */
  keepVisible?: boolean;
  /** A successful empty page has a fresh total, but no row range to display. */
  empty?: boolean;
  className?: string;
}) {
  const { page, pageCount, total, pageSize, setPage } = paging;
  const showPages = pageCount > 1 || (keepVisible && page > 1);
  const [wasVisible, setWasVisible] = useState(showPages);
  if (showPages && !wasVisible) setWasVisible(true);
  if (!showPages && !(keepVisible && wasVisible)) return null;
  const outOfRange = page > pageCount;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  const atFirst = loading || unavailable || page <= 1;
  const atLast = loading || unavailable || page >= pageCount;
  return (
    <nav
      aria-label={`Pages of ${noun.many}`}
      aria-busy={loading}
      className={`flex flex-wrap items-center justify-between gap-3 ${className}`}
    >
      <p className="text-sm tabular-nums text-fg-subtle">
        {unavailable ? (
          "Page unavailable"
        ) : loading ? (
          `Loading page ${page}…`
        ) : empty || outOfRange || total === 0 ? (
          `${countOf(total, noun.one, noun.many)} total`
        ) : (
          <>
            {first.toLocaleString()}–{last.toLocaleString()} of {countOf(total, noun.one, noun.many)}
          </>
        )}
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label="Previous page"
          aria-disabled={atFirst}
          onClick={() => {
            if (!atFirst) setPage(page - 1);
          }}
          className={PAGE_BUTTON}
        >
          <ChevronLeft size={16} strokeWidth={1.8} aria-hidden />
        </button>
        <span className="text-sm tabular-nums text-fg-muted">
          {loading || unavailable || outOfRange ? `Page ${page}` : `Page ${page} of ${pageCount}`}
        </span>
        <button
          type="button"
          aria-label="Next page"
          aria-disabled={atLast}
          onClick={() => {
            if (!atLast) setPage(page + 1);
          }}
          className={PAGE_BUTTON}
        >
          <ChevronRight size={16} strokeWidth={1.8} aria-hidden />
        </button>
      </div>
    </nav>
  );
}
