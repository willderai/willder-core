// @vitest-environment jsdom
//
// The agents page offers the Configuration panel only to a caller who may change it.
// GET /api/agents leaves an agent's system prompt and settings out for a caller without
// access.manage at the org root, and PATCH refuses that caller. Before this, a member
// still saw "Edit" and a form with an empty prompt that could only fail on save.
//
// The page is fed the real GET /api/agents handler's response, with the database and
// the access decision mocked, so these tests follow the route's actual shape rather
// than a fixture that could drift from it.
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
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { agent: { findMany: vi.fn() } } }));
vi.mock("@/services/access", async (orig) => ({
  ...(await orig<typeof import("@/services/access")>()),
  readableScopePaths: vi.fn(async () => []),
  can: vi.fn(),
}));
vi.mock("@/services/agents/run-visibility", () => ({
  summarizeVisibleRuns: vi.fn(async () => new Map()),
}));

import { requireAccessContext } from "@/lib/access-context";
import { db } from "@/lib/db";
import { can } from "@/services/access";
import { GET as agentsGET } from "@/app/api/agents/route";
import AgentsPage from "./page";
import { emptyDashboardResponse } from "@/components/agents/dashboard/empty-dashboard.testsupport";

const PROMPT = "Summarize the week's design decisions for the handoff.";

const rows = [
  {
    id: "agent_custom",
    orgId: "org_1",
    agentKey: "custom-1",
    name: "Weekly digest",
    role: "custom",
    model: null,
    systemPrompt: PROMPT,
    settings: { memoryScope: "org_1.design" },
    tools: [],
    active: true,
  },
  {
    id: "agent_qa",
    orgId: "org_1",
    agentKey: "qa",
    name: "QA",
    role: "qa",
    model: null,
    systemPrompt: "QA prompt",
    settings: {},
    tools: [],
    active: true,
  },
];

function signInAs(role: "admin" | "member") {
  vi.mocked(requireAccessContext).mockResolvedValue({
    org: { id: "org_1" },
    user: { id: `user_${role}`, role },
    ctx: { orgId: "org_1", actor: { type: "human", id: `user_${role}`, role } },
  } as never);
  vi.mocked(can).mockResolvedValue(
    role === "admin"
      ? { allowed: true, reason: "access.manage at org_1" }
      : { allowed: false, reason: "needs access.manage" },
  );
}

class NoopResizeObserver {
  observe() {}
  disconnect() {}
}

beforeEach(() => {
  vi.mocked(db.agent.findMany).mockResolvedValue(rows as never);
  vi.stubGlobal("ResizeObserver", NoopResizeObserver);
  // The roster comes from the real handler; every other fetch the page or its
  // children make (scope list, run history, contacts) answers empty.
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url: string) =>
        emptyDashboardResponse(url) ??
        (url === "/api/agents?kind=builtin" ? agentsGET() : new Response("{}", { status: 200 })),
    ),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/** Opens the modal behind an agent card's primary button and returns its panel. */
async function openCard(buttonName: string) {
  const [button] = await screen.findAllByRole("button", { name: buttonName });
  fireEvent.click(button);
  // The shared Modal carries no dialog role; its panel is the box holding the Close button.
  const close = await screen.findByRole("button", { name: "Close" });
  return close.closest<HTMLElement>("div.fixed")!;
}

describe("agents page Configuration panel", () => {
  it("is absent for a member, whose roster arrives without prompts", async () => {
    signInAs("member");
    const roster = await (await agentsGET()).json();
    expect(roster.agents.every((a: object) => !("systemPrompt" in a))).toBe(true);

    render(<AgentsPage />);
    const dialog = await openCard("Details");
    expect(within(dialog).queryByText("Configuration")).toBeNull();
    expect(within(dialog).queryByText(/Edit/)).toBeNull();
    expect(within(dialog).getByText("An org owner or admin sets its tools and memory scope.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Configure" })).toBeNull();
    expect(screen.queryByRole("button", { name: "+ New agent" })).toBeNull();
  });

  it("is absent for a member on a runnable agent, which still offers its task", async () => {
    signInAs("member");
    render(<AgentsPage />);
    const dialog = await openCard("Set up & run");
    expect(within(dialog).queryByText("Configuration")).toBeNull();
    expect(within(dialog).getByText("Task & run")).toBeTruthy();
  });

  it("opens for an admin with the agent's stored prompt", async () => {
    signInAs("admin");
    render(<AgentsPage />);
    const dialog = await openCard("Configure");
    fireEvent.click(within(dialog).getByText("Edit ▼"));
    await waitFor(() => expect(within(dialog).getByDisplayValue(PROMPT)).toBeTruthy());
    expect(screen.getByRole("button", { name: "+ New agent" })).toBeTruthy();
  });

  // An agent saved without a prompt comes back with `systemPrompt: null`, not without
  // the field. The admin may still configure it: absence, not an empty value, is the
  // member's signal.
  it("opens for an admin on an agent whose stored prompt is null", async () => {
    vi.mocked(db.agent.findMany).mockResolvedValue(rows.map((row) => ({ ...row, systemPrompt: null })) as never);
    signInAs("admin");
    render(<AgentsPage />);
    const dialog = await openCard("Configure");
    expect(within(dialog).getByText("Configuration")).toBeTruthy();
    expect(screen.getByRole("button", { name: "+ New agent" })).toBeTruthy();
  });
});
