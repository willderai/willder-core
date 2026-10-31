// memory_changes: list what other agents or people changed in the caller's
// scope, newest last. The one rule: the cursor is server-held, so no caller can
// send or receive a position whose gaps would count writes it may not read.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveCallerScopePath } from "@/services/access";
import { readChanges, MAX_CHANGES_PER_READ } from "@/services/memory/change-feed";
import { toolError, type ToolContext } from "./tool-context";

/** ` · <day>` for when a change was recorded, the day in UTC (2026-10-01); nothing when unknown. */
function recordedDay(at: Date | string | undefined): string {
  const time = at ? new Date(at).getTime() : Number.NaN;
  return Number.isNaN(time) ? "" : ` · ${new Date(time).toISOString().slice(0, 10)}`;
}

export function registerMemoryChanges(server: McpServer, { ctx, cap, taskStartOnly }: ToolContext): void {
  server.registerTool(
    "memory_changes",
    {
      title: "What changed since you last looked",
      description:
        "List memory changes another agent or person made, newest last. Your own writes are never listed: you already know them, and a memory_ingest is readable by the time the call returns, so read it back with memory_query instead. Always continues from your own previous call — the server holds your position, so you do not track one and cannot be told about changes outside your scope. Access-scoped to your capability and audited.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .positive()
          .max(MAX_CHANGES_PER_READ)
          .optional()
          .describe(`Max changes to return (default 20, max ${MAX_CHANGES_PER_READ})`),
        scopePath: z.string().optional().describe("ltree scope to watch. Defaults to your token's scope."),
      },
    },
    taskStartOnly(async ({ limit, scopePath }) => {
      try {
        // Same read-side scope default as memory_query: fall back to the token's
        // own scope on an absent or malformed caller-supplied path, which can
        // never widen what the caller already covers.
        const target = await resolveCallerScopePath(ctx, scopePath, cap, { onInvalid: "fallback" });
        // No cursor argument on this surface: the server-held position is the only
        // one, so nothing a caller sends or receives can carry the org-wide `seq`
        // whose gaps would count writes it may not read. A non-MCP client that
        // needs an explicit cursor uses GET /api/changes?after=<change id>.
        const { changes, hasMore } = await readChanges(ctx, target, { limit });
        // The caller's own writes are dropped here as change notices drop them
        // (mcp/change-notices.ts), and still pass the cursor, so whether one is
        // listed never depends on which tool the agent happened to call first.
        const fromOthers = changes.filter((change) => change.actorId !== ctx.actor.id);
        if (!fromOthers.length && !hasMore) return { content: [{ type: "text" as const, text: "No changes." }] };
        // Each change ends with the day it was recorded, in UTC, so a history read off the log
        // ("when did we switch") has its dates. It goes last: readers find a change by its
        // opening (`create fact <id> by <actor>:`).
        const lines = fromOthers.map(
          (c) => `${c.op} ${c.recordType} ${c.recordId} by ${c.actorId}: ${c.summary}${recordedDay(c.createdAt)}`,
        );
        if (hasMore) lines.push("(more changes waiting — call again)");
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (e) {
        return toolError(e);
      }
    }),
  );
}
