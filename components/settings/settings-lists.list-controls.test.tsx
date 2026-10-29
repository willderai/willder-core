// @vitest-environment jsdom
//
// The smaller Settings and Integrations lists share the list toolbar: connectors (Slack, Figma,
// PostHog, GitHub sources), connected OAuth apps and the expired-or-revoked agent
// tokens. Each narrows only what it already loaded and keeps its view under its own
// URL prefix. Organization roles and entity aliases page on the server instead:
// settings-paged-lists.test.tsx.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { isSourcesList, sourcesPage } from "./sources-test-api";

let urlParams = new URLSearchParams();
vi.mock("next/navigation", () => ({ useSearchParams: () => urlParams }));

const DAY = 24 * 60 * 60 * 1000;
const inDays = (days: number) => new Date(Date.now() + days * DAY).toISOString();

/** What the toolbar's polite live region says: the count a screen reader hears. */
const liveCount = () => document.querySelector("[aria-live='polite']")?.textContent ?? "";

function chooseFilter(noun: string, group: string, choice: string) {
  const toggle = screen.getByRole("button", { name: /^Filters/ });
  if (toggle.getAttribute("aria-expanded") !== "true") fireEvent.click(toggle);
  const panel = screen.getByRole("group", { name: `Filter ${noun}` });
  fireEvent.click(within(within(panel).getByRole("group", { name: group })).getByRole("button", { name: choice }));
}

function stubFetch(routes: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => Response.json(routes[url] ?? {})),
  );
}

beforeEach(() => {
  urlParams = new URLSearchParams();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
  window.history.replaceState(null, "", "/");
});

describe("Connectors list controls", () => {
  const source = (id: string, type: string, name: string, status: string, createdDaysAgo: number) => ({
    id,
    type,
    externalId: id,
    name,
    scopePath: "org_1",
    status,
    meta: null,
    createdAt: inDays(-createdDaysAgo),
  });
  const SOURCES = [
    source("s1", "slack", "#deals", "active", 1),
    source("s2", "figma", "Brand kit", "error", 2),
    source("s3", "github", "acme/web", "active", 3),
    source("s4", "gdrive", "Not a connector", "active", 4),
  ];

  async function renderPanel() {
    vi.stubEnv("NEXT_PUBLIC_CONNECTORS_ENABLED", "true");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        Response.json(isSourcesList(url) ? sourcesPage(url, SOURCES) : { integrations: [] }),
      ),
    );
    const { ConnectorsPanel } = await import("./connectors-panel");
    render(<ConnectorsPanel />);
    await screen.findByText("#deals");
  }

  const names = () => screen.getAllByRole("article").map((a) => within(a).getAllByText(/./)[1].textContent);

  it("filters by type and status, counting only connector sources", async () => {
    await renderPanel();
    await waitFor(() => expect(names()).toEqual(["#deals", "Brand kit", "acme/web"]));
    chooseFilter("connectors", "Type", "GitHub");
    await waitFor(() => expect(names()).toEqual(["acme/web"]));
    await waitFor(() => expect(liveCount()).toBe("1 of 3 connectors"));
    chooseFilter("connectors", "Type", "All");
    chooseFilter("connectors", "Status", "Error");
    await waitFor(() => expect(names()).toEqual(["Brand kit"]));
  });

  it("searches by name and sorts by name", async () => {
    await renderPanel();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search connectors" }), { target: { value: "a" } });
    await waitFor(() => expect(names()).toEqual(["#deals", "Brand kit", "acme/web"]));
    fireEvent.change(screen.getByRole("combobox", { name: "Sort by" }), { target: { value: "name" } });
    await waitFor(() => expect(names()).toEqual(["#deals", "acme/web", "Brand kit"]));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search connectors" }), {
      target: { value: "nothing like it" },
    });
    await waitFor(() => expect(screen.getByText("No connectors match “nothing like it”.")).toBeTruthy());
  });
});

describe("Connected apps list controls", () => {
  const app = (id: string, agentId: string, permission: string, connectedDaysAgo: number, expiresInDays: number) => ({
    id,
    clientId: `https://${agentId.toLowerCase()}.example/client`,
    agentId,
    scopeName: "Sales",
    permission,
    connectedAt: inDays(-connectedDaysAgo),
    expiresAt: inDays(expiresInDays),
  });
  const APPS = [
    app("a1", "Claude", "write", 1, 90),
    app("a2", "ChatGPT", "read", 2, 10),
    app("a3", "Cursor", "admin", 3, 30),
  ];

  async function renderPanel() {
    stubFetch({ "/api/access/oauth-connections": { connections: APPS } });
    const { ConnectedAppsPanel } = await import("./connected-apps-panel");
    render(<ConnectedAppsPanel />);
    await screen.findByText("Claude");
  }

  const names = () =>
    within(screen.getByRole("list", { name: "Connected apps" }))
      .getAllByRole("listitem")
      .map((li) => li.querySelector("p")?.textContent);

  it("filters by access and orders by expiry", async () => {
    await renderPanel();
    expect(names()).toEqual(["Claude", "ChatGPT", "Cursor"]);
    chooseFilter("connected apps", "Access", "Read");
    expect(names()).toEqual(["ChatGPT"]);
    chooseFilter("connected apps", "Access", "All");
    fireEvent.change(screen.getByRole("combobox", { name: "Sort by" }), { target: { value: "expires" } });
    expect(names()).toEqual(["ChatGPT", "Cursor", "Claude"]);
  });

  it("searches the client id as well as the name", async () => {
    await renderPanel();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search connected apps" }), {
      target: { value: "cursor.example" },
    });
    expect(names()).toEqual(["Cursor"]);
  });
});

describe("Disconnected agent tokens list controls", () => {
  const cap = (id: string, agentId: string, revokedDaysAgo: number | null, expiresInDays: number) => ({
    id,
    agentId,
    permission: "read",
    scopePath: "org_1",
    expiresAt: inDays(expiresInDays),
    revokedAt: revokedDaysAgo === null ? null : inDays(-revokedDaysAgo),
    createdAt: inDays(-20),
  });
  const CAPS = [
    cap("c1", "live-bot", null, 30),
    cap("c2", "old-bot", 1, 30),
    cap("c3", "stale-bot", null, -3),
    cap("c4", "gone-bot", 5, 30),
  ];

  async function renderPanel() {
    stubFetch({ "/api/access/capabilities": { capabilities: CAPS } });
    const { McpPanel } = await import("./mcp-panel");
    render(<McpPanel />);
    await screen.findByText("live-bot");
  }

  const inactive = () =>
    within(screen.getByRole("region", { name: "Disconnected agents" }))
      .getAllByRole("row")
      .map((r) => within(r).getAllByRole("cell")[0].textContent);

  it("lists most recently ended first and filters revoked from expired", async () => {
    await renderPanel();
    expect(inactive()).toEqual(["old-bot", "stale-bot", "gone-bot"]);
    const details = screen.getByText("3 expired or revoked").closest("details") as HTMLElement;
    fireEvent.click(within(details).getByRole("button", { name: /^Filters/ }));
    fireEvent.click(
      within(within(details).getByRole("group", { name: "Status" })).getByRole("button", { name: "Expired" }),
    );
    expect(inactive()).toEqual(["stale-bot"]);
    fireEvent.click(
      within(within(details).getByRole("group", { name: "Status" })).getByRole("button", { name: "Revoked" }),
    );
    expect(inactive()).toEqual(["old-bot", "gone-bot"]);
  });
});
