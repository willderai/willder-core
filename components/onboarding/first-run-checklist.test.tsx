import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { FirstRunStatus } from "@/app/api/onboarding/first-run/route";
import { FirstRunChecklist } from "./first-run-checklist";

const EMPTY: FirstRunStatus = { fact: null, openedFact: false, subScopeToken: null, denied: false };

const COMPLETE: FirstRunStatus = {
  fact: {
    changeId: "chg 1",
    writer: "Claude Code Agent",
    writerType: "agent",
    source: "MCP",
    scopeName: "Engineering",
  },
  openedFact: true,
  subScopeToken: { agent: "Reviewer Agent", scopeName: "Docs" },
  denied: true,
};

function respond(...responses: (FirstRunStatus | number)[]) {
  const fetchMock = vi.fn();
  for (const r of responses) {
    fetchMock.mockResolvedValueOnce(
      typeof r === "number" ? new Response("{}", { status: r }) : new Response(JSON.stringify(r), { status: 200 }),
    );
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderChecklist() {
  return render(<FirstRunChecklist fallback={<p>Suggested path</p>} />);
}

async function steps() {
  const list = await screen.findByRole("list");
  return within(list).getAllByRole("listitem");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("first-run checklist", () => {
  it("in an empty workspace, every step is undone and names its next action", async () => {
    respond(EMPTY);
    renderChecklist();
    const [write, see, less] = await steps();

    expect(screen.getByText("0 of 3 done")).toBeTruthy();
    expect(within(write).getByLabelText("Not done")).toBeTruthy();
    expect(
      within(write)
        .getByRole("link", { name: /Connect your agent/ })
        .getAttribute("href"),
    ).toBe("/integrations#connect-ai");
    expect(
      within(write)
        .getByRole("link", { name: /Connect a source/ })
        .getAttribute("href"),
    ).toBe("/integrations#sources");
    expect(within(see).queryByRole("link")).toBeNull();
    expect(
      within(less)
        .getByRole("link", { name: /Mint a token/ })
        .getAttribute("href"),
    ).toBe("/access?tab=tokens");
  });

  it("offers the read-only replay only to a workspace with no fact yet", async () => {
    respond(EMPTY);
    const { unmount } = renderChecklist();
    expect((await screen.findByRole("link", { name: /Replay a real team/ })).getAttribute("href")).toBe("/timelapse");
    unmount();

    respond(COMPLETE);
    renderChecklist();
    await steps();
    expect(screen.queryByRole("link", { name: /Replay a real team/ })).toBeNull();
  });

  it("when every record exists, says what is true in each step", async () => {
    respond(COMPLETE);
    renderChecklist();
    const [write, see, less] = await steps();

    expect(screen.getByText("3 of 3 done")).toBeTruthy();
    for (const step of [write, see, less]) expect(within(step).getByLabelText("Done")).toBeTruthy();
    expect(write.textContent).toContain("Claude Code Agent wrote to Engineering via MCP.");
    expect(
      within(see)
        .getByRole("link", { name: /Open the fact/ })
        .getAttribute("href"),
    ).toBe("/audit?view=timeline&change=chg%201");
    expect(less.textContent).toContain("Reviewer Agent was refused. Its token covers Docs only.");
  });

  it("a token with no denial yet is a step in progress, not done", async () => {
    respond({ ...COMPLETE, denied: false });
    renderChecklist();
    const less = (await steps())[2]!;
    expect(within(less).getByLabelText("Not done")).toBeTruthy();
    expect(less.textContent).toContain("Reviewer Agent's token covers Docs only.");
    expect(screen.getByText("2 of 3 done")).toBeTruthy();
  });

  it("a fact whose entry point was not recorded names no source", async () => {
    respond({ ...COMPLETE, fact: { ...COMPLETE.fact!, source: null } });
    renderChecklist();
    expect((await steps())[0]!.textContent).toContain("Claude Code Agent wrote to Engineering.");
  });

  it("shows the suggested path, not an all-undone checklist, to someone who cannot see the records", async () => {
    respond(403);
    renderChecklist();
    expect(await screen.findByText("Suggested path")).toBeTruthy();
    expect(screen.queryByText(/of 3 done/)).toBeNull();
  });

  it("says a failed load failed, and retries it", async () => {
    const fetchMock = respond(500, EMPTY);
    renderChecklist();
    expect((await screen.findByRole("alert")).textContent).toContain("could not be loaded");
    expect(screen.queryByText(/of 3 done/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("0 of 3 done")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // The whole checklist has to read in one 390px phone screenshot, so its words are budgeted, not left to grow.
  it("fits one phone screen: at most 65 words in its fullest state", async () => {
    for (const status of [EMPTY, COMPLETE, { ...COMPLETE, openedFact: false, denied: false }]) {
      respond(status);
      const { container, unmount } = renderChecklist();
      await steps();
      const words = (container.textContent ?? "").split(/\s+/).filter(Boolean).length;
      expect(words).toBeLessThanOrEqual(65);
      unmount();
    }
  });
});
