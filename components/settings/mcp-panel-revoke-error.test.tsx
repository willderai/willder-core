// Regression test: `revokeCap` must wrap its call in try/catch and must not
// clear `confirmRevokeId` before checking whether the DELETE actually
// succeeded, or a rejected revoke (403/404, or a network-level failure)
// silently resets the "Disconnect? yes/no" prompt back to the plain
// "disconnect" button — leaving an admin with no way to tell the token is
// still live. The error banner must also render outside `{showForm && (...)}`,
// which is closed by default, or `err` can be set correctly and still render
// nowhere the admin can see it.
//
// These tests pin the two user-visible halves of the fix: the error is shown
// with the issue form closed, and the confirm prompt survives a failed revoke
// instead of resetting as if nothing had been attempted.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { McpPanel } from "./mcp-panel";

const CAP = {
  id: "cap_1",
  agentId: "mcp-claude",
  scopePath: "org_1",
  permission: "read",
  expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString(),
  revokedAt: null,
  createdAt: new Date().toISOString(),
};

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

async function renderWithOneConnection(deleteResponse: () => Promise<Response> | never) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return deleteResponse();
      return new Response(JSON.stringify({ capabilities: [CAP] }), { status: 200 });
    }),
  );
  render(<McpPanel />);
  await waitFor(() => expect(screen.getByText("1 active connection")).toBeTruthy());

  // The issue form starts closed — this is the state a real failed revoke
  // most often happens in, and the one the old code rendered nothing for.
  expect(screen.queryByText("+ New connection")).toBeTruthy();
  expect(screen.queryByPlaceholderText("e.g. mcp-claude")).toBeNull();

  screen.getByText("disconnect").click();
  await waitFor(() => expect(screen.getByText("Disconnect?")).toBeTruthy());
  screen.getByText("yes").click();
}

describe("McpPanel — a failed disconnect is visible and does not reset silently", () => {
  it("shows the error with the issue form closed", async () => {
    await renderWithOneConnection(
      async () => new Response(JSON.stringify({ error: "not a scope admin" }), { status: 403 }),
    );

    expect(await screen.findByText("not a scope admin")).toBeTruthy();
  });

  it("keeps the confirm prompt up after a rejected DELETE, instead of resetting to 'disconnect'", async () => {
    await renderWithOneConnection(
      async () => new Response(JSON.stringify({ error: "not a scope admin" }), { status: 403 }),
    );
    await screen.findByText("not a scope admin");

    expect(screen.getByText("Disconnect?")).toBeTruthy();
    expect(screen.queryByText("disconnect")).toBeNull();
  });

  it("shows an error rather than throwing on a network-level failure", async () => {
    await renderWithOneConnection(async () => {
      throw new TypeError("Failed to fetch");
    });

    expect(await screen.findByText("Failed to fetch")).toBeTruthy();
    expect(screen.getByText("Disconnect?")).toBeTruthy();
  });

  it("CONTROL: a successful disconnect clears the confirm prompt and drops the connection", async () => {
    await renderWithOneConnection(async () => new Response(JSON.stringify({ revoked: CAP.id }), { status: 200 }));

    await waitFor(() => expect(screen.queryByText("Disconnect?")).toBeNull());
  });
});
