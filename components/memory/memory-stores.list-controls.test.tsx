// @vitest-environment jsdom
//
// The Explore page's store lists search, filter, order and
// page on the server (GET /api/memory/stores?list=), because they are paged and
// only the server can leave out rows outside the scope before it counts. These
// tests check what each list asks for and how it shows each answer; the route's
// own rule is proven against a real database in
// app/api/memory/stores/store-pages.realdb.test.ts.
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { StoreChunk, StoreFile, StoreRule, StoresOverview } from "@/types/memory";

// Next.js keeps useSearchParams in step with pushState and replaceState; so does this fake.
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(window.location.search) }));
const openAt = (query: string) => window.history.replaceState(null, "", `/memory/explore?${query}`);
vi.mock("@/components/help", () => ({ HelpTip: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("./graph-explorer", () => ({ GraphExplorer: () => <div>Graph</div> }));
vi.mock("./scope-picker", () => ({
  ScopePicker: ({ selected, onChange }: { selected: string | null; onChange: (value: string | null) => void }) => (
    <select aria-label="Scope" value={selected ?? ""} onChange={(event) => onChange(event.target.value || null)}>
      <option value="">Organization root</option>
      <option value="org_1.sales">Sales</option>
      <option value="org_1.support">Support</option>
    </select>
  ),
}));

import { MemoryStores } from "./memory-stores";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** The polite live region of the toolbar on screen: the count a screen reader hears. */
const liveCount = () => document.querySelector("[role='search'] [aria-live='polite']")?.textContent ?? "";

function rule(id: string, subject = id): StoreRule {
  return {
    id,
    kind: "convention",
    subject,
    text: "Dedupe by domain.",
    status: "in_force",
    scopePath: "org_1.sales",
    scopeName: "Sales",
    createdAt: "2026-10-01T00:00:00.000Z",
  };
}
function chunk(id: string, snippet = id): StoreChunk {
  return {
    id,
    snippet,
    source: "text",
    author: null,
    scopePath: "org_1.sales",
    scopeName: "Sales",
    createdAt: "2026-10-01T00:00:00.000Z",
    supersededById: null,
  };
}
function file(id: string): StoreFile {
  return {
    id,
    externalFileId: `${id}.pdf`,
    sourceName: "Drive",
    sourceType: "gdrive",
    chunkCount: 2,
    syncedAt: "2026-10-01T00:00:00.000Z",
    scopePath: "org_1.sales",
    scopeName: "Sales",
  };
}

const OVERVIEW: StoresOverview = {
  scope: "org_1.sales",
  counts: { records: 0, briefs: 0, rules: 120, notes: 0, chunks: 3, files: 2 },
  lowerBounds: [],
  records: [],
  briefs: [],
  rules: Array.from({ length: 50 }, (_, i) => rule(`newest-${i}`)),
  notes: [],
  chunks: [chunk("c1"), chunk("c2"), chunk("c3")],
  files: [file("f1"), file("f2")],
};

let pageAnswer: (url: URL) => Response;
const pageRequests = () =>
  vi
    .mocked(fetch)
    .mock.calls.map(([url]) => new URL(String(url), "https://w.test"))
    .filter((url) => url.pathname === "/api/memory/stores" && url.searchParams.has("list"));

beforeEach(() => {
  window.history.replaceState(null, "", "/memory/explore");
  pageAnswer = (url) => {
    const page = Number(url.searchParams.get("page"));
    const narrowed = url.searchParams.has("q") || url.searchParams.has("kind");
    const items =
      url.searchParams.get("list") === "rules" && !narrowed
        ? Array.from({ length: page < 3 ? 50 : 20 }, (_, i) => rule(`server-${(page - 1) * 50 + i}`))
        : [];
    return json({
      scope: "org_1.sales",
      list: url.searchParams.get("list"),
      items,
      total: narrowed ? 0 : 120,
      page,
      pageSize: 50,
      capped: false,
    });
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(input, "https://w.test");
      if (url.pathname === "/api/memory/graph") return json({ nodes: [], edges: [] });
      if (url.searchParams.has("list")) return pageAnswer(url);
      return json(OVERVIEW);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const props = { canDelete: false, canWrite: false, canManageScopes: false };

describe("Explore lists on the server", () => {
  it("takes every page of a store larger than one page from the server, and sends a search there", async () => {
    const answerPages = pageAnswer;
    pageAnswer = (url) =>
      url.searchParams.get("q") === "acme"
        ? json({
            scope: "org_1.sales",
            list: "rules",
            items: [rule("acme-1", "Acme renewal")],
            total: 3,
            page: 1,
            pageSize: 50,
            capped: false,
          })
        : answerPages(url);
    render(<MemoryStores initialScope="org_1.sales" {...props} />);
    // Page 1 comes from the same ordered query as page 2, never from the overview's own read.
    expect(await screen.findByText("server-0")).toBeTruthy();
    expect(screen.queryByText("newest-0")).toBeNull();
    expect(Object.fromEntries(pageRequests()[0]!.searchParams)).toEqual({
      list: "rules",
      sort: "created",
      order: "desc",
      page: "1",
      scope: "org_1.sales",
    });
    expect(screen.getByText("1–50 of 120 rules and decisions")).toBeTruthy();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search rules and decisions" }), {
      target: { value: "acme" },
    });
    expect(await screen.findByText("Acme renewal")).toBeTruthy();
    const sent = pageRequests().at(-1)!;
    expect(Object.fromEntries(sent.searchParams)).toEqual({
      list: "rules",
      sort: "created",
      order: "desc",
      page: "1",
      scope: "org_1.sales",
      q: "acme",
    });
    await waitFor(() => expect(liveCount()).toBe("3 of 120 rules and decisions"));
  });

  it("pages on, and sends the kind filter and a title order from page 1", async () => {
    render(<MemoryStores initialScope="org_1.sales" {...props} />);
    await screen.findByText("server-0");

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("server-50")).toBeTruthy();
    expect(pageRequests().at(-1)?.searchParams.get("page")).toBe("2");
    expect(screen.getByText("Page 2 of 3")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    const panel = screen.getByRole("group", { name: "Filter rules and decisions" });
    fireEvent.click(
      within(within(panel).getByRole("group", { name: "Kind" })).getByRole("button", { name: "Decisions" }),
    );
    await waitFor(() => expect(pageRequests().at(-1)?.searchParams.get("kind")).toBe("decision"));
    expect(pageRequests().at(-1)?.searchParams.get("page")).toBe("1");

    fireEvent.change(screen.getByRole("combobox", { name: "Sort by" }), { target: { value: "subject" } });
    await waitFor(() => expect(pageRequests().at(-1)?.searchParams.get("sort")).toBe("subject"));
    expect(pageRequests().at(-1)?.searchParams.get("order")).toBe("asc");
  });

  it("says a failed page could not load, and claims no count, instead of showing no matches", async () => {
    pageAnswer = () => json({ error: "Could not read memory." }, 500);
    openAt("rules.q=acme");
    render(<MemoryStores initialScope="org_1.sales" {...props} />);

    expect((await screen.findByRole("alert")).textContent).toContain("Could not read memory.");
    expect(screen.queryByText(/No rules and decisions match/)).toBeNull();
    expect(liveCount()).toBe("");
  });

  it("offers the way back when nothing matches", async () => {
    openAt("rules.q=nothing");
    render(<MemoryStores initialScope="org_1.sales" {...props} />);

    expect(await screen.findByText(/No rules and decisions match/)).toBeTruthy();
    expect(liveCount()).toBe("0 of 120 rules and decisions");
    fireEvent.click(screen.getByRole("button", { name: "Clear search and filters" }));
    expect(await screen.findByText("server-0")).toBeTruthy();
  });

  it("searches text passages and filters by version, beside the search by meaning", async () => {
    pageAnswer = () =>
      json({
        scope: "org_1.sales",
        list: "chunks",
        items: [chunk("hit", "Superseded pricing note")],
        total: 2000,
        page: 1,
        pageSize: 50,
        capped: true,
      });
    render(<MemoryStores initialScope="org_1.sales" {...props} />);
    fireEvent.click(await screen.findByRole("tab", { name: /^Text passages/ }));
    expect(screen.getByRole("searchbox", { name: "Search text passages by meaning" })).toBeTruthy();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search text passages" }), { target: { value: "pricing" } });
    expect(await screen.findByText("Superseded pricing note")).toBeTruthy();
    expect(screen.getByText(/Counting stopped at 2,000 matches/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    fireEvent.click(within(screen.getByRole("group", { name: "Version" })).getByRole("button", { name: "Superseded" }));
    await waitFor(() => expect(pageRequests().at(-1)?.searchParams.get("version")).toBe("superseded"));
    expect(pageRequests().at(-1)?.searchParams.get("q")).toBe("pricing");
  });

  it("orders files by passage count, most first", async () => {
    pageAnswer = () =>
      json({
        scope: "org_1.sales",
        list: "files",
        items: [file("big")],
        total: 2,
        page: 1,
        pageSize: 50,
        capped: false,
      });
    render(<MemoryStores initialScope="org_1.sales" {...props} />);
    fireEvent.click(await screen.findByRole("tab", { name: /^Files/ }));
    fireEvent.change(screen.getByRole("combobox", { name: "Sort by" }), { target: { value: "chunks" } });

    expect(await screen.findByText("big.pdf")).toBeTruthy();
    const sent = pageRequests().at(-1)!;
    expect(sent.searchParams.get("list")).toBe("files");
    expect(sent.searchParams.get("sort")).toBe("chunks");
    expect(sent.searchParams.get("order")).toBe("desc");
  });

  it("lists a store that fits on one page from the overview, with no request of its own", async () => {
    render(<MemoryStores initialScope="org_1.sales" {...props} />);
    fireEvent.click(await screen.findByRole("tab", { name: /^Files/ }));
    expect(await screen.findByText("f1.pdf")).toBeTruthy();
    expect(pageRequests().filter((url) => url.searchParams.get("list") === "files")).toEqual([]);
  });

  it("keeps each tab's search to its own list", async () => {
    render(<MemoryStores initialScope="org_1.sales" {...props} />);
    await screen.findByText("server-0");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search rules and decisions" }), {
      target: { value: "acme" },
    });
    await waitFor(() => expect(pageRequests().at(-1)?.searchParams.get("list")).toBe("rules"));

    fireEvent.click(screen.getByRole("tab", { name: /^Files/ }));
    expect(await screen.findByText("f1.pdf")).toBeTruthy();
    expect((screen.getByRole("searchbox", { name: "Search files" }) as HTMLInputElement).value).toBe("");
    expect(pageRequests().filter((url) => url.searchParams.get("list") === "files")).toEqual([]);
  });

  it("asks for the new scope's page when the scope changes", async () => {
    openAt("rules.q=acme");
    render(<MemoryStores initialScope="org_1.sales" {...props} />);
    await waitFor(() => expect(pageRequests().at(-1)?.searchParams.get("scope")).toBe("org_1.sales"));

    fireEvent.change(screen.getByRole("combobox", { name: "Scope" }), { target: { value: "org_1.support" } });
    await waitFor(() => expect(pageRequests().at(-1)?.searchParams.get("scope")).toBe("org_1.support"));
    expect(pageRequests().at(-1)?.searchParams.get("q")).toBe("acme");
  });

  it("starts the new scope's list at page 1", async () => {
    openAt("rules.page=2");
    render(<MemoryStores initialScope="org_1.sales" {...props} />);
    expect(await screen.findByText("server-50")).toBeTruthy();

    fireEvent.change(screen.getByRole("combobox", { name: "Scope" }), { target: { value: "org_1.support" } });
    await waitFor(() => expect(pageRequests().at(-1)?.searchParams.get("scope")).toBe("org_1.support"));
    expect(pageRequests().at(-1)?.searchParams.get("page")).toBe("1");
    expect(new URLSearchParams(window.location.search).get("rules.page")).toBeNull();
  });
});
