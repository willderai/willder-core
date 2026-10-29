import { describe, expect, it } from "vitest";
import {
  buildTimeline,
  laneKey,
  parseWindow,
  percentile,
  scopeOfTarget,
  summarizeLatency,
  type TimelineReadInput,
  type TimelineWriteInput,
} from "./timeline";

const CREW = "org_acme.crew_1c5b79";
const OTHER = "org_acme.sales_9f2e11";
const t = (seconds: number) => new Date(Date.UTC(2026, 8, 25, 12, 0, seconds));

function write(
  id: string,
  actorId: string,
  seconds: number,
  scopePath = CREW,
  actorType = "agent",
): TimelineWriteInput {
  return {
    id,
    at: t(seconds),
    actorType,
    actorId,
    origin: "mcp",
    scopePath,
    op: "create",
    recordType: "fact",
    recordId: `rec-${id}`,
  };
}

function read(
  id: string,
  actorId: string,
  seconds: number,
  target: string | null = CREW,
  extra: Partial<TimelineReadInput> = {},
): TimelineReadInput {
  return {
    id,
    at: t(seconds),
    actorType: "agent",
    actorId,
    action: "memory.read",
    target,
    decision: "allow",
    origin: "mcp",
    ...extra,
  };
}

function build(writes: TimelineWriteInput[], reads: TimelineReadInput[]) {
  return buildTimeline({ writes, reads, names: new Map() });
}

describe("scopeOfTarget", () => {
  it("reads the scope off a bare scope target and a scope/detail target", () => {
    expect(scopeOfTarget(CREW)).toBe(CREW);
    expect(scopeOfTarget(`${CREW}/query:who owns billing`)).toBe(CREW);
  });

  it("returns null for targets that name no scope path", () => {
    expect(scopeOfTarget(null)).toBeNull();
    expect(scopeOfTarget("group:acme.crew/fact:1")).toBeNull();
    expect(scopeOfTarget("query:older row")).toBeNull();
  });
});

describe("percentile and summarizeLatency", () => {
  it("uses nearest rank, matching the concurrent-writes measure", () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 50)).toBe(5);
    expect(percentile(sorted, 95)).toBe(10);
    expect(percentile([42], 95)).toBe(42);
  });

  it("reports no summary rather than zeros when nothing was measured", () => {
    expect(summarizeLatency([])).toBeNull();
    expect(summarizeLatency([3000, 1000, 2000])).toEqual({ count: 3, medianMs: 2000, p95Ms: 3000 });
  });
});

describe("buildTimeline", () => {
  it("gives every actor a lane and puts a write on its writer's lane", () => {
    const timeline = build([write("w1", "alpha", 0)], [read("r1", "beta", 5)]);
    expect(timeline.lanes.map((l) => l.key)).toEqual([laneKey("agent", "alpha"), laneKey("agent", "beta")]);
    expect(timeline.writes[0]).toMatchObject({ id: "w1", laneKey: "agent:alpha", scopePath: CREW });
  });

  it("joins a write to each reader's first covering read after it, with its latency", () => {
    const timeline = build(
      [write("w1", "alpha", 10)],
      [read("early", "beta", 5), read("first", "beta", 16), read("later", "beta", 30), read("r-gamma", "gamma", 12)],
    );
    expect(timeline.sightings).toEqual([
      {
        writeId: "w1",
        laneKey: "agent:beta",
        readId: "first",
        at: t(16).toISOString(),
        latencyMs: 6000,
        action: "memory.read",
        scopePath: CREW,
        origin: "mcp",
        outcome: "allow",
      },
      {
        writeId: "w1",
        laneKey: "agent:gamma",
        readId: "r-gamma",
        at: t(12).toISOString(),
        latencyMs: 2000,
        action: "memory.read",
        scopePath: CREW,
        origin: "mcp",
        outcome: "allow",
      },
    ]);
    expect(timeline.latency).toEqual({ count: 2, medianMs: 2000, p95Ms: 6000 });
    expect(timeline.unseenWriteIds).toEqual([]);
  });

  it("counts a read of an ancestor scope as covering, and a sibling scope as not", () => {
    const timeline = build(
      [write("w1", "alpha", 0)],
      [read("sibling", "beta", 2, OTHER), read("ancestor", "gamma", 3, "org_acme")],
    );
    expect(timeline.sightings.map((s) => s.readId)).toEqual(["ancestor"]);
  });

  it("does not treat a prefix-sharing sibling scope as an ancestor", () => {
    const timeline = build([write("w1", "alpha", 0, "org_acme.crew_1c5b79")], [read("r", "beta", 1, "org_acme.crew")]);
    expect(timeline.sightings).toEqual([]);
  });

  it("never draws an edge from a denied read, the writer's own read, or a person's read", () => {
    const timeline = build(
      [write("w1", "alpha", 0)],
      [
        read("denied", "beta", 1, CREW, { decision: "deny" }),
        read("own", "alpha", 2),
        read("person", "user_1", 3, CREW, { actorType: "human" }),
        read("entity", "gamma", 4, `${CREW}/entity:e1`, { action: "memory.entity" }),
      ],
    );
    expect(timeline.sightings).toEqual([]);
    expect(timeline.unseenWriteIds).toEqual(["w1"]);
    expect(timeline.latency).toBeNull();
  });

  it("puts a denied read on the lane that tried, people included", () => {
    const timeline = build(
      [],
      [
        read("d1", "beta", 1, `${OTHER}/query:pricing`, { decision: "deny" }),
        read("d2", "user_1", 2, OTHER, { decision: "deny", actorType: "human", action: "memory.entity" }),
      ],
    );
    expect(timeline.denials).toEqual([
      {
        id: "d1",
        at: t(1).toISOString(),
        laneKey: "agent:beta",
        action: "memory.read",
        scopePath: OTHER,
        origin: "mcp",
        outcome: "deny",
      },
      {
        id: "d2",
        at: t(2).toISOString(),
        laneKey: "human:user_1",
        action: "memory.entity",
        scopePath: OTHER,
        origin: "mcp",
        outcome: "deny",
      },
    ]);
  });

  it("types a write's lane from the actor type its change event recorded", () => {
    const timeline = build(
      [write("w1", "user_1", 0, CREW, "human"), write("w2", "slack-sync:src_1", 1, CREW, "extraction")],
      [],
    );
    expect(timeline.writes.map((w) => w.laneKey)).toEqual(["human:user_1", "extraction:slack-sync:src_1"]);
  });

  it("keeps a human and an agent that share an id on separate lanes", () => {
    const timeline = build(
      [write("w1", "shared", 0)],
      [read("d", "shared", 1, CREW, { decision: "deny", actorType: "human" })],
    );
    expect(timeline.lanes.map((l) => l.key).sort()).toEqual(["agent:shared", "human:shared"]);
  });

  it("colours a lane by the scope it touched most", () => {
    const timeline = build(
      [write("w1", "alpha", 0, OTHER)],
      [read("a", "alpha", 1), read("b", "alpha", 2), read("c", "beta", 3, OTHER)],
    );
    expect(timeline.lanes.find((l) => l.key === "agent:alpha")!.scopePath).toBe(CREW);
    expect(timeline.lanes.find((l) => l.key === "agent:beta")!.scopePath).toBe(OTHER);
  });

  it("orders its output by time whatever order the rows arrive in", () => {
    const timeline = build([write("late", "alpha", 20), write("early", "alpha", 0)], [read("r", "beta", 25)]);
    expect(timeline.writes.map((w) => w.id)).toEqual(["early", "late"]);
    expect(timeline.sightings.map((s) => [s.writeId, s.latencyMs])).toEqual([
      ["early", 25000],
      ["late", 5000],
    ]);
  });

  it("uses a lane's display name when one is given", () => {
    const timeline = buildTimeline({
      writes: [write("w1", "alpha", 0)],
      reads: [],
      names: new Map([["agent:alpha", "Agent A"]]),
    });
    expect(timeline.lanes[0]!.name).toBe("Agent A");
  });
});

describe("parseWindow", () => {
  const now = new Date("2026-09-26T12:00:00Z");

  it("defaults to the 24 hours before now", () => {
    expect(parseWindow(null, null, now)).toEqual({ from: new Date("2026-09-25T12:00:00Z"), to: now });
  });

  it("rejects unparseable, reversed and over-wide windows with the fix in the message", () => {
    expect(parseWindow("yesterday", null, now)).toEqual({ error: expect.stringMatching(/ISO timestamps/) });
    expect(parseWindow("2026-09-26T13:00:00Z", null, now)).toEqual({ error: "from must be earlier than to" });
    expect(parseWindow("2026-08-01T00:00:00Z", null, now)).toEqual({ error: expect.stringMatching(/at most 31 days/) });
  });

  it("accepts a window of exactly the maximum width", () => {
    expect(parseWindow("2026-08-26T12:00:00Z", null, now)).toEqual({ from: new Date("2026-08-26T12:00:00Z"), to: now });
  });
});
