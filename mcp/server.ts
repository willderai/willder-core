// Willder MCP server over stdio, for local development against your own database.
// Hosted clients connect to app/api/mcp/route.ts instead; both register the same
// tools, resources and prompts (mcp/tools.ts, mcp/resources.ts, mcp/prompts.ts), so the
// two transports cannot drift on behavior.
//
// The one rule: before the first call it checks the required environment
// (lib/required-env.ts) and the database (lib/db-startup.ts), so a missing variable,
// a stopped Postgres or an unmigrated database stops it with one line naming the fix.
// stdout carries only MCP protocol messages; every log line goes to stderr.
//
// Run: WILLDER_CAPABILITY_TOKEN=wcap_... npm run --silent mcp
// Connect a client: docs/development.md, Ten-minute path, step 5.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { assertDatabaseReachable } from "@/lib/db-startup";
import { STDIO_MCP_ENV, assertRequiredEnv } from "@/lib/required-env";
import { resolveCapability, type AccessContext } from "@/services/access";
import { registerWillderTools } from "./tools";
import { createWillderServer } from "./willder-server";
import { connectionSessionKeyOf, newMcpSessionId } from "./connection-session";
import { registerWillderResources } from "./resources";
import { registerWillderPrompts } from "./prompts";

async function main() {
  assertRequiredEnv(STDIO_MCP_ENV);
  const token = process.env.WILLDER_CAPABILITY_TOKEN?.trim() ?? "";

  // Before the first Prisma call: a missing or stopped database fails here with
  // one line naming the fix, not with a Prisma invocation stack.
  await assertDatabaseReachable();

  const cap = await resolveCapability(token, "mcp");
  if (!cap) {
    console.error(
      "willder MCP server failed: WILLDER_CAPABILITY_TOKEN is not a live token in this database (unknown, expired or revoked). Mint a fresh one with: npm run selfhost:token (a self-hosted install, docs/self-host.md) or bash scripts/run-check.sh scripts/dev-token.ts (development).",
    );
    process.exit(1);
  }

  const ctx: AccessContext = {
    orgId: cap.orgId,
    actor: { type: "agent", id: cap.agentId, capabilityToken: token },
    origin: "mcp",
  };

  const server = createWillderServer();
  // A stdio server serves the one client that started it, so the process is one
  // connection, and one session for the task-start block (mcp/connection-session.ts).
  registerWillderTools(server, ctx, cap, { session: connectionSessionKeyOf(newMcpSessionId()) });
  registerWillderResources(server, ctx, cap);
  registerWillderPrompts(server, ctx, cap);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`willder MCP server running (stdio) as agent ${cap.agentId}; tools/list names the tools.`);
}

main().catch((e) => {
  console.error("willder MCP server failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
