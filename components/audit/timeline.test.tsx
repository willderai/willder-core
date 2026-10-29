// @vitest-environment jsdom
//
// The Timeline view's contract with its two routes: it draws what the timeline
// route derived, reads a change's text only through the detail route with the
// scope it is showing, and never paints a response that arrives for a window
// the viewer has already left.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import type { Timeline } from "@/services/audit/timeline";
import { AuditTimeline } from "./timeline";

/** The audit page's part: the open change lives in the address; here, in state. */
function Timeline({ scope, change = null }: { scope: string; change?: string | null }) {
  const [selected, setSelected] = useState<string | null>(change);
  return <AuditTimeline scope={scope} selected={selected} onSelect={setSelected} />;
}

const SCOPE = "org_c1.crew_1c5b79";
const TO = "2026-09-25T13:00:00.000Z";
const FROM = "2026-09-25T12:00:00.000Z";

const TIMELINE: Timeline = {
  lanes: [
    { key: "agent:alpha", actorType: "agent", actorId: "alpha", name: "Agent A", scopePath: SCOPE },
    { key: "agent:beta", actorType: "agent", actorId: "beta", name: "Agent B", scopePath: SCOPE },
  ],
  writes: [
    {
      id: "w1",
      at: "2026-09-25T12:10:00.000Z",
      laneKey: "agent:alpha",
      scopePath: SCOPE,
      op: "create",
      recordType: "fact",
      recordId: "f1",
      origin: "mcp",
      outcome: "success",
    },
  ],
  sightings: [
    {
      writeId: "w1",
      laneKey: "agent:beta",
      readId: "r1",
      at: "2026-09-25T12:10:06.496Z",
      latencyMs: 6496,
      action: "memory.read",
      scopePath: SCOPE,
      origin: "mcp",
      outcome: "allow",
    },
  ],
  denials: [
    {
      id: "d1",
      at: "2026-09-25T12:20:00.000Z",
      laneKey: "agent:beta",
      action: "memory.read",
      scopePath: SCOPE,
      origin: "mcp",
      outcome: "deny",
    },
  ],
  latency: { count: 1, medianMs: 6496, p95Ms: 6496 },
  unseenWriteIds: [],
};

function timelineResponse(timeline: Timeline) {
  return { scope: SCOPE, from: FROM, to: TO, timeline, truncated: { writes: false, reads: false } };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

class NoopResizeObserver {
  observe() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", NoopResizeObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AuditTimeline", () => {
  it("draws lanes, the latency figures and the denial count from the route's timeline", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(timelineResponse(TIMELINE))),
    );
    render(<Timeline scope={SCOPE} />);

    expect(await screen.findByText("Agent A")).toBeTruthy();
    expect(screen.getByText("Agent B")).toBeTruthy();
    expect(screen.getAllByText("6.5 s")).toHaveLength(2); // median and p95
    expect(screen.getByText("Denied reads").nextSibling?.textContent).toBe("1");
    expect(screen.getByText("Changed action").nextSibling?.textContent).toBe("Not measured");
    expect(screen.getByText(/It does not confirm that the specific change was delivered/)).toBeTruthy();
    const url = new URL(vi.mocked(fetch).mock.calls[0]![0] as string, "http://t");
    expect(url.pathname).toBe("/api/audit/timeline");
    expect(url.searchParams.get("scope")).toBe(SCOPE);
  });

  it("opens a write's text through the detail route, scoped to the scope on screen", async () => {
    const fetchMock = vi.fn(async (input: string) =>
      input.startsWith("/api/audit/timeline/w1")
        ? json({
            id: "w1",
            op: "create",
            recordType: "fact",
            recordId: "f1",
            scopePath: SCOPE,
            summary: "Conflict sample 3",
            writer: "Agent A",
            source: null,
            replacedById: null,
            replacesIds: [],
            actingFor: null,
            replacedBy: null,
            replaces: [],
            at: TIMELINE.writes[0]!.at,
          })
        : json(timelineResponse(TIMELINE)),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<Timeline scope={SCOPE} />);

    fireEvent.click(await screen.findByRole("button", { name: /create fact/ }));
    expect(await screen.findByText("Conflict sample 3")).toBeTruthy();
    const detailCall = fetchMock.mock.calls.find(([u]) => u.startsWith("/api/audit/timeline/w1"))!;
    expect(new URL(detailCall[0], "http://t").searchParams.get("scope")).toBe(SCOPE);
    expect(screen.getByText("Agent B", { selector: "li span" })).toBeTruthy();
  });

  it("answers who wrote a change, its source, what it replaced and who read it, as the route reports them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) =>
        input.startsWith("/api/audit/timeline/w1")
          ? json({
              id: "w1",
              op: "supersede",
              recordType: "convention",
              recordId: "c1",
              scopePath: SCOPE,
              summary: "superseded by c2: release cadence",
              writer: "Slack Sync Agent",
              actingFor: "Jane Doe",
              source: { id: "src1", name: "Acme #eng", type: "slack" },
              replacedById: "c2",
              replacesIds: ["c0"],
              replacedBy: { id: "c2", change: null },
              replaces: [{ id: "c0", change: null }],
              at: TIMELINE.writes[0]!.at,
            })
          : json(timelineResponse(TIMELINE)),
      ),
    );
    render(<Timeline scope={SCOPE} />);

    fireEvent.click(await screen.findByRole("button", { name: /create fact/ }));
    const panel = await screen.findByRole("region", { name: "Selected change" });
    await within(panel).findByText("superseded by c2: release cadence");
    const answer = (label: string) =>
      within(panel).getByText(label, { selector: "dt" }).nextElementSibling?.textContent;
    expect(answer("Written by")).toBe("Slack Sync Agent, acting for Jane Doe");
    expect(answer("Source")).toBe("Acme #eng (slack)");
    expect(within(panel).getByRole("link", { name: "Acme #eng (slack)" }).getAttribute("href")).toBe(
      "/integrations#source-src1",
    );
    expect(answer("Replaced")).toBe("Replaces c0Replaced by c2");
    expect(within(panel).getByText("Agent B", { selector: "li span" })).toBeTruthy();
  });

  it("says a direct write has no connected source and a create replaced nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) =>
        input.startsWith("/api/audit/timeline/w1")
          ? json({
              id: "w1",
              op: "create",
              recordType: "fact",
              recordId: "f1",
              scopePath: SCOPE,
              summary: "Direct note",
              writer: "Agent A",
              source: null,
              replacedById: null,
              replacesIds: [],
              actingFor: null,
              replacedBy: null,
              replaces: [],
              at: TIMELINE.writes[0]!.at,
            })
          : json(timelineResponse(TIMELINE)),
      ),
    );
    render(<Timeline scope={SCOPE} />);

    fireEvent.click(await screen.findByRole("button", { name: /create fact/ }));
    const panel = await screen.findByRole("region", { name: "Selected change" });
    await within(panel).findByText("Direct note");
    const answer = (label: string) =>
      within(panel).getByText(label, { selector: "dt" }).nextElementSibling?.textContent;
    expect(answer("Source")).toBe("Written directly, not by a connected source");
    expect(answer("Replaced")).toBe("Nothing");
  });

  it("shows the route's error instead of an empty chart", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ error: "from must be earlier than to" }, 400)),
    );
    render(<Timeline scope={SCOPE} />);
    expect((await screen.findByRole("alert")).textContent).toContain("from must be earlier than to");
  });

  it("describes an empty timeline without claiming no other reads happened", async () => {
    const empty: Timeline = { lanes: [], writes: [], sightings: [], denials: [], latency: null, unseenWriteIds: [] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(timelineResponse(empty))),
    );
    render(<Timeline scope={SCOPE} />);

    expect(await screen.findByText(/No writes, eligible agent reads, or denied reads/)).toBeTruthy();
    expect(screen.queryByText(/Nothing was written or read/)).toBeNull();
  });

  it("exposes labeled write controls inside a group and opens them with the keyboard", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) =>
        input.startsWith("/api/audit/timeline/w1")
          ? json({
              id: "w1",
              op: "create",
              recordType: "fact",
              recordId: "f1",
              scopePath: SCOPE,
              summary: "Keyboard-selected write",
              writer: "Agent A",
              source: null,
              replacedById: null,
              replacesIds: [],
              actingFor: null,
              replacedBy: null,
              replaces: [],
              at: TIMELINE.writes[0]!.at,
            })
          : json(timelineResponse(TIMELINE)),
      ),
    );
    render(<Timeline scope={SCOPE} />);

    const chart = await screen.findByRole("group", { name: "Timeline of 1 writes across 2 lanes" });
    const write = within(chart).getByRole("button", { name: /Inspect create fact f1 by Agent A/ });
    expect(write.closest('[role="img"]')).toBeNull();
    expect(write.getAttribute("tabindex")).toBe("0");
    expect(write.getAttribute("aria-pressed")).toBe("false");
    fireEvent.keyDown(write, { key: "Enter" });
    expect(await screen.findByText("Keyboard-selected write")).toBeTruthy();
    expect(write.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.keyDown(write, { key: " " });
    expect(await screen.findByText("Keyboard-selected write")).toBeTruthy();
  });

  it.each([
    ["missing data", {}],
    ["missing nested arrays", { ...timelineResponse(TIMELINE), timeline: { lanes: [] } }],
    ["invalid time window", { ...timelineResponse(TIMELINE), from: TO, to: FROM }],
    [
      "dangling write reference",
      timelineResponse({ ...TIMELINE, sightings: [{ ...TIMELINE.sightings[0]!, writeId: "missing" }] }),
    ],
    ["another scope", { ...timelineResponse(TIMELINE), scope: "org_c1.other" }],
  ])("shows a recoverable error for HTTP 200 with %s", async (_label, body) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(body))
      .mockResolvedValueOnce(json(timelineResponse(TIMELINE)));
    vi.stubGlobal("fetch", fetchMock);
    render(<Timeline scope={SCOPE} />);

    expect((await screen.findByRole("alert")).textContent).toContain("The timeline returned incomplete data.");
    expect(screen.queryByRole("group", { name: /Timeline of/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Agent A")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("handles invalid JSON and non-string HTTP errors without rendering raw objects", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("not JSON", { status: 200 }))
      .mockResolvedValueOnce(json({ error: { internal: "detail" } }, 500));
    vi.stubGlobal("fetch", fetchMock);
    render(<Timeline scope={SCOPE} />);

    expect((await screen.findByRole("alert")).textContent).toContain("The timeline returned incomplete data.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("The timeline could not load (HTTP 500).")).toBeTruthy();
  });

  it("lets a malformed change detail be retried without losing the selected write", async () => {
    let detailCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        if (!input.startsWith("/api/audit/timeline/w1")) return json(timelineResponse(TIMELINE));
        detailCalls++;
        return json(
          detailCalls === 1
            ? { summary: { invalid: true } }
            : {
                id: "w1",
                op: "create",
                recordType: "fact",
                recordId: "f1",
                scopePath: SCOPE,
                summary: "Recovered change",
                writer: "Agent A",
                source: null,
                replacedById: null,
                replacesIds: [],
                actingFor: null,
                replacedBy: null,
                replaces: [],
                at: TIMELINE.writes[0]!.at,
              },
        );
      }),
    );
    render(<Timeline scope={SCOPE} />);

    fireEvent.click(await screen.findByRole("button", { name: /Inspect create fact/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("This change returned incomplete data.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Recovered change")).toBeTruthy();
    expect(detailCalls).toBe(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("never shows one window's rows under another, loaded or late", async () => {
    const pending: ((r: Response) => void)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve))),
    );
    render(<Timeline scope={SCOPE} />);
    await act(async () => pending[0]!(json(timelineResponse(TIMELINE))));
    expect(await screen.findByText("Agent A")).toBeTruthy();

    // Switching range hides the 24-hour rows at once, not when 7 days arrives.
    fireEvent.click(screen.getByRole("button", { name: "7 days" }));
    expect(screen.queryByText("Agent A")).toBeNull();

    // Back to 24 hours, then away again before it answers: the late answer is dropped.
    fireEvent.click(screen.getByRole("button", { name: "24 hours" }));
    fireEvent.click(screen.getByRole("button", { name: "1 hour" }));
    const stale = { ...TIMELINE, lanes: [{ ...TIMELINE.lanes[0]!, name: "Stale Lane" }] };
    await act(async () => pending[2]!(json(timelineResponse(stale))));
    expect(screen.queryByText("Stale Lane")).toBeNull();

    await act(async () => pending[3]!(json(timelineResponse(TIMELINE))));
    expect(await screen.findByText("Agent A")).toBeTruthy();
  });
});

// Every request to the timeline route is an access decision with its own audit row,
// so live refresh must not turn a refusal into a row every LIVE_REFRESH_MS.
describe("AuditTimeline live refresh", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it("keeps refreshing a timeline the viewer may read", async () => {
    const fetchMock = vi.fn(async () => json(timelineResponse(TIMELINE)));
    vi.stubGlobal("fetch", fetchMock);
    render(<Timeline scope={SCOPE} />);
    expect(await screen.findByText("Agent A")).toBeTruthy();
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it("stops refreshing after a refusal, so one refusal is one request", async () => {
    const fetchMock = vi.fn(async () => json({ error: "forbidden" }, 403));
    vi.stubGlobal("fetch", fetchMock);
    render(<Timeline scope={SCOPE} />);
    expect((await screen.findByRole("alert")).textContent).toContain("Admin access required");
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
