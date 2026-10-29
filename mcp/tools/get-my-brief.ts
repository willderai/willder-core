// get_my_brief: fetch a generated brief (Handoff/Architecture/QA agent output).
// The one rule: a brief fetched by id is authorized against the brief's OWN
// scope, not the caller's, so the audit row names the scope the content came
// from — and the not-found path is gated too, so a dead token cannot use
// hit/miss as an unaudited existence oracle.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AccessDeniedError, can, isValidLtreePath, orgRootPath, resolveCallerScopePath } from "@/services/access";
import { authorizeBrief, latestBriefAtScope } from "@/services/memory/briefs";
import { recordServedScopes, toolError, type ToolContext, type ResolvedCapability } from "./tool-context";

/** Render a stored brief as the plain-text document the agent reads; also the text of the
 * `willder://brief` resource (mcp/resources.ts). */
export function formatBrief(brief: {
  id: string;
  title: string;
  summary: string;
  sections: unknown;
  granteeName: string | null;
  scopePath: string;
  scopeLabel: string | null;
  googleDocUrl: string | null;
  createdAt: Date;
}): string {
  const sections = Array.isArray(brief.sections)
    ? (brief.sections as { heading: string; content: string }[])
        .map((s) => `## ${s.heading}\n${s.content}`)
        .join("\n\n")
    : "";
  const header = [
    `# ${brief.title}`,
    brief.granteeName ? `For: ${brief.granteeName}` : null,
    // scopeLabel carries the human-readable target for a scope-less QA run;
    // scopePath itself is always the real authorization scope.
    `Scope: ${brief.scopeLabel ?? brief.scopePath}`,
    brief.googleDocUrl ? `Google Doc: ${brief.googleDocUrl}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return `${header}\n\n${brief.summary}\n\n${sections}`;
}

export function registerGetMyBrief(server: McpServer, { ctx, cap, notifyingRead: notifying }: ToolContext): void {
  server.registerTool(
    "get_my_brief",
    {
      title: "Get my brief",
      description:
        "Fetch a generated brief (Handoff/Architecture/QA agent output) for this org. Defaults to the most recent brief within your token's own scope if no id is given.",
      inputSchema: {
        briefId: z
          .string()
          .optional()
          .describe("A specific brief id. If omitted, returns the most recent brief for your scope."),
        scopePath: z
          .string()
          .optional()
          .describe("Filter to briefs generated for this scope. Defaults to your token's scope."),
      },
    },
    notifying(async ({ briefId, scopePath }) => {
      try {
        if (briefId) {
          // The briefId lookup has no scope predicate of its own ({ id, orgId }
          // only), so it can't be gated by the caller-supplied scopePath (or
          // cap.scopePath default) the way the branch below is — that would
          // just re-authorize the caller against itself and say nothing about
          // this specific row. authorizeBrief() decides against the brief's OWN
          // scopePath — the scope its content actually belongs to — so the
          // audit row targets the scope the content really came from, not
          // whatever scope the caller happened to pass. A stored scopePath
          // that is not a valid path is decided at the org root rather than
          // crashing check()'s ltree cast.
          //
          // A miss is decided too, at the token's own scope: otherwise a
          // revoked or expired token naming a nonexistent id walks past the
          // gate and leaves no audit row, which also makes the hit/miss pair an
          // unaudited existence oracle. There is no row to check against, so
          // this only has to catch a dead token, not authorize a brief.
          const ownScope = cap.scopePath ?? orgRootPath(ctx.orgId);
          const access = await authorizeBrief(ctx, briefId, { action: "memory.read", absentScope: ownScope });

          // A brief the token may not read answers exactly like an absent id,
          // in the same text: an "access denied" for one and "not found" for
          // the other told a caller which ids are real. Only a token that
          // cannot read its own scope (revoked or expired) is refused outright,
          // for a hit and a miss alike. The probe runs for both, so neither
          // answer costs less work than the other.
          if (access.status !== "allowed") {
            const live = await can(ctx, { action: "memory.read", scope: ownScope });
            if (!live.allowed) throw new AccessDeniedError(live);
            return { content: [{ type: "text" as const, text: `Brief ${briefId} not found.` }] };
          }

          await recordBriefRead(cap, access.brief.scopePath);
          return { content: [{ type: "text" as const, text: formatBrief(access.brief) }] };
        }

        // latestBriefAtScope() runs check() before it touches the table — a
        // revoked or expired capability token must not read a brief through a
        // lookup filtered on orgId alone. Read scope, same check()/AccessDeniedError
        // pattern as memory_ingest. The caller-supplied scopePath is
        // resolved the same read-side way as memory_query/memory_entity.
        const target = await resolveCallerScopePath(ctx, scopePath, cap, { onInvalid: "fallback" });
        const { decision, brief } = await latestBriefAtScope(ctx, target);
        if (!decision.allowed) {
          throw new AccessDeniedError(decision);
        }
        if (!brief) return { content: [{ type: "text" as const, text: "No brief found for this scope." }] };
        await recordBriefRead(cap, brief.scopePath);
        return { content: [{ type: "text" as const, text: formatBrief(brief) }] };
      } catch (e) {
        return toolError(e);
      }
    }),
  );
}

/**
 * Record a served brief for the derived-write rule: its text is drawn from its own scope.
 * A stored scope that is not a valid path is decided at the org root, so it counts as that.
 */
export async function recordBriefRead(cap: ResolvedCapability, scopePath: string): Promise<void> {
  await recordServedScopes(cap, [isValidLtreePath(scopePath) ? scopePath : orgRootPath(cap.orgId)]);
}
