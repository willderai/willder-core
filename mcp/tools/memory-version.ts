// memory_version: read one stored version of a fact or rule by id. The one rule: the
// version names its own scope, so the caller supplies none and a version it may not
// read is reported as missing, exactly like one that does not exist.
//
// A call with no id is refused by the schema with how to make it: an agent that loaded the
// tool from a task-start line called it with empty arguments and got a validation error naming
// no fix. versionId stays required
// in the advertised schema, so a client, the public docs (lib/docs.ts) and the refusal probe
// (which fills required arguments) all see the real contract.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readMemoryVersion, type MemoryVersion } from "@/services/memory/versions";
import { recordServedVersions, toolError, type ToolContext } from "./tool-context";
import { derivedMarkersFor } from "../derived-write";

/**
 * What a call that names no version is told: what to pass, and where the id is found. The SDK
 * serves a schema refusal as JSON, so the text holds no double quote that would come back escaped.
 */
export const MISSING_VERSION_ID =
  "memory_version needs versionId as a string: the id after `fact`, `decision` or `convention` in a task-start line (for `[fact abc123]` pass versionId abc123), or the id a change notice names.";

export function registerMemoryVersion(server: McpServer, { ctx, cap, notifyingRead: notifying }: ToolContext): void {
  server.registerTool(
    "memory_version",
    {
      title: "Read one version by id",
      description:
        "Fetch one stored version of a fact or a rule by its id — the id a change notice gives you when another agent's write superseded yours, or when your own write lost a race. Says whether the version is current, superseded or retired, and by what, with the date of each version it names (what a fact said before and when it changed). Access-scoped and audited.",
      inputSchema: {
        versionId: z
          .string({ required_error: MISSING_VERSION_ID, invalid_type_error: MISSING_VERSION_ID })
          .trim()
          .min(1, MISSING_VERSION_ID)
          .describe(
            'The version\'s id: the id after "fact" in a task-start line (`[fact <id>]`), or the id a change notice reported.',
          ),
      },
    },
    notifying(async ({ versionId }) => {
      try {
        const version = await readMemoryVersion(ctx, versionId);
        if (!version) return { content: [{ type: "text" as const, text: "Version not found." }] };
        if (version.kind === "fact") await recordServedVersions(cap, [version.id]);
        const shared = (await derivedMarkersFor(ctx, [version.id])).get(version.id);
        return { content: [{ type: "text" as const, text: describeVersion(version, shared) }] };
      } catch (e) {
        return toolError(e);
      }
    }),
  );
}

/** A date as the version's lineage states it: the day in UTC, 2026-10-01. */
const utcDay = (at: Date) => at.toISOString().slice(0, 10);

/** One version as plain lines, so a model can read it without parsing anything. Also the text
 * of a `willder://version/{versionId}` resource (mcp/resources.ts). */
export function describeVersion(version: MemoryVersion, shared: string | undefined): string {
  // A fact its writer dated (memory_ingest's occurredAt) is also served with that date, the one
  // memory_query gives it, when it falls on another day than the write.
  const occurred =
    version.occurredAt && utcDay(version.occurredAt) !== utcDay(version.createdAt)
      ? `, as of ${utcDay(version.occurredAt)}`
      : "";
  const lines = [
    `${version.kind} ${version.id} (${version.status})`,
    `scope: ${version.scopePath}`,
    `written by ${version.actorId ?? "unknown"} at ${version.createdAt.toISOString()}${occurred}`,
  ];
  // A declared share's marker (mcp/derived-write.ts): names the source only to a reader of it.
  if (shared) lines.push(shared);
  // Each version the lineage names is dated as a day in UTC (2026-10-01), by the date memory_query
  // serves it with, so a reader can say when a value changed without opening every version; an
  // id whose date is not known is named alone. A replacement recorded on another day than its
  // own date (a dated import of history) says both.
  const asOf = (id: string) => {
    const at = version.lineageDatedAt?.[id];
    return at ? ` (as of ${utcDay(at)})` : "";
  };
  if (version.supersededById) {
    const dated = version.lineageDatedAt?.[version.supersededById];
    const recorded =
      version.supersededAt && (!dated || utcDay(dated) !== utcDay(version.supersededAt))
        ? `, recorded ${utcDay(version.supersededAt)}`
        : "";
    lines.push(`superseded by: ${version.supersededById}${asOf(version.supersededById)}${recorded}`);
  }
  if (version.supersedesIds.length > 0)
    lines.push(`supersedes: ${version.supersedesIds.map((id) => `${id}${asOf(id)}`).join(", ")}`);
  lines.push("", version.content);
  return lines.join("\n");
}
