// Willder's MCP resources: what a client can open without a tool call, from an attach menu or
// an @-mention.
//
// - `willder://brief`, listed: the newest brief generated for the token's own scope, the
//   document get_my_brief returns when it is given no id.
// - `willder://version/{versionId}`, a template: one stored version of a fact or rule, by the id
//   a change notice or a cited fact names, as memory_version returns it.
//
// The one rule: a resource is read through the same access decision as the tool it mirrors,
// and recorded as served the same way, so opening one can never show more than the tool would.
// A version the token may not read, or one that reads as erased, is answered exactly like one
// that does not exist. Nothing stored is enumerated: resources/list names the brief alone,
// which every connection is listed, so the list says nothing about what a scope holds.
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { AccessContext } from "@/services/access";
import { latestBriefAtScope } from "@/services/memory/briefs";
import { readMemoryVersion } from "@/services/memory/versions";
import { derivedMarkersFor } from "./derived-write";
import { formatBrief, recordBriefRead } from "./tools/get-my-brief";
import { describeVersion } from "./tools/memory-version";
import { recordServedVersions, type ResolvedCapability } from "./tools/tool-context";

/** The URI of the token's own brief. */
export const BRIEF_RESOURCE_URI = "willder://brief";

/** The URI template a stored version is read at. */
export const VERSION_RESOURCE_TEMPLATE = "willder://version/{versionId}";

/** Register Willder's resources onto `server`, read as `ctx`/`cap`. */
export function registerWillderResources(server: McpServer, ctx: AccessContext, cap: ResolvedCapability): void {
  server.registerResource(
    "brief",
    BRIEF_RESOURCE_URI,
    {
      title: "My brief",
      description:
        "The newest brief generated for your token's scope (Handoff, Architecture or QA agent output), as get_my_brief returns it. Access-scoped and audited.",
      mimeType: "text/markdown",
    },
    async (uri) => {
      const { decision, brief } = await latestBriefAtScope(ctx, cap.scopePath);
      if (!decision.allowed) throw new McpError(ErrorCode.InvalidRequest, `Access denied: ${decision.reason}`);
      if (!brief)
        return { contents: [{ uri: uri.href, mimeType: "text/plain", text: "No brief found for this scope." }] };
      await recordBriefRead(cap, brief.scopePath);
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: formatBrief(brief) }] };
    },
  );

  server.registerResource(
    "memory-version",
    new ResourceTemplate(VERSION_RESOURCE_TEMPLATE, { list: undefined }),
    {
      title: "A stored version of a fact or rule",
      description:
        "One stored version of a fact or a rule, by the id a change notice or a cited fact gives, as memory_version returns it. Says whether it is current, superseded or retired. Access-scoped and audited.",
      mimeType: "text/plain",
    },
    async (uri, { versionId }) => {
      // Ids are cuids, which need no percent-encoding; anything else simply names no version.
      const version = typeof versionId === "string" ? await readMemoryVersion(ctx, versionId) : null;
      // An unknown resource is Invalid Params with the uri in `data` (SEP-2164). A version the
      // token may not read takes this same path, so the two cannot be told apart.
      if (!version) throw new McpError(ErrorCode.InvalidParams, "Resource not found", { uri: uri.href });
      if (version.kind === "fact") await recordServedVersions(cap, [version.id]);
      const shared = (await derivedMarkersFor(ctx, [version.id])).get(version.id);
      return { contents: [{ uri: uri.href, mimeType: "text/plain", text: describeVersion(version, shared) }] };
    },
  );
}
