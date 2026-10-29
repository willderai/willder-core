"use client";

/**
 * The Integrations page as tabs: one panel at a time, chosen by the URL's anchor
 * (`/integrations#mailboxes`), so the links made when the page was one long
 * scroll still open the panel they named, back and forward step between tabs, and
 * a tab is a link someone can share. Only the chosen panel mounts, so only it fetches.
 *
 * The anchor never reaches the server, so the panel mounts once the browser has
 * read it. A URL without a usable anchor gets one written in, chosen from what
 * the URL does carry: the OAuth return (`?integration=gmail`) opens its provider's
 * tab and a list view (`?connections.q=…`) opens its list's tab.
 */
import { useCallback, useLayoutEffect, useRef, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";

export type IntegrationsTab = {
  /** The anchor that opens this tab, e.g. "connect-ai". */
  id: string;
  label: string;
  /** Other anchors this tab answers, e.g. "connectors" while one card covers both. */
  aliases?: string[];
  panel: ReactNode;
};

/** List-state prefixes (components/list-controls) and the anchor of the panel each list is on. */
const LIST_PREFIX_ANCHOR: ReadonlyArray<[prefix: string, anchor: string]> = [
  ["sources.", "sources"],
  ["connectors.", "connectors"],
  ["mailboxes.", "mailboxes"],
  ["connections.", "connect-ai"],
  ["disconnected.", "connect-ai"],
  ["apps.", "connected-apps"],
];

/** Mail providers return from OAuth to the Mailboxes tab; any other provider is a connector. */
const MAILBOX_PROVIDERS = new Set(["gmail", "outlook"]);

/** The anchor as the browser matches it against ids: percent-decoded, without the "#". */
function anchorOf(hash: string): string {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** The tab an anchor names, or null. `#source-<id>`, a link to one source's card, names the sources tab. */
function tabForAnchor(tabs: ReadonlyArray<Pick<IntegrationsTab, "id" | "aliases">>, anchor: string): string | null {
  const name = anchor.startsWith("source-") ? "sources" : anchor;
  return tabs.find((tab) => tab.id === name || tab.aliases?.includes(name))?.id ?? null;
}

/** The anchor a query string implies when the URL has none of its own, or null. */
function anchorForQuery(search: string): string | null {
  const params = new URLSearchParams(search);
  const provider = params.get("integration");
  if (provider !== null) return MAILBOX_PROVIDERS.has(provider) ? "mailboxes" : "connectors";
  for (const key of params.keys()) {
    const match = LIST_PREFIX_ANCHOR.find(([prefix]) => key.startsWith(prefix));
    if (match) return match[1];
  }
  return null;
}

/**
 * Which tab a URL opens: the one its anchor names, else the one its query implies,
 * else the first. `tabs` must not be empty.
 */
export function integrationsTabFor(
  tabs: ReadonlyArray<Pick<IntegrationsTab, "id" | "aliases">>,
  search: string,
  hash: string,
): string {
  const fromAnchor = tabForAnchor(tabs, anchorOf(hash));
  if (fromAnchor) return fromAnchor;
  const implied = anchorForQuery(search);
  return (implied && tabForAnchor(tabs, implied)) ?? tabs[0].id;
}

// A tab change is a pushState, which fires no event, so the store tells its own listeners.
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  window.addEventListener("hashchange", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
    window.removeEventListener("hashchange", listener);
  };
}

function goTo(anchor: string, mode: "push" | "replace") {
  const { pathname, search } = window.location;
  const url = `${pathname}${search}#${anchor}`;
  // Next.js keeps its router state on both, so back and forward stay client-side.
  if (mode === "push") window.history.pushState(null, "", url);
  else window.history.replaceState(window.history.state, "", url);
  listeners.forEach((listener) => listener());
}

const TAB =
  "inline-flex min-h-10 items-center rounded-full px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info";

export function IntegrationsTabs({ tabs, className = "" }: { tabs: IntegrationsTab[]; className?: string }) {
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const getSnapshot = useCallback(() => integrationsTabFor(tabs, window.location.search, window.location.hash), [tabs]);
  // Null on the server and while hydrating: no tab is chosen until the anchor is read.
  const active = useSyncExternalStore(subscribe, getSnapshot, () => null);

  // Write the chosen tab into a URL that did not name it, before any panel's own
  // effects run: the connector card clears `?integration=` once it has read it, and
  // the tab must not fall back to the first when it does.
  useLayoutEffect(() => {
    if (active === null) return;
    if (tabForAnchor(tabs, anchorOf(window.location.hash)) !== active) goTo(active, "replace");
  }, [active, tabs]);

  function select(id: string) {
    if (id !== active) goTo(id, "push");
  }

  // Arrow keys, Home and End move focus along the tabs; Enter or Space opens one.
  // Opening on focus would mount, and fetch, every panel the arrows pass over.
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = tabs.length - 1;
    const to =
      event.key === "ArrowRight"
        ? index === last
          ? 0
          : index + 1
        : event.key === "ArrowLeft"
          ? index === 0
            ? last
            : index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (to === null) return;
    event.preventDefault();
    tabRefs.current.get(tabs[to].id)?.focus();
  }

  const current = tabs.find((tab) => tab.id === active);

  return (
    <div className={className}>
      <div className="max-w-full overflow-x-auto [scrollbar-width:none]">
        {/* One row that scrolls sideways on a phone, rather than a block of wrapped pills. */}
        <div
          role="tablist"
          aria-label="Integrations"
          className="inline-flex gap-1 whitespace-nowrap rounded-full border border-divider bg-fg/[0.03] p-1"
        >
          {tabs.map((tab, index) => {
            const selected = tab.id === active;
            return (
              <button
                key={tab.id}
                ref={(node) => {
                  if (node) tabRefs.current.set(tab.id, node);
                  else tabRefs.current.delete(tab.id);
                }}
                type="button"
                role="tab"
                id={`tab-${tab.id}`}
                aria-selected={selected}
                aria-controls={selected ? `tabpanel-${tab.id}` : undefined}
                // Before a tab is chosen the first one takes focus, so Tab still reaches the row.
                tabIndex={selected || (active === null && index === 0) ? 0 : -1}
                onClick={() => select(tab.id)}
                onKeyDown={(event) => onKeyDown(event, index)}
                className={`${TAB} ${selected ? "bg-accent/15 text-fg dark:text-accent" : "text-fg-subtle hover:bg-fg/[0.05] hover:text-fg"}`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {current ? (
        <div
          role="tabpanel"
          id={`tabpanel-${current.id}`}
          aria-labelledby={`tab-${current.id}`}
          tabIndex={0}
          className="mt-8 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-info sm:mt-10"
        >
          {current.panel}
        </div>
      ) : (
        <div role="status" className="mt-8 py-10 text-center text-sm text-fg-subtle sm:mt-10">
          Loading…
        </div>
      )}
    </div>
  );
}
