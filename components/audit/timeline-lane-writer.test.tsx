// @vitest-environment jsdom
//
// The Timeline lane label is
// the writer a reader sees on screen. A non-product Agent row whose name claims a built-in
// agent is labelled with its key by resolveAgentNames, but the lane must still show that
// difference in its visible text, not only in a hover title.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { Timeline } from "@/services/audit/timeline";
import { TimelineChart } from "./timeline-chart";

vi.mock("@/lib/db", () => ({
  db: { source: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) }, agent: { findMany: vi.fn() } },
}));
import { db } from "@/lib/db";
import { resolveActorNames } from "@/services/audit/actor-names";

class NoopResizeObserver {
  observe() {}
  disconnect() {}
}
beforeEach(() => vi.stubGlobal("ResizeObserver", NoopResizeObserver));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SCOPE = "org_c1.crew_1";

function visibleLaneText(name: string): string {
  const timeline: Timeline = {
    lanes: [{ key: "agent:x", actorType: "agent", actorId: "x", name, scopePath: SCOPE }],
    writes: [],
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
  const texts = [...container.querySelectorAll("text")].map((t) => t.textContent ?? "");
  cleanup();
  return texts.find((t) => t.length > 0 && !/^\d/.test(t)) ?? "";
}

describe("Timeline lane label", () => {
  it.each([
    ["architecture-agent", "Architecture agent"],
    ["github-secret-scanning", "Github Secret Scanning"],
  ])("a custom Agent row named like %s does not show the same lane text as the real one", async (realId, spoofName) => {
    vi.mocked(db.agent.findMany).mockResolvedValue([
      { agentKey: "architecture-agent", name: "Architecture agent" },
      { agentKey: "custom-1", name: spoofName },
    ] as never);
    const names = await resolveActorNames("org1", [realId, "custom-1"]);
    expect(names["custom-1"]).not.toBe(names[realId]);
    expect(visibleLaneText(names["custom-1"]!)).not.toBe(visibleLaneText(names[realId]!));
  });
});
