// memory_changes ends each change with the day it was recorded, in UTC, after its summary: a
// history read off the log ("when did we switch") has its dates, and the opening readers find a
// change by (`create fact <id> by <actor>:`) is unchanged.
import { describe, expect, it, vi } from "vitest";

const { readChanges } = vi.hoisted(() => ({ readChanges: vi.fn() }));
vi.mock("@/services/access", () => ({ resolveCallerScopePath: vi.fn(async () => "org_1.eng") }));
vi.mock("@/services/memory/change-feed", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory/change-feed")>()),
  readChanges,
}));
vi.mock("./tool-context", () => ({
  toolError: (e: unknown) => ({ content: [{ type: "text", text: String(e) }], isError: true }),
}));

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMemoryChanges } from "./memory-changes";
import type { ToolContext } from "./tool-context";

type Handler = (a: Record<string, unknown>) => Promise<{ content: { type: "text"; text: string }[] }>;

function handler(): Handler {
  let registered: Handler | undefined;
  const server = { registerTool: (_n: string, _c: unknown, h: Handler) => (registered = h) };
  registerMemoryChanges(
    server as unknown as McpServer,
    {
      ctx: { orgId: "org_1", actor: { type: "agent", id: "reader" } },
      cap: { scopePath: "org_1.eng" },
      taskStartOnly: (h: Handler) => h,
    } as unknown as ToolContext,
  );
  return registered!;
}

const change = (over: Record<string, unknown>) => ({
  id: "c",
  scopePath: "org_1.eng",
  recordType: "fact",
  recordId: "v1",
  op: "create",
  actorId: "writer",
  summary: "Database: Postgres",
  createdAt: new Date("2026-01-10T23:59:00Z"),
  supersededById: null,
  ...over,
});

describe("memory_changes — each change's day", () => {
  it("ends every line with the day it was recorded, a superseded write's included", async () => {
    readChanges.mockResolvedValue({
      changes: [
        change({ summary: "[superseded by v2] Database: Postgres", supersededById: "v2" }),
        change({
          id: "c2",
          recordId: "v2",
          op: "update",
          summary: "Database: MySQL",
          createdAt: new Date("2026-05-01T00:00:01Z"),
        }),
        change({
          id: "c3",
          recordId: "v1",
          op: "supersede",
          summary: "replaced by v2: Database",
          createdAt: new Date("2026-05-01T00:00:02Z"),
        }),
      ],
      hasMore: false,
    });
    const text = (await handler()({})).content[0].text;
    expect(text.split("\n")).toEqual([
      "create fact v1 by writer: [superseded by v2] Database: Postgres · 2026-01-10",
      "update fact v2 by writer: Database: MySQL · 2026-05-01",
      "supersede fact v1 by writer: replaced by v2: Database · 2026-05-01",
    ]);
    // The opening readers of the log match.
    expect(text.split("\n").map((line) => /^\S+ \S+ (\S+) by \S+?:/.exec(line)?.[1])).toEqual(["v1", "v2", "v1"]);
  });

  it("names no day for a change whose time is unknown, and leaves the caller's own writes out", async () => {
    readChanges.mockResolvedValue({
      changes: [change({ createdAt: undefined }), change({ id: "own", actorId: "reader" })],
      hasMore: true,
    });
    expect((await handler()({})).content[0].text).toBe(
      "create fact v1 by writer: Database: Postgres\n(more changes waiting — call again)",
    );
  });
});
