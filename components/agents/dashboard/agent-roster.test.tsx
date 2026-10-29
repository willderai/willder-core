// @vitest-environment jsdom
//
// The roster asks the server for every view (search, filters, order, page), restores
// that view from the URL, starts again at page 1 when the view changes, and never
// shows an answer to an earlier view.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children?: unknown }) =>
    createElement("a", { href, ...props }, children as never),
}));
let urlParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useSearchParams: () => urlParams,
  usePathname: () => "/agents",
  useRouter: () => ({}),
}));

import { AgentRoster, type RosterRow } from "./agent-roster";

const week = (total: number, failed = 0) =>
  Array.from({ length: 7 }, (_, i) => (i === 6 ? { total, failed } : { total: 0, failed: 0 }));
const own = (id: string, name: string, extra: Partial<RosterRow> = {}): RosterRow => ({
  kind: "custom",
  id,
  key: `custom-${id}`,
  name,
  role: "custom",
  status: "idle",
  activity: 3,
  lastRunStatus: "completed",
  lastRunId: "r1",
  lastActiveAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
  scopes: [],
  permission: null,
  liveTokens: null,
  lastAllowedAt: null,
  lastDeniedAt: null,
  series: week(3),
  ...extra,
});
const connected: RosterRow = {
  kind: "connected",
  id: "claude-code",
  key: "claude-code",
  name: "claude-code",
  role: null,
  status: "failing",
  activity: 41,
  lastRunStatus: null,
  lastRunId: null,
  lastActiveAt: new Date().toISOString(),
  lastAllowedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  lastDeniedAt: new Date().toISOString(),
  scopes: ["org_x.dept_sales", "org_x.eng"],
  permission: "write",
  liveTokens: 2,
  series: week(41, 5),
};

let answer: (url: string) => Promise<Response>;
const requests = () => vi.mocked(fetch).mock.calls.map(([url]) => String(url));
const page = (rows: RosterRow[], total = rows.length) => Response.json({ rows, total, page: 1, pageSize: 12 });

beforeEach(() => {
  urlParams = new URLSearchParams();
  window.history.replaceState(null, "", "/agents");
  answer = async () => page([own("a1", "Weekly digest"), connected], 30);
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => answer(url)),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("agents roster", () => {
  it("restores a deep-linked view and page and sends all of it to the server", async () => {
    urlParams = new URLSearchParams(
      "roster.kind=connected&roster.status=failing&roster.q=claude&roster.sort=lastActive&roster.page=2",
    );
    render(<AgentRoster selectedId={null} onOpen={() => {}} />);
    await screen.findByText("claude-code");
    expect(requests()).toEqual([
      "/api/agents/roster?sort=lastActive&order=desc&q=claude&kind=connected&status=failing&page=2",
    ]);
  });

  it("starts again at page 1 when a filter changes, and keeps the page in the URL", async () => {
    render(<AgentRoster selectedId={null} onOpen={() => {}} />);
    await screen.findByText("Weekly digest", { selector: "p" });
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(requests().at(-1)).toContain("page=2"));
    expect(window.location.search).toContain("roster.page=2");
    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    fireEvent.click(within(screen.getByRole("group", { name: "Type" })).getByRole("button", { name: "Custom" }));
    await waitFor(() => expect(requests().at(-1)).toBe("/api/agents/roster?sort=name&order=asc&kind=custom"));
    expect(window.location.search).not.toContain("roster.page");
  });

  it("never shows an answer to an earlier view that lands late", async () => {
    let releaseFirst: () => void = () => {};
    answer = (url) =>
      url.includes("kind=custom")
        ? Promise.resolve(page([own("a2", "Pricing scout")]))
        : new Promise((resolve) => {
            releaseFirst = () => resolve(page([own("a1", "Stale agent")]));
          });
    render(<AgentRoster selectedId={null} onOpen={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    fireEvent.click(within(screen.getByRole("group", { name: "Type" })).getByRole("button", { name: "Custom" }));
    await screen.findByText("Pricing scout", { selector: "p" });
    releaseFirst();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("Stale agent", { selector: "p" })).toBeNull();
    expect(screen.getByText("Pricing scout", { selector: "p" })).toBeTruthy();
  });

  it("shows a connected agent's scopes shortened, with its tokens and audit one click away", async () => {
    render(<AgentRoster selectedId={null} onOpen={() => {}} />);
    const row = (await screen.findByText("claude-code")).closest("li")!;
    expect(within(row).getByText("Failing")).toBeTruthy();
    expect(within(row).getByText(/write on Dept_sales and 1 more/i)).toBeTruthy();
    expect(within(row).getByRole("img").getAttribute("aria-label")).toBe("41 calls, 5 denied, last 7 days");
    expect(within(row).getByRole("link", { name: "Tokens" }).getAttribute("href")).toBe(
      "/access?tab=tokens&q=claude-code",
    );
    expect(within(row).getByRole("link", { name: "Audit" }).getAttribute("href")).toBe("/audit?q=claude-code");
  });

  it("shows a connected agent's last allowed and last denied call side by side", async () => {
    answer = async () =>
      page(
        [
          connected,
          { ...connected, id: "idle-mcp", key: "idle-mcp", name: "idle-mcp", lastDeniedAt: null },
          {
            ...connected,
            id: "old-mcp",
            key: "old-mcp",
            name: "old-mcp",
            lastDeniedAt: new Date(Date.now() - 9 * 86_400_000).toISOString(),
          },
        ],
        3,
      );
    render(<AgentRoster selectedId={null} onOpen={() => {}} />);
    const failing = (await screen.findByText("claude-code")).closest("li")!;
    expect(within(failing).getByText(/Last allowed call/).parentElement?.textContent).toMatch(/Allowed 3h ago/);
    expect(within(failing).getByText(/Last denied call/).parentElement?.textContent).toContain("Denied just now");
    expect(within(failing).getByText(/Last denied call/).parentElement?.className).toContain("text-danger");
    const quiet = screen.getByText("idle-mcp").closest("li")!;
    expect(within(quiet).getByText(/Last denied call/).parentElement?.textContent).toContain("Denied never");
    // An old refusal is still shown, but not as an alarm.
    const old = screen.getByText("old-mcp").closest("li")!;
    const oldDenied = within(old).getByText(/Last denied call/).parentElement!;
    expect(oldDenied.textContent).toContain("Denied 9d ago");
    expect(oldDenied.className).not.toContain("text-danger");
  });

  it("sends token use filters and the last allowed and denied sorts to the server", async () => {
    urlParams = new URLSearchParams("roster.use=unused&roster.sort=lastDenied");
    render(<AgentRoster selectedId={null} onOpen={() => {}} />);
    await screen.findByText("claude-code");
    expect(requests()).toEqual(["/api/agents/roster?sort=lastDenied&order=desc&use=unused"]);
    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    fireEvent.click(
      within(screen.getByRole("group", { name: "Token use" })).getByRole("button", { name: "Denied this week" }),
    );
    await waitFor(() => expect(requests().at(-1)).toBe("/api/agents/roster?sort=lastDenied&order=desc&use=denied"));
  });

  it("opens one of the org's own agents", async () => {
    answer = async () => page([own("a1", "Weekly digest")], 1);
    const onOpen = vi.fn();
    render(<AgentRoster selectedId={null} onOpen={onOpen} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Open/ }));
    expect(onOpen).toHaveBeenCalledWith("a1");
  });

  it("says plainly when the roster cannot load", async () => {
    answer = async () => new Response("{}", { status: 500 });
    render(<AgentRoster selectedId={null} onOpen={() => {}} />);
    expect((await screen.findByRole("alert")).textContent).toContain("Could not load the agents");
  });
});

describe("roster pager lifetime", () => {
  it.each([200, 403, 500])("keeps focus and hides stale counts through page turns ending in %s", async (status) => {
    let release!: (response: Response) => void;
    answer = (url) =>
      url.includes("page=2")
        ? new Promise((r) => {
            release = r;
          })
        : Promise.resolve(page([own("a1", "Weekly digest")], 30));
    render(<AgentRoster selectedId={null} onOpen={() => {}} />);
    const next = await screen.findByRole("button", { name: "Next page" });
    next.focus();
    fireEvent.click(next);
    await waitFor(() => expect(release).toBeDefined());
    expect(document.activeElement).toBe(next);
    const nav = screen.getByRole("navigation", { name: "Pages of agents" });
    expect(nav.textContent).toContain("Loading page 2");
    expect(nav.textContent).not.toContain(" of ");
    const before = requests().length;
    fireEvent.click(next);
    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    expect(requests()).toHaveLength(before);
    release(status === 200 ? page([], 0) : new Response("{}", { status }));
    await waitFor(() => expect(nav.getAttribute("aria-busy")).toBe("false"));
    expect(document.activeElement).toBe(next);
    expect(next.getAttribute("aria-disabled")).toBe("true");
    expect(nav.textContent).not.toMatch(/13–0|Page 2 of 1/);
    if (status !== 200) {
      expect(nav.textContent).not.toContain(" of ");
      expect(screen.queryByText("Weekly digest", { selector: "p" })).toBeNull();
    }
  });

  it("does not resurrect page 2 when a filter is cleared", async () => {
    render(<AgentRoster selectedId={null} onOpen={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Next page" }));
    await waitFor(() => expect(requests().at(-1)).toContain("page=2"));
    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    fireEvent.click(within(screen.getByRole("group", { name: "Type" })).getByRole("button", { name: "Custom" }));
    await waitFor(() => expect(requests().at(-1)).toContain("kind=custom"));
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    await waitFor(() => expect(requests().at(-1)).toBe("/api/agents/roster?sort=name&order=asc"));
  });
});

describe("empty roster pages", () => {
  it("reports a fresh total without inventing a row range for an empty in-range page", async () => {
    answer = async () => page([], 30);
    render(<AgentRoster selectedId={null} onOpen={() => {}} />);
    expect(await screen.findByText("30 agents total")).toBeTruthy();
    expect(screen.queryByText(/1–12/)).toBeNull();
  });
});

describe("returning to a previous roster view", () => {
  it.each([false, true])("does not reuse an old answer when empty=%s and its URL returns", async (empty) => {
    const pending: Array<(response: Response) => void> = [];
    let reads = 0;
    answer = async () => {
      reads++;
      if (reads === 1) return page(empty ? [] : [own("a1", "Old roster")], empty ? 0 : 30);
      return new Promise((resolve) => pending.push(resolve));
    };
    render(<AgentRoster selectedId={null} onOpen={() => {}} />);
    await screen.findByText(empty ? "No agents yet." : "Old roster", { selector: "p" });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "new-search" } });
    await waitFor(() => expect(pending).toHaveLength(1));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(screen.queryByText("No agents yet.")).toBeNull();
    expect(screen.queryByText("Old roster", { selector: "p" })).toBeNull();
    expect(screen.getByText("Loading agents…")).toBeTruthy();
    pending[1](page([own("a2", "Fresh roster")], 1));
    await screen.findByText("Fresh roster", { selector: "p" });
    pending[0](page([own("a3", "Late search")], 1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByText("Fresh roster", { selector: "p" })).toBeTruthy();
  });
});
