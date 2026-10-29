// The connected agents table searches, filters and orders the live tokens it
// loaded; its column headers sort and report the order to assistive tech.
// Expired and revoked tokens stay in their own collapsed list, untouched.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

let urlParams = new URLSearchParams();
vi.mock("next/navigation", () => ({ useSearchParams: () => urlParams }));

import { McpPanel } from "./mcp-panel";

/** What the toolbar's polite live region says: the count a screen reader hears. */
const liveCount = () => document.querySelector("[aria-live='polite']")?.textContent ?? "";

const DAY = 24 * 60 * 60 * 1000;
const inDays = (days: number) => new Date(Date.now() + days * DAY).toISOString();

function cap(
  id: string,
  agentId: string,
  permission: string,
  scopePath: string,
  expiresInDays: number,
  createdDaysAgo: number,
) {
  return {
    id,
    agentId,
    permission,
    scopePath,
    expiresAt: inDays(expiresInDays),
    revokedAt: null,
    createdAt: inDays(-createdDaysAgo),
  };
}

const CAPS = [
  cap("c1", "claude-desktop", "read", "org_1.sales", 30, 3),
  cap("c2", "cursor", "write", "org_1.eng", 7, 1),
  cap("c3", "openai-agent", "admin", "org_1", 90, 2),
  { ...cap("c4", "old-bot", "read", "org_1", 1, 9), revokedAt: inDays(-1) },
];

const agentsInTable = () => {
  const table = screen.getByRole("region", { name: "Connected agents" });
  return within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[0].textContent);
};

beforeEach(() => {
  urlParams = new URLSearchParams();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ capabilities: CAPS }), { status: 200 })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("McpPanel connected agents list controls", () => {
  it("lists live tokens newest first and leaves revoked ones out of the table", async () => {
    render(<McpPanel />);
    await screen.findByText("cursor");
    expect(agentsInTable()).toEqual(["cursor", "openai-agent", "claude-desktop"]);
  });

  it("filters by access, counting admin tokens as read + write", async () => {
    render(<McpPanel />);
    await screen.findByText("cursor");
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    const access = within(screen.getByRole("group", { name: "Filter connected agents" })).getByRole("group", {
      name: "Access",
    });
    fireEvent.click(within(access).getByRole("button", { name: "Read + write" }));
    expect(agentsInTable()).toEqual(["cursor", "openai-agent"]);
    expect(liveCount()).toBe("2 of 3 connected agents");
    fireEvent.click(within(access).getByRole("button", { name: "Read only" }));
    expect(agentsInTable()).toEqual(["claude-desktop"]);
  });

  it("searches the scope and sorts from a column header, with aria-sort following", async () => {
    render(<McpPanel />);
    await screen.findByText("cursor");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search connected agents" }), {
      target: { value: "org_1." },
    });
    expect(agentsInTable()).toEqual(["cursor", "claude-desktop"]);

    const expires = screen.getByRole("columnheader", { name: /Expires/ });
    expect(expires.getAttribute("aria-sort")).toBe("none");
    fireEvent.click(within(expires).getByRole("button"));
    expect(expires.getAttribute("aria-sort")).toBe("ascending");
    expect(agentsInTable()).toEqual(["cursor", "claude-desktop"]);
    fireEvent.click(within(expires).getByRole("button"));
    expect(agentsInTable()).toEqual(["claude-desktop", "cursor"]);
  });

  it("replaces the table with a no-match message that clears back to every live token", async () => {
    render(<McpPanel />);
    await screen.findByText("cursor");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search connected agents" }), {
      target: { value: "old-bot" },
    });
    expect(screen.queryByRole("region", { name: "Connected agents" })).toBeNull();
    expect(screen.getByText("No connected agents match “old-bot”.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear search and filters" }));
    expect(agentsInTable()).toHaveLength(3);
  });
});
