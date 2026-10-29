// @vitest-environment jsdom
//
// The agents page's run history searches, filters and orders on the server: the
// list is paged, and only GET /api/agents/:id/runs can leave out runs the caller
// cannot read before it counts. These tests check what the page asks the route
// for and how it shows each answer; the route's own access rule is proven against
// a real database in app/api/agents/[id]/runs-search.realdb.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children?: unknown }) =>
    createElement("a", { href, ...props }, children as never),
}));
let urlParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  usePathname: () => "/agents",
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  useSearchParams: () => urlParams,
}));

import AgentsPage from "./page";
import { emptyDashboardResponse } from "@/components/agents/dashboard/empty-dashboard.testsupport";

/** What the toolbar's polite live region says: the count a screen reader hears. */
const liveCount = () =>
  screen.getByText("Run history").closest(".glass-surface")?.querySelector("[aria-live='polite']")?.textContent ?? "";

const LATEST = {
  id: "run_latest",
  status: "completed",
  triggeredBy: "user_1",
  meta: { campaignId: "camp_globex", campaignName: "Globex intro" },
  startedAt: "2026-10-03T00:00:00Z",
  finishedAt: "2026-10-03T00:01:00Z",
};
const FAILED = {
  id: "run_failed",
  status: "failed",
  triggeredBy: "user_1",
  meta: { campaignId: "camp_acme", campaignName: "Acme pilot" },
  startedAt: "2026-10-02T00:00:00Z",
  finishedAt: "2026-10-02T00:01:00Z",
};

const AGENT = {
  id: "agent_custom",
  agentKey: "custom-1",
  name: "Weekly digest",
  role: "custom",
  model: null,
  tools: [],
  active: true,
  _count: { runs: 3 },
  runs: [LATEST],
};

let runsAnswer: (url: string) => Response;
const runRequests = () =>
  vi
    .mocked(fetch)
    .mock.calls.map(([url]) => String(url))
    .filter((url) => url.startsWith("/api/agents/agent_custom/runs"));

class NoopResizeObserver {
  observe() {}
  disconnect() {}
}

beforeEach(() => {
  urlParams = new URLSearchParams();
  window.history.replaceState(null, "", "/agents");
  runsAnswer = () => new Response(JSON.stringify({ runs: [FAILED], total: 1 }), { status: 200 });
  vi.stubGlobal("ResizeObserver", NoopResizeObserver);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const dashboard = emptyDashboardResponse(url);
      if (dashboard) return dashboard;
      if (url === "/api/agents?kind=builtin") return new Response(JSON.stringify({ agents: [AGENT] }), { status: 200 });
      if (url.startsWith("/api/agents/agent_custom/runs")) return runsAnswer(url);
      return new Response("{}", { status: 200 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openHistory() {
  render(<AgentsPage />);
  return screen.findByRole("search", { name: "Search, filter and sort runs" });
}

describe("agents page run history list controls", () => {
  it("shows the runs the agent payload carries until something narrows or reorders the list", async () => {
    await openHistory();
    expect(screen.getByText(/Globex intro/)).toBeTruthy();
    expect(runRequests()).toEqual([]);
    expect(screen.getByRole("button", { name: "Load the newest 3 of 3 runs" })).toBeTruthy();
  });

  it("asks the route for a status and shows its page with the matching count", async () => {
    const toolbar = await openHistory();
    fireEvent.click(within(toolbar).getByRole("button", { name: "Filters" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Status" })).getByRole("button", { name: "Failed" }));

    await screen.findByText(/Acme pilot/);
    expect(runRequests()).toEqual(["/api/agents/agent_custom/runs?limit=50&order=desc&status=failed"]);
    expect(screen.queryByText(/Globex intro/)).toBeNull();
    expect(liveCount()).toBe("1 of 3 runs");
    expect(screen.queryByRole("button", { name: /Load the newest/ })).toBeNull();
  });

  it("sends the search once typing pauses and the reversed order", async () => {
    const toolbar = await openHistory();
    fireEvent.change(within(toolbar).getByRole("searchbox", { name: "Search runs" }), { target: { value: "acme" } });
    fireEvent.click(within(toolbar).getByRole("button", { name: /^Order: Newest first/ }));
    await screen.findByText(/Acme pilot/);
    expect(runRequests().at(-1)).toBe("/api/agents/agent_custom/runs?limit=50&order=asc&q=acme");
    expect(runRequests().some((url) => url.includes("q=a&") || url.endsWith("q=a"))).toBe(false);
  });

  it("says when the route found nothing and clears back to the agent's runs", async () => {
    runsAnswer = () => new Response(JSON.stringify({ runs: [], total: 0 }), { status: 200 });
    urlParams = new URLSearchParams("runs.q=nothing");
    await openHistory();
    await screen.findByText("No runs match “nothing”.");
    fireEvent.click(screen.getByRole("button", { name: "Clear search and filters" }));
    await screen.findByText(/Globex intro/);
  });

  it("says plainly when the route fails, rather than showing an empty history", async () => {
    runsAnswer = () => new Response(JSON.stringify({ error: "boom" }), { status: 500 });
    urlParams = new URLSearchParams("runs.status=failed");
    await openHistory();
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not load these runs. Change the filters or reload to try again.",
    );
    expect(screen.queryByText("No runs recorded yet.")).toBeNull();
  });

  it("notes when more runs match than one page shows", async () => {
    runsAnswer = () => new Response(JSON.stringify({ runs: [FAILED], total: 80 }), { status: 200 });
    urlParams = new URLSearchParams("runs.status=failed");
    await openHistory();
    await waitFor(() => expect(screen.getByText("Showing the newest 1 of 80 matching runs.")).toBeTruthy());
  });

  it("loads the full history on request, then older runs by cursor until the last page", async () => {
    const OLDER = {
      ...FAILED,
      id: "run_older",
      meta: { campaignId: "camp_initech", campaignName: "Initech intro" },
      startedAt: "2026-10-01T00:00:00Z",
    };
    runsAnswer = (url) =>
      url.includes("cursor=")
        ? Response.json({ runs: [OLDER], total: 3, nextCursor: null })
        : Response.json({ runs: [LATEST, FAILED], total: 3, nextCursor: "2026-10-02T00:00:00.000Z_run_failed" });
    await openHistory();
    fireEvent.click(screen.getByRole("button", { name: "Load the newest 3 of 3 runs" }));
    await screen.findByText(/Acme pilot/);
    expect(runRequests()).toEqual(["/api/agents/agent_custom/runs?limit=50&order=desc"]);
    expect(screen.getByText("Showing the newest 2 of 3 matching runs.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Load 1 older run" }));
    await screen.findByText(/Initech intro/);
    expect(runRequests().at(-1)).toBe(
      `/api/agents/agent_custom/runs?limit=50&order=desc&cursor=${encodeURIComponent("2026-10-02T00:00:00.000Z_run_failed")}`,
    );
    expect(screen.getAllByText(/Globex intro|Acme pilot|Initech intro/)).toHaveLength(3);
    expect(screen.queryByRole("button", { name: /older runs/ })).toBeNull();
  });

  it("writes a history of 1,050 runs with a thousands separator in every count", async () => {
    const fetchRest = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) =>
      String(input) === "/api/agents?kind=builtin"
        ? Response.json({ agents: [{ ...AGENT, _count: { runs: 1050 } }] })
        : fetchRest(input, init),
    );
    runsAnswer = () => Response.json({ runs: [LATEST, FAILED], total: 1050, nextCursor: "c1" });
    await openHistory();
    fireEvent.click(screen.getByRole("button", { name: "Load the newest 50 of 1,050 runs" }));
    expect(await screen.findByText("Showing the newest 2 of 1,050 matching runs.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Load 50 older runs" })).toBeTruthy();
  });

  it("drops a load-more answer that arrives after the view changed", async () => {
    let release: (r: Response) => void = () => {};
    runsAnswer = (url) =>
      url.includes("cursor=")
        ? (new Promise<Response>((resolve) => {
            release = resolve;
          }) as never)
        : url.includes("status=failed")
          ? Response.json({ runs: [FAILED], total: 1, nextCursor: null })
          : Response.json({ runs: [LATEST], total: 3, nextCursor: "c1" });
    const toolbar = await openHistory();
    fireEvent.click(screen.getByRole("button", { name: "Load the newest 3 of 3 runs" }));
    fireEvent.click(await screen.findByRole("button", { name: "Load 2 older runs" }));
    expect(screen.getByRole("button", { name: "Loading…" })).toBeTruthy();

    fireEvent.click(within(toolbar).getByRole("button", { name: "Filters" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Status" })).getByRole("button", { name: "Failed" }));
    await screen.findByText(/Acme pilot/);
    release(
      Response.json({
        runs: [{ ...LATEST, id: "run_late", meta: { campaignId: "camp_late", campaignName: "Late answer" } }],
        total: 3,
        nextCursor: null,
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(/Late answer/)).toBeNull();
  });

  it("says when more runs could not load, and keeps the ones shown", async () => {
    runsAnswer = (url) =>
      url.includes("cursor=")
        ? new Response("{}", { status: 500 })
        : Response.json({ runs: [LATEST], total: 3, nextCursor: "c1" });
    await openHistory();
    fireEvent.click(screen.getByRole("button", { name: "Load the newest 3 of 3 runs" }));
    fireEvent.click(await screen.findByRole("button", { name: "Load 2 older runs" }));
    expect(await screen.findByRole("button", { name: "Could not load more runs. Try again" })).toBeTruthy();
    expect(screen.getByText(/Globex intro/)).toBeTruthy();
  });
});
