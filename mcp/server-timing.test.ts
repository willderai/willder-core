import { describe, expect, it } from "vitest";
import { mcpServerTiming } from "./server-timing";

const quiet = { handlerMs: 41.27, instanceAgeMs: 912345.6, connectionsOpened: 0, taskStartMs: [] };

describe("the Server-Timing value /api/mcp sends", () => {
  it("names the handler's own time, the instance's age and the connections it opened", () => {
    expect(mcpServerTiming(quiet)).toBe('handler;dur=41.3, instance-age;dur=912345.6, db-connections-opened;desc="0"');
  });

  it("keeps one task-start entry per tool call, after the request's own entries", () => {
    expect(mcpServerTiming({ ...quiet, connectionsOpened: 3, taskStartMs: [12.04, 7] })).toBe(
      'handler;dur=41.3, instance-age;dur=912345.6, db-connections-opened;desc="3", task-start;dur=12.0, task-start;dur=7.0',
    );
  });

  it("reports a request that reached a just-started instance with an age below its own handler time", () => {
    // The module was evaluated for this request: the instance is younger than the work done in it.
    const cold = mcpServerTiming({ ...quiet, handlerMs: 640, instanceAgeMs: 0.4, connectionsOpened: 2 });
    expect(cold).toContain("handler;dur=640.0");
    expect(cold).toContain("instance-age;dur=0.4");
    expect(cold).toContain('db-connections-opened;desc="2"');
  });
});
