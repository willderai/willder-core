// The Grants and Tokens tabs sort and filter with the shared list toolbar, while
// the page's one search box stays the search, so sidebar links (?tab=tokens&q=…)
// keep landing on a filtered tab. Each tab's view lives under its own URL prefix.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

let urlParams = new URLSearchParams();
const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => urlParams,
}));

vi.mock("@/components/reveal", () => ({
  Reveal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { AccessView } from "./access-view";
import { grantsPage, tokensPage } from "./access-test-api";
import { waitOnFakeClock } from "@/lib/fake-clock-waits.testsupport";

waitOnFakeClock();

const DAY = 24 * 60 * 60 * 1000;
const inDays = (days: number) => new Date(Date.now() + days * DAY).toISOString();
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

function grant(
  id: string,
  scope: string,
  granteeType: string,
  granteeName: string,
  permission: string,
  expiresInDays: number | null,
  createdDaysAgo: number,
) {
  return {
    id,
    granteeType,
    granteeId: `${granteeType}_${id}`,
    granteeName,
    permission,
    expiresAt: expiresInDays === null ? null : inDays(expiresInDays),
    createdAt: inDays(-createdDaysAgo),
    scope: { id: `s_${scope}`, path: `org_1.${scope}`, name: scope },
  };
}

// In the route's own order, newest first.
const GRANTS = [
  grant("g1", "sales", "agent", "Scout", "read", 3, 1),
  grant("g2", "eng", "user", "Ana", "admin", null, 2),
  grant("g3", "brand", "role", "member", "write", -1, 3),
  grant("g4", "accounts", "agent", "Closer", "write", 60, 4),
];

function cap(id: string, agentId: string, permission: string, createdDaysAgo: number, extra: object = {}) {
  return {
    id,
    agentId,
    scopePath: "org_1",
    permission,
    expiresAt: inDays(30),
    revokedAt: null,
    createdAt: inDays(-createdDaysAgo),
    agentDeactivated: false,
    ...extra,
  };
}

const CAPS = [
  cap("tok_00000001", "scout", "read", 1),
  cap("tok_00000002", "closer", "write", 2, { revokedAt: inDays(-1) }),
  cap("tok_00000003", "auditor", "admin", 3),
  cap("tok_00000004", "drafter", "read", 4, { agentDeactivated: true }),
];

/** What the toolbar's polite live region says: the count a screen reader hears. */
const liveCount = () => document.querySelector("[aria-live='polite']")?.textContent ?? "";

function firstCells(regionName: string) {
  const table = screen.getByRole("region", { name: regionName });
  return within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[0].textContent);
}

function chooseFilter(noun: string, group: string, choice: string) {
  const toggle = screen.getByRole("button", { name: /^Filters/ });
  if (toggle.getAttribute("aria-expanded") !== "true") fireEvent.click(toggle);
  const panel = screen.getByRole("group", { name: `Filter ${noun}` });
  fireEvent.click(within(within(panel).getByRole("group", { name: group })).getByRole("button", { name: choice }));
}

beforeEach(() => {
  urlParams = new URLSearchParams();
  replace.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.startsWith("/api/access/grants?")) return json(grantsPage(url, GRANTS));
      if (url.startsWith("/api/access/capabilities?")) return json(tokensPage(url, CAPS));
      return json({ scopes: [], members: [], agents: [] });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("Access Grants tab list controls", () => {
  it("filters by permission, grantee type and expiry, and counts what is left", async () => {
    render(<AccessView canManage />);
    await screen.findByText("sales");
    await waitFor(() => expect(firstCells("Access grants")).toEqual(["sales", "eng", "brand", "accounts"]));

    chooseFilter("grants", "Permission", "Write");
    await waitFor(() => expect(firstCells("Access grants")).toEqual(["brand", "accounts"]));
    await waitFor(() => expect(liveCount()).toBe("2 of 4 grants"));

    chooseFilter("grants", "Grantee type", "Agent");
    await waitFor(() => expect(firstCells("Access grants")).toEqual(["accounts"]));

    chooseFilter("grants", "Permission", "All");
    chooseFilter("grants", "Grantee type", "All");
    chooseFilter("grants", "Expiry", "Within 7 days");
    await waitFor(() => expect(firstCells("Access grants")).toEqual(["sales"]));
    chooseFilter("grants", "Expiry", "Expired");
    await waitFor(() => expect(firstCells("Access grants")).toEqual(["brand"]));
    chooseFilter("grants", "Expiry", "Never");
    await waitFor(() => expect(firstCells("Access grants")).toEqual(["eng"]));
  });

  it("sorts by expiry from the column header with permanent grants last, then reverses", async () => {
    render(<AccessView canManage />);
    await screen.findByText("sales");
    const expires = screen.getByRole("columnheader", { name: /Expires/ });
    fireEvent.click(within(expires).getByRole("button"));
    expect(expires.getAttribute("aria-sort")).toBe("ascending");
    await waitFor(() => expect(firstCells("Access grants")).toEqual(["brand", "sales", "accounts", "eng"]));
    fireEvent.click(within(expires).getByRole("button"));
    await waitFor(() => expect(firstCells("Access grants")).toEqual(["eng", "accounts", "sales", "brand"]));
  });

  it("narrows with the page search and a filter together, and Clear all empties both", async () => {
    render(<AccessView canManage />);
    await screen.findByText("sales");
    const search = screen.getByRole("searchbox", { name: /Search grants/ });
    fireEvent.change(search, { target: { value: "agent" } });
    await waitFor(() => expect(firstCells("Access grants")).toEqual(["sales", "accounts"]));
    // The page's box is the only search: the toolbar adds none of its own.
    expect(screen.getAllByRole("searchbox")).toHaveLength(1);

    chooseFilter("grants", "Permission", "Read");
    await waitFor(() => expect(firstCells("Access grants")).toEqual(["sales"]));
    await waitFor(() => expect(liveCount()).toBe("1 of 4 grants"));

    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect((search as HTMLInputElement).value).toBe("");
    await waitFor(() => expect(firstCells("Access grants")).toEqual(["sales", "eng", "brand", "accounts"]));
  });

  it("shows a no-match state that clears the page search and the filters", async () => {
    render(<AccessView canManage />);
    await screen.findByText("sales");
    fireEvent.change(screen.getByRole("searchbox", { name: /Search grants/ }), { target: { value: "eng" } });
    chooseFilter("grants", "Permission", "Read");
    expect(await screen.findByText("No grants match “eng” with these filters.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear search and filters" }));
    await waitFor(() => expect(firstCells("Access grants")).toEqual(["sales", "eng", "brand", "accounts"]));
  });

  it("sorts a grantee without a name by its id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("/api/access/grants?")) {
          return json(
            grantsPage(url, [
              grant("g1", "sales", "user", "Maya", "read", null, 1),
              {
                ...grant("g2", "eng", "user", "", "read", null, 2),
                granteeName: undefined,
                granteeId: "ana@acme.test",
              },
            ]),
          );
        }
        return json({ scopes: [], members: [], agents: [] });
      }),
    );
    render(<AccessView canManage />);
    await screen.findByText("sales");
    fireEvent.click(within(screen.getByRole("columnheader", { name: /Grantee/ })).getByRole("button"));
    await waitFor(() => expect(firstCells("Access grants")).toEqual(["eng", "sales"]));
  });

  it("opens a shared link in the view it names, under the grants. prefix", async () => {
    urlParams = new URLSearchParams("grants.sort=grantee&grants.permission=write");
    render(<AccessView canManage />);
    await screen.findByText("brand");
    await waitFor(() => expect(firstCells("Access grants")).toEqual(["accounts", "brand"]));
  });
});

describe("Access Tokens tab list controls", () => {
  it("filters by status, telling a deactivated agent's token from an active one", async () => {
    urlParams = new URLSearchParams("tab=tokens");
    render(<AccessView canManage />);
    await screen.findByText("scout");
    await waitFor(() => expect(firstCells("Agent tokens")).toEqual(["scout", "closer", "auditor", "drafter"]));

    chooseFilter("tokens", "Status", "Active");
    await waitFor(() => expect(firstCells("Agent tokens")).toEqual(["scout", "auditor"]));
    chooseFilter("tokens", "Status", "Agent deactivated");
    await waitFor(() => expect(firstCells("Agent tokens")).toEqual(["drafter"]));
    chooseFilter("tokens", "Status", "Revoked");
    await waitFor(() => expect(firstCells("Agent tokens")).toEqual(["closer"]));
    chooseFilter("tokens", "Status", "All");
    chooseFilter("tokens", "Permission", "Admin");
    await waitFor(() => expect(firstCells("Agent tokens")).toEqual(["auditor"]));
  });

  it("sorts by agent from its header and keeps the sidebar's q link working", async () => {
    urlParams = new URLSearchParams("tab=tokens&q=00000003");
    render(<AccessView canManage />);
    await screen.findByText("auditor");
    await waitFor(() => expect(firstCells("Agent tokens")).toEqual(["auditor"]));
    await waitFor(() => expect(liveCount()).toBe("1 of 4 tokens"));

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
    fireEvent.click(within(screen.getByRole("columnheader", { name: /Agent/ })).getByRole("button"));
    await waitFor(() => expect(firstCells("Agent tokens")).toEqual(["auditor", "closer", "drafter", "scout"]));
  });

  it("matches a token by its scope's display name, not only its path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("/api/access/capabilities?")) {
          return json(
            tokensPage(url, [
              cap("tok_00000001", "scout", "read", 1, { scopePath: "org_1.t_9f2", scopeName: "Pipeline" }),
              cap("tok_00000003", "auditor", "admin", 3),
            ]),
          );
        }
        return json({ scopes: [], members: [], agents: [] });
      }),
    );
    urlParams = new URLSearchParams("tab=tokens&q=pipeline");
    render(<AccessView canManage />);
    await screen.findByText("scout");
    await waitFor(() => expect(firstCells("Agent tokens")).toEqual(["scout"]));
  });

  it("keeps each tab's sort and filters in the URL when switching tabs", async () => {
    urlParams = new URLSearchParams("tab=tokens&tokens.status=active&grants.permission=read");
    render(<AccessView canManage />);
    await screen.findByText("scout");
    fireEvent.click(screen.getByRole("button", { name: "Grants" }));
    expect(replace).toHaveBeenCalledWith("/access?tokens.status=active&grants.permission=read", { scroll: false });
  });
});

describe("Access Grants tab paging", () => {
  // Thirty grants, newest first: one more page than the server's 25.
  const MANY = Array.from({ length: 30 }, (_, i) =>
    grant(`p${i}`, `team${String(i).padStart(2, "0")}`, "role", "member", "read", null, i),
  );
  const requested = () =>
    vi
      .mocked(fetch)
      .mock.calls.map(([url]) => String(url))
      .filter((url) => url.startsWith("/api/access/grants?"));

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.startsWith("/api/access/grants?")
          ? json(grantsPage(url, MANY))
          : json({ scopes: [], members: [], agents: [] }),
      ),
    );
  });

  it("asks the server for one page at a time and keeps the page in the URL", async () => {
    render(<AccessView canManage />);
    await screen.findByText("team00");
    expect(firstCells("Access grants")).toHaveLength(25);
    expect(screen.getByText("1–25 of 30 grants")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() =>
      expect(firstCells("Access grants")).toEqual(["team25", "team26", "team27", "team28", "team29"]),
    );
    expect(new URLSearchParams(window.location.search).get("grants.page")).toBe("2");
    expect(requested().at(-1)).toBe("/api/access/grants?page=2&sort=created&order=desc");
  });

  it("marks the previous page as loading while the next one is on its way, never as its answer", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (!url.startsWith("/api/access/grants?")) return json({ scopes: [], members: [], agents: [] });
        if (url.includes("page=2")) await held;
        return json(grantsPage(url, MANY));
      }),
    );
    render(<AccessView canManage />);
    await screen.findByText("team00");
    const region = screen.getByRole("region", { name: "Access grants" });
    expect(region.getAttribute("aria-busy")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(requested().at(-1)).toBe("/api/access/grants?page=2&sort=created&order=desc"));
    expect(screen.getByRole("region", { name: "Access grants" }).getAttribute("aria-busy")).toBe("true");

    release();
    await waitFor(() =>
      expect(firstCells("Access grants")).toEqual(["team25", "team26", "team27", "team28", "team29"]),
    );
    expect(screen.getByRole("region", { name: "Access grants" }).getAttribute("aria-busy")).toBe("false");
  });

  it("opens a deep link on its page, and a new search starts again at page 1", async () => {
    window.history.replaceState(null, "", "/access?grants.page=2");
    urlParams = new URLSearchParams("grants.page=2");
    render(<AccessView canManage />);
    await screen.findByText("team29");
    expect(requested()[0]).toBe("/api/access/grants?page=2&sort=created&order=desc");

    fireEvent.change(screen.getByRole("searchbox", { name: /Search grants/ }), { target: { value: "team0" } });
    await waitFor(() => expect(firstCells("Access grants")).toHaveLength(10));
    expect(requested().at(-1)).toBe("/api/access/grants?page=1&sort=created&order=desc&q=team0");
    expect(new URLSearchParams(window.location.search).get("grants.page")).toBeNull();
  });
});

describe("Access Grants tab failures", () => {
  it("says the grants could not load instead of showing an empty list, and retries", async () => {
    let fail = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("/api/access/grants?"))
          return fail ? new Response("{}", { status: 500 }) : json(grantsPage(url, GRANTS));
        return json({ scopes: [], members: [], agents: [] });
      }),
    );
    render(<AccessView canManage />);
    expect(await screen.findByText("Could not load the grants.")).toBeTruthy();
    expect(screen.queryByText("No grants yet. Create one above.")).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(firstCells("Access grants")).toEqual(["sales", "eng", "brand", "accounts"]));
  });
});
