// @vitest-environment jsdom
//
// Connected apps lists the person's OAuth connections from
// GET /api/access/oauth-connections and disconnects one with a DELETE, removing it
// only once the server confirms.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConnectedAppsPanel } from "./connected-apps-panel";

const CLAUDE = {
  id: "conn_claude",
  clientId: "https://claude.ai/oauth/mcp-client-metadata.json",
  agentId: "Claude",
  capabilityId: "cap_1",
  scopePath: "org_a.sales",
  scopeName: "Sales",
  permission: "write",
  expiresAt: "2027-01-06T00:00:00.000Z",
  connectedAt: "2026-10-08T00:00:00.000Z",
};

function mockFetch(connections: unknown[], deleteResponse: { status: number; body: unknown }) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "DELETE") return Response.json(deleteResponse.body, { status: deleteResponse.status });
    return Response.json({ connections });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ConnectedAppsPanel", () => {
  it("lists each app with what it can reach, and removes it once the disconnect succeeds", async () => {
    const fetchMock = mockFetch([CLAUDE], { status: 200, body: { revoked: CLAUDE.id } });
    render(<ConnectedAppsPanel />);

    expect(await screen.findByText("Claude")).toBeTruthy();
    expect(document.body.textContent).toContain("Read and write on Sales");

    fireEvent.click(screen.getByRole("button", { name: "Disconnect Claude" }));
    await waitFor(() => expect(screen.queryByText("Claude")).toBeNull());
    expect(fetchMock).toHaveBeenCalledWith("/api/access/oauth-connections/conn_claude", { method: "DELETE" });
    expect(screen.getByText("You have not connected any apps.")).toBeTruthy();
  });

  it("keeps the app listed and shows the server's error when the disconnect is refused", async () => {
    mockFetch([CLAUDE], { status: 404, body: { error: "connection not found" } });
    render(<ConnectedAppsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Disconnect Claude" }));
    expect((await screen.findByRole("alert")).textContent).toBe("connection not found");
    expect(screen.getByText("Claude")).toBeTruthy();
  });
});
