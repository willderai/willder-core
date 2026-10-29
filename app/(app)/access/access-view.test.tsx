import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AccessView } from "./access-view";
import { grantsPage, tokensPage } from "./access-test-api";
import { waitOnFakeClock } from "@/lib/fake-clock-waits.testsupport";

waitOnFakeClock();

// The page seeds its tab and filter from the URL; each test sets `searchParams`.
let searchParams = new URLSearchParams();
const routerReplace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: routerReplace }),
  useSearchParams: () => searchParams,
}));

vi.mock("@/components/reveal", () => ({
  Reveal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

// Two tokens for one agent, same scope and permission, minted a minute apart:
// the case where an admin could not tell which row to revoke.
const CAPABILITIES = [
  {
    id: "cmg6k2m1p0001l804a7f3x9qz",
    agentId: "qa-agent",
    scopePath: "org_1",
    permission: "read",
    expiresAt: "2099-01-01T00:00:00.000Z",
    revokedAt: null,
    createdAt: "2026-09-30T07:01:00.000Z",
    agentDeactivated: false,
  },
  {
    id: "cmg6k2m1q0002l804k2d8w4vn",
    agentId: "qa-agent",
    scopePath: "org_1",
    permission: "read",
    expiresAt: "2099-01-01T00:00:00.000Z",
    revokedAt: null,
    createdAt: "2026-09-30T07:02:00.000Z",
    agentDeactivated: false,
  },
];

function stubApi(audit: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.startsWith("/api/access/capabilities?")) return json(tokensPage(url, CAPABILITIES));
      if (url === "/api/access/scopes") return json({ scopes: [] });
      if (url.startsWith("/api/access/grants?")) return json(grantsPage(url, []));
      if (url.startsWith("/api/audit")) return json(audit);
      return json({});
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  searchParams = new URLSearchParams();
  // The audit tab keeps its page and decision in the address bar itself.
  window.history.replaceState(null, "", "/");
  routerReplace.mockClear();
});

function auditRow(id: string, target: string, decision: "allow" | "deny") {
  return {
    id,
    actorType: "agent",
    actorName: "qa-agent",
    action: "memory.read",
    target,
    decision,
    reason: null,
    at: "2026-09-30T08:00:00.000Z",
  };
}

/** One GET /api/audit answer; one page of one row unless `overrides` says otherwise. */
function auditPage(entries: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    entries,
    total: entries.length,
    counts: { allowed: entries.length, denied: 0 },
    page: 1,
    pageSize: 50,
    totalPages: 1,
    ...overrides,
  };
}

describe("Access page", () => {
  it("tells two tokens for the same agent apart by short id and creation time", async () => {
    stubApi({});
    render(<AccessView canManage />);
    fireEvent.click(screen.getByRole("button", { name: "Tokens" }));

    const table = await screen.findByRole("region", { name: "Agent tokens" });
    expect(within(table).getByRole("columnheader", { name: "Token ID" })).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: "Created" })).toBeTruthy();
    expect(within(table).getByText("a7f3x9qz").getAttribute("title")).toBe(CAPABILITIES[0].id);
    expect(within(table).getByText("k2d8w4vn").getAttribute("title")).toBe(CAPABILITIES[1].id);
  });

  it("reports the audit trail's full total and both decision counts, not the page length", async () => {
    stubApi({
      entries: [
        {
          id: "a1",
          actorType: "agent",
          actorName: "qa-agent",
          action: "capability.refused",
          target: "org_1",
          decision: "deny",
          reason: "capability revoked",
          capabilityId: CAPABILITIES[0].id,
          at: "2026-09-30T08:00:00.000Z",
        },
      ],
      total: 4999,
      counts: { allowed: 4987, denied: 12 },
      page: 1,
      pageSize: 50,
      totalPages: 100,
    });
    render(<AccessView canManage />);
    fireEvent.click(screen.getByRole("button", { name: "Audit log" }));

    expect(await screen.findByText("1–1 of 4,999 rows · 4,987 allowed · 12 denied")).toBeTruthy();
    const table = screen.getByRole("region", { name: "Access audit" });
    expect(within(table).getByText("qa-agent")).toBeTruthy();
    expect(within(table).getByText("token a7f3x9qz")).toBeTruthy();
  });

  it("never truncates the marker that tells a custom agent from a product writer, and escapes bidi controls", async () => {
    const marker = ' (agent key "custom-1")';
    stubApi({
      entries: [
        {
          id: "a1",
          actorType: "agent",
          actorName: `\u202EtnegA erutcetihcrA\u202C Agent${marker}`,
          action: "memory.write",
          target: "org_1",
          decision: "allow",
          reason: null,
          capabilityId: null,
          at: "2026-09-30T08:00:00.000Z",
        },
      ],
      total: 1,
      counts: { allowed: 1, denied: 0 },
      page: 1,
      pageSize: 50,
      totalPages: 1,
    });
    const { container } = render(<AccessView canManage />);
    fireEvent.click(screen.getByRole("button", { name: "Audit log" }));

    const table = await screen.findByRole("region", { name: "Access audit" });
    const shown = await within(table).findByText(marker.trim(), { normalizer: (t) => t.trim() });
    expect(shown.closest(".truncate")).toBeNull();
    expect(shown.classList.contains("shrink-0")).toBe(true);
    expect(within(table).getByText("[U+202E]tnegA erutcetihcrA[U+202C] Agent").classList.contains("truncate")).toBe(
      true,
    );
    expect(/\p{Bidi_Control}/u.test(container.innerHTML)).toBe(false);
  });

  it("escapes bidi controls in agent, member and grantee names on the Grants and Tokens tabs", async () => {
    const spoof = "\u202EmetsyS\u202C";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("/api/access/grants?")) {
          return json(
            grantsPage(url, [
              {
                id: "g1",
                granteeType: "agent",
                granteeId: "custom-1",
                granteeName: `${spoof} Agent`,
                permission: "read",
                expiresAt: null,
                createdAt: "2026-09-30T07:00:00.000Z",
                scope: { id: "s1", path: "org_1", name: "Root" },
              },
            ]),
          );
        }
        if (url === "/api/access/scopes") return json({ scopes: [] });
        if (url.startsWith("/api/settings/members?"))
          return json({ members: [{ id: "u1", name: `${spoof} Admin`, email: "a@example.com" }], total: 1 });
        if (url.startsWith("/api/agents?limit="))
          return json({ agents: [{ id: "g1", agentKey: "custom-1", name: `${spoof} Agent` }], more: false });
        if (url.startsWith("/api/access/capabilities?")) return json(tokensPage(url, []));
        return json({});
      }),
    );
    const bidi = /\p{Bidi_Control}/u;
    const { container } = render(<AccessView canManage />);

    expect(await screen.findByText("[U+202E]metsyS[U+202C] Agent")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "+ New grant" }));
    fireEvent.click(screen.getByRole("button", { name: "Member: Choose a member" }));
    expect(await screen.findByRole("option", { name: /^\[U\+202E\]metsyS\[U\+202C\] Admin/ })).toBeTruthy();
    fireEvent.change(screen.getByDisplayValue("user"), { target: { value: "agent" } });
    fireEvent.click(screen.getByRole("button", { name: "Agent: Choose an agent" }));
    expect(await screen.findByRole("option", { name: "[U+202E]metsyS[U+202C] Agent" })).toBeTruthy();
    expect(bidi.test(container.innerHTML)).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Tokens" }));
    fireEvent.click(await screen.findByRole("button", { name: "+ Issue token" }));
    fireEvent.click(screen.getByRole("button", { name: "Agent: Choose an agent" }));
    await screen.findByRole("option", { name: "[U+202E]metsyS[U+202C] Agent" });
    expect(bidi.test(container.innerHTML)).toBe(false);
  });

  it("filters the Tokens tab by a token's short id taken from the URL", async () => {
    stubApi({});
    searchParams = new URLSearchParams("tab=tokens&q=k2d8w4vn");
    render(<AccessView canManage />);

    const table = await screen.findByRole("region", { name: "Agent tokens" });
    expect(within(table).getByText("k2d8w4vn")).toBeTruthy();
    expect(within(table).queryByText("a7f3x9qz")).toBeNull();
    await waitFor(() => expect(document.querySelector("[aria-live='polite']")?.textContent).toBe("1 of 2 tokens"));
  });

  it("shows matching scopes flat, each with the names above it", async () => {
    stubApi({});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/api/access/scopes"
          ? json({
              scopes: [
                { id: "s0", path: "org_1", name: "Organization", createdAt: "2026-09-01T00:00:00.000Z" },
                { id: "s1", path: "org_1.dept_eng", name: "Engineering", createdAt: "2026-09-01T00:00:00.000Z" },
                { id: "s2", path: "org_1.dept_eng.platform", name: "Platform", createdAt: "2026-09-01T00:00:00.000Z" },
              ],
            })
          : json({}),
      ),
    );
    searchParams = new URLSearchParams("tab=scopes&q=platform");
    render(<AccessView canManage />);

    expect(await screen.findByText("Platform")).toBeTruthy();
    expect(screen.getByText("Organization / Engineering")).toBeTruthy();
    expect(screen.queryByText("Engineering")).toBeNull();
    expect(screen.getByText("1 of 3 scopes matches \u201cplatform\u201d")).toBeTruthy();
  });

  it("searches every audit row on the server, with exact counts for the matches", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.startsWith("/api/audit")
        ? json(
            auditPage([auditRow("a1", "org_1", "deny"), auditRow("a2", "org_1", "allow")], {
              total: 37,
              counts: { allowed: 30, denied: 7 },
              totalPages: 1,
            }),
          )
        : json({}),
    );
    vi.stubGlobal("fetch", fetchMock);
    searchParams = new URLSearchParams("tab=audit&q=a7f3x9qz");
    render(<AccessView canManage />);

    expect(await screen.findByText("1–2 of 37 matches · 30 allowed · 7 denied")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/audit?page=1&q=a7f3x9qz",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/access/search"))).toBe(false);
  });

  it("pages through the log, and a new search or decision starts again at page 1", async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (!url.startsWith("/api/audit")) return json({});
        requests.push(url);
        const page = Number(new URL(url, "https://w.test").searchParams.get("page"));
        return json(
          auditPage([auditRow(`p${page}`, `org_1.page${page}`, "allow")], {
            page,
            total: 120,
            counts: { allowed: 120, denied: 0 },
            totalPages: 3,
          }),
        );
      }),
    );
    searchParams = new URLSearchParams("tab=audit");
    render(<AccessView canManage />);

    expect(await screen.findByText("Page 1 of 3")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Previous page" }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("org_1.page2")).toBeTruthy();
    expect(screen.getByText("51–51 of 120 rows · 120 allowed · 0 denied")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("org_1.page3")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next page" }).getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "deny" }));
    expect(await screen.findByText("org_1.page1")).toBeTruthy();
    expect(requests.at(-1)).toBe("/api/audit?page=1&decision=deny");
  });

  it("keeps the audit tab's page and decision in the URL, so a link reopens them", async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (!url.startsWith("/api/audit")) return json({});
        requests.push(url);
        const page = Number(new URL(url, "https://w.test").searchParams.get("page"));
        return json(
          auditPage([auditRow(`p${page}`, `org_1.page${page}`, "deny")], {
            page,
            total: 120,
            counts: { allowed: 0, denied: 120 },
            totalPages: 3,
          }),
        );
      }),
    );
    searchParams = new URLSearchParams("tab=audit");
    const first = render(<AccessView canManage />);
    fireEvent.click(await screen.findByRole("button", { name: "deny" }));
    // Next is held (aria-disabled) while the deny page loads, and a press then is ignored: if the
    // unfiltered page arrived before the press on deny, its pager is already on screen, so wait
    // for the deny page itself before pressing.
    await waitFor(() => expect(requests).toContain("/api/audit?page=1&decision=deny"));
    const next = screen.getByRole("button", { name: "Next page" });
    await waitFor(() => expect(next.getAttribute("aria-disabled")).toBe("false"));
    fireEvent.click(next);
    expect(await screen.findByText("org_1.page2")).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get("audit.decision")).toBe("deny");
    expect(new URLSearchParams(window.location.search).get("audit.page")).toBe("2");

    first.unmount();
    requests.length = 0;
    render(<AccessView canManage />);
    expect(await screen.findByText("org_1.page2")).toBeTruthy();
    expect(requests).toEqual(["/api/audit?page=2&decision=deny"]);
    expect(screen.getByRole("button", { name: "deny" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("opens the audit tab on page 1 after the search changed on another tab", async () => {
    const requests: string[] = [];
    stubApi(auditPage([auditRow("a1", "org_1.x", "allow")], { total: 120, totalPages: 3 }));
    const stubbed = vi.mocked(fetch);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("/api/audit")) requests.push(url);
        return stubbed(url);
      }),
    );
    searchParams = new URLSearchParams("audit.page=3");
    window.history.replaceState(null, "", "/access?audit.page=3");
    render(<AccessView canManage />);
    fireEvent.change(await screen.findByRole("searchbox"), { target: { value: "deploy" } });
    fireEvent.click(screen.getByRole("button", { name: "Audit log" }));
    await waitFor(() => expect(requests.length).toBeGreaterThan(0));
    expect(requests.every((url) => new URL(url, "https://w.test").searchParams.get("page") === "1")).toBe(true);
    expect(routerReplace).toHaveBeenCalledWith("/access?tab=audit&q=deploy", { scroll: false });
  });

  it("sends a link's overlong search cut to what the route accepts, and finds the way back from an empty page", async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (!url.startsWith("/api/audit")) return json({});
        requests.push(url);
        const page = Number(new URL(url, "https://w.test").searchParams.get("page"));
        return json(
          page === 1
            ? auditPage([auditRow("p1", "org_1.page1", "allow")], {
                total: 60,
                counts: { allowed: 60, denied: 0 },
                totalPages: 2,
              })
            : auditPage([], { page, total: 50, counts: { allowed: 50, denied: 0 }, totalPages: 1 }),
        );
      }),
    );
    searchParams = new URLSearchParams(`tab=audit&q=${"z".repeat(140)}`);
    render(<AccessView canManage />);

    expect(await screen.findByText("org_1.page1")).toBeTruthy();
    expect(new URL(requests[0]!, "https://w.test").searchParams.get("q")).toBe("z".repeat(100));
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText(/No audit rows on this page/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to the first page" }));
    expect(await screen.findByText("org_1.page1")).toBeTruthy();
  });

  it("says the log could not load instead of showing an empty one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (url.startsWith("/api/audit") ? json({ error: "boom" }, 500) : json({}))),
    );
    searchParams = new URLSearchParams("tab=audit&q=acme");
    render(<AccessView canManage />);

    expect((await screen.findByRole("alert")).textContent).toContain("Could not load the audit log");
    expect(screen.queryByText(/No audit rows match/)).toBeNull();
    expect(screen.queryByText(/0 matches/)).toBeNull();
  });

  it("shows the admin notice when the server refuses the audit log", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ error: "forbidden" }, 403)),
    );
    searchParams = new URLSearchParams("tab=audit&q=sales");
    render(<AccessView canManage />);

    expect(await screen.findByText("Admin access required to view this section.")).toBeTruthy();
  });

  it("never shows an older search's answer after a newer one", async () => {
    let releaseOld: () => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("q=old")) {
          return new Promise<Response>((resolve) => {
            releaseOld = () => resolve(json(auditPage([auditRow("o1", "org_1.old", "allow")])));
          });
        }
        return Promise.resolve(json(auditPage([auditRow("n1", "org_1.newer", "allow")])));
      }),
    );
    searchParams = new URLSearchParams("tab=audit&q=old");
    render(<AccessView canManage />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "newer" } });
    expect(await screen.findByText("org_1.newer")).toBeTruthy();
    releaseOld();
    await act(() => vi.advanceTimersByTimeAsync(20));
    expect(screen.queryByText("org_1.old")).toBeNull();
    expect(screen.getByText("org_1.newer")).toBeTruthy();
  });

  it("issues a token for the nested scope picked by typing, sending its full path", async () => {
    const posts: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/access/capabilities" && init?.method === "POST") {
          posts.push(JSON.parse(String(init.body)));
          return json({ token: "wld_issued" });
        }
        if (url.startsWith("/api/access/capabilities?")) return json(tokensPage(url, []));
        if (url === "/api/access/scopes")
          return json({
            scopes: [
              { id: "s0", path: "org_1", name: "Organization", createdAt: "2026-09-01T00:00:00.000Z" },
              { id: "s1", path: "org_1.crew_1c5b79", name: "crew", createdAt: "2026-09-01T00:00:00.000Z" },
              {
                id: "s2",
                path: "org_1.crew_1c5b79.atlas_36c2d6",
                name: "atlas",
                createdAt: "2026-09-01T00:00:00.000Z",
              },
              { id: "s3", path: "org_1.sales", name: "Sales", createdAt: "2026-09-01T00:00:00.000Z" },
            ],
          });
        if (url.startsWith("/api/agents?limit="))
          return json({ agents: [{ id: "a1", agentKey: "coding_agent", name: "Coding" }], more: false });
        return json({});
      }),
    );
    searchParams = new URLSearchParams("tab=tokens");
    render(<AccessView canManage />);

    fireEvent.click(await screen.findByRole("button", { name: "+ Issue token" }));
    fireEvent.click(screen.getByRole("button", { name: "Agent: Choose an agent" }));
    fireEvent.click(await screen.findByRole("option", { name: "Coding" }));
    fireEvent.click(screen.getByRole("button", { name: "Scope: Org root" }));
    const filter = screen.getByRole("combobox", { name: "Search scope" });
    fireEvent.change(filter, { target: { value: "atlas" } });
    // The scopes arrive by their own request: Enter picks the match only once it is listed.
    await screen.findByRole("option", { name: /^atlas, in / });
    fireEvent.keyDown(filter, { key: "Enter" });
    expect(screen.getByRole("button", { name: "Scope: Org root › crew › atlas" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Issue token" }));
    expect(await screen.findByText("wld_issued")).toBeTruthy();
    expect(posts).toEqual([
      { agentId: "coding_agent", scopePath: "org_1.crew_1c5b79.atlas_36c2d6", permission: "read", ttlHours: 168 },
    ]);
  });
  // The scopes behind the grant and parent-scope tests: an org root, a team and
  // a child under it, plus a second team, in the order GET /api/access/scopes returns.
  const NESTED_SCOPES = [
    { id: "s0", path: "org_1", name: "Organization", createdAt: "2026-09-01T00:00:00.000Z" },
    { id: "s1", path: "org_1.crew_1c5b79", name: "crew", createdAt: "2026-09-01T00:00:00.000Z" },
    { id: "s2", path: "org_1.crew_1c5b79.atlas_36c2d6", name: "atlas", createdAt: "2026-09-01T00:00:00.000Z" },
    { id: "s3", path: "org_1.sales", name: "Sales", createdAt: "2026-09-01T00:00:00.000Z" },
  ];

  function stubPosts(postUrl: string, posts: unknown[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === postUrl && init?.method === "POST") {
          posts.push(JSON.parse(String(init.body)));
          return json({});
        }
        if (url === "/api/access/scopes") return json({ scopes: NESTED_SCOPES });
        if (url.startsWith("/api/access/grants?")) return json(grantsPage(url, []));
        return json({});
      }),
    );
  }

  it("creates a grant on the nested scope picked by typing, sending that scope's id", async () => {
    const posts: unknown[] = [];
    stubPosts("/api/access/grants", posts);
    render(<AccessView canManage />);

    fireEvent.click(await screen.findByRole("button", { name: "+ New grant" }));
    fireEvent.change(screen.getByRole("option", { name: "everyone (scope baseline)" }).closest("select")!, {
      target: { value: "everyone" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Scope: Choose a scope" }));
    const filter = screen.getByRole("combobox", { name: "Search scope" });
    fireEvent.change(filter, { target: { value: "atlas" } });
    // The scopes arrive by their own request: Enter picks the match only once it is listed.
    await screen.findByRole("option", { name: /^atlas, in / });
    fireEvent.keyDown(filter, { key: "Enter" });

    fireEvent.click(screen.getByRole("button", { name: "Create grant" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ scopeId: "s2", granteeType: "everyone" });
  });

  it("refuses to create a grant until a scope is chosen", async () => {
    const posts: unknown[] = [];
    stubPosts("/api/access/grants", posts);
    render(<AccessView canManage />);

    fireEvent.click(await screen.findByRole("button", { name: "+ New grant" }));
    fireEvent.change(screen.getByRole("option", { name: "everyone (scope baseline)" }).closest("select")!, {
      target: { value: "everyone" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create grant" }));

    expect(await screen.findByText("Choose a scope for the grant.")).toBeTruthy();
    expect(posts).toEqual([]);
  });

  it("creates a sub-scope under the nested parent picked by typing, sending its full path", async () => {
    const posts: unknown[] = [];
    stubPosts("/api/access/scopes", posts);
    searchParams = new URLSearchParams("tab=scopes");
    render(<AccessView canManage />);

    fireEvent.click(await screen.findByRole("button", { name: "+ New scope" }));
    fireEvent.change(screen.getByPlaceholderText("e.g. Sales Team"), { target: { value: "evals" } });
    fireEvent.click(screen.getByRole("button", { name: "Parent scope: Org root" }));
    const filter = screen.getByRole("combobox", { name: "Search parent scope" });
    fireEvent.change(filter, { target: { value: "atlas" } });
    // The scopes arrive by their own request: Enter picks the match only once it is listed.
    await screen.findByRole("option", { name: /^atlas, in / });
    fireEvent.keyDown(filter, { key: "Enter" });

    fireEvent.click(screen.getByRole("button", { name: "Create scope" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ name: "evals", parentPath: "org_1.crew_1c5b79.atlas_36c2d6" });
  });

  it("loads no list for someone who may not manage access, on any tab the URL names", async () => {
    for (const tab of ["", "tab=scopes", "tab=tokens", "tab=audit&q=deny"]) {
      const fetchSpy = vi.fn(async () => json({}));
      vi.stubGlobal("fetch", fetchSpy);
      searchParams = new URLSearchParams(tab);
      const { unmount } = render(<AccessView canManage={false} />);

      expect(screen.getByText(/Only an admin of this organization can see its grants/)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Tokens" })).toBeNull();
      await act(() => vi.advanceTimersByTimeAsync(300)); // past the audit search debounce
      expect(fetchSpy).not.toHaveBeenCalled();
      unmount();
    }
  });

  it("never calls a deactivated agent's live token active, and filters on that status", async () => {
    const deactivated = { ...CAPABILITIES[1], agentDeactivated: true };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.startsWith("/api/access/capabilities?")
          ? json(tokensPage(url, [CAPABILITIES[0], deactivated]))
          : json({ scopes: [], agents: [] }),
      ),
    );
    searchParams = new URLSearchParams("tab=tokens");
    render(<AccessView canManage />);

    const table = await screen.findByRole("region", { name: "Agent tokens" });
    // Newest first by default, so the deactivated agent's later token leads.
    const rows = ["a7f3x9qz", "k2d8w4vn"].map((id) => within(table).getByText(id).closest("tr") as HTMLElement);
    expect(within(rows[0]).getByText("active")).toBeTruthy();
    expect(within(rows[1]).getByText("agent deactivated")).toBeTruthy();
    expect(within(rows[1]).queryByText("active")).toBeNull();
    // Reactivating the agent would make the token work again, so it can still be revoked.
    expect(within(rows[1]).getByRole("button", { name: "revoke" })).toBeTruthy();

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "deactivated" } });
    await waitFor(() => expect(screen.queryByText("a7f3x9qz")).toBeNull());
    expect(screen.getByText("k2d8w4vn")).toBeTruthy();
  });
});
