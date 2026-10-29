// memory_stale: what to refresh next. Lists the records in a scope that rest on a source
// which was replaced, or changed after they were built, most depended-on first.
// The one rule: the report is always scoped, defaulting to the token's own scope, and
// staleReport() runs check() on it, so it never names a record outside that scope or one
// that reads as erased.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveCallerScopePath } from "@/services/access";
import {
  DEFAULT_RECOMMENDATIONS,
  MAX_RECOMMENDATIONS,
  MAX_ROWS_PER_QUERY,
  staleReport,
  type Recommendation,
} from "@/services/memory/dependencies";
import { toolError, type ToolContext } from "./tool-context";

/** One recommendation as a line an agent can act on: the record, what moved, why, when. */
export function formatRecommendation(item: Recommendation): string {
  const { reason } = item.latest;
  const why =
    reason.kind === "superseded" ? `replaced by ${reason.byId}` : reason.op === "update" ? "updated" : `${reason.op}d`;
  const relation = item.latest.kind === "cites" ? "cites" : "rests on";
  const more = item.staleSources > 1 ? ` (${item.staleSources} of its sources moved on)` : "";
  const dependents = item.dependents === 1 ? "1 record rests on it" : `${item.dependents} records rest on it`;
  return `• ${item.recordId}: ${relation} ${item.latest.sourceId}, ${why} at ${reason.at.toISOString()}${more}; ${dependents}`;
}

export function registerMemoryStale(server: McpServer, { ctx, cap, notifyingRead: notifying }: ToolContext): void {
  server.registerTool(
    "memory_stale",
    {
      title: "What to refresh next",
      description:
        "Records in a scope (briefs, derived records) whose cited or source fact has been replaced, or was changed or removed after they were built, most depended-on first. Read-only; access-scoped and audited.",
      inputSchema: {
        scopePath: z.string().optional().describe("ltree scope to inspect. Defaults to your token's scope."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_RECOMMENDATIONS)
          .optional()
          .describe(`Most records to return (default ${DEFAULT_RECOMMENDATIONS})`),
      },
    },
    notifying(async ({ scopePath, limit }) => {
      try {
        // Same read-side scope default as memory_query; staleReport() runs check().
        const target = await resolveCallerScopePath(ctx, scopePath, cap, { onInvalid: "fallback" });
        const report = await staleReport(ctx, target, limit);
        const lines = report.recommend.length
          ? report.recommend.map(formatRecommendation)
          : [`Nothing stale in ${target}.`];
        if (report.truncated) {
          lines.push(
            `Only the newest ${MAX_ROWS_PER_QUERY} rows of each query were read; older records in ${target} were not checked.`,
          );
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (e) {
        return toolError(e);
      }
    }),
  );
}
