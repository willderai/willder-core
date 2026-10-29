// @vitest-environment jsdom
//
// The Slack OAuth account card: what Integrations shows after the provider sends the
// browser back (connected, declined, error, and a success flag the server can't
// confirm), what Connect and Disconnect actually send, and that a late response
// can't bring back an account that is already gone.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConnectorAccountCard, connectOutcome, readRedirectResult } from "./connector-account-card";
import { integrationsPage } from "./integrations-test-api";

type Row = {
  id: string;
  provider: string;
  externalAccountId: string | null;
  status: "pending" | "connected" | "disconnected" | "error";
  meta: Record<string, unknown> | null;
  createdAt: string;
};

const row = (over: Partial<Row>): Row => ({
  id: "int_1",
  provider: "slack",
  externalAccountId: "T111",
  status: "connected",
  meta: { teamName: "Acme" },
  createdAt: "2026-09-25T00:00:00.000Z",
  ...over,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

type Call = { url: string; method: string };
function mockFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const call = { url, method: init?.method ?? "GET" };
      calls.push(call);
      return handler(call);
    }),
  );
  return calls;
}

let assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  assign = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...new URL("http://localhost:3000/integrations"), href: "http://localhost:3000/integrations", assign },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function landOn(search: string) {
  const href = `http://localhost:3000/integrations${search}`;
  const url = new URL(href);
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { href, search: url.search, pathname: url.pathname, hash: url.hash, assign },
  });
}

describe("readRedirectResult", () => {
  it("reads the callback's flag only for its own provider", () => {
    expect(readRedirectResult("?integration=slack&connected=1", "slack")).toBe(true);
    expect(readRedirectResult("?integration=slack&connected=0", "slack")).toBe(false);
    expect(readRedirectResult("?integration=figma&connected=1", "slack")).toBeNull();
    expect(readRedirectResult("?integration=slack&connected=yes", "slack")).toBeNull();
    expect(readRedirectResult("", "slack")).toBeNull();
  });
});

describe("connectOutcome", () => {
  it("treats a success flag as connected only when a connected account exists", () => {
    expect(connectOutcome(true, { connectedCount: 1, latestError: null })).toBe("connected");
    expect(connectOutcome(true, { connectedCount: 0, latestError: null })).toBe("unconfirmed");
  });

  it("tells a decline from an error by the newest errored attempt", () => {
    const declined = row({ id: "int_2", status: "error", meta: { error: "access_denied" } });
    const broke = row({ id: "int_3", status: "error", meta: { error: "exchange failed" } });
    expect(connectOutcome(false, { connectedCount: 0, latestError: declined })).toBe("declined");
    expect(connectOutcome(false, { connectedCount: 0, latestError: broke })).toBe("failed");
    expect(connectOutcome(false, { connectedCount: 0, latestError: null })).toBe("failed");
  });
});

describe("ConnectorAccountCard after the OAuth redirect", () => {
  it("connected=1 with a connected row: names the workspace and clears the flag from the URL", async () => {
    landOn("?integration=slack&connected=1");
    const replaceState = vi.spyOn(window.history, "replaceState");
    mockFetch((call) => json(integrationsPage(call.url, [row({})])));
    render(<ConnectorAccountCard provider="slack" />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Slack connected: Acme."));
    expect(screen.getByText("connected")).toBeTruthy();
    expect(replaceState).toHaveBeenCalledWith(window.history.state, "", "/integrations");
  });

  it("connected=1 but no connected row on the server: says so instead of claiming success", async () => {
    landOn("?integration=slack&connected=1");
    mockFetch((call) => json(integrationsPage(call.url, [row({ status: "pending" })])));
    render(<ConnectorAccountCard provider="slack" />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/no connected account on record/));
    expect(screen.queryByText("Disconnect")).toBeNull();
  });

  it("connected=0 after the user declined: reports a cancel, not a failure", async () => {
    landOn("?integration=slack&connected=0");
    mockFetch((call) => json(integrationsPage(call.url, [row({ status: "error", meta: { error: "access_denied" } })])));
    render(<ConnectorAccountCard provider="slack" />);
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("You cancelled the Slack sign-in. Nothing was connected."),
    );
  });

  it("connected=0 after a failed exchange: reports the failure", async () => {
    landOn("?integration=slack&connected=0");
    mockFetch((call) => json(integrationsPage(call.url, [row({ status: "error", meta: { error: "invalid_code" } })])));
    render(<ConnectorAccountCard provider="slack" />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/^Slack connection failed/));
  });

  it("ignores another provider's redirect flag and leaves the URL alone", async () => {
    landOn("?integration=figma&connected=1");
    const replaceState = vi.spyOn(window.history, "replaceState");
    mockFetch((call) => json(integrationsPage(call.url, [])));
    render(<ConnectorAccountCard provider="slack" />);
    await waitFor(() => expect(screen.getByText("Connect Slack")).toBeTruthy());
    expect(screen.queryByRole("status")).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("shows only this provider's rows and marks a fixture connection as test mode", async () => {
    mockFetch((call) =>
      json(
        integrationsPage(call.url, [
          row({ id: "int_g", provider: "gmail", externalAccountId: "a@b.co", meta: { email: "a@b.co" } }),
          row({ id: "int_m", externalAccountId: "mock_slack_1", meta: { mock: true } }),
        ]),
      ),
    );
    render(<ConnectorAccountCard provider="slack" />);
    await waitFor(() => expect(screen.getByText("mock_slack_1")).toBeTruthy());
    expect(screen.getByText("test mode")).toBeTruthy();
    expect(screen.queryByText("a@b.co")).toBeNull();
    expect(screen.getByText("Connect another")).toBeTruthy();
  });

  it("says the list couldn't load instead of showing an empty, unconnected card", async () => {
    mockFetch(() => json({ error: "boom" }, 500));
    render(<ConnectorAccountCard provider="slack" />);
    await waitFor(() => expect(screen.getByText(/Couldn't load Slack connections/)).toBeTruthy());
  });
});

describe("ConnectorAccountCard connect and disconnect", () => {
  it("Connect POSTs to the provider's connect route and follows the returned authorize URL", async () => {
    const calls = mockFetch((call) => {
      if (call.method === "POST") {
        return json({ integration: { id: "int_9" }, authUrl: "https://slack.com/oauth/v2/authorize?state=s" }, 201);
      }
      return json(integrationsPage(call.url, []));
    });
    render(<ConnectorAccountCard provider="slack" />);
    fireEvent.click(await screen.findByText("Connect Slack"));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://slack.com/oauth/v2/authorize?state=s"));
    expect(calls).toContainEqual({ url: "/api/integrations/slack/connect", method: "POST" });
  });

  it("a server without Slack OAuth credentials gets a plain explanation and no redirect", async () => {
    mockFetch((call) =>
      call.method === "POST"
        ? json({ error: "SLACK_CLIENT_ID and SLACK_CLIENT_SECRET must be set to connect slack" }, 503)
        : json(integrationsPage(call.url, [])),
    );
    render(<ConnectorAccountCard provider="slack" />);
    fireEvent.click(await screen.findByText("Connect Slack"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/isn't set up on this server yet/));
    expect(screen.getByRole("alert").textContent).not.toMatch(/SLACK_CLIENT/);
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByText("Connect Slack")).toBeTruthy();
  });

  it("a member (403) sees the server's reason and is not redirected", async () => {
    mockFetch((call) =>
      call.method === "POST"
        ? json({ error: "only an org owner or admin can connect an integration" }, 403)
        : json(integrationsPage(call.url, [])),
    );
    render(<ConnectorAccountCard provider="slack" />);
    fireEvent.click(await screen.findByText("Connect Slack"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/owner or admin/));
    expect(assign).not.toHaveBeenCalled();
  });

  it("Disconnect DELETEs that integration by id and warns when the upstream revoke wasn't confirmed", async () => {
    let gone = false;
    const calls = mockFetch((call) => {
      if (call.method === "DELETE") {
        gone = true;
        return json({ disconnected: "int_1", providerRevoked: false });
      }
      return json(
        integrationsPage(call.url, gone ? [row({ status: "disconnected", externalAccountId: null })] : [row({})]),
      );
    });
    render(<ConnectorAccountCard provider="slack" />);
    fireEvent.click(await screen.findByText("Disconnect"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/didn't confirm the revoke/));
    expect(calls).toContainEqual({ url: "/api/integrations/int_1", method: "DELETE" });
    await waitFor(() => expect(screen.queryByText("Acme")).toBeNull());
    expect(screen.getByText("Connect Slack")).toBeTruthy();
  });

  it("a late response for the previous provider can't fill the card after it switches provider", async () => {
    let releaseSlack!: () => void;
    let listCalls = 0;
    mockFetch(async (call) => {
      listCalls++;
      if (listCalls === 1) {
        await new Promise<void>((r) => (releaseSlack = r));
        return json(integrationsPage(call.url, [row({})]));
      }
      return json(integrationsPage(call.url, []));
    });
    const { rerender } = render(<ConnectorAccountCard provider="slack" />);
    await waitFor(() => expect(listCalls).toBe(1));
    rerender(<ConnectorAccountCard provider="figma" />);
    await waitFor(() => expect(screen.getByText("Connect Figma")).toBeTruthy());
    releaseSlack();
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText("Acme")).toBeNull();
    expect(screen.getByText("Connect Figma")).toBeTruthy();
  });
});
