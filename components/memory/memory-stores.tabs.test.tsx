// @vitest-environment jsdom
//
// The Explore page's seven tabs: ARIA tab semantics, the tab and each list's page
// kept in the URL, and how each kind of memory reads in its own list.
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { StoreBrief, StoreNote, StoreRule, StoresOverview } from "@/types/memory";

// Next.js keeps useSearchParams in step with pushState and replaceState; so does this fake.
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(window.location.search) }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@/components/help", () => ({ HelpTip: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("./graph-explorer", () => ({ GraphExplorer: () => <div>Graph</div> }));
vi.mock("./scope-picker", () => ({ ScopePicker: () => null }));

import { MemoryStores } from "./memory-stores";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const openAt = (query: string) => window.history.replaceState(null, "", `/memory/explore${query ? `?${query}` : ""}`);
const urlParam = (name: string) => new URLSearchParams(window.location.search).get(name);

const SALES = "org_1.demo_ad8a10";
const at = "2026-10-01T00:00:00.000Z";
function rule(id: string, extra: Partial<StoreRule> = {}): StoreRule {
  return {
    id,
    kind: "convention",
    subject: id,
    text: "Dedupe accounts by domain.",
    status: "in_force",
    scopePath: SALES,
    scopeName: "Demo",
    createdAt: at,
    ...extra,
  };
}
const note = (extra: Partial<StoreNote>): StoreNote => ({
  id: "n1",
  kind: "claim",
  task: "Fix the login redirect",
  body: "On it, branch fix/login.",
  agentName: "Copy agent",
  status: "live",
  scopePath: SALES,
  scopeName: "Demo",
  createdAt: at,
  expiresAt: "2026-10-01T02:00:00.000Z",
  ...extra,
});
const brief: StoreBrief = {
  id: "b1",
  type: "qa_review",
  title: "Checkout QA",
  scopePath: `${SALES}.old_derived_gone_8654b1_2bde43`,
  scopeName: null,
  createdAt: at,
};

let overview: StoresOverview;
let pageAnswer: (url: URL) => Response;
const pageRequests = () =>
  vi
    .mocked(fetch)
    .mock.calls.map(([url]) => new URL(String(url), "https://w.test"))
    .filter((url) => url.searchParams.has("list"));

beforeEach(() => {
  openAt("");
  overview = {
    scope: SALES,
    counts: { records: 0, briefs: 1, rules: 2, notes: 3, chunks: 0, files: 0 },
    lowerBounds: [],
    records: [],
    briefs: [brief],
    rules: [rule("Account dedupe"), rule("Old pricing", { kind: "decision", status: "replaced" })],
    notes: [
      note({}),
      note({ id: "n2", kind: "question", status: "expired", agentName: null }),
      note({ id: "n3", kind: "status", status: "released" }),
    ],
    chunks: [],
    files: [],
  };
  pageAnswer = (url) => {
    const page = Number(url.searchParams.get("page"));
    const narrowed = url.searchParams.has("kind");
    const total = narrowed ? 3 : 120;
    const count = narrowed ? 3 : page < 3 ? 50 : 20;
    const items = Array.from({ length: count }, (_, i) => rule(`server-${(page - 1) * 50 + i}`));
    return json({
      scope: SALES,
      list: "rules",
      items: page > Math.ceil(total / 50) ? [] : items,
      total,
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
      return json(overview);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const props = { initialScope: SALES, canDelete: false, canWrite: false, canManageScopes: false };
const selectedTab = () => screen.getAllByRole("tab").find((tab) => tab.getAttribute("aria-selected") === "true")!;

describe("Explore tabs", () => {
  it("is an ARIA tab list of the seven kinds, with the selected tab labelling its panel", async () => {
    render(<MemoryStores {...props} />);
    const list = screen.getByRole("tablist", { name: "Kinds of memory" });
    expect(
      within(list)
        .getAllByRole("tab")
        .map((tab) => tab.textContent?.replace(/ [\d,+]+$/, "")),
    ).toEqual([
      "Rules and decisions",
      "Working notes",
      "Briefs",
      "Text passages",
      "Graph",
      "Files",
      "Sources and contacts",
    ]);
    expect(selectedTab().textContent).toMatch(/^Rules and decisions/);
    expect(selectedTab().tabIndex).toBe(0);
    expect(screen.getByRole("tab", { name: /^Briefs/ }).tabIndex).toBe(-1);
    const panel = screen.getByRole("tabpanel");
    expect(panel.getAttribute("aria-labelledby")).toBe(selectedTab().id);
    expect(selectedTab().getAttribute("aria-controls")).toBe(panel.id);
    expect(within(panel).getByText(/^Conventions and decisions agents are given/)).toBeTruthy();
  });

  it("opens the tab a link names, and the default tab for an unknown one", async () => {
    openAt("tab=notes");
    render(<MemoryStores {...props} />);
    expect(selectedTab().textContent).toMatch(/^Working notes/);
    expect(await screen.findAllByText("Fix the login redirect")).toHaveLength(3);
    cleanup();

    openAt("tab=chunks.v2");
    render(<MemoryStores {...props} />);
    expect(selectedTab().textContent).toMatch(/^Rules and decisions/);
  });

  it("writes the chosen tab to the URL, and leaves the default tab out of it", async () => {
    render(<MemoryStores {...props} />);
    fireEvent.click(screen.getByRole("tab", { name: /^Briefs/ }));
    expect(urlParam("tab")).toBe("briefs");
    expect(await screen.findByText("Checkout QA")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /^Rules and decisions/ }));
    expect(urlParam("tab")).toBeNull();
  });

  it("follows back and forward between tabs, including back to a list's page", async () => {
    overview.counts.rules = 120;
    render(<MemoryStores {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Next page" }));
    expect(await screen.findByText("server-50")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /^Working notes/ }));
    expect(urlParam("tab")).toBe("notes");

    window.history.back();
    await waitFor(() => expect(selectedTab().textContent).toMatch(/^Rules and decisions/));
    expect(urlParam("rules.page")).toBe("2");
    expect(await screen.findByText("server-50")).toBeTruthy();

    window.history.forward();
    await waitFor(() => expect(selectedTab().textContent).toMatch(/^Working notes/));
  });

  it("moves focus with the arrow keys, Home and End, wrapping at the ends, and selects only on activation", () => {
    render(<MemoryStores {...props} />);
    const focused = () => (document.activeElement as HTMLElement).textContent;
    const rules = screen.getByRole("tab", { name: /^Rules and decisions/ });
    rules.focus();
    fireEvent.keyDown(rules, { key: "ArrowLeft" });
    expect(focused()).toMatch(/^Sources and contacts/);
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(focused()).toMatch(/^Rules and decisions/);
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(focused()).toMatch(/^Sources and contacts/);
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(focused()).toMatch(/^Working notes/);
    // Focus moved; the selection did not, until the tab is activated.
    expect(selectedTab().textContent).toMatch(/^Rules and decisions/);
    fireEvent.click(document.activeElement!);
    expect(selectedTab().textContent).toMatch(/^Working notes/);
  });
});

describe("Explore pages in the URL", () => {
  beforeEach(() => {
    overview.counts.rules = 120;
  });

  it("opens the page a link names, and writes the next page back", async () => {
    openAt("rules.page=2");
    render(<MemoryStores {...props} />);
    expect(await screen.findByText("server-50")).toBeTruthy();
    expect(pageRequests().at(-1)?.searchParams.get("page")).toBe("2");

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("server-100")).toBeTruthy();
    expect(urlParam("rules.page")).toBe("3");
    expect(screen.getByRole("button", { name: "Next page" }).getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("101–120 of 120 rules and decisions")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    fireEvent.click(await screen.findByRole("button", { name: "Previous page" }));
    await screen.findByText("server-0");
    expect(urlParam("rules.page")).toBeNull();
  });

  it("starts again at page 1 when a filter shrinks the list below the current page", async () => {
    openAt("rules.page=3");
    render(<MemoryStores {...props} />);
    await screen.findByText("server-100");

    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    fireEvent.click(within(screen.getByRole("group", { name: "Kind" })).getByRole("button", { name: "Decisions" }));
    await waitFor(() => expect(pageRequests().at(-1)?.searchParams.get("kind")).toBe("decision"));
    expect(pageRequests().at(-1)?.searchParams.get("page")).toBe("1");
    expect(urlParam("rules.page")).toBeNull();
    expect(urlParam("rules.kind")).toBe("decision");
    expect(await screen.findByText("server-0")).toBeTruthy();
  });

  it("offers the first page when a link names a page past the end", async () => {
    openAt("rules.page=9");
    render(<MemoryStores {...props} />);
    expect(await screen.findByText(/^No rules and decisions on this page\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to the first page" }));
    expect(await screen.findByText("server-0")).toBeTruthy();
    expect(urlParam("rules.page")).toBeNull();
  });
});

describe("Explore counts and scope changes", () => {
  it("marks a count that stopped at its scan bound as a floor", () => {
    overview.counts.rules = 2000;
    overview.lowerBounds = ["rules"];
    render(<MemoryStores {...props} />);
    return waitFor(() => expect(screen.getByRole("tab", { name: "Rules and decisions 2,000+" })).toBeTruthy());
  });

  it("reads a page past what the server accepts as page 1", async () => {
    overview.counts.rules = 120;
    openAt("rules.page=100001");
    render(<MemoryStores {...props} />);
    expect(await screen.findByText("server-0")).toBeTruthy();
    expect(pageRequests().at(-1)?.searchParams.get("page")).toBe("1");
  });
});

describe("Explore rows", () => {
  it("names each row's scope, with the full scope id on hover", async () => {
    openAt("tab=briefs");
    render(<MemoryStores {...props} />);
    // No scope row names this path, so the label is read from its last segment.
    const derived = await screen.findByText("Old derived gone 8654b1");
    expect(derived.getAttribute("title")).toBe(`${SALES}.old_derived_gone_8654b1_2bde43`);
    expect(screen.queryByText(/demo_ad8a10/)).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: /^Rules and decisions/ }));
    const named = (await screen.findAllByText("Demo"))[0];
    expect(named.getAttribute("title")).toBe(SALES);
  });

  it("marks a rule that is no longer served, and says which kind each one is", async () => {
    render(<MemoryStores {...props} />);
    expect(await screen.findByText("Account dedupe")).toBeTruthy();
    expect(screen.getAllByText("Convention")).toHaveLength(1);
    expect(screen.getByText("Decision")).toBeTruthy();
    expect(screen.getByText("Replaced by a later version")).toBeTruthy();
  });

  it("shows whether each working note is live, expired or released, and who posted it", async () => {
    openAt("tab=notes");
    render(<MemoryStores {...props} />);
    expect(await screen.findByText(/^Live until /)).toBeTruthy();
    expect(screen.getByText("Expired")).toBeTruthy();
    expect(screen.getByText("Released")).toBeTruthy();
    expect(screen.getByText("Removed agent")).toBeTruthy();
    expect(screen.getAllByText("Copy agent")).toHaveLength(2);
  });

  it("links a brief to its page and names its type", async () => {
    openAt("tab=briefs");
    render(<MemoryStores {...props} />);
    expect((await screen.findByRole("link", { name: "Checkout QA" })).getAttribute("href")).toBe("/briefs/b1");
    expect(screen.getByText("QA review")).toBeTruthy();
  });
});
