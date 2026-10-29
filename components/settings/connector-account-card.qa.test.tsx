// @vitest-environment jsdom
//
// The Slack OAuth account card: three behaviours the card
// implements that its own suite does not pin down. Each test here fails when the
// matching guard in connector-account-card.tsx is removed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConnectorAccountCard } from "./connector-account-card";
import { integrationsPage } from "./integrations-test-api";

const connectedRow = {
  id: "int_1",
  provider: "slack",
  externalAccountId: "T111",
  status: "connected",
  meta: { teamName: "Acme" },
  createdAt: "2026-09-25T00:00:00.000Z",
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

let assign: ReturnType<typeof vi.fn>;

function landOn(search: string) {
  const href = `http://localhost:3000/integrations${search}`;
  const url = new URL(href);
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { href, search: url.search, pathname: url.pathname, hash: url.hash, assign },
  });
}

beforeEach(() => {
  assign = vi.fn();
  landOn("");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ConnectorAccountCard (QA)", () => {
  it("does not judge the redirect flag before the integration list has loaded", async () => {
    landOn("?integration=slack&connected=1");
    let release!: () => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        await new Promise<void>((r) => (release = r));
        return json(integrationsPage(url, [connectedRow]));
      }),
    );
    render(<ConnectorAccountCard provider="slack" />);
    await waitFor(() => expect(release).toBeTypeOf("function"));
    // While the list is still in flight nothing is claimed either way.
    expect(screen.queryByRole("status")).toBeNull();
    release();
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Slack connected: Acme."));
  });

  it("a connect response without an authorize URL shows an error and never navigates", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) =>
        init?.method === "POST" ? json({ integration: { id: "int_9" } }, 201) : json(integrationsPage(url, [])),
      ),
    );
    render(<ConnectorAccountCard provider="slack" />);
    fireEvent.click(await screen.findByText("Connect Slack"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Couldn't start the Slack sign-in/));
    expect(assign).not.toHaveBeenCalled();
  });

  it("a stale failed load cannot blank a newer successful one", async () => {
    let rejectFirst!: (e: Error) => void;
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "DELETE") return json({ disconnected: "int_1", providerRevoked: true });
        calls++;
        if (calls === 1) return json(integrationsPage(url, [connectedRow]));
        if (calls === 2) return new Promise<Response>((_, reject) => (rejectFirst = reject));
        return json(integrationsPage(url, [connectedRow]));
      }),
    );
    const { rerender } = render(<ConnectorAccountCard provider="slack" />);
    await screen.findByText("Acme");
    // Disconnect triggers load #2, which hangs; switching provider back and forth starts #3 and #4.
    fireEvent.click(screen.getByText("Disconnect"));
    await waitFor(() => expect(rejectFirst).toBeTypeOf("function"));
    rerender(<ConnectorAccountCard provider="figma" />);
    rerender(<ConnectorAccountCard provider="slack" />);
    await waitFor(() => expect(screen.getByText("Acme")).toBeTruthy());
    rejectFirst(new Error("network"));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(/Couldn't load Slack connections/)).toBeNull();
    expect(screen.getByText("Acme")).toBeTruthy();
  });

  it("identifies the workspace by the provider's logo, not a letter badge", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => json(integrationsPage(url, [connectedRow]))),
    );
    const { container } = render(<ConnectorAccountCard provider="slack" />);
    await waitFor(() => expect(screen.getByText("Slack workspace")).toBeTruthy());
    const card = container.querySelector("[data-testid=connector-account-slack]")!;
    expect(card.querySelector("svg[data-connector-logo=slack]")).not.toBeNull();
  });
});
