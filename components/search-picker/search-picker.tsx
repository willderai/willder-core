"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import { listSearchText, MAX_LIST_SEARCH_LENGTH } from "@/lib/list-search";

/**
 * A form field that picks one row from a list too long to load: a member, an agent,
 * a contact, an account. Opening it asks the server for the first few matches;
 * typing asks again for that text. It never holds the whole list, so it reads the
 * same with ten rows or ten thousand, and when more match than it shows it says so
 * and asks the person to keep typing (lib/pick-query.ts is the server half).
 *
 * The parent keeps the chosen option, label included, because the option may not
 * be among the matches currently on screen.
 */

export type PickOption = {
  /** What the form submits. */
  value: string;
  label: string;
  /** A second line that tells two similar labels apart, such as an email. */
  detail?: string;
};

/** One answer from the server: the matches shown, and whether more exist. */
export type PickResult = { options: PickOption[]; more: boolean };

export type PickSearch = (query: string, signal: AbortSignal) => Promise<PickResult>;

/** Wait after a keystroke before asking the server, so typing a word sends one request. */
const TYPING_DELAY_MS = 250;

/** What the server said, tagged with the search, text and attempt it answers. */
type Answer = { search: PickSearch; key: string } & ({ result: PickResult } | { failed: true });

export function SearchPicker({
  label,
  placeholder,
  searchPlaceholder,
  selected,
  onChange,
  search,
}: {
  /** The field's accessible name, e.g. "Member". */
  label: string;
  /** Shown on the closed field while nothing is chosen. */
  placeholder: string;
  /** Shown in the search box, e.g. "Search by name or email". */
  searchPlaceholder: string;
  selected: PickOption | null;
  onChange: (option: PickOption) => void;
  search: PickSearch;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [active, setActive] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const id = useId();
  const listboxId = `${id}-listbox`;

  const text = listSearchText(query);
  // An answer counts only for the search, text and attempt it was asked for; a slower
  // answer to an earlier keystroke is dropped by the abort below and never shown.
  const key = `${attempt}:${text}`;
  const current = answer?.search === search && answer.key === key ? answer : null;
  const shown = current && "result" in current ? current.result.options : [];

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        search(text, controller.signal).then(
          (result) => {
            if (!controller.signal.aborted) setAnswer({ search, key, result });
          },
          () => {
            if (!controller.signal.aborted) setAnswer({ search, key, failed: true });
          },
        );
      },
      text === "" ? 0 : TYPING_DELAY_MS,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, text, key, search]);

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
    setActive(0);
    setOpen(true);
  }

  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function choose(option: PickOption) {
    onChange(option);
    close();
  }

  function onInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => Math.max(Math.min(i + 1, shown.length - 1), 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter") {
      // Enter inside the form would submit it; here it picks the active match.
      event.preventDefault();
      if (shown[active]) choose(shown[active]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  }

  return (
    <div ref={containerRef} className="flex min-w-0 flex-col gap-2">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${selected ? selected.label : placeholder}`}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            openList();
          }
        }}
        className="flex min-w-0 w-full items-center justify-between gap-2 min-h-11 rounded-xl border border-[var(--field-border)] bg-[var(--field-background)] px-4 py-2.5 text-left text-sm text-fg hover:border-[var(--field-border-hover)] focus-visible:border-[var(--field-border-focus)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info"
      >
        <span className="min-w-0 [overflow-wrap:anywhere]">
          {selected ? (
            <>
              {selected.label}
              {selected.detail && <span className="text-fg-subtle"> · {selected.detail}</span>}
            </>
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
              aria-busy={current === null}
              aria-activedescendant={shown[active] ? `${id}-option-${active}` : undefined}
              value={query}
              maxLength={MAX_LIST_SEARCH_LENGTH}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={onInputKeyDown}
              placeholder={searchPlaceholder}
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
            {shown.map((option, index) => {
              const isSelected = option.value === selected?.value;
              return (
                <li
                  key={option.value}
                  id={`${id}-option-${index}`}
                  role="option"
                  aria-selected={isSelected}
                  data-index={index}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(option)}
                  className={`flex min-w-0 cursor-pointer flex-col rounded-lg px-3 py-2 text-sm [overflow-wrap:anywhere] ${
                    index === active ? "bg-fg/[0.08] text-fg" : "text-fg-muted"
                  }`}
                >
                  <span className={isSelected ? "font-medium text-gold" : undefined}>{option.label}</span>
                  {option.detail && <span className="text-xs text-fg-subtle">{option.detail}</span>}
                </li>
              );
            })}
          </ul>
          <PickerStatus answer={current} text={text} onRetry={() => setAttempt((n) => n + 1)} />
        </div>
      )}
    </div>
  );
}

/** The line under the matches: searching, failed, nothing found, or more than shown. */
function PickerStatus({ answer, text, onRetry }: { answer: Answer | null; text: string; onRetry: () => void }) {
  const line = "px-3 py-2 text-sm text-fg-subtle";
  if (answer === null)
    return (
      <p className={line} role="status">
        Searching…
      </p>
    );
  if ("failed" in answer) {
    return (
      <p className={`${line} flex flex-wrap items-center gap-x-2`} role="alert">
        Could not load matches.
        <button type="button" onClick={onRetry} className="text-fg underline underline-offset-2 hover:text-gold">
          Try again
        </button>
      </p>
    );
  }
  const { options, more } = answer.result;
  if (options.length === 0) {
    return (
      <p className={line} role="status">
        {text === "" ? "Nothing to pick yet." : <>No matches for &ldquo;{text}&rdquo;.</>}
      </p>
    );
  }
  if (more)
    return (
      <p className={line} role="status">
        Showing the first {options.length}. Keep typing to narrow.
      </p>
    );
  return null;
}
