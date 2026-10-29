"use client";

// The Explore page: what memory holds in one scope, one tab per kind of stored memory.
//
// Every tab but Graph lists one store from GET /api/memory/stores; Graph is the
// existing explorer. Each list has the shared list toolbar: its search, filter, order
// and pages run on the server (?list=), because the lists are paged and only the
// server can leave out rows outside the scope before it counts. Until something
// narrows, reorders or pages a list, it shows the newest rows the overview already
// carries. The Text passages tab also searches by meaning, with the same read as Ask
// (POST /api/memory/query), and lists its vector hits with their similarity.
//
// Each tab's label carries its count for the selected scope; a count that has not
// loaded, or failed, is left off rather than shown as zero. The active tab (?tab=)
// and each list's page (?<list>.page=) are in the URL, so a link, reload, back and
// forward reopen the same view. Every response is tied to the scope it was requested
// for, so a slow answer for a previous scope never fills the current one.

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Search } from "lucide-react";
import type { MemoryFact, SearchResult, StoreChunk, StoresOverview } from "@/types/memory";
import type { StoreList } from "@/lib/memory-store-lists";
import { Button, Card, Tabs, tabId, tabPanelId } from "@/components/ui";
import { HelpTip } from "@/components/help";
import { displayWriterLabel, fmt } from "@/components/audit/format";
import { GraphExplorer } from "./graph-explorer";
import { ScopePicker } from "./scope-picker";
import { BriefsList, ChunksList, FilesList, NotesList, RecordsList, RulesList } from "./store-rows";
import { BRIEF_LIST, CHUNK_LIST, FILE_LIST, NOTE_LIST, RECORD_LIST, RULE_LIST } from "./store-list-configs";
import { clearListPages, Empty, ErrorState, fetchJson, StoreListTab, useUrlParam } from "./store-list-tab";

type StoreTab = StoreList | "graph";

/** The tabs in order, each with the one line that says what the store holds. The first is the default. */
const STORE_TABS: { key: StoreTab; label: string; explainer: string }[] = [
  {
    key: "rules",
    label: "Rules and decisions",
    explainer:
      "Conventions and decisions agents are given before they start work in a scope. Replaced and retired versions stay listed, marked as such.",
  },
  {
    key: "notes",
    label: "Working notes",
    explainer:
      "Short notes agents post while they work: a claim on a task, an intent, a status or a question. Each is live for at most four hours.",
  },
  {
    key: "briefs",
    label: "Briefs",
    explainer: "Handoffs, architecture plans and QA reviews generated from what memory holds in a scope.",
  },
  {
    key: "chunks",
    label: "Text passages",
    explainer:
      "Text stored for search, from uploads, connected sources and agent writes. Search them by words or by meaning.",
  },
  { key: "graph", label: "Graph", explainer: "People, projects and other entities, and the facts that link them." },
  {
    key: "files",
    label: "Files",
    explainer: "Files a connected source synced, with how many text passages each produced.",
  },
  {
    key: "records",
    label: "Sources and contacts",
    explainer:
      "The sources connected to memory and the people in your contacts. Contacts are org-wide, so they are listed only at the org root.",
  },
];

const TAB_PARAM = "tab";
const TAB_ID_PREFIX = "memory-store";

/** Must match GraphExplorer's own request so both describe the same graph. */
const GRAPH_NODE_LIMIT = 300;

type Loaded<T> =
  | { scope: string | null; state: "ok"; value: T }
  | { scope: string | null; state: "error"; error: string };

const isStoreTab = (key: string | null): key is StoreTab => STORE_TABS.some((t) => t.key === key);

export function MemoryStores({
  initialScope,
  canDelete,
  canWrite,
  canManageScopes,
}: {
  initialScope: string | null;
  canDelete: boolean;
  canWrite: boolean;
  canManageScopes: boolean;
}) {
  const [scope, setScope] = useState<string | null>(initialScope);
  const [tabParam, setTabParam] = useUrlParam(TAB_PARAM, "push");
  const tab: StoreTab = isStoreTab(tabParam) ? tabParam : STORE_TABS[0].key;
  const [overview, setOverview] = useState<Loaded<StoresOverview> | null>(null);
  const [nodes, setNodes] = useState<Loaded<number> | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    // Settle a request only while its scope is still the one on screen.
    const settle = <T,>(request: Promise<T>, set: (loaded: Loaded<T>) => void) =>
      request.then(
        (value) => {
          if (!controller.signal.aborted) set({ scope, state: "ok", value });
        },
        (e: Error) => {
          if (!controller.signal.aborted) set({ scope, state: "error", error: e.message });
        },
      );
    const scopeQs = scope ? `scope=${encodeURIComponent(scope)}` : "";
    settle(
      fetchJson<StoresOverview>(`/api/memory/stores${scopeQs ? `?${scopeQs}` : ""}`, controller.signal),
      setOverview,
    );
    settle(
      fetchJson<{ nodes: unknown[] }>(
        `/api/memory/graph?limit=${GRAPH_NODE_LIMIT}${scopeQs ? `&${scopeQs}` : ""}`,
        controller.signal,
      ).then((graph) => graph.nodes.length),
      setNodes,
    );
    return () => controller.abort();
  }, [scope]);

  // Another scope's lists start again at their first page.
  const changeScope = (next: string | null) => {
    clearListPages();
    setScope(next);
  };

  // Until the new scope's responses arrive, the previous scope's are not shown.
  const current = overview?.scope === scope ? overview : null;
  const nodeCount = nodes?.scope === scope ? nodes : null;
  const active = STORE_TABS.find((t) => t.key === tab)!;
  const tabs = STORE_TABS.map((t) => ({ key: t.key, label: t.label, badge: tabCount(t.key, current, nodeCount) }));

  return (
    <div className="mt-4 flex flex-col gap-4 sm:mt-6">
      <div className="flex flex-wrap items-center gap-3">
        <HelpTip tip="Select a memory scope. Every tab and count shows only what you can read in it.">
          <ScopePicker selected={scope} onChange={changeScope} manageable={canManageScopes} />
        </HelpTip>
      </div>

      <Tabs
        items={tabs}
        value={tab}
        onChange={(key) => setTabParam(key === STORE_TABS[0].key ? null : key)}
        label="Kinds of memory"
        idPrefix={TAB_ID_PREFIX}
        className="self-start"
      />

      <div
        role="tabpanel"
        id={tabPanelId(TAB_ID_PREFIX, tab)}
        aria-labelledby={tabId(TAB_ID_PREFIX, tab)}
        className="flex flex-col gap-4"
      >
        <p className="text-sm text-fg-muted">{active.explainer}</p>
        {tab === "graph" ? (
          <GraphExplorer key={scope ?? ""} scope={scope} canDelete={canDelete} canWrite={canWrite} />
        ) : current === null ? (
          <p role="status" className="py-10 text-center text-sm text-fg-muted">
            Loading…
          </p>
        ) : current.state === "error" ? (
          <ErrorState message={current.error} />
        ) : tab === "chunks" ? (
          <ChunksTab
            key={scope ?? ""}
            scope={scope}
            chunks={current.value.chunks}
            total={current.value.counts.chunks}
          />
        ) : (
          <StoreTabList key={`${tab}:${scope ?? ""}`} list={tab} scope={scope} overview={current.value} />
        )}
      </div>
    </div>
  );
}

/** A tab's count for its label: "12", "300+" at the graph cap, or nothing while it loads or after it failed. */
function tabCount(
  tab: StoreTab,
  overview: Loaded<StoresOverview> | null,
  nodes: Loaded<number> | null,
): string | undefined {
  if (tab === "graph") {
    if (nodes?.state !== "ok") return undefined;
    return nodes.value >= GRAPH_NODE_LIMIT ? `${GRAPH_NODE_LIMIT}+` : nodes.value.toLocaleString();
  }
  if (overview?.state !== "ok") return undefined;
  const count = overview.value.counts[tab].toLocaleString();
  return (overview.value.lowerBounds as string[]).includes(tab) ? `${count}+` : count;
}

/** The list for one store tab other than Text passages, which adds its search by meaning. */
function StoreTabList({
  list,
  scope,
  overview,
}: {
  list: Exclude<StoreList, "chunks">;
  scope: string | null;
  overview: StoresOverview;
}) {
  const shared = { scope, total: overview.counts[list] };
  switch (list) {
    case "rules":
      return (
        <StoreListTab
          {...shared}
          list="rules"
          config={RULE_LIST}
          newest={overview.rules}
          empty="No rules or decisions in this scope yet. Agents record them with the memory_record_convention tool."
          render={(rules) => <RulesList rules={rules} />}
        />
      );
    case "notes":
      return (
        <StoreListTab
          {...shared}
          list="notes"
          config={NOTE_LIST}
          newest={overview.notes}
          empty="No working notes in this scope yet. Agents post them while they work."
          render={(notes) => <NotesList notes={notes} />}
        />
      );
    case "briefs":
      return (
        <StoreListTab
          {...shared}
          list="briefs"
          config={BRIEF_LIST}
          newest={overview.briefs}
          empty="No briefs in this scope yet. Run a Handoff, Architecture or QA agent to generate one."
          render={(briefs) => <BriefsList briefs={briefs} />}
        />
      );
    case "files":
      return (
        <StoreListTab
          {...shared}
          list="files"
          config={FILE_LIST}
          newest={overview.files}
          empty="No files yet. Files from connected sources appear here; uploaded text is stored as text passages."
          render={(files) => <FilesList files={files} />}
        />
      );
    case "records":
      return (
        <StoreListTab
          {...shared}
          list="records"
          config={RECORD_LIST}
          newest={overview.records}
          empty="No sources or contacts in this scope yet."
          render={(records) => <RecordsList records={records} />}
        />
      );
  }
}

/** Enough candidates that vector hits are not crowded out by graph facts in the merged read. */
const CHUNK_SEARCH_LIMIT = 50;

type ChunkSearch =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "hits"; hits: MemoryFact[] }
  | { state: "not-asked" }
  | { state: "error"; error: string };

/** Runs the Ask read in `scope` and keeps its vector hits, best match first. */
async function searchChunks(query: string, scope: string | null, signal: AbortSignal): Promise<ChunkSearch> {
  const res = await fetch("/api/memory/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, scope: scope ?? undefined, limit: CHUNK_SEARCH_LIMIT }),
    signal,
  });
  const body = (await res.json().catch(() => ({}))) as SearchResult & { error?: string };
  if (!res.ok)
    throw new Error(res.status === 403 ? "You don't have access to this scope." : (body.error ?? "Search failed."));
  const vector = body.breakdown?.stores.find((s) => s.store === "semantic");
  if (!vector) return { state: "not-asked" };
  if (vector.failed) return { state: "error", error: "Vector search is unavailable right now." };
  // The read ranks by provenance tier; this list is about similarity alone.
  const hits = body.facts
    .filter((f) => f.store === "semantic")
    .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
  return { state: "hits", hits };
}

/**
 * The chunk list, with the shared toolbar for text search, and a second search by
 * meaning that runs the Ask read. Keyed by scope by its parent, so a scope change
 * drops both searches and aborts their requests.
 */
function ChunksTab({ scope, chunks, total }: { scope: string | null; chunks: StoreChunk[]; total: number }) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<ChunkSearch>({ state: "idle" });
  const inFlight = useRef<AbortController | null>(null);
  useEffect(() => () => inFlight.current?.abort(), []);

  const run = (event: FormEvent) => {
    event.preventDefault();
    inFlight.current?.abort();
    const trimmed = query.trim();
    if (!trimmed) {
      setSearch({ state: "idle" });
      return;
    }
    const controller = new AbortController();
    inFlight.current = controller;
    setSearch({ state: "loading" });
    searchChunks(trimmed, scope, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) setSearch(result);
      },
      (e: Error) => {
        if (!controller.signal.aborted) setSearch({ state: "error", error: e.message });
      },
    );
  };

  const byMeaning = (
    <form
      role="search"
      aria-label="Search text passages by meaning"
      onSubmit={run}
      className="flex flex-wrap items-center gap-2"
    >
      <input
        type="search"
        aria-label="Search text passages by meaning"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Or search by meaning, the way Ask does…"
        className="min-h-11 min-w-0 flex-1 rounded-xl border border-[var(--field-border)] bg-[var(--field-background)] px-4 py-2 text-sm text-fg transition-colors placeholder:text-[var(--field-placeholder)] hover:border-[var(--field-border-hover)] focus-visible:border-[var(--field-border-focus)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info"
      />
      <Button type="submit" variant="ghost" size="sm" className="gap-1.5">
        <Search size={14} aria-hidden="true" /> Search by meaning
      </Button>
    </form>
  );

  if (search.state === "idle") {
    return (
      <StoreListTab
        scope={scope}
        list="chunks"
        config={CHUNK_LIST}
        newest={chunks}
        total={total}
        empty="No text passages yet. Upload a file or connect a source."
        render={(items) => <ChunksList chunks={items} />}
        before={total > 0 ? byMeaning : null}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {byMeaning}
      <button
        type="button"
        onClick={() => {
          inFlight.current?.abort();
          setQuery("");
          setSearch({ state: "idle" });
        }}
        className="self-start text-sm text-accent underline-offset-4 hover:underline"
      >
        Back to the passage list
      </button>
      {search.state === "loading" ? (
        <p className="py-10 text-center text-sm text-fg-muted">Searching…</p>
      ) : search.state === "error" ? (
        <ErrorState message={search.error} />
      ) : search.state === "not-asked" ? (
        <Empty>
          This question was not sent to vector search, so no text passages were scored. Questions like &ldquo;who
          is&hellip;&rdquo; are answered from the graph, and some plans do not include vector search.
        </Empty>
      ) : (
        <ChunkHits hits={search.hits} />
      )}
    </div>
  );
}

function ChunkHits({ hits }: { hits: MemoryFact[] }) {
  if (hits.length === 0) return <Empty>No text passages match in this scope.</Empty>;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-fg-subtle">
        {hits.length} matching {hits.length === 1 ? "text passage" : "text passages"}, best first.
      </p>
      <Card className="divide-y divide-divider">
        {hits.map((h) => (
          <div key={h.uuid} className="flex flex-col gap-2 px-5 py-4">
            <p className="whitespace-pre-line break-words text-sm leading-relaxed text-fg">{h.fact}</p>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-mono text-xs text-info">similarity {(h.similarity ?? 0).toFixed(2)}</span>
              {h.excerptOfChars && (
                <span className="text-sm text-fg-subtle">
                  excerpt of {h.excerptOfChars.toLocaleString("en-US")} characters
                </span>
              )}
              {h.actorName && (
                <span className="break-words text-sm text-fg-muted">{displayWriterLabel(h.actorName)}</span>
              )}
              {h.validAt && (
                <span className="font-mono text-xs text-fg-subtle">
                  {h.validAtSource === "occurred" ? "occurred" : "ingested"} {fmt(h.validAt)}
                </span>
              )}
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}
