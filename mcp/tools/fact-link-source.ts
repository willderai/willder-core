// fact_link_source: link an already-confirmed fact (its known Graphiti edge
// uuid) to the PR, commit, or file it was recorded from, so it can be flagged
// when that source moves. Staleness surfacing itself lives in
// services/memory/fact-provenance.ts; this tool only records the link.
//
// The link's source reference is text every reader of its scope is shown when the source
// moves (the task-start block's stale flags), so recording one is a write under the
// derived-write rule (mcp/derived-write.ts): an agent id that was ever shown a scope outside the
// link's scope cannot record it there. A link cannot declare a share, so that write is refused.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AccessDeniedError, check, resolveCallerScopePath } from "@/services/access";
import { recordFactProvenance } from "@/services/memory/fact-provenance";
import { authorizeUndeclaredWrite } from "../derived-write";
import { toolError, type ToolContext } from "./tool-context";

export function registerFactLinkSource(server: McpServer, { ctx, cap, notifying }: ToolContext): void {
  server.registerTool(
    "fact_link_source",
    {
      title: "Link a fact to its source",
      description:
        "Record that a stored fact/decision came from a specific PR, commit, or file, so it can later be flagged if that source changes. Refused with derived_write: when this agent id has ever read a scope outside the link's scope (the record never expires, and a link cannot declare a share), since the link is shown to that scope's readers. Requires a capability token with memory.write permission.",
      inputSchema: {
        // .trim() before .min(1)/.optional(): the REST staleness endpoint always
        // trims the reported sourceRef before its
        // exact-equality match, so an MCP-recorded link stored with padding
        // ("  path/to/file  ") could never be found again through that path.
        // Trimming here, not in recordFactProvenance, keeps normalization at the
        // input boundary — the REST route already trims its own body fields the
        // same way before they reach the service.
        graphitiFactUuid: z
          .string()
          .trim()
          .min(1)
          .describe(
            "Known uuid of the fact this link is attached to. memory_query and memory_entity currently return text, not fact UUIDs.",
          ),
        sourceType: z.enum(["pr", "commit", "file"]).describe("What kind of source this is."),
        sourceRef: z
          .string()
          .trim()
          .min(1)
          .describe("The source identifier, e.g. a PR URL, 'owner/repo@sha', or a repo-relative file path."),
        recordedRevision: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Commit or PR head sha at the time this fact was recorded, if known."),
        scopePath: z.string().optional().describe("ltree scope to record into. Defaults to your token's scope."),
      },
    },
    notifying(async ({ graphitiFactUuid, sourceType, sourceRef, recordedRevision, scopePath }) => {
      try {
        // Same write-side scope guard as memory_ingest: a caller-supplied
        // scopePath that fails validation is refused, not silently widened.
        const target = await resolveCallerScopePath(ctx, scopePath, cap, {
          onInvalid: "refuse",
          action: "memory.write",
        });
        await authorizeUndeclaredWrite(ctx, cap, target, "source link");
        const decision = await check(ctx, {
          action: "memory.write",
          scope: target,
          target: `fact:${graphitiFactUuid}`,
        });
        if (!decision.allowed) {
          throw new AccessDeniedError(decision);
        }
        // The uuid is a tool argument, so recordFactProvenance resolves it
        // against `target` through the memory service before writing;
        // toolError below reports an unresolved one without saying whether it
        // exists somewhere this token cannot read.
        await recordFactProvenance(ctx, {
          orgId: ctx.orgId,
          scopePath: target,
          graphitiFactUuid,
          sourceType,
          sourceRef,
          recordedRevision,
          ownerId: cap.agentId,
        });
        return {
          content: [{ type: "text" as const, text: "Linked. This fact will be flagged if that source moves." }],
        };
      } catch (e) {
        return toolError(e);
      }
    }),
  );
}
