// @vitest-environment jsdom
//
// Choosing which agent's run history the page shows must work from the keyboard.
// The card used to be a clicking div: no focus stop, no Enter or Space, and no way for
// a screen reader to tell which agent was chosen. Each card now carries a real button
// whose pressed state is the selection; the browser gives a native button its focus
// stop and its Enter and Space activation.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

const agents = [
  {
    id: "agent_arch",
    name: "Architecture",
    role: "architecture",
    model: null,
    tools: [],
    active: true,
    runs: [],
    _count: { runs: 0 },
  },
  { id: "agent_qa", name: "QA", role: "qa", model: null, tools: [], active: true, runs: [], _count: { runs: 0 } },
];

class NoopResizeObserver {
  observe() {}
  disconnect() {}
}

const fetchMock = vi.fn(
  async (url: string) =>
    emptyDashboardResponse(url) ??
    (url === "/api/agents?kind=builtin"
      ? new Response(JSON.stringify({ agents }), { status: 200 })
      : new Response(JSON.stringify({ runs: [], total: 0 }), { status: 200 })),
);

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", NoopResizeObserver);
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  fetchMock.mockClear();
});

/** The agent named beside the "Run history" title, i.e. whose runs are on screen. */
function runHistoryAgent() {
  return screen.getByText("Run history").nextElementSibling?.textContent;
}

describe("agent card selection", () => {
  it("is a native button per card whose pressed state is the selection", async () => {
    render(<AgentsPage />);
    const arch = await screen.findByRole("button", { name: "Show run history for Architecture" });
    const qa = screen.getByRole("button", { name: "Show run history for QA" });

    for (const button of [arch, qa]) {
      expect(button.tagName).toBe("BUTTON");
      expect(button.getAttribute("type")).toBe("button");
    }
    // The first agent in the roster is chosen on load.
    expect(arch.getAttribute("aria-pressed")).toBe("true");
    expect(qa.getAttribute("aria-pressed")).toBe("false");
  });

  it("moves the selection and the run history to the agent whose button is activated", async () => {
    render(<AgentsPage />);
    const qa = await screen.findByRole("button", { name: "Show run history for QA" });
    expect(runHistoryAgent()).toBe("Architecture");

    fireEvent.click(qa);

    expect(qa.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Show run history for Architecture" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(runHistoryAgent()).toBe("QA");
  });

  it("leaves the selection alone when the card's own primary button opens its modal", async () => {
    render(<AgentsPage />);
    const qa = await screen.findByRole("button", { name: "Show run history for QA" });
    const [, qaPrimary] = screen.getAllByRole("button", { name: "Set up & run" });

    fireEvent.click(qaPrimary);

    expect(await screen.findByRole("button", { name: "Close" })).toBeTruthy();
    expect(qa.getAttribute("aria-pressed")).toBe("false");
  });
});
