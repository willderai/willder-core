// @vitest-environment jsdom
//
// The run memory trail polls while its run is running. Every request to the run's
// audit route is an access decision with its own audit row, so a refused viewer must
// cost one request, not one every poll interval.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RunMemoryTrail } from "./run-memory-trail";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("RunMemoryTrail", () => {
  it("keeps polling a running run the viewer may read", async () => {
    const fetchMock = vi.fn(async (_url: string) => json({ entries: [], finishedAt: null }));
    vi.stubGlobal("fetch", fetchMock);
    render(<RunMemoryTrail agentId="a1" runId="r1" status="running" />);
    expect(await screen.findByText("This run touched no memory yet.")).toBeTruthy();
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(fetchMock.mock.calls.length).toBeGreaterThan(2);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/agents/a1/runs/r1/audit");
  });

  it("stops polling after a refusal, so one refusal is one request", async () => {
    const fetchMock = vi.fn(async () => json({ error: "forbidden" }, 403));
    vi.stubGlobal("fetch", fetchMock);
    render(<RunMemoryTrail agentId="a1" runId="r1" status="running" />);
    expect(await screen.findByText(/Admin access required/)).toBeTruthy();
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("waits for Load more past a full page, then continues from the last row shown", async () => {
    const entry = (id: string) => ({
      id,
      action: "memory.read",
      target: "org_1.sales:q",
      decision: "allow",
      reason: null,
      at: "2026-10-14T10:00:00Z",
    });
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("cursor=")
        ? json({ entries: [entry("e3")], hasMore: false, endCursor: "c3", finishedAt: null })
        : json({ entries: [entry("e1"), entry("e2")], hasMore: true, endCursor: "c2", finishedAt: null }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<RunMemoryTrail agentId="a1" runId="r1" status="running" />);
    expect(await screen.findByText("Showing the first 2 entries.")).toBeTruthy();
    // A full page stops the poll: a long trail is not walked to its end on its own.
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(screen.queryByText(/Showing the first/)).toBeNull());
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/agents/a1/runs/r1/audit?cursor=c2");
    expect(screen.getAllByText("allow")).toHaveLength(3);

    // Still running: the poll reads the last page again from its start and replaces it.
    await act(async () => vi.advanceTimersByTimeAsync(4_500));
    expect(fetchMock.mock.calls[2]![0]).toBe("/api/agents/a1/runs/r1/audit?cursor=c2");
    expect(screen.getAllByText("allow")).toHaveLength(3);
  });

  it("shows a row that committed late with an earlier time than rows already shown", async () => {
    const entry = (id: string, at: string) => ({
      id,
      action: "memory.read",
      target: `org_1.sales:${id}`,
      decision: "allow",
      reason: null,
      at,
    });
    const answers = [
      // e2 (10:00:02) is read first; e1 (10:00:01) commits after that read.
      json({ entries: [entry("e2", "2026-10-14T10:00:02Z")], hasMore: false, endCursor: "c2", finishedAt: null }),
      json({
        entries: [entry("e1", "2026-10-14T10:00:01Z"), entry("e2", "2026-10-14T10:00:02Z")],
        hasMore: false,
        endCursor: "c2",
        finishedAt: "2026-10-14T10:01:00Z",
      }),
    ];
    const fetchMock = vi.fn(async (_url: string) => answers.shift()!);
    vi.stubGlobal("fetch", fetchMock);
    render(<RunMemoryTrail agentId="a1" runId="r1" status="running" />);
    expect(await screen.findByText("allow")).toBeTruthy();
    await act(async () => vi.advanceTimersByTimeAsync(4_500));
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/agents/a1/runs/r1/audit");
    expect(screen.getAllByText("allow")).toHaveLength(2);
  });

  it("clears every row shown when the trail is withheld past the first page, and reads from the start after", async () => {
    const entry = {
      id: "e1",
      action: "memory.read",
      target: "org_1.sales:q",
      decision: "allow",
      reason: null,
      at: "2026-10-14T10:00:00Z",
    };
    const withheld = {
      entries: [],
      hasMore: false,
      endCursor: null,
      entriesSuppressed: true,
      possibleOverlap: true,
      finishedAt: null,
    };
    const answers = [
      json({ entries: [entry], hasMore: true, endCursor: "c1", finishedAt: null }),
      json(withheld),
      json(withheld),
    ];
    const fetchMock = vi.fn(
      async (_url: string) => answers.shift() ?? json({ entries: [], finishedAt: "2026-10-14T11:00:00Z" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<RunMemoryTrail agentId="a1" runId="r1" status="running" />);
    expect(await screen.findByText("allow")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText(/Can.t show this trail right now/)).toBeTruthy();
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/agents/a1/runs/r1/audit?cursor=c1");
    expect(screen.queryByText("allow")).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(4_500));
    expect(fetchMock.mock.calls[2]![0]).toBe("/api/agents/a1/runs/r1/audit");
  });

  it("shows a row that committed late with an earlier time than rows already shown", async () => {
    const entry = (id: string, at: string) => ({
      id,
      action: "memory.read",
      target: `org_1.sales:${id}`,
      decision: "allow",
      reason: null,
      at,
    });
    const answers = [
      // e2 (10:00:02) is read first; e1 (10:00:01) commits after that read.
      json({ entries: [entry("e2", "2026-10-14T10:00:02Z")], hasMore: false, endCursor: "c2", finishedAt: null }),
      json({
        entries: [entry("e1", "2026-10-14T10:00:01Z"), entry("e2", "2026-10-14T10:00:02Z")],
        hasMore: false,
        endCursor: "c2",
        finishedAt: "2026-10-14T10:01:00Z",
      }),
    ];
    const fetchMock = vi.fn(async (_url: string) => answers.shift()!);
    vi.stubGlobal("fetch", fetchMock);
    render(<RunMemoryTrail agentId="a1" runId="r1" status="running" />);
    expect(await screen.findByText("allow")).toBeTruthy();
    await act(async () => vi.advanceTimersByTimeAsync(4_500));
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/agents/a1/runs/r1/audit");
    expect(screen.getAllByText("allow")).toHaveLength(2);
  });

  it("clears the rows shown when the trail is withheld, and reads from the start after", async () => {
    const entry = {
      id: "e1",
      action: "memory.read",
      target: "org_1.sales:q",
      decision: "allow",
      reason: null,
      at: "2026-10-14T10:00:00Z",
    };
    const answers = [
      json({ entries: [entry], hasMore: false, endCursor: "c1", finishedAt: null }),
      json({
        entries: [],
        hasMore: false,
        endCursor: null,
        entriesSuppressed: true,
        possibleOverlap: true,
        finishedAt: null,
      }),
      json({
        entries: [],
        hasMore: false,
        endCursor: null,
        entriesSuppressed: true,
        possibleOverlap: true,
        finishedAt: null,
      }),
    ];
    const fetchMock = vi.fn(async () => answers.shift() ?? json({ entries: [], finishedAt: "2026-10-14T11:00:00Z" }));
    vi.stubGlobal("fetch", fetchMock);
    render(<RunMemoryTrail agentId="a1" runId="r1" status="running" />);
    expect(await screen.findByText("allow")).toBeTruthy();
    await act(async () => vi.advanceTimersByTimeAsync(4_500));
    expect(await screen.findByText(/Can.t show this trail right now/)).toBeTruthy();
    expect(screen.queryByText("allow")).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(4_500));
    expect(fetchMock.mock.calls[2]).toEqual(["/api/agents/a1/runs/r1/audit"]);
  });
});
