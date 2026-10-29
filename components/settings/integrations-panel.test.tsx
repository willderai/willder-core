// @vitest-environment jsdom
//
// Mailbox connections list every connected account, not one per provider: since a
// second Gmail (or Outlook) connect keeps the first, both rows must be visible and
// each must disconnect its own row through DELETE /api/integrations/:id. A failed
// GET must read as an error with a retry, never as the "Not connected" empty state.
// Each provider's card reads its own page of accounts (integrations-test-api.ts stands
// in for GET /api/integrations?provider=).
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { IntegrationsPanel } from "./integrations-panel";
import { isIntegrationsList, integrationsPage } from "./integrations-test-api";

type Row = {
  id: string;
  provider: string;
  externalAccountId: string | null;
  status: "pending" | "connected" | "disconnected" | "error";
  meta: Record<string, string> | null;
  createdAt: string;
};

function connectedGmail(id: string, email: string): Row {
  return {
    id,
    provider: "gmail",
    externalAccountId: `acct_${id}`,
    status: "connected",
    meta: { email },
    createdAt: "2026-09-25T00:00:00Z",
  };
}

// Serves GET /api/integrations from `rows` and applies DELETE /api/integrations/:id
// the way the route does: the row stays, marked disconnected.
// `holdOutlookReload` makes Outlook's list read after a DELETE wait for the returned
// `release`, to pin the order where Gmail's card has settled and Outlook's has not.
function mockIntegrationsApi(rows: Row[], deleteBody: Record<string, unknown> = {}, holdOutlookReload = false) {
  const deletes: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (isIntegrationsList(url) && method === "GET") {
      if (
        holdOutlookReload &&
        deletes.length > 0 &&
        new URL(url, "http://localhost").searchParams.get("provider") === "outlook"
      )
        await gate;
      return Response.json(integrationsPage(url, rows));
    }
    const match = url.match(/^\/api\/integrations\/([^/]+)$/);
    if (match && method === "DELETE") {
      deletes.push(match[1]);
      rows = rows.map((r) =>
        r.id === match[1] ? { ...r, status: "disconnected" as const, externalAccountId: null } : r,
      );
      return new Response(JSON.stringify({ disconnected: match[1], ...deleteBody }), { status: 200 });
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fn);
  return { deletes, release };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("IntegrationsPanel — several accounts of one provider", () => {
  it("renders both connected Gmail accounts, each with its own disconnect", async () => {
    mockIntegrationsApi([connectedGmail("int_a", "sales@acme.com"), connectedGmail("int_b", "support@acme.com")]);
    render(<IntegrationsPanel />);

    const list = await screen.findByRole("list", { name: "Connected Gmail accounts" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getByText("sales@acme.com")).toBeTruthy();
    expect(within(list).getByText("support@acme.com")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect sales@acme.com" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect support@acme.com" })).toBeTruthy();
  });

  it("disconnecting one account deletes only that row and keeps the other listed", async () => {
    const api = mockIntegrationsApi([
      connectedGmail("int_a", "sales@acme.com"),
      connectedGmail("int_b", "support@acme.com"),
    ]);
    render(<IntegrationsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Disconnect support@acme.com" }));

    await waitFor(() => expect(screen.queryByText("support@acme.com")).toBeNull());
    expect(api.deletes).toEqual(["int_b"]);
    const list = screen.getByRole("list", { name: "Connected Gmail accounts" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(within(list).getByText("sales@acme.com")).toBeTruthy();
  });

  it("offers Connect again once the last account of a provider is disconnected", async () => {
    const api = mockIntegrationsApi([connectedGmail("int_a", "sales@acme.com")]);
    render(<IntegrationsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Disconnect sales@acme.com" }));

    await waitFor(() => expect(screen.queryByRole("list", { name: "Connected Gmail accounts" })).toBeNull());
    expect(api.deletes).toEqual(["int_a"]);
    // Gmail and Outlook both show Connect now.
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Connect" })).toHaveLength(2));
  });
});

describe("IntegrationsPanel — a provider with nothing connected", () => {
  it("shows a pending attempt over a newer error, with a way to cancel it", async () => {
    const attempt = (id: string, status: Row["status"], createdAt: string): Row => ({
      id,
      provider: "gmail",
      externalAccountId: null,
      status,
      meta: null,
      createdAt,
    });
    // Newest first, as the route reads them: the error is newer than the pending attempt.
    mockIntegrationsApi([
      attempt("int_err", "error", "2026-09-25T02:00:00Z"),
      attempt("int_pend", "pending", "2026-09-25T01:00:00Z"),
    ]);
    render(<IntegrationsPanel />);

    expect(await screen.findByText("pending…")).toBeTruthy();
    expect(screen.queryByText("error")).toBeNull();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
  });
});

describe("IntegrationsPanel — the provider did not confirm the revoke", () => {
  it("says the token is deleted and why the revoke was not confirmed", async () => {
    mockIntegrationsApi([connectedGmail("int_a", "sales@acme.com")], {
      providerRevoked: false,
      providerRevokeError: "Google revoke failed: HTTP 503",
    });
    render(<IntegrationsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Disconnect sales@acme.com" }));

    const status = await screen.findByRole("status");
    expect(status.textContent).toBe(
      "Disconnected and the token is deleted, but the provider did not confirm the revoke: Google revoke failed: HTTP 503.",
    );
  });

  it("shows no notice when the revoke was confirmed", async () => {
    const api = mockIntegrationsApi([connectedGmail("int_a", "sales@acme.com")], { providerRevoked: true });
    render(<IntegrationsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Disconnect sales@acme.com" }));

    await waitFor(() => expect(api.deletes).toEqual(["int_a"]));
    await waitFor(() => expect(screen.queryByText("sales@acme.com")).toBeNull());
    // Both cards re-read after a disconnect; the status element is Outlook's "Checking…"
    // until its read lands, so wait for the end state rather than for Gmail's row alone.
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("does not take Outlook's Checking… for a notice: Gmail settled first, Outlook still reading", async () => {
    const api = mockIntegrationsApi([connectedGmail("int_a", "sales@acme.com")], { providerRevoked: true }, true);
    render(<IntegrationsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Disconnect sales@acme.com" }));
    await waitFor(() => expect(screen.queryByText("sales@acme.com")).toBeNull());

    expect((await screen.findByRole("status")).textContent).toBe("Checking…");
    api.release();
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });
});

describe("IntegrationsPanel — the list could not be loaded", () => {
  it("shows an error with a retry, not Not connected, when GET /api/integrations fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "unavailable" }), { status: 503 })),
    );
    render(<IntegrationsPanel />);

    // findAllByRole settles on the first alert; the two lists load on their own requests.
    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
    const [gmail, outlook] = screen.getAllByRole("alert");
    expect(within(gmail).getByText("Couldn't load Gmail connections.")).toBeTruthy();
    expect(within(gmail).getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(within(outlook).getByText("Couldn't load Outlook connections.")).toBeTruthy();
    expect(screen.queryByText("Not connected")).toBeNull();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
  });

  it("shows the same error state when the request never reaches the server", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    render(<IntegrationsPanel />);

    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
    expect(screen.queryByText("Not connected")).toBeNull();
  });

  it("Try again reloads and, on success, shows the normal Connect rows", async () => {
    let fail = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        fail ? new Response("{}", { status: 500 }) : Response.json(integrationsPage(url, [])),
      ),
    );
    render(<IntegrationsPanel />);

    const [retry] = await screen.findAllByRole("button", { name: "Try again" });
    fail = false;
    fireEvent.click(retry);

    await waitFor(() => expect(screen.getAllByRole("button", { name: "Connect" })).toHaveLength(2));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a successful empty list still renders Not connected with Connect for each provider", async () => {
    mockIntegrationsApi([]);
    render(<IntegrationsPanel />);

    await waitFor(() => expect(screen.getAllByRole("button", { name: "Connect" })).toHaveLength(2));
    expect(screen.getAllByText("Not connected")).toHaveLength(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
