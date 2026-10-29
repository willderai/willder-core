// Shared Willder MCP tool implementations. Registered onto an McpServer by both
// the local stdio process (mcp/server.ts) and the hosted HTTP endpoint
// (app/api/mcp/route.ts) so the two transports can never drift on behavior —
// same tools, same check() gate, same audit trail, same error shapes.
//
// Every tool here is gated by the caller-supplied AccessContext + resolved
// capability (org/agent identity + default scopePath). Callers MUST resolve
// the capability token themselves (see services/access.resolveCapability) and
// build the AccessContext BEFORE calling registerWillderTools — this module
// trusts whatever ctx/cap it's given and does no token parsing of its own.
//
// Each tool's schema, description and handler lives in its own file under
// mcp/tools/; this file is the list of them and nothing else.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AccessContext } from "@/services/access";
import {
  createToolContext,
  type ConnectionOptions,
  type ResolvedCapability,
  type ToolContext,
} from "./tools/tool-context";
import { registerMemoryQuery } from "./tools/memory-query";
import { registerMemoryEntity } from "./tools/memory-entity";
import { registerMemoryIngest } from "./tools/memory-ingest";
import { registerMemoryVersion } from "./tools/memory-version";
import { registerFactLinkSource } from "./tools/fact-link-source";
import { registerGetMyBrief } from "./tools/get-my-brief";
import { registerMemoryChanges } from "./tools/memory-changes";
import { registerMemoryStale } from "./tools/memory-stale";
import { registerMemoryNote } from "./tools/memory-note";
import { registerContactSearch, registerContactRead, registerContactUpsert } from "./tools/contacts";
import { registerSendFeedback } from "./tools/send-feedback";
import { listsTool } from "./tool-set";

export type { ConnectionOptions, ResolvedCapability };

/** Every Willder MCP tool by name, in the order they are registered. Adding a tool
 * means adding its file and one line here. */
const TOOL_REGISTRARS: Record<string, (server: McpServer, tools: ToolContext) => void> = {
  memory_query: registerMemoryQuery,
  memory_entity: registerMemoryEntity,
  memory_version: registerMemoryVersion,
  memory_ingest: registerMemoryIngest,
  fact_link_source: registerFactLinkSource,
  get_my_brief: registerGetMyBrief,
  memory_stale: registerMemoryStale,
  memory_changes: registerMemoryChanges,
  memory_note: registerMemoryNote,
  contact_search: registerContactSearch,
  contact_read: registerContactRead,
  contact_upsert: registerContactUpsert,
  send_feedback: registerSendFeedback,
};

/** Every Willder MCP tool's name, listed or not, so a transport can tell an unlisted tool from an unknown one. */
export const WILLDER_TOOL_NAMES: readonly string[] = Object.keys(TOOL_REGISTRARS);

/**
 * Register every Willder MCP tool (memory_query, memory_entity, memory_version,
 * memory_ingest, fact_link_source, get_my_brief, memory_stale, memory_changes, memory_note, contact_search,
 * contact_read, contact_upsert, send_feedback) onto `server`, scoped to `ctx`/`cap`. Safe to call once per
 * request (hosted, stateless) or once per process (stdio, long-lived) — holds
 * no module-level state itself.
 *
 * By default, every memory tool except memory_changes appends what changed in the token's
 * scope since the agent's last call (mcp/change-notices.ts). memory_changes is
 * left without change notices because it is that same feed, read on request.
 * Every memory tool, memory_changes included, carries the task-start block on
 * the first call of a session (mcp/task-start-notice.ts). send_feedback is not
 * a memory tool and carries neither. Read tools can opt into compact supplementary
 * context (mcp/context-policy.ts); writes retain these notices. `connection` carries the task the
 * connection names and the connection's session (mcp/connection-session.ts), if
 * any, and hears how long each call's block took, for a transport that reports
 * it (app/api/mcp/route.ts). `connection.tools` names the tool set (mcp/tool-set.ts):
 * a coding connection registers only the coding tools, so only they are listed.
 */
export function registerWillderTools(
  server: McpServer,
  ctx: AccessContext,
  cap: ResolvedCapability,
  connection: ConnectionOptions = {},
): void {
  const tools = createToolContext(ctx, cap, connection);
  const toolSet = connection.tools ?? "all";
  // A stateless request that calls one listed tool needs only that tool: registering the
  // rest builds their schemas and closures on every call for nothing, and that CPU is paid by
  // every request sharing the instance under concurrent load. Any other request,
  // and a name this connection does not list, registers every listed tool as before.
  const only =
    connection.calls !== undefined &&
    Object.hasOwn(TOOL_REGISTRARS, connection.calls) &&
    listsTool(toolSet, connection.calls)
      ? connection.calls
      : null;
  for (const [name, register] of Object.entries(TOOL_REGISTRARS)) {
    if (only === null ? listsTool(toolSet, name) : name === only) register(server, tools);
  }
}
