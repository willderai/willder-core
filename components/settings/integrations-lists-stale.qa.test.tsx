// @vitest-environment jsdom
//
// The server-paged Integrations cards: what the screen shows between
// one page and the next, and after a failed reload. While the next page of Gmail
// accounts or Slack workspaces loads, the page already shown stays on screen, marked
// busy, instead of collapsing to "Loading…". And when a change in Connectors makes
// Knowledge sources reload and that reload fails, the panel says it could not load,
// without also saying it was "Updated after a change".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { isIntegrationsList, integrationsPage } from "./integrations-test-api";
import { isSourcesList, sourcesPage } from "./sources-test-api";
import { gitHubProbeAnswer, pickGitHubRepository } from "./github-picker.testsupport";

type Row = {
  id: string;
  provider: string;
  externalAccountId: string;
  status: string;
  meta: Record<string, string>;
  createdAt: string;
};

/** Eleven connected accounts of `provider`, one more than a page holds, newest first. */
function elevenAccounts(provider: string, meta: (i: number) => Record<string, string>): Row[] {
  return Array.from({ length: 11 }, (_, i) => ({
    id: `int_${provider}_${i}`,
    provider,
    externalAccountId: `acct_${i}`,
    status: "connected",
    meta: meta(i),
    createdAt: new Date(Date.UTC(2026, 8, 30 - i)).toISOString(),
  }));
}

/** Serves the first page at once and holds every later page until `release()`. */
function holdLaterPages(rows: Row[]) {
  let release: () => void = () => {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (!isIntegrationsList(url)) throw new Error(`unexpected ${url}`);
      if (new URL(url, "http://localhost").searchParams.get("page") !== "1") {
        await new Promise<void>((r) => (release = r));
      }
      return Response.json(integrationsPage(url, rows));
    }),
  );
  return { release: () => release() };
}

beforeEach(() => {
  window.history.replaceState(null, "", "/integrations");
  vi.stubEnv("NEXT_PUBLIC_CONNECTORS_ENABLED", "true");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Integrations cards keep the page shown while the next one loads", () => {
  it("Gmail: the first page stays on screen, busy, until page 2 arrives", async () => {
    const { release } = holdLaterPages(elevenAccounts("gmail", (i) => ({ email: `user${i}@acme.test` })));
    const { IntegrationsPanel } = await import("./integrations-panel");
    render(<IntegrationsPanel />);
    const gmail = () => within(screen.getByRole("list", { name: "Connected Gmail accounts" }));
    expect(await screen.findByText("user0@acme.test")).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: "Next page" })[0]);
    await waitFor(() =>
      expect(screen.getByRole("list", { name: "Connected Gmail accounts" }).getAttribute("aria-busy")).toBe("true"),
    );
    expect(gmail().getByText("user0@acme.test")).toBeTruthy();

    release();
    expect(await screen.findByText("user10@acme.test")).toBeTruthy();
    expect(screen.getByRole("list", { name: "Connected Gmail accounts" }).getAttribute("aria-busy")).toBe("false");
  });

  it("Slack: the first page of workspaces stays on screen, busy, until page 2 arrives", async () => {
    const { release } = holdLaterPages(elevenAccounts("slack", (i) => ({ teamName: `Team ${i}` })));
    const { ConnectorAccountCard } = await import("./connector-account-card");
    render(<ConnectorAccountCard provider="slack" />);
    expect(await screen.findByText("Team 0")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(screen.getByText("Team 0").closest("ul")?.getAttribute("aria-busy")).toBe("true"));
    expect(screen.queryByText("Loading…")).toBeNull();

    release();
    expect(await screen.findByText("Team 10")).toBeTruthy();
    expect(screen.queryByText("Team 0")).toBeNull();
  });
});

describe("Knowledge sources after a change elsewhere", () => {
  it("a failed reload says it failed and does not claim the list was updated", async () => {
    const repo = {
      id: "src_repo",
      type: "github",
      externalId: "owner/scratch",
      name: "owner/scratch",
      scopePath: "org.scratch",
      status: "disconnected",
      meta: null,
      createdAt: "2026-09-01T00:00:00Z",
      _count: { files: 0 },
    };
    let failLists = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        const probe = gitHubProbeAnswer(url, ["owner/scratch"]);
        if (probe) return probe;
        if (isSourcesList(url) && method === "GET") {
          return failLists ? new Response("{}", { status: 500 }) : Response.json(sourcesPage(url, [repo]));
        }
        if (url === "/api/sources" && method === "POST") {
          failLists = true;
          return Response.json({ source: { ...repo, status: "syncing" } }, { status: 201 });
        }
        throw new Error(`unexpected ${method} ${url}`);
      }),
    );
    const { SourcesPanel } = await import("./sources-panel");
    const { ConnectorsPanel } = await import("./connectors-panel");
    render(
      <>
        <section aria-label="Knowledge sources">
          <SourcesPanel />
        </section>
        <section aria-label="Source connectors">
          <ConnectorsPanel />
        </section>
      </>,
    );
    const knowledge = () => within(screen.getByRole("region", { name: "Knowledge sources" }));
    const connectors = () => within(screen.getByRole("region", { name: "Source connectors" }));
    expect(await knowledge().findByText("Disconnected")).toBeTruthy();

    fireEvent.click(connectors().getByRole("button", { name: /Connect GitHub/ }));
    await pickGitHubRepository(
      "github_pat_test",
      "owner/scratch",
      screen.getByRole("region", { name: "Source connectors" }),
    );
    fireEvent.click(connectors().getByRole("button", { name: "Connect" }));

    expect(await knowledge().findByText("Could not load sources.")).toBeTruthy();
    expect(knowledge().queryByText(/updated after a change/i)).toBeNull();
    expect(knowledge().queryByText("Disconnected")).toBeNull();
  });
});
