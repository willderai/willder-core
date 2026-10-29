"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { displayWriterLabel, tokenShortId } from "@/components/audit/format";
import { WriterLabel } from "@/components/audit/writer-label";
import { SearchField } from "./search-field";

// The sidebar search box: scopes, agents, tokens, sources and audit rows of the
// active org, from GET /api/access/search. The server decides what each kind
// may return; this component shows a kind it was refused as refused, never as
// "no matches", and drops any response that arrives for an older query.

const MIN_QUERY = 2;
const DEBOUNCE_MS = 250;

type Kind<T> = { denied: true } | { denied: false; items: T[]; hasMore: boolean };
type Results = {
  scopes: Kind<{ id: string; name: string; path: string }>;
  agents: Kind<{ id: string; name: string; agentKey: string }>;
  tokens: Kind<{ id: string; agentId: string; status: string }>;
  sources: Kind<{ id: string; name: string; type: string }>;
  audit: Kind<{ id: string; actorName: string; action: string; target: string | null; decision: "allow" | "deny" }>;
};
/** One result. An audit hit names its writer in `writer` (drawn by WriterLabel, so the
 * marker that sets a custom agent apart is never pushed off by the text around it) and
 * the action in `label`. */
type Row = { key: string; href: string; label: string; writer?: string; detail?: string; deny?: boolean };
type Group = { title: string; rows: Row[]; hasMore: boolean; seeAll?: string };

const KIND_TITLES: Record<keyof Results, string> = {
  scopes: "Scopes",
  agents: "Agents",
  tokens: "Tokens",
  sources: "Sources",
  audit: "Audit rows",
};

function accessHref(tab: string, q: string) {
  return `/access?tab=${tab}&q=${encodeURIComponent(q)}`;
}

/** Turns the API response into display groups, in the sidebar's fixed order. */
function toGroups(results: Results, q: string): { groups: Group[]; denied: string[] } {
  const groups: Group[] = [];
  const denied: string[] = [];
  function add<T>(kind: keyof Results, value: Kind<T>, row: (item: T) => Row, seeAll?: string) {
    if (value.denied) {
      denied.push(KIND_TITLES[kind].toLowerCase());
      return;
    }
    if (value.items.length === 0) return;
    groups.push({ title: KIND_TITLES[kind], rows: value.items.map(row), hasMore: value.hasMore, seeAll });
  }
  add(
    "scopes",
    results.scopes,
    (s) => ({ key: s.id, href: accessHref("scopes", s.name), label: s.name, detail: s.path }),
    accessHref("scopes", q),
  );
  add("agents", results.agents, (a) => ({
    key: a.id,
    href: `/agents/${a.id}`,
    label: displayWriterLabel(a.name),
    detail: a.agentKey,
  }));
  add(
    "tokens",
    results.tokens,
    (t) => ({
      key: t.id,
      href: accessHref("tokens", tokenShortId(t.id)),
      label: `Token ${tokenShortId(t.id)}`,
      detail: `${t.agentId} · ${t.status}`,
    }),
    accessHref("tokens", q),
  );
  add("sources", results.sources, (s) => ({
    key: s.id,
    href: "/integrations#sources",
    label: displayWriterLabel(s.name),
    detail: s.type,
  }));
  add(
    "audit",
    results.audit,
    (r) => ({
      key: r.id,
      href: accessHref("audit", q),
      writer: r.actorName,
      label: r.action,
      detail: r.target ?? undefined,
      deny: r.decision === "deny",
    }),
    accessHref("audit", q),
  );
  return { groups, denied };
}

/** The server's answer to one query. Anything not answering the current query
 * is never shown: the box reads "Searching…" until the right answer lands. */
type Answer = { q: string; results: Results } | { q: string; failed: true };

export function NavSearch({
  collapsed,
  onExpand,
  onNavigate,
}: {
  /** The rail shows only a button; pressing it expands the sidebar and focuses the box. */
  collapsed: boolean;
  onExpand: () => void;
  /** Called after a result is chosen, so a phone's overlay sidebar can close. */
  onNavigate: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [shownOn, setShownOn] = useState(pathname);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const focusOnExpand = useRef(false);

  const trimmed = query.trim();

  useEffect(() => {
    if (!collapsed && focusOnExpand.current) {
      focusOnExpand.current = false;
      inputRef.current?.focus();
    }
  }, [collapsed]);

  // Closing drops the answer, so reopening (after an org switch, say) fetches
  // afresh instead of showing rows from the org that was active before.
  function close() {
    setOpen(false);
    setAnswer(null);
  }

  // A new page, including the /dashboard an org switch lands on, closes the panel.
  if (pathname !== shownOn) {
    setShownOn(pathname);
    close();
  }

  useEffect(() => {
    if (!open || trimmed.length < MIN_QUERY) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/access/search?q=${encodeURIComponent(trimmed)}`, { signal: controller.signal });
        const results = res.ok ? ((await res.json()) as Results) : null;
        if (controller.signal.aborted) return;
        setAnswer(results ? { q: trimmed, results } : { q: trimmed, failed: true });
      } catch {
        if (!controller.signal.aborted) setAnswer({ q: trimmed, failed: true });
      }
    }, DEBOUNCE_MS);
    // Aborting drops the in-flight response, so a slow answer to "sal" can
    // never replace the answer to "sales".
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, trimmed]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) close();
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  if (collapsed) {
    return (
      <button
        type="button"
        aria-label="Search"
        title="Search"
        onClick={() => {
          focusOnExpand.current = true;
          onExpand();
        }}
        className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl text-fg-subtle transition-colors hover:bg-fg/[0.04] hover:text-accent"
      >
        <Search size={18} strokeWidth={1.6} aria-hidden />
      </button>
    );
  }

  const current = answer?.q === trimmed ? answer : null;
  const view = current && !("failed" in current) ? toGroups(current.results, current.q) : null;
  const firstHref = view?.groups[0]?.rows[0]?.href;

  function choose(href: string) {
    close();
    onNavigate();
    router.push(href);
  }

  return (
    <div ref={rootRef} className="relative">
      <SearchField
        ref={inputRef}
        value={query}
        onChange={(value) => {
          setQuery(value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            close();
            return;
          }
          if (event.key === "Enter" && firstHref) {
            event.preventDefault();
            choose(firstHref);
          }
        }}
        label="Search scopes, agents, tokens, sources and audit"
        placeholder="Search access"
      />
      {open && trimmed.length >= MIN_QUERY && (
        <div
          role="region"
          aria-label="Search results"
          aria-live="polite"
          className="absolute left-0 top-full z-50 mt-2 max-h-[min(28rem,70vh)] w-[min(20rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-divider bg-overlay p-2 shadow-2xl"
        >
          {!current && <p className="px-2 py-3 text-sm text-fg-subtle">Searching…</p>}
          {current && "failed" in current && <p className="px-2 py-3 text-sm text-danger">Search failed. Try again.</p>}
          {view && view.groups.length === 0 && (
            <p className="px-2 py-3 text-sm text-fg-subtle">No matches for &ldquo;{trimmed}&rdquo;.</p>
          )}
          {view?.groups.map((group) => (
            <div key={group.title} className="py-1">
              <p className="flex items-center justify-between px-2 pb-1 text-eyebrow font-semibold uppercase tabular-nums text-fg-subtle">
                <span>{group.title}</span>
                <span>
                  {group.rows.length}
                  {group.hasMore ? "+" : ""}
                </span>
              </p>
              <ul>
                {group.rows.map((row) => (
                  <li key={row.key}>
                    <Link
                      href={row.href}
                      onClick={() => {
                        close();
                        onNavigate();
                      }}
                      className="flex flex-col rounded-lg px-2 py-1.5 hover:bg-fg/[0.05]"
                    >
                      {row.writer !== undefined ? (
                        <span className={`flex min-w-0 text-sm ${row.deny ? "text-danger" : "text-fg"}`}>
                          {row.deny && <span className="shrink-0 whitespace-pre">Denied: </span>}
                          <WriterLabel label={row.writer} />
                          <span className="min-w-0 shrink-[2] truncate whitespace-pre"> · {row.label}</span>
                        </span>
                      ) : (
                        <span className={`truncate text-sm ${row.deny ? "text-danger" : "text-fg"}`}>
                          {row.deny ? "Denied: " : ""}
                          {row.label}
                        </span>
                      )}
                      {row.detail && <span className="truncate font-mono text-xs text-fg-subtle">{row.detail}</span>}
                    </Link>
                  </li>
                ))}
              </ul>
              {group.hasMore && group.seeAll && (
                <Link
                  href={group.seeAll}
                  onClick={() => {
                    close();
                    onNavigate();
                  }}
                  className="block px-2 py-1 text-sm text-accent hover:underline"
                >
                  See all on Access
                </Link>
              )}
            </div>
          ))}
          {view && view.denied.length > 0 && (
            <p className="border-t border-divider px-2 pt-2 text-sm text-fg-subtle">
              Not searched: {view.denied.join(", ")}. Your role cannot list them.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
