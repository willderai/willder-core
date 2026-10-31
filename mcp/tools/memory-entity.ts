// memory_entity: fetch one entity and its known facts by id. Same read-side
// scope default as memory_query — the token's own scope bounds the lookup.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveCallerScopePath } from "@/services/access";
import { guardedMemory } from "@/services/memory";
import { IF_REVISION_DESCRIPTION, IF_REVISION_MAX_LENGTH, withRevisionReceipt } from "../revision-receipt";
import { recordServedFacts, recordServedScopes, toolError, type ToolContext } from "./tool-context";
import { servedDays } from "../fact-citation";

export function registerMemoryEntity(server: McpServer, { ctx, cap, notifyingRead: notifying }: ToolContext): void {
  server.registerTool(
    "memory_entity",
    {
      title: "What we know about an entity",
      description:
        "Fetch a single entity (person, company, or deal) and its known facts by id. Ends with a revision; send it back as ifRevision to skip an answer you already hold. Access-scoped and audited.",
      inputSchema: {
        entityId: z.string().describe("The entity's id (uuid)"),
        scopePath: z.string().optional().describe("ltree scope to look within. Defaults to your token's scope."),
        ifRevision: z.string().max(IF_REVISION_MAX_LENGTH).optional().describe(IF_REVISION_DESCRIPTION),
      },
    },
    notifying(async ({ entityId, scopePath, ifRevision }) => {
      try {
        // Same read-side scope default as memory_query.
        const target = await resolveCallerScopePath(ctx, scopePath, cap, { onInvalid: "fallback" });
        const entity = await guardedMemory.entity(ctx, { groupId: ctx.orgId, entityId }, target);
        // "Not found" is not given a revision: it is also what a hidden entity reads
        // as, and a receipt adds nothing to a four-word answer.
        if (!entity) return { content: [{ type: "text" as const, text: "Entity not found." }] };
        // Each fact ends with the day it is dated by, as memory_query dates it (mcp/fact-citation.ts),
        // so an earlier statement on the entity is told from a later one.
        const days = await servedDays(ctx.orgId, entity.facts ?? []);
        const facts =
          (entity.facts ?? []).map((f, i) => `• ${f.fact}${days[i] ? ` (as of ${days[i]})` : ""}`).join("\n") ||
          "(no facts)";
        // These facts' text is a read like memory_query's: record the versions behind
        // them so this agent's next write about them is checked against what it saw.
        await recordServedFacts(cap, entity.facts ?? [], target);
        // The summary is the graph's own text about the entity, with no stored version
        // behind it: the scope it was read under stands for it (derived-write rule).
        if (entity.summary) await recordServedScopes(cap, [target]);
        const summary = entity.summary ? `${entity.summary}\n` : "";
        // On a tier that does not read the graph, the entity is matched by name in the
        // stored facts, and the answer says so rather than passing for the graph's entity.
        const matched =
          entity.matchedBy === "raw-name"
            ? "Matched by name in stored memory (the knowledge graph is not read on this plan).\n"
            : "";
        return withRevisionReceipt("memory_entity", { orgId: ctx.orgId, target, entityId }, ifRevision, {
          content: [{ type: "text" as const, text: `${entity.name} (${entity.type})\n${matched}${summary}${facts}` }],
        });
      } catch (e) {
        return toolError(e);
      }
    }),
  );
}
