"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import { matchesQuery } from "@/components/access-search/match";

/**
 * The scope field on the Access forms (grant, new scope, issue token). Scopes
 * are a tree, so the list shows it: each scope sits indented under its parent,
 * and typing filters by name or by the names above it. A filtered list is
 * flat, each match labelled with its ancestors, the same way the Scopes tab
 * search shows matches. The value is always the full scope path.
 */

export type ScopeOption = { id: string; path: string; name: string };

type Row = {
  /** The scope path, or "" for the empty option. */
  value: string;
  name: string;
  /** Names of the ancestors present in the list, root first. */
  trail: string[];
  depth: number;
  path: string;
};

const TRAIL_SEPARATOR = " › ";

/**
 * Orders scopes depth first, children by name, each under its nearest ancestor
 * in the list. A scope whose ancestors are all absent starts a tree of its own.
 */
export function scopeTreeRows(scopes: ReadonlyArray<ScopeOption>): Row[] {
  const byPath = new Map(scopes.map((s) => [s.path, s]));
  const children = new Map<string | null, ScopeOption[]>();
  for (const scope of scopes) {
    const segments = scope.path.split(".");
    let parent: string | null = null;
    for (let i = segments.length - 1; i > 0; i--) {
      const candidate = segments.slice(0, i).join(".");
      if (byPath.has(candidate)) {
        parent = candidate;
        break;
      }
    }
    children.set(parent, [...(children.get(parent) ?? []), scope]);
  }

  const rows: Row[] = [];
  const visit = (parent: string | null, trail: string[]) => {
    const kids = [...(children.get(parent) ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    for (const scope of kids) {
      rows.push({ value: scope.path, name: scope.name, trail, depth: trail.length, path: scope.path });
      visit(scope.path, [...trail, scope.name]);
    }
  };
  visit(null, []);
  return rows;
}

function optionLabel(row: Row): string {
  return row.trail.length === 0 ? row.name : `${row.name}, in ${row.trail.join(TRAIL_SEPARATOR)}`;
}

export function ScopeSelect({
  scopes,
  value,
  onChange,
  label,
  emptyLabel,
  placeholder = "Choose a scope",
}: {
  scopes: ReadonlyArray<ScopeOption>;
  /** The selected scope path, or "" for none. */
  value: string;
  onChange: (path: string) => void;
  /** The field's accessible name. */
  label: string;
  /**
   * When set, "" is a choice with this label (e.g. "Org root") and stands in
   * for the org root scope, which is then not listed a second time.
   */
  emptyLabel?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const id = useId();
  const listboxId = `${id}-listbox`;

  const rows = useMemo(() => {
    const tree = scopeTreeRows(scopes);
    if (emptyLabel === undefined) return tree;
    const root = tree.find((r) => r.depth === 0 && !r.path.includes("."));
    const empty: Row = { value: "", name: emptyLabel, trail: [], depth: 0, path: root?.path ?? "" };
    // The root scope's descendants keep their depth under the empty option,
    // and their trails name it the way the empty option does.
    const rest = tree
      .filter((r) => r !== root)
      .map((r) =>
        root && r.path.startsWith(`${root.path}.`)
          ? { ...r, trail: [emptyLabel, ...r.trail.slice(1)] }
          : { ...r, depth: r.depth + 1, trail: [emptyLabel, ...r.trail] },
      );
    return [empty, ...rest];
  }, [scopes, emptyLabel]);

  const filtering = query.trim() !== "";
  const shown = filtering
    ? rows.filter((r) => matchesQuery(query, [r.name, r.path, [...r.trail, r.name].join(TRAIL_SEPARATOR)]))
    : rows;
  // With an empty option, the org root path and "" are the same choice.
  const selectedValue = emptyLabel !== undefined && value !== "" && rows[0]?.path === value ? "" : value;
  const selected = rows.find((r) => r.value === selectedValue) ?? null;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  function openList() {
    setQuery("");
    setActive(
      Math.max(
        0,
        rows.findIndex((r) => r.value === selectedValue),
      ),
    );
    setOpen(true);
  }

  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function choose(row: Row) {
    onChange(row.value);
    close();
  }

  function onInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => Math.min(i + 1, shown.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter") {
      // Enter inside the form would submit it; here it picks the active scope.
      event.preventDefault();
      if (shown[active]) choose(shown[active]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  }

  const triggerText = selected ? [...selected.trail, selected.name] : null;

  return (
    <div ref={containerRef} className="flex min-w-0 flex-col gap-2">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${selected ? [...selected.trail, selected.name].join(TRAIL_SEPARATOR) : placeholder}`}
        title={selected?.path || undefined}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            openList();
          }
        }}
        className="flex min-w-0 w-full items-center justify-between gap-2 min-h-11 rounded-xl border border-[var(--field-border)] bg-[var(--field-background)] px-4 py-2.5 text-left text-sm text-fg hover:border-[var(--field-border-hover)] focus-visible:border-[var(--field-border-focus)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info"
      >
        <span className="flex min-w-0 flex-wrap items-center gap-x-1 [overflow-wrap:anywhere]">
          {triggerText ? (
            triggerText.map((name, i) => (
              <span key={i} className={i === triggerText.length - 1 ? "text-fg" : "text-fg-subtle"}>
                {i > 0 && (
                  <span aria-hidden className="mr-1 text-fg-subtle">
                    ›
                  </span>
                )}
                {name}
              </span>
            ))
          ) : (
            <span className="text-fg-subtle">{placeholder}</span>
          )}
        </span>
        <ChevronDown
          size={14}
          strokeWidth={2}
          aria-hidden
          className={`shrink-0 text-fg-subtle transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="flex min-w-0 flex-col gap-1.5 rounded-xl border border-divider bg-ink/95 p-1.5">
          <div className="relative flex items-center">
            <Search
              size={14}
              strokeWidth={1.8}
              aria-hidden
              className="pointer-events-none absolute left-3 text-fg-subtle"
            />
            <input
              ref={inputRef}
              role="combobox"
              aria-label={`Search ${label.toLowerCase()}`}
              aria-expanded
              aria-controls={listboxId}
              aria-autocomplete="list"
              aria-activedescendant={shown[active] ? `${id}-option-${active}` : undefined}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={onInputKeyDown}
              placeholder="Search scopes"
              autoComplete="off"
              spellCheck={false}
              className="min-w-0 w-full rounded-lg border border-[var(--field-border)] bg-[var(--field-background)] py-2 pl-9 pr-3 text-sm text-fg placeholder:text-[var(--field-placeholder)] focus-visible:border-[var(--field-border-focus)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info"
            />
          </div>
          <ul
            ref={listRef}
            id={listboxId}
            role="listbox"
            aria-label={label}
            className="max-h-64 overflow-y-auto overscroll-contain"
          >
            {shown.map((row, index) => {
              const isActive = index === active;
              const isSelected = row.value === selectedValue;
              return (
                <li
                  key={row.value || "__empty__"}
                  id={`${id}-option-${index}`}
                  role="option"
                  aria-selected={isSelected}
                  aria-label={optionLabel(row)}
                  data-index={index}
                  data-depth={filtering ? 0 : row.depth}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(row)}
                  style={filtering ? undefined : { paddingLeft: `${0.75 + row.depth * 1}rem` }}
                  className={`flex min-w-0 cursor-pointer flex-col rounded-lg py-2 pr-3 pl-3 text-sm [overflow-wrap:anywhere] ${
                    isActive ? "bg-fg/[0.08] text-fg" : "text-fg-muted"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    {!filtering && row.depth > 0 && (
                      <span aria-hidden className="text-fg-subtle">
                        └
                      </span>
                    )}
                    <span className={isSelected ? "font-medium text-gold" : undefined}>{row.name}</span>
                  </span>
                  {filtering && row.trail.length > 0 && (
                    <span aria-hidden className="text-xs text-fg-subtle">
                      {row.trail.join(TRAIL_SEPARATOR)}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          {shown.length === 0 && (
            <p className="px-3 py-2 text-sm text-fg-subtle">No scopes match &ldquo;{query.trim()}&rdquo;.</p>
          )}
        </div>
      )}
    </div>
  );
}
