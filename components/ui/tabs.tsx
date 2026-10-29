"use client";

import type { KeyboardEvent } from "react";

// Reusable controlled tabs — a segmented pill control (rounded-full track, active
// segment lifts on a subtle fill). Stateless; parent owns the active key.
//
// Without `label` it is a row of toggle buttons (aria-pressed). With `label` it is an
// ARIA tab list: each button is a `tab` controlling the panel `tabPanelId(idPrefix, key)`,
// only the active tab is in the Tab order, and the arrow keys, Home and End move focus
// between tabs. Enter or Space selects the focused tab (manual activation), so arrowing
// across does not mount, and fetch for, every panel on the way.
export type TabItem = { key: string; label: string; /** Shown after the label, such as a count. */ badge?: string };

/** The id of the panel a tab controls; the page gives its panel this id and `role="tabpanel"`. */
export const tabPanelId = (idPrefix: string, key: string) => `${idPrefix}-panel-${key}`;
/** The id of a tab button, for the panel's aria-labelledby. */
export const tabId = (idPrefix: string, key: string) => `${idPrefix}-tab-${key}`;

export function Tabs({
  items,
  value,
  onChange,
  className = "",
  label,
  idPrefix = "tabs",
}: {
  items: TabItem[];
  value: string;
  onChange: (key: string) => void;
  className?: string;
  /** The tab list's accessible name; giving one makes the control an ARIA tab list. */
  label?: string;
  /** Prefix of the tab and panel ids, unique on the page. Used only with `label`. */
  idPrefix?: string;
}) {
  const isTabList = label !== undefined;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const focused = items.findIndex((it) => tabId(idPrefix, it.key) === (event.target as HTMLElement).id);
    const current = focused === -1 ? items.findIndex((it) => it.key === value) : focused;
    const next =
      event.key === "ArrowRight"
        ? (current + 1) % items.length
        : event.key === "ArrowLeft"
          ? (current - 1 + items.length) % items.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    event.currentTarget.ownerDocument.getElementById(tabId(idPrefix, items[next].key))?.focus();
  };

  return (
    <div
      role={isTabList ? "tablist" : undefined}
      aria-label={label}
      onKeyDown={isTabList ? onKeyDown : undefined}
      className={`inline-flex max-w-full flex-wrap gap-1 rounded-2xl sm:rounded-full border border-divider bg-fg/[0.03] p-1 ${className}`}
    >
      {items.map((it) => {
        const active = value === it.key;
        return (
          <button
            type="button"
            key={it.key}
            onClick={() => onChange(it.key)}
            {...(isTabList
              ? {
                  role: "tab",
                  id: tabId(idPrefix, it.key),
                  "aria-selected": active,
                  "aria-controls": tabPanelId(idPrefix, it.key),
                  tabIndex: active ? 0 : -1,
                }
              : { "aria-pressed": active })}
            className={`min-h-10 rounded-full px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
              active ? "bg-accent/15 text-fg dark:text-accent" : "text-fg-subtle hover:text-fg"
            }`}
          >
            {it.label}
            {it.badge !== undefined && (
              <>
                {" "}
                <span className="ml-0.5 font-normal tabular-nums opacity-80">{it.badge}</span>
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}
