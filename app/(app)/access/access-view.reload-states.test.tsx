// @vitest-environment jsdom
//
// The Access page's paged lists (Grants, Tokens, the Audit log) while the page asked for
// is on its way: the pager stays in place, inert, with no count from the page before, so
// keyboard focus stays on Next through a page turn instead of falling to the top of the
// document; and a search after a search that matched nothing shows "Loading…", not an
// empty table.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AccessView } from "./access-view";
import { grantsPage, tokensPage } from "./access-test-api";
import { waitOnFakeClock } from "@/lib/fake-clock-waits.testsupport";

waitOnFakeClock();

let searchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {} }),
  useSearchParams: () => searchParams,
}));
vi.mock("@/components/reveal", () => ({ Reveal: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const pad = (i: number) => String(i).padStart(2, "0");

const GRANTS = Array.from({ length: 30 }, (_, i) => ({
  id: `g${pad(i)}`,
  granteeType: "agent",
  granteeId: `agent_${i}`,
  granteeName: `Agent ${pad(i)}`,
  permission: "read",
  expiresAt: null,
  createdAt: new Date(Date.UTC(2026, 0, 30 - i)).toISOString(),
  scope: { id: `s${i}`, path: `org_1.team${pad(i)}`, name: `team${pad(i)}` },
}));
const TOKENS = Array.from({ length: 30 }, (_, i) => ({
  id: `cap${pad(i)}`,
  agentId: `agent-${pad(i)}`,
  scopePath: "org_1",
  permission: "read",
  expiresAt: "2099-01-01T00:00:00.000Z",
  revokedAt: null,
  createdAt: new Date(Date.UTC(2026, 0, 30 - i)).toISOString(),
  agentDeactivated: false,
}));

function auditPage(page: number) {
  const entries = [
    {
      id: `a${page}`,
      actorType: "agent",
      actorName: "qa-agent",
      action: "memory.read",
      target: `org_1.page${page}`,
      decision: "allow",
      reason: null,
      at: "2026-09-30T08:00:00.000Z",
    },
  ];
  return { entries, total: 51, counts: { allowed: 51, denied: 0 }, page, pageSize: 50, totalPages: 2 };
}

/** Answers every list at once except page 2, or a search for `held`, which wait for `release()`. */
function stubApi(heldSearch = "\u0000") {
  const held: Array<() => void> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const page = new URL(url, "http://localhost").searchParams.get("page");
      const answer = url.startsWith("/api/access/grants?")
        ? grantsPage(url, GRANTS as never)
        : url.startsWith("/api/access/capabilities?")
          ? tokensPage(url, TOKENS)
          : url.startsWith("/api/audit")
            ? auditPage(Number(page))
            : { scopes: [], members: [], agents: [] };
      if (page === "2" || url.includes(`q=${heldSearch}`)) await new Promise<void>((r) => held.push(r));
      return json(answer);
    }),
  );
  return {
    release: () =>
      act(async () => {
        held.splice(0).forEach((r) => r());
      }),
    heldCount: () => held.length,
    reads: () => vi.mocked(fetch).mock.calls.length,
  };
}

/** Presses Next from the keyboard's point of view and checks focus never leaves it. */
async function turnPage(api: ReturnType<typeof stubApi>, nav: string, onPage2: string) {
  const next = within(screen.getByRole("navigation", { name: nav })).getByRole("button", { name: "Next page" });
  next.focus();
  fireEvent.click(next);
  await waitFor(() => expect(api.heldCount()).toBe(1));

  const pager = screen.getByRole("navigation", { name: nav });
  expect(pager.getAttribute("aria-busy")).toBe("true");
  expect(pager.textContent).toContain("Loading page 2…");
  expect(pager.textContent).not.toMatch(/ of /);
  expect(document.activeElement).toBe(next);
  const reads = api.reads();
  fireEvent.click(next);
  expect(api.reads()).toBe(reads);

  await api.release();
  expect(await screen.findByText(onPage2)).toBeTruthy();
  expect(screen.getByRole("navigation", { name: nav }).getAttribute("aria-busy")).toBe("false");
  expect(document.activeElement).toBe(next);
  expect(next.getAttribute("aria-disabled")).toBe("true");
}

afterEach(() => {
  vi.unstubAllGlobals();
  searchParams = new URLSearchParams();
  window.history.replaceState(null, "", "/");
});

describe("Access pagers through a page turn", () => {
  it("Grants: the pager stays, inert, and Next keeps focus", async () => {
    window.history.replaceState(null, "", "/access");
    const api = stubApi();
    render(<AccessView canManage />);
    await screen.findByText("team00");
    await turnPage(api, "Pages of grants", "team25");
  });

  it("Tokens: the pager stays, inert, and Next keeps focus", async () => {
    window.history.replaceState(null, "", "/access?tab=tokens");
    searchParams = new URLSearchParams("tab=tokens");
    const api = stubApi();
    render(<AccessView canManage />);
    await screen.findByText("agent-00");
    await turnPage(api, "Pages of tokens", "agent-25");
  });

  it("Audit log: the pager stays, inert, and Next keeps focus", async () => {
    window.history.replaceState(null, "", "/access?tab=audit");
    searchParams = new URLSearchParams("tab=audit");
    const api = stubApi();
    render(<AccessView canManage />);
    await screen.findByText("org_1.page1");
    await turnPage(api, "Pages of audit rows", "org_1.page2");
  });
});

describe("Access lists during a search after one that matched nothing", () => {
  it.each([
    ["Grants", "/access", "team00", "Access grants"],
    ["Tokens", "/access?tab=tokens", "agent-00", "Agent tokens"],
  ])("%s: shows Loading…, not an empty table, until the answer comes", async (_tab, url, first, region) => {
    window.history.replaceState(null, "", url);
    searchParams = new URLSearchParams(url.split("?")[1] ?? "");
    const api = stubApi("zzzz");
    render(<AccessView canManage />);
    await screen.findByText(first);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzz" } });
    await waitFor(() => expect(screen.queryByText(first)).toBeNull());
    expect(await screen.findByText(/match .zzz./)).toBeTruthy();

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzzz" } });
    await waitFor(() => expect(api.heldCount()).toBe(1));
    expect(screen.queryByRole("region", { name: region })).toBeNull();
    expect(screen.queryByText(/match .zzz/)).toBeNull();
    expect(screen.getByText("Loading…")).toBeTruthy();
    await api.release();
    expect(await screen.findByText(/match .zzzz./)).toBeTruthy();
  });
});

describe("stale access writes", () => {
  it.each(["grants", "tokens"])("%s cannot revoke the stale row again while the refresh is pending", async (kind) => {
    searchParams = new URLSearchParams(`tab=${kind}`);
    window.history.replaceState(null, "", `/access?tab=${kind}`);
    let changed = false;
    const pending: Array<() => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "DELETE") {
          changed = true;
          return json({ ok: true });
        }
        if (changed && url.startsWith("/api/access/")) await new Promise<void>((resolve) => pending.push(resolve));
        return json(
          url.startsWith("/api/access/grants?")
            ? grantsPage(url, GRANTS as never)
            : url.startsWith("/api/access/capabilities?")
              ? tokensPage(url, TOKENS)
              : { scopes: [], members: [], agents: [] },
        );
      }),
    );
    render(<AccessView canManage />);
    const revoke = (await screen.findAllByRole("button", { name: "revoke" }))[0];
    fireEvent.click(revoke);
    fireEvent.click(screen.getByRole("button", { name: "yes" }));
    await waitFor(() => expect(pending.length).toBeGreaterThan(0));
    const staleRevoke = screen.getAllByRole("button", { name: "revoke" })[0];
    expect(staleRevoke.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(staleRevoke);
    expect(screen.queryByRole("button", { name: "yes" })).toBeNull();
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
    await act(async () => pending.splice(0).forEach((resolve) => resolve()));
  });
});

describe("pending confirmations on stale access rows", () => {
  it.each(["grants", "tokens"])("%s cannot confirm revoke during a page turn", async (kind) => {
    searchParams = new URLSearchParams(`tab=${kind}`);
    window.history.replaceState(null, "", `/access?tab=${kind}`);
    const api = stubApi();
    render(<AccessView canManage />);
    fireEvent.click((await screen.findAllByRole("button", { name: "revoke" }))[0]);
    const yes = screen.getByRole("button", { name: "yes" });
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(api.heldCount()).toBe(1));
    expect(yes.getAttribute("aria-disabled")).toBe("true");
    const calls = api.reads();
    fireEvent.click(yes);
    expect(api.reads()).toBe(calls);
    await api.release();
  });
});
