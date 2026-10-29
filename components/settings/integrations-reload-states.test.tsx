// @vitest-environment jsdom
//
// What the server-paged Integrations lists show while the page they asked for is on its
// way: the Mailboxes cards, the Slack workspace card, Knowledge sources and Connectors.
// Nothing that claims what the org holds now (an empty or no-match message, a connected
// status, "Connect another") is drawn from the answer before a write; the rows from it
// may stay, dimmed. And a pager stays in place through a page turn, so focus stays on Next.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { isIntegrationsList, integrationsPage } from "./integrations-test-api";
import { isSourcesList, sourcesPage } from "./sources-test-api";

let urlParams = new URLSearchParams();
vi.mock("next/navigation", () => ({ useSearchParams: () => urlParams }));

type Account = {
  id: string;
  provider: string;
  externalAccountId: string;
  status: string;
  meta: Record<string, string>;
  createdAt: string;
};
type Source = {
  id: string;
  type: string;
  name: string;
  externalId: string;
  scopePath: string;
  status: string;
  meta: null;
  createdAt: string;
  _count: { files: number };
};

const day = (i: number) => new Date(Date.UTC(2026, 8, 30 - i)).toISOString();
const gmail = (i: number): Account => ({
  id: `int_gmail_${i}`,
  provider: "gmail",
  externalAccountId: `g${i}`,
  status: "connected",
  meta: { email: `user${i}@acme.test` },
  createdAt: day(i),
});
const slack = (i: number): Account => ({
  id: `int_slack_${i}`,
  provider: "slack",
  externalAccountId: `t${i}`,
  status: "connected",
  meta: { teamName: `Team ${i}` },
  createdAt: day(i),
});
const source = (type: string, i: number): Source => ({
  id: `s${i}`,
  type,
  name: `${type} ${String(i).padStart(2, "0")}`,
  externalId: `x${i}`,
  scopePath: `org.s${i}`,
  status: "active",
  meta: null,
  createdAt: day(i),
  _count: { files: 1 },
});

/**
 * The integrations and sources routes over mutable fixtures. A GET that `hold(url)`
 * picks waits until `release()`; a DELETE removes the row it names.
 */
function server(data: { accounts: Account[]; sources: Source[] }, hold: { list: (url: string) => boolean }) {
  const held: Array<() => void> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "DELETE") {
        const id = url.split("/").at(-1);
        data.accounts = data.accounts.filter((a) => a.id !== id);
        return Response.json({ ok: true });
      }
      if (!isIntegrationsList(url) && !isSourcesList(url)) return Response.json({});
      if (hold.list(url)) await new Promise<void>((r) => held.push(r));
      return Response.json(isSourcesList(url) ? sourcesPage(url, data.sources) : integrationsPage(url, data.accounts));
    }),
  );
  return {
    release: () =>
      act(async () => {
        held.splice(0).forEach((r) => r());
      }),
    heldCount: () => held.length,
    reads: (path: string) =>
      vi
        .mocked(fetch)
        .mock.calls.filter(([u, i]) => !i?.method && new URL(String(u), "http://localhost").pathname === path).length,
  };
}

const param = (url: string, name: string) => new URL(url, "http://localhost").searchParams.get(name);

/** The Gmail card: the card around its label. */
const gmailCard = () => screen.getByText("Gmail", { selector: "span" }).closest(".glass-surface") as HTMLElement;

/** Asserts focus stays on Next while page 2 loads, the pager claims no count, and it waits. */
async function turnPageKeepingFocus(api: ReturnType<typeof server>, path: string, nav: string) {
  const next = within(screen.getByRole("navigation", { name: nav })).getByRole("button", { name: "Next page" });
  next.focus();
  fireEvent.click(next);
  await waitFor(() => expect(api.heldCount()).toBe(1));
  const pager = screen.getByRole("navigation", { name: nav });
  expect(pager.getAttribute("aria-busy")).toBe("true");
  expect(pager.textContent).toContain("Loading page 2…");
  expect(pager.textContent).not.toMatch(/ of /);
  expect(document.activeElement).toBe(next);
  const reads = api.reads(path);
  fireEvent.click(next);
  expect(api.reads(path)).toBe(reads);
  await api.release();
  await waitFor(() => expect(screen.getByRole("navigation", { name: nav }).getAttribute("aria-busy")).toBe("false"));
  expect(document.activeElement).toBe(next);
  expect(next.getAttribute("aria-disabled")).toBe("true");
}

beforeEach(() => {
  urlParams = new URLSearchParams();
  window.history.replaceState(null, "", "/integrations");
  vi.stubEnv("NEXT_PUBLIC_CONNECTORS_ENABLED", "true");
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Mailboxes cards", () => {
  it("do not still read connected while the reload after disconnecting the only account is in flight", async () => {
    const data = { accounts: [gmail(0)], sources: [] };
    let disconnected = false;
    const api = server(data, { list: (url) => disconnected && param(url, "provider") === "gmail" });
    const { IntegrationsPanel } = await import("./integrations-panel");
    render(<IntegrationsPanel />);
    await screen.findByText("user0@acme.test");
    expect(within(gmailCard()).getByText("connected")).toBeTruthy();

    disconnected = true;
    fireEvent.click(screen.getByRole("button", { name: "Disconnect user0@acme.test" }));
    await waitFor(() => expect(api.heldCount()).toBe(1));
    const card = within(gmailCard());
    expect(card.queryByText("connected")).toBeNull();
    expect(gmailCard().querySelector(".from-gold\\/0")).toBeNull();
    expect(card.getByText("Checking…")).toBeTruthy();
    expect(card.queryByRole("button", { name: "Connect" })).toBeNull();

    await api.release();
    expect(await within(gmailCard()).findByText("Not connected")).toBeTruthy();
    expect(within(gmailCard()).getByRole("button", { name: "Connect" })).toBeTruthy();
  });

  it("keep the action a keyboard user pressed in place, inert, while they check after a write", async () => {
    const pending: Account = { ...gmail(0), status: "pending" };
    const data = { accounts: [pending], sources: [] };
    let disconnected = false;
    const api = server(data, { list: () => disconnected });
    const { IntegrationsPanel } = await import("./integrations-panel");
    render(<IntegrationsPanel />);
    const outlookCard = () =>
      screen.getByText("Outlook", { selector: "span" }).closest(".glass-surface") as HTMLElement;
    await screen.findByText("pending…");
    const disconnect = within(gmailCard()).getByRole("button", { name: "Disconnect" });
    const outlookConnect = within(outlookCard()).getByRole("button", { name: "Connect" });

    disconnected = true;
    disconnect.focus();
    fireEvent.click(disconnect);
    await waitFor(() => expect(api.heldCount()).toBe(2));
    expect(within(gmailCard()).getByText("Checking…")).toBeTruthy();
    expect(within(gmailCard()).queryByText("pending…")).toBeNull();
    expect(document.activeElement).toBe(disconnect);
    expect(disconnect.getAttribute("aria-disabled")).toBe("true");
    // The other card reloads too (one revision): its Connect stays, inert, rather than vanishing.
    expect(within(outlookCard()).getByRole("button", { name: "Connect" })).toBe(outlookConnect);
    expect(outlookConnect.getAttribute("aria-disabled")).toBe("true");
    const deletes = () => vi.mocked(fetch).mock.calls.filter(([, i]) => i?.method === "DELETE").length;
    const posts = () => vi.mocked(fetch).mock.calls.filter(([, i]) => i?.method === "POST").length;
    const before = deletes();
    fireEvent.click(disconnect);
    fireEvent.click(outlookConnect);
    expect(deletes()).toBe(before);
    expect(posts()).toBe(0);

    await api.release();
    expect(await within(gmailCard()).findByText("Not connected")).toBeTruthy();
    expect(document.activeElement).toBe(disconnect);
    expect(disconnect.textContent).toBe("Connect");
    expect(disconnect.getAttribute("aria-disabled")).toBe("false");
  });

  it("keep their connected status through a page turn, which changes only the rows, and keep focus on Next", async () => {
    const data = { accounts: Array.from({ length: 11 }, (_, i) => gmail(i)), sources: [] };
    const api = server(data, { list: (url) => param(url, "provider") === "gmail" && param(url, "page") === "2" });
    const { IntegrationsPanel } = await import("./integrations-panel");
    render(<IntegrationsPanel />);
    await screen.findByText("user0@acme.test");

    const next = within(gmailCard()).getByRole("button", { name: "Next page" });
    next.focus();
    fireEvent.click(next);
    await waitFor(() => expect(api.heldCount()).toBe(1));
    expect(within(gmailCard()).getByText("connected")).toBeTruthy();
    expect(within(gmailCard()).queryByText("Checking…")).toBeNull();
    expect(document.activeElement).toBe(next);
    await api.release();
    expect(await screen.findByText("user10@acme.test")).toBeTruthy();
    expect(document.activeElement).toBe(next);
  });

  it("do not show the last search's no-match message while the next search is on its way", async () => {
    const data = { accounts: [gmail(0), gmail(1)], sources: [] };
    const api = server(data, { list: (url) => param(url, "q") === "zzzz" });
    const { IntegrationsPanel } = await import("./integrations-panel");
    render(<IntegrationsPanel />);
    await screen.findByText("user0@acme.test");
    const search = within(gmailCard()).getByRole("searchbox");
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(await within(gmailCard()).findByText(/No accounts match/)).toBeTruthy();

    fireEvent.change(search, { target: { value: "zzzz" } });
    await waitFor(() => expect(api.heldCount()).toBe(1));
    expect(within(gmailCard()).queryByText(/No accounts match/)).toBeNull();
    expect(within(gmailCard()).getByText("Loading…")).toBeTruthy();
    await api.release();
    expect(await within(gmailCard()).findByText(/No accounts match .zzzz./)).toBeTruthy();
  });
});

describe("Slack workspace card", () => {
  it("does not offer 'Connect another' while the reload after disconnecting the only workspace is in flight", async () => {
    const data = { accounts: [slack(0)], sources: [] };
    let disconnected = false;
    const api = server(data, { list: () => disconnected });
    const { ConnectorAccountCard } = await import("./connector-account-card");
    render(<ConnectorAccountCard provider="slack" />);
    await screen.findByText("Team 0");
    expect(screen.getByRole("button", { name: "Connect another" })).toBeTruthy();

    disconnected = true;
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(api.heldCount()).toBe(1));
    expect(screen.queryByRole("button", { name: "Connect another" })).toBeNull();
    expect(screen.getByRole("button", { name: "Connect Slack" })).toBeTruthy();
    await api.release();
    await waitFor(() => expect(screen.queryByText("Team 0")).toBeNull());
    expect(screen.getByRole("button", { name: "Connect Slack" })).toBeTruthy();
  });

  it("does not show the last search's no-match message while the next search is on its way", async () => {
    const data = { accounts: [slack(0), slack(1)], sources: [] };
    const api = server(data, { list: (url) => param(url, "q") === "zzzz" });
    const { ConnectorAccountCard } = await import("./connector-account-card");
    render(<ConnectorAccountCard provider="slack" />);
    await screen.findByText("Team 0");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzz" } });
    expect(await screen.findByText(/No workspaces match/)).toBeTruthy();

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzzz" } });
    await waitFor(() => expect(api.heldCount()).toBe(1));
    expect(screen.queryByText(/No workspaces match/)).toBeNull();
    expect(screen.getByText("Loading…")).toBeTruthy();
    await api.release();
    expect(await screen.findByText(/No workspaces match .zzzz./)).toBeTruthy();
  });

  it("keeps focus on Next through a page turn", async () => {
    const data = { accounts: Array.from({ length: 11 }, (_, i) => slack(i)), sources: [] };
    const api = server(data, { list: (url) => param(url, "page") === "2" });
    const { ConnectorAccountCard } = await import("./connector-account-card");
    render(<ConnectorAccountCard provider="slack" />);
    await screen.findByText("Team 0");
    await turnPageKeepingFocus(api, "/api/integrations", "Pages of workspaces");
  });
});

describe("Knowledge sources", () => {
  it("does not keep the empty-org message while a reload is in flight, and Refresh keeps focus", async () => {
    const data = { accounts: [], sources: [] as Source[] };
    let refreshing = false;
    const api = server(data, { list: () => refreshing });
    const { SourcesPanel } = await import("./sources-panel");
    render(<SourcesPanel />);
    expect(await screen.findByText("Start with one source your agents need.")).toBeTruthy();

    data.sources = [source("website", 1)];
    refreshing = true;
    const refresh = screen.getByRole("button", { name: "Refresh status" });
    refresh.focus();
    fireEvent.click(refresh);
    await waitFor(() => expect(api.heldCount()).toBe(1));
    expect(screen.queryByText("Start with one source your agents need.")).toBeNull();
    expect(screen.getByText("Loading sources…")).toBeTruthy();
    expect(document.activeElement).toBe(refresh);
    expect(refresh.getAttribute("aria-disabled")).toBe("true");
    const reads = api.reads("/api/sources");
    fireEvent.click(refresh);
    expect(api.reads("/api/sources")).toBe(reads);

    await api.release();
    expect(await screen.findByRole("heading", { name: "website 01" })).toBeTruthy();
    expect(document.activeElement).toBe(refresh);
  });

  it("does not show the last search's no-match message while the next search is on its way", async () => {
    const data = { accounts: [], sources: [source("website", 1), source("website", 2)] };
    const api = server(data, { list: (url) => isSourcesList(url) && param(url, "q") === "zzzz" });
    const { SourcesPanel } = await import("./sources-panel");
    render(<SourcesPanel />);
    await screen.findByRole("heading", { name: "website 01" });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzz" } });
    expect(await screen.findByText(/No sources match/)).toBeTruthy();

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzzz" } });
    await waitFor(() => expect(api.heldCount()).toBe(1));
    expect(screen.queryByText(/No sources match/)).toBeNull();
    await api.release();
    expect(await screen.findByText(/No sources match .zzzz./)).toBeTruthy();
  });

  it("keeps focus on Next through a page turn", async () => {
    const data = { accounts: [], sources: Array.from({ length: 11 }, (_, i) => source("website", i + 1)) };
    const api = server(data, { list: (url) => isSourcesList(url) && param(url, "page") === "2" });
    const { SourcesPanel } = await import("./sources-panel");
    render(<SourcesPanel />);
    await screen.findByRole("heading", { name: "website 01" });
    await turnPageKeepingFocus(api, "/api/sources", "Pages of sources");
  });
});

describe("Connectors", () => {
  it("does not keep saying nothing is connected while a reload after a change elsewhere is in flight", async () => {
    const data = { accounts: [], sources: [] as Source[] };
    let changed = false;
    const api = server(data, { list: (url) => changed && isSourcesList(url) });
    const { ConnectorsPanel } = await import("./connectors-panel");
    const { announceSourcesChanged } = await import("./sources-changed");
    render(<ConnectorsPanel />);
    expect(await screen.findByText(/No Slack, Figma, PostHog or GitHub sources connected yet/)).toBeTruthy();

    data.sources = [source("slack", 1)];
    changed = true;
    act(() => announceSourcesChanged("Knowledge sources"));
    await waitFor(() => expect(api.heldCount()).toBe(1));
    expect(screen.queryByText(/No Slack, Figma, PostHog or GitHub sources connected yet/)).toBeNull();
    expect(screen.getByText("Loading…")).toBeTruthy();

    await api.release();
    expect(await screen.findByText("slack 01")).toBeTruthy();
    expect(screen.queryByText(/No Slack, Figma, PostHog or GitHub sources connected yet/)).toBeNull();
  });

  it("does not show the last search's no-match message while the next search is on its way", async () => {
    const data = { accounts: [], sources: [source("slack", 1), source("figma", 2)] };
    const api = server(data, { list: (url) => isSourcesList(url) && param(url, "q") === "zzzz" });
    const { ConnectorsPanel } = await import("./connectors-panel");
    render(<ConnectorsPanel />);
    await screen.findByText("slack 01");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzz" } });
    expect(await screen.findByText(/No connectors match/)).toBeTruthy();

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzzz" } });
    await waitFor(() => expect(api.heldCount()).toBe(1));
    expect(screen.queryByText(/No connectors match/)).toBeNull();
    expect(screen.getByText("Loading…")).toBeTruthy();
    await api.release();
    expect(await screen.findByText(/No connectors match .zzzz./)).toBeTruthy();
  });

  it("keeps focus on Next through a page turn", async () => {
    const data = { accounts: [], sources: Array.from({ length: 11 }, (_, i) => source("slack", i + 1)) };
    const api = server(data, { list: (url) => isSourcesList(url) && param(url, "page") === "2" });
    const { ConnectorsPanel } = await import("./connectors-panel");
    render(<ConnectorsPanel />);
    await screen.findByText("slack 01");
    await turnPageKeepingFocus(api, "/api/sources", "Pages of connectors");
  });
});

describe("stale row writes", () => {
  it.each(["gmail", "slack", "source", "connector"])(
    "%s refuses a second disconnect while the refreshed rows are pending",
    async (kind) => {
      let hold = false;
      const data = {
        accounts: kind === "gmail" ? [gmail(0)] : kind === "slack" ? [slack(0)] : [],
        sources: kind === "source" ? [source("website", 1)] : kind === "connector" ? [source("figma", 1)] : [],
      };
      const api = server(data, { list: () => hold });
      if (kind === "gmail") {
        const { IntegrationsPanel } = await import("./integrations-panel");
        render(<IntegrationsPanel />);
      }
      if (kind === "slack") {
        const { ConnectorAccountCard } = await import("./connector-account-card");
        render(<ConnectorAccountCard provider="slack" />);
      }
      if (kind === "source") {
        const { SourcesPanel } = await import("./sources-panel");
        render(<SourcesPanel />);
      }
      if (kind === "connector") {
        const { ConnectorsPanel } = await import("./connectors-panel");
        render(<ConnectorsPanel />);
      }
      const button = await screen.findByRole("button", {
        name: kind === "gmail" ? "Disconnect user0@acme.test" : "Disconnect",
      });
      hold = true;
      fireEvent.click(button);
      if (kind === "source" || kind === "connector")
        fireEvent.click(await screen.findByRole("button", { name: "Disconnect and remove" }));
      await waitFor(() => expect(api.heldCount()).toBeGreaterThan(0));
      const writes = () => vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "DELETE").length;
      expect(writes()).toBe(1);
      expect(button.getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(button);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(writes()).toBe(1);
      await api.release();
    },
  );
});

describe("pending disconnect confirmations", () => {
  it.each(["source", "connector"])("%s refuses a confirmation opened before a search commits", async (kind) => {
    const type = kind === "source" ? "website" : "figma";
    const data = { accounts: [], sources: [source(type, 1), source(type, 2)] };
    const api = server(data, { list: (url) => param(url, "q") === "new-search" });
    if (kind === "source") {
      const { SourcesPanel } = await import("./sources-panel");
      render(<SourcesPanel />);
    } else {
      const { ConnectorsPanel } = await import("./connectors-panel");
      render(<ConnectorsPanel />);
    }
    const disconnect = (await screen.findAllByRole("button", { name: "Disconnect" }))[0];
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "new-search" } });
    fireEvent.click(disconnect);
    await waitFor(() => expect(api.heldCount()).toBe(1));
    const confirm = screen.getByRole("button", { name: "Disconnect and remove" });
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(confirm);
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(0);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(false);
    await api.release();
  });
});

describe("returning to a source list before its answer", () => {
  it.each(["source", "connector"])("%s keeps old row actions inert when the old query returns", async (kind) => {
    let hold = false;
    const type = kind === "source" ? "website" : "figma";
    const data = { accounts: [], sources: [source(type, 1), source(type, 2)] };
    const api = server(data, { list: () => hold });
    if (kind === "source") {
      const { SourcesPanel } = await import("./sources-panel");
      render(<SourcesPanel />);
    } else {
      const { ConnectorsPanel } = await import("./connectors-panel");
      render(<ConnectorsPanel />);
    }
    const disconnect = (await screen.findAllByRole("button", { name: "Disconnect" }))[0];
    hold = true;
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "new-search" } });
    await waitFor(() => expect(api.heldCount()).toBe(1));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
    await waitFor(() => expect(api.heldCount()).toBe(2));
    expect(disconnect.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(disconnect);
    expect(screen.queryByRole("dialog")).toBeNull();
    await api.release();
    await waitFor(() => expect(disconnect.getAttribute("aria-disabled")).toBe("false"));
  });
});
