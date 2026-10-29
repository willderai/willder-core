// @vitest-environment jsdom
//
// A writer label whose name carries a bidi control ("‮metsyS‬" is drawn as
// "System") is marked by services/audit/actor-names.ts, but the control would still
// reorder what the screen shows. Every audit surface that draws a writer label shows the
// controls escaped instead, so no label reaches the screen with a live one in it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Timeline } from "@/services/audit/timeline";
import { ActorPicker } from "./actor-picker";
import { AuditLog } from "./audit-log";
import { TimelineChart } from "./timeline-chart";

const BIDI = /\p{Bidi_Control}/u;
const SPOOF = '‮metsyS‬ Agent (agent key "custom-1")';
const SHOWN = '[U+202E]metsyS[U+202C] Agent (agent key "custom-1")';

class NoopResizeObserver {
  observe() {}
  disconnect() {}
}
beforeEach(() => vi.stubGlobal("ResizeObserver", NoopResizeObserver));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("a writer label with a bidi control is drawn with the control escaped", () => {
  it("in a Timeline lane: the SVG text, its hover title and the write's accessible name", () => {
    const timeline = {
      lanes: [{ key: "agent:custom-1", actorType: "agent", actorId: "custom-1", name: SPOOF, scopePath: "org_c1" }],
      writes: [
        {
          id: "w1",
          laneKey: "agent:custom-1",
          at: 1_000,
          op: "create",
          recordType: "fact",
          recordId: "f1",
          scopePath: "org_c1",
        },
      ],
      sightings: [],
      denials: [],
      latency: { count: 0, medianMs: null, p95Ms: null },
      unseenWriteIds: [],
    } as unknown as Timeline;
    const { container } = render(
      <TimelineChart
        timeline={timeline}
        domain={[0, 3_600_000]}
        playhead={null}
        selectedWriteId={null}
        onSelectWrite={() => {}}
      />,
    );
    expect(BIDI.test(container.innerHTML)).toBe(false);
    expect(container.textContent).toContain(SHOWN);
  });

  it("in the actors picker", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ actors: [{ actorType: "agent", actorId: "custom-1", name: SPOOF }] })),
    );
    const { container } = render(<ActorPicker selected={null} onChange={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "All identities" }));
    await screen.findByText("[U+202E]metsyS[U+202C] Agent");
    expect(BIDI.test(container.innerHTML)).toBe(false);
  });

  it("in the audit log, in the row and in its details", async () => {
    const entry = {
      id: "audit_01",
      actorType: "agent",
      actorName: SPOOF,
      action: "memory.write",
      target: "org_test.support/fact:f1",
      decision: "allow",
      reason: "ok",
      changeIds: [],
      at: "2026-09-29T13:24:01.123Z",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/api/audit/actors"
          ? json({ actors: [] })
          : json({
              entries: [entry],
              total: 1,
              counts: { allowed: 1, denied: 0 },
              page: 1,
              pageSize: 50,
              totalPages: 1,
            }),
      ),
    );
    const { container } = render(<AuditLog scope={null} />);
    fireEvent.click(await screen.findByRole("button", { name: "Inspect event audit_01" }));
    expect(screen.getAllByText(SHOWN)).toHaveLength(2);
    expect(BIDI.test(container.innerHTML)).toBe(false);
  });
});
