// @vitest-environment jsdom
//
// The activity feed pages older runs by cursor, drops a page that lands after the
// filter changed, and opens a run to show how it went in words.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children?: unknown }) =>
    createElement("a", { href, ...props }, children as never),
}));
vi.mock("@/components/agents/run-memory-trail", () => ({
  RunMemoryTrail: () => createElement("p", null, "memory trail"),
}));

import { ActivityFeed, outcomeOf, type ActivityRun } from "./activity-feed";

const run = (id: string, extra: Partial<ActivityRun> = {}): ActivityRun => ({
  id,
  agentId: "agent_qa",
  agentName: "QA agent",
  agentRole: "qa",
  status: "completed",
  stalled: false,
  phase: null,
  meta: { campaignName: `subject ${id}` },
  error: null,
  startedAt: "2026-10-14T10:00:00Z",
  finishedAt: "2026-10-14T10:00:05Z",
  ...extra,
});

let answer: (url: string) => Promise<Response>;
const requests = () => vi.mocked(fetch).mock.calls.map(([url]) => String(url));

beforeEach(() => {
  answer = async (url) =>
    url.includes("before=")
      ? Response.json({ runs: [run("r3")], next: null })
      : Response.json({ runs: [run("r1"), run("r2")], next: "cursor-2" });
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => answer(url)),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("activity feed", () => {
  it("shows older runs after the newest page, by cursor", async () => {
    render(<ActivityFeed />);
    await screen.findByText("subject r2");
    fireEvent.click(screen.getByRole("button", { name: "Show older runs" }));
    await screen.findByText("subject r3");
    expect(requests().at(-1)).toBe("/api/agents/activity?limit=20&before=cursor-2");
    expect(screen.queryByRole("button", { name: "Show older runs" })).toBeNull();
  });

  it("drops an older page that lands after the filter changed", async () => {
    let release: () => void = () => {};
    answer = (url) =>
      url.includes("before=")
        ? new Promise((resolve) => {
            release = () => resolve(Response.json({ runs: [run("late")], next: null }));
          })
        : url.includes("status=failed")
          ? Promise.resolve(Response.json({ runs: [run("f1", { status: "failed" })], next: null }))
          : Promise.resolve(Response.json({ runs: [run("r1")], next: "cursor-1" }));
    render(<ActivityFeed />);
    fireEvent.click(await screen.findByRole("button", { name: "Show older runs" }));
    fireEvent.click(screen.getByRole("button", { name: "Failed" }));
    await screen.findByText("subject f1");
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("subject late")).toBeNull();
  });

  it("opens a failed run with its error in words and a link to its steps", async () => {
    answer = async () =>
      Response.json({
        runs: [run("r1", { status: "failed", phase: "failed", error: "Memory read was denied" })],
        next: null,
      });
    render(<ActivityFeed />);
    fireEvent.click(await screen.findByRole("button", { name: /QA agent/ }));
    expect(screen.getByText("It stopped with this error: Memory read was denied")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open the run's steps and output" }).getAttribute("href")).toBe(
      "/agents/agent_qa/run/r1",
    );
    expect(screen.getByText("memory trail")).toBeTruthy();
  });

  it("offers no steps link for a one-shot run, and says when nothing matches", async () => {
    answer = async (url) => Response.json({ runs: url.includes("status=running") ? [] : [run("r1")], next: null });
    render(<ActivityFeed />);
    fireEvent.click(await screen.findByRole("button", { name: /QA agent/ }));
    expect(screen.queryByRole("link", { name: /steps/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Running" }));
    await waitFor(() => expect(screen.getByText("No runs you can see match this filter.")).toBeTruthy());
  });

  it("names the two kinds of running that are not working", () => {
    expect(outcomeOf({ status: "running", stalled: true, phase: "executing" }).label).toBe("Stalled");
    expect(outcomeOf({ status: "running", stalled: false, phase: "paused" }).label).toBe("Waiting on a person");
    expect(outcomeOf({ status: "running", stalled: false, phase: null }).label).toBe("Running");
  });
});
