// Hosted MCP endpoint — live check. Run with: npm run mcp:check
//
// Drives the REAL app/api/mcp/route.ts through the plain
// @modelcontextprotocol/sdk client (the same client class a generic/
// non-Claude MCP host would use — no Claude-specific assumptions anywhere in
// this file) over a real HTTP socket, against a throwaway org on Neon:
// initialize -> tools/list -> memory_query -> memory_ingest with a read-only
// token (must be denied + audited) -> memory_ingest with a write token (must
// succeed + audit + actually queue the real ingest pipeline). Exercises the
// exact security-model claims mcp/README.md documents ("A read-only token
// cannot call memory_ingest; the call is denied and audited").
//
// Needs the same local stack as memory:check/campaigns:check (real
// DATABASE_URL; a running memory-service for memory_query to return real
// facts instead of erroring) — offline-friendly in the same sense those are:
// no external LLM/opt-in providers, but not usable with zero services up.
// If memory-service isn't reachable, memory_query's underlying store call
// will fail — that failure is logged and does NOT fail this check, since
// what this check exists to prove is the MCP protocol/auth/audit contract,
// not memory-service connectivity (that's memory:check's job). The
// default-deny assertions (the actual ask this check was written for) never
// depend on the store and always run for real.
//
// Complements app/api/mcp/route.test.ts, which drives the identical protocol
// flow offline (DB + store mocked) so it runs in every CI build with no
// secrets; this script is the live counterpart against real Neon, same
// convention as scripts/check-access.ts / scripts/check-capabilities.ts.
// The ingest tool queues onto Inngest (services/agents ingestMemory) and returns
// as soon as the event is accepted; the real store write happens later, in the
// Inngest worker. This script has no worker draining that queue (it's a bare
// script, not the Next dev server + inngest-cli), so without this bypass the
// write would never happen no matter how long we waited for it — set BEFORE any
// other import so it's in place the moment mcp/tools.ts eventually calls
// ingestMemory(). Local to this script's process only; does not change
// mcp/tools.ts, route.ts, or prod behavior.
process.env.INNGEST_BYPASS = "1";

import { db } from "@/lib/db";
import { generateCapabilityToken, orgRootPath } from "@/services/access";
import { startMcpTestServer } from "@/mcp/http-test-server";
import { memory } from "@/services/memory";
import type { MemoryGraph } from "@/types/memory";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("FAILED: " + msg);
  console.log("  ✓ " + msg);
}

async function connectClient(url: string, token: string): Promise<InstanceType<typeof Client>> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "generic-mcp-check", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

// ── Memory-graph cleanup helpers ──────────────────────────────────────────────
// memory_ingest writes into Neo4j (Graphiti) via `scopePath`, not through Postgres
// — org.delete()'s cascade only reaches Postgres tables (scope/capabilities/
// audit_log/memory_chunks). Without this, a __mcp_check__ fact/entity drips into
// the real graph on every run and is never cleaned up.

async function readGraph(groupId: string): Promise<MemoryGraph> {
  try {
    return await memory.graph({ groupId, limit: 200 });
  } catch (e) {
    console.warn("  (graph read failed:", e instanceof Error ? e.message : e, ")");
    return { nodes: [], edges: [] };
  }
}

function graphEmpty(g: MemoryGraph): boolean {
  return g.nodes.length === 0 && g.edges.length === 0;
}

// Poll instead of trusting a single read: even with the Inngest bypass forcing
// the write to be awaited before memory_ingest's tool call resolves, Neo4j may
// not reflect it on the very next read.
async function waitUntilGraphNonEmpty(groupId: string, timeoutMs = 8000, intervalMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!graphEmpty(await readGraph(groupId))) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function cleanupMemoryGraph(groupId: string): Promise<void> {
  const g = await readGraph(groupId);
  for (const edge of g.edges) {
    await memory
      .removeFact({ groupId, factId: edge.uuid })
      .catch((e) =>
        console.error(`  cleanup: failed to remove fact ${edge.uuid}:`, e instanceof Error ? e.message : e),
      );
  }
  for (const node of g.nodes) {
    await memory
      .removeEntity({ groupId, entityId: node.uuid })
      .catch((e) =>
        console.error(`  cleanup: failed to remove entity ${node.uuid}:`, e instanceof Error ? e.message : e),
      );
  }
  if (g.nodes.length || g.edges.length) {
    console.log(`  cleaned up ${g.nodes.length} entity node(s) + ${g.edges.length} fact edge(s) from the memory graph`);
  }
}

async function main() {
  console.log("Checking the hosted MCP endpoint (app/api/mcp/route.ts) via a plain MCP-SDK client...\n");

  // `org` and `server` are tracked as optional and the whole setup below runs
  // INSIDE this try, not before it — a failure creating the scope/capabilities
  // or starting the server used to strand a real __mcp_check__ org (+ its
  // Postgres rows) in Neon, since the only cleanup lived in a finally that
  // never got entered. Now any failure at any point still reaches the finally
  // below, which cleans up whatever actually got created.
  let org: Awaited<ReturnType<typeof db.org.create>> | undefined;
  let server: Awaited<ReturnType<typeof startMcpTestServer>> | undefined;

  try {
    org = await db.org.create({ data: { name: "__mcp_check__" } });
    const scopePath = orgRootPath(org.id);
    await db.scope.create({ data: { orgId: org.id, path: scopePath, name: "Organization" } });
    assert(graphEmpty(await readGraph(scopePath)), "memory graph starts empty for this fresh org (t0 control)");

    const readToken = generateCapabilityToken();
    const writeToken = generateCapabilityToken();
    const expiresAt = new Date(Date.now() + 3600_000);
    const { hashCapabilityToken } = await import("@/services/access/capabilities");
    await db.capability.create({
      data: {
        orgId: org.id,
        agentId: "check-mcp-reader",
        tokenHash: hashCapabilityToken(readToken),
        scopePath,
        permission: "read",
        expiresAt,
      },
    });
    await db.capability.create({
      data: {
        orgId: org.id,
        agentId: "check-mcp-writer",
        tokenHash: hashCapabilityToken(writeToken),
        scopePath,
        permission: "write",
        expiresAt,
      },
    });

    server = await startMcpTestServer();

    // ── initialize -> tools/list ─────────────────────────────────────────────
    console.log("Protocol handshake...");
    const listClient = await connectClient(server.url, readToken);
    const { tools } = await listClient.listTools();
    const names = new Set(tools.map((t) => t.name));
    for (const expected of ["memory_query", "memory_entity", "memory_ingest"]) {
      assert(names.has(expected), `tools/list includes ${expected}`);
    }
    await listClient.close();

    // ── memory_query (read token) ────────────────────────────────────────────
    console.log("\nmemory_query with a read-scoped token...");
    const readerBefore = await db.auditLog.count({
      where: { orgId: org.id, action: "memory.read", decision: "allow" },
    });
    const reader = await connectClient(server.url, readToken);
    try {
      const result = await reader.callTool({
        name: "memory_query",
        arguments: { query: "what do we know about Acme?" },
      });
      if (result.isError) {
        console.log(
          "  (memory_query returned an error — likely memory-service isn't running locally; not failing this check on that, see header)",
        );
      } else {
        assert(true, "memory_query returned a result (not an MCP-level error)");
      }
    } finally {
      await reader.close();
    }
    const readerAfter = await db.auditLog.count({ where: { orgId: org.id, action: "memory.read", decision: "allow" } });
    assert(readerAfter > readerBefore, "memory_query wrote an allow audit row for the read-scoped token");

    // ── memory_ingest with a READ-ONLY token: must be denied + audited ──────
    console.log("\nmemory_ingest with a READ-ONLY token (default-deny)...");
    const denyBefore = await db.auditLog.count({ where: { orgId: org.id, action: "memory.write", decision: "deny" } });
    const readerAgain = await connectClient(server.url, readToken);
    try {
      const result = await readerAgain.callTool({
        name: "memory_ingest",
        arguments: { content: "Acme is opening a new Austin office", name: "Acme Corp" },
      });
      assert(result.isError === true, "memory_ingest with a read-only token returns isError");
      assert(/access denied/i.test(JSON.stringify(result.content)), "error text says Access denied");
    } finally {
      await readerAgain.close();
    }
    const denyAfter = await db.auditLog.count({ where: { orgId: org.id, action: "memory.write", decision: "deny" } });
    assert(
      denyAfter > denyBefore,
      "denied memory_ingest wrote a deny audit row (read-only token cannot call memory_ingest, denied+audited)",
    );

    // ── memory_ingest with a WRITE token: must succeed + audit ──────────────
    console.log("\nmemory_ingest with a write-scoped token...");
    const allowBefore = await db.auditLog.count({
      where: { orgId: org.id, action: "memory.write", decision: "allow" },
    });
    const writer = await connectClient(server.url, writeToken);
    try {
      const result = await writer.callTool({
        name: "memory_ingest",
        arguments: { content: "Acme is opening a new Austin office", name: "Acme Corp" },
      });
      assert(result.isError !== true, "memory_ingest with a write token succeeds");
    } finally {
      await writer.close();
    }
    const allowAfter = await db.auditLog.count({ where: { orgId: org.id, action: "memory.write", decision: "allow" } });
    assert(allowAfter > allowBefore, "allowed memory_ingest wrote an allow audit row");

    console.log("\nConfirming the ingested fact actually lands in the memory graph (not just accepted)...");
    const landed = await waitUntilGraphNonEmpty(scopePath);
    assert(landed, "memory_ingest with a write token is retrievable from the real memory graph, not just queued");

    // ── No bearer token / unknown token: 401 before any tool runs ───────────
    console.log("\nAuth edge cases...");
    const noAuth = await fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "no-auth", version: "0" } },
      }),
    });
    assert(noAuth.status === 401, "missing bearer token → 401");
    const badAuth = await fetch(server.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer wcap_totally_unknown",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bad-token", version: "0" } },
      }),
    });
    assert(badAuth.status === 401, "unknown bearer token → 401");

    console.log("\nHosted MCP endpoint healthy (protocol-generic client, default-deny + audit verified).");
  } finally {
    // Nested so a server.close() failure can't skip org cleanup: each step below
    // is caught on its own and cleanup keeps going regardless of what already
    // failed. Order matters — the memory graph is read/cleaned by scopePath
    // (derived from org.id), so it has to happen before the org row is gone,
    // but it does NOT depend on the test server still being up.
    if (server) {
      try {
        await server.close();
      } catch (e) {
        console.error("  server.close() failed (continuing to org cleanup):", e instanceof Error ? e.message : e);
      }
    }
    if (org) {
      try {
        await cleanupMemoryGraph(orgRootPath(org.id));
      } catch (e) {
        console.error("  memory graph cleanup failed:", e instanceof Error ? e.message : e);
      }
      // cascade removes scope/capabilities/audit_log/memory_chunks rows (all
      // Postgres); the Neo4j graph write is cleaned up above since it lives
      // outside Postgres and isn't touched by this cascade.
      await db.org.delete({ where: { id: org.id } });
    }
  }
}

main()
  .catch((e) => {
    console.error("MCP check FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
