import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { StoresOverview } from "@/types/memory";
import { MemoryStores } from "./memory-stores";

vi.mock("@/components/help", () => ({ HelpTip: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("./graph-explorer", () => ({
  GraphExplorer: ({ scope }: { scope: string | null }) => <div>Graph for {scope ?? "root"}</div>,
}));
vi.mock("./scope-picker", () => ({
  ScopePicker: ({ selected, onChange }: { selected: string | null; onChange: (value: string | null) => void }) => (
    <select aria-label="Scope" value={selected ?? ""} onChange={(event) => onChange(event.target.value || null)}>
      <option value="">Organization root</option>
      <option value="org_1.sales">Sales</option>
      <option value="org_1.support">Support</option>
    </select>
  ),
}));

beforeEach(() => window.history.replaceState(null, "", "/memory/explore"));
afterEach(() => vi.unstubAllGlobals());

const NO_COUNTS = { records: 0, briefs: 0, rules: 0, notes: 0, chunks: 0, files: 0 };

/** An overview whose one rule is titled `subject`, the default tab's list. */
function overview(scope: string, subject: string, counts: Partial<StoresOverview["counts"]> = {}): StoresOverview {
  return {
    scope,
    counts: { ...NO_COUNTS, rules: 1, ...counts },
    lowerBounds: [],
    records: [],
    briefs: [],
    rules: [
      {
        id: subject,
        kind: "convention",
        subject,
        text: "Text",
        status: "in_force",
        scopePath: scope,
        scopeName: null,
        createdAt: "2026-09-29T10:00:00.000Z",
      },
    ],
    notes: [],
    chunks: [],
    files: [],
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** A fetch whose responses resolve only when the test says so, keyed by URL. */
function controllableFetch() {
  const pending = new Map<string, (res: Response) => void>();
  const fetchMock = vi.fn(
    (url: string, _init?: RequestInit) => new Promise<Response>((resolve) => pending.set(url, resolve)),
  );
  const respond = async (url: string, res: Response) => {
    await act(async () => pending.get(url)!(res));
  };
  return { fetchMock, respond };
}

const props = { canDelete: false, canWrite: false, canManageScopes: false };

describe("MemoryStores", () => {
  it("shows each store's count in its tab, and a graph at the node cap as a floor, not an exact figure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.startsWith("/api/memory/stores")
          ? json(
              overview("org_1.sales", "Launch plan", {
                records: 4,
                briefs: 2,
                rules: 12,
                notes: 3,
                chunks: 1340,
                files: 9,
              }),
            )
          : json({ nodes: Array.from({ length: 300 }, (_, i) => ({ uuid: String(i) })), edges: [] }),
      ),
    );
    render(<MemoryStores initialScope="org_1.sales" {...props} />);
    expect(await screen.findByText("Launch plan")).toBeTruthy();
    await screen.findByRole("tab", { name: "Graph 300+" });
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Rules and decisions 12",
      "Working notes 3",
      "Briefs 2",
      "Text passages 1,340",
      "Graph 300+",
      "Files 9",
      "Sources and contacts 4",
    ]);
    // A store that fits on one page needs no pager.
    expect(screen.queryByRole("navigation", { name: /^Pages of/ })).toBeNull();
  });

  it("says a failed store is unavailable instead of showing zero", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.startsWith("/api/memory/stores") ? json({ error: "no grant" }, 403) : json({ nodes: [], edges: [] }),
      ),
    );
    render(<MemoryStores initialScope="org_1.sales" {...props} />);
    expect((await screen.findByRole("alert")).textContent).toContain("You don't have access to this scope.");
    await screen.findByRole("tab", { name: "Graph 0" });
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Rules and decisions",
      "Working notes",
      "Briefs",
      "Text passages",
      "Graph 0",
      "Files",
      "Sources and contacts",
    ]);
  });

  it("never fills the current scope with a late response for the previous one", async () => {
    const { fetchMock, respond } = controllableFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryStores initialScope="org_1.sales" {...props} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Scope" }), { target: { value: "org_1.support" } });
    await respond("/api/memory/stores?scope=org_1.support", json(overview("org_1.support", "Support runbook")));
    await respond("/api/memory/stores?scope=org_1.sales", json(overview("org_1.sales", "Sales pipeline")));

    expect(await screen.findByText("Support runbook")).toBeTruthy();
    expect(screen.queryByText("Sales pipeline")).toBeNull();
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("shows each store's empty state and keeps the graph explorer in its own tab", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.startsWith("/api/memory/stores")
          ? json({
              scope: "org_1",
              counts: NO_COUNTS,
              lowerBounds: [],
              records: [],
              briefs: [],
              rules: [],
              notes: [],
              chunks: [],
              files: [],
            })
          : json({ nodes: [], edges: [] }),
      ),
    );
    render(<MemoryStores initialScope={null} {...props} />);
    expect(await screen.findByText(/^No rules or decisions in this scope yet\./)).toBeTruthy();
    const empties: [RegExp, RegExp][] = [
      [/^Working notes/, /^No working notes in this scope yet\./],
      [/^Briefs/, /^No briefs in this scope yet\./],
      [/^Text passages/, /^No text passages yet\./],
      [/^Files/, /^No files yet\./],
      [/^Sources and contacts/, /^No sources or contacts in this scope yet\./],
    ];
    for (const [tab, empty] of empties) {
      fireEvent.click(screen.getByRole("tab", { name: tab }));
      expect(screen.getByText(empty)).toBeTruthy();
      expect(screen.queryByRole("navigation", { name: /^Pages of/ })).toBeNull();
    }
    fireEvent.click(screen.getByRole("tab", { name: /^Graph/ }));
    expect(screen.getByText("Graph for root")).toBeTruthy();
  });
});

describe("MemoryStores: Text passages search", () => {
  const withChunks = (scope: string): StoresOverview => ({
    ...overview(scope, "Launch plan", { chunks: 1 }),
    chunks: [
      {
        id: "c-list",
        snippet: "Listed chunk",
        source: "upload",
        author: null,
        scopePath: scope,
        scopeName: null,
        createdAt: "2026-09-29T10:00:00.000Z",
        supersededById: null,
      },
    ],
  });
  const searchChunks = (query: string) => {
    const box = screen.getByRole("searchbox", { name: "Search text passages by meaning" });
    fireEvent.change(box, { target: { value: query } });
    fireEvent.submit(box.closest("form")!);
  };

  it("runs the Ask query in the selected scope and lists only vector hits, each with its similarity score", async () => {
    const queries: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/memory/query") {
          queries.push(JSON.parse(init!.body as string));
          return json({
            facts: [
              { uuid: "e1", fact: "Graph edge about pricing", validAt: null, store: "graph" },
              // Out of similarity order, as the read's provenance ranking can return them.
              {
                uuid: "c2",
                fact: "Annual plans get two months free",
                validAt: null,
                store: "semantic",
                similarity: 0.52,
              },
              {
                uuid: "c1",
                fact: "Pricing tiers are 29 and 99",
                validAt: "2026-09-28T10:00:00.000Z",
                store: "semantic",
                similarity: 0.8134,
              },
            ],
            breakdown: {
              stores: [
                { store: "graph", hits: 1 },
                { store: "semantic", hits: 2 },
              ],
              contextTokens: 20,
            },
          });
        }
        return url.startsWith("/api/memory/stores") ? json(withChunks("org_1.sales")) : json({ nodes: [], edges: [] });
      }),
    );
    render(<MemoryStores initialScope="org_1.sales" {...props} />);
    fireEvent.click(await screen.findByRole("tab", { name: /^Text passages/ }));
    searchChunks("pricing");

    expect(await screen.findByText("Pricing tiers are 29 and 99")).toBeTruthy();
    expect(queries).toEqual([{ query: "pricing", scope: "org_1.sales", limit: 50 }]);
    expect(screen.getAllByText(/^similarity /).map((el) => el.textContent)).toEqual([
      "similarity 0.81",
      "similarity 0.52",
    ]);
    expect(screen.queryByText("Graph edge about pricing")).toBeNull();
    expect(screen.queryByText("Listed chunk")).toBeNull();
    expect(screen.getByText("2 matching text passages, best first.")).toBeTruthy();
  });

  it("labels a hit's date as when it occurred when the writer stated one, else as when it was ingested", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/memory/query") {
          return json({
            facts: [
              {
                uuid: "c1",
                fact: "Visit moved to Friday",
                validAt: "2026-03-13T15:00:00.000Z",
                validAtSource: "occurred",
                store: "semantic",
                similarity: 0.8,
              },
              {
                uuid: "c2",
                fact: "Portal enabled",
                validAt: "2026-03-14T10:00:00.000Z",
                validAtSource: "stored",
                store: "semantic",
                similarity: 0.7,
              },
            ],
            breakdown: { stores: [{ store: "semantic", hits: 2 }], contextTokens: 8 },
          });
        }
        return url.startsWith("/api/memory/stores") ? json(withChunks("org_1.sales")) : json({ nodes: [], edges: [] });
      }),
    );
    render(<MemoryStores initialScope="org_1.sales" {...props} />);
    fireEvent.click(await screen.findByRole("tab", { name: /^Text passages/ }));
    searchChunks("visit");

    expect(await screen.findByText("Visit moved to Friday")).toBeTruthy();
    expect(screen.getAllByText(/^(occurred|ingested) /).map((el) => el.textContent?.split(" ")[0])).toEqual([
      "occurred",
      "ingested",
    ]);
  });

  it("says a hit served as an excerpt is one, with the chunk's full length", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/memory/query") {
          return json({
            facts: [
              { uuid: "c1", fact: "Portal enabled", validAt: null, store: "semantic", similarity: 0.8 },
              {
                uuid: "c2",
                fact: "… The release train leaves on Tuesday. …",
                validAt: null,
                store: "semantic",
                similarity: 0.7,
                excerptOfChars: 67716,
              },
            ],
            breakdown: { stores: [{ store: "semantic", hits: 2 }], contextTokens: 8 },
          });
        }
        return url.startsWith("/api/memory/stores") ? json(withChunks("org_1.sales")) : json({ nodes: [], edges: [] });
      }),
    );
    render(<MemoryStores initialScope="org_1.sales" {...props} />);
    fireEvent.click(await screen.findByRole("tab", { name: /^Text passages/ }));
    searchChunks("release train");

    expect(await screen.findByText("… The release train leaves on Tuesday. …")).toBeTruthy();
    expect(screen.getAllByText(/^excerpt of /).map((el) => el.textContent)).toEqual(["excerpt of 67,716 characters"]);
  });

  it("says vector search failed rather than that nothing matched", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/api/memory/query"
          ? json({
              facts: [],
              breakdown: {
                stores: [
                  { store: "graph", hits: 0 },
                  { store: "semantic", hits: 0, failed: true },
                ],
                contextTokens: 0,
              },
            })
          : url.startsWith("/api/memory/stores")
            ? json(withChunks("org_1.sales"))
            : json({ nodes: [], edges: [] }),
      ),
    );
    render(<MemoryStores initialScope="org_1.sales" {...props} />);
    fireEvent.click(await screen.findByRole("tab", { name: /^Text passages/ }));
    searchChunks("pricing");

    expect((await screen.findByRole("alert")).textContent).toContain("Vector search is unavailable right now.");
    expect(screen.queryByText(/No text passages match/)).toBeNull();
  });

  it("says when the question was not routed to vector search at all", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/api/memory/query"
          ? json({ facts: [], breakdown: { stores: [{ store: "graph", hits: 0 }], contextTokens: 0 } })
          : url.startsWith("/api/memory/stores")
            ? json(withChunks("org_1.sales"))
            : json({ nodes: [], edges: [] }),
      ),
    );
    render(<MemoryStores initialScope="org_1.sales" {...props} />);
    fireEvent.click(await screen.findByRole("tab", { name: /^Text passages/ }));
    searchChunks("who is Amy");

    expect(await screen.findByText(/This question was not sent to vector search/)).toBeTruthy();
  });

  it("drops a search answer that arrives after the scope changed", async () => {
    const { fetchMock, respond } = controllableFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryStores initialScope="org_1.sales" {...props} />);
    await respond("/api/memory/stores?scope=org_1.sales", json(withChunks("org_1.sales")));
    fireEvent.click(screen.getByRole("tab", { name: /^Text passages/ }));
    searchChunks("pricing");

    fireEvent.change(screen.getByRole("combobox", { name: "Scope" }), { target: { value: "org_1.support" } });
    await respond("/api/memory/stores?scope=org_1.support", json(withChunks("org_1.support")));
    await respond(
      "/api/memory/query",
      json({
        facts: [{ uuid: "c1", fact: "Sales-only chunk", validAt: null, store: "semantic", similarity: 0.9 }],
        breakdown: { stores: [{ store: "semantic", hits: 1 }], contextTokens: 4 },
      }),
    );

    expect(screen.queryByText("Sales-only chunk")).toBeNull();
    expect(screen.getByText("Listed chunk")).toBeTruthy();
    const queryCall = fetchMock.mock.calls.find(([url]) => url === "/api/memory/query")!;
    expect(queryCall[1]?.signal?.aborted).toBe(true);
  });
});
