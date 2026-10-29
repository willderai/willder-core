// @vitest-environment jsdom
//
// An agent's test run drafts for one contact, picked by searching on the server
// (GET /api/contacts?limit=&q=, lib/pick-query.ts) rather than from a select holding
// every contact in the org. Draft stays off until a contact is picked, and the run is
// sent for the contact picked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children?: unknown }) =>
    createElement("a", { href, ...props }, children as never),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/agents",
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

import AgentsPage from "./page";
import { emptyDashboardResponse } from "@/components/agents/dashboard/empty-dashboard.testsupport";
import { PICK_LIMIT } from "@/lib/pick-query";

const AGENT = {
  id: "agent_custom",
  orgId: "org_1",
  agentKey: "custom-1",
  name: "Weekly digest",
  role: "custom",
  model: null,
  systemPrompt: "Draft a follow-up.",
  settings: {},
  tools: [],
  active: true,
  _count: { runs: 0 },
  runs: [],
};

class NoopResizeObserver {
  observe() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", NoopResizeObserver);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const dashboard = emptyDashboardResponse(url);
      if (dashboard) return dashboard;
      if (url === "/api/agents?kind=builtin") return Response.json({ agents: [AGENT] });
      if (url.startsWith("/api/contacts?")) {
        const q = new URL(url, "http://t").searchParams.get("q");
        const contacts =
          q === "dana" ? [{ id: "c_dana", name: "Dana Ruiz", email: "dana@client.test", title: "CTO" }] : [];
        return Response.json({ contacts, more: false });
      }
      if (init?.method === "POST") return Response.json({ error: "stop here" }, { status: 500 });
      return Response.json({});
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("agents page test run", () => {
  it("drafts for a contact searched on the server, and only once one is picked", async () => {
    render(<AgentsPage />);
    const [configure] = await screen.findAllByRole("button", { name: "Configure" });
    fireEvent.click(configure);
    const dialog = (await screen.findByRole("button", { name: "Close" })).closest<HTMLElement>("div.fixed")!;

    fireEvent.click(within(dialog).getByText("Edit ▼"));
    const draft = await within(dialog).findByRole("button", { name: "▶ Draft" });
    expect((draft as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(within(dialog).getByRole("button", { name: "Contact: Choose a contact" }));
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Search contact" }), { target: { value: "dana" } });
    fireEvent.click(await within(dialog).findByRole("option", { name: /Dana Ruiz/ }));
    const contactSearches = vi
      .mocked(fetch)
      .mock.calls.map(([url]) => String(url))
      .filter((url) => url.startsWith("/api/contacts"));
    expect(contactSearches).toContain(`/api/contacts?limit=${PICK_LIMIT}&q=dana`);
    expect(contactSearches.every((url) => url.includes("limit="))).toBe(true);

    expect((draft as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(draft);
    await waitFor(() =>
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        "/api/agents/agent_custom/run",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ contactId: "c_dana" }),
        }),
      ),
    );
  });
});
