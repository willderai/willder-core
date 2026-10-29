// Drives the REAL hosted MCP endpoint (./route.ts) through the plain
// @modelcontextprotocol/sdk client — the same client class any non-Claude MCP
// host (a custom agent, a script, in principle ChatGPT's connector once it
// speaks Streamable HTTP) would use, with zero Claude-specific assumptions.
// Offline: only @/lib/db, the memory store singleton, and the Inngest ingest
// call are mocked (same boundary services/access/check.test.ts already uses
// for check() itself) — resolveCapability(), check(), and every real MCP
// tool in mcp/tools.ts run for real over a real HTTP socket. This is the
// fast, CI-safe complement to scripts/check-mcp.ts, which runs the same
// protocol flow against a real Neon DB (see that file's header).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The derived-write rule is tested on Postgres (mcp/derived-write.realdb.test.ts); off here.
// Graph facts here are stand-ins with no stored rows behind them, so the serve-time source
// check (services/memory/graph-fact-sources.ts) supports them; it is proven against real rows
// in services/memory/graph-fact-sources.realdb.test.ts.
vi.mock("@/services/memory/graph-fact-sources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory/graph-fact-sources")>()),
  loadGraphSources: async () => ({ supports: () => true }),
}));
vi.mock("@/services/access/derived-writes", () => import("@/services/access/derived-writes.testsupport"));
vi.mock("@/lib/db", () => ({
  db: {
    // guardedMemory reads the org's account tier after check() allows a read; no tier recorded means the default.
    org: { findUnique: async () => ({ settings: {} }) },
    capability: { findUnique: vi.fn() },
    // memory_ingest resolves the calling agent's display name, and resolveCapability asks whether the
    // token's agent is deactivated; no agent row means the fallback label and an active agent.
    agent: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
    $queryRaw: vi.fn(),
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit_test" }), update: vi.fn() },
  },
}));

// Only the raw store I/O (Graphiti/pgvector) is mocked — GuardedMemoryStore,
// check(), and the audit trail above it are all real.
vi.mock("@/services/memory/store", () => ({
  memory: {
    retrieve: vi.fn().mockResolvedValue({
      facts: [{ uuid: "fact_1", fact: "Acme is opening a new Austin office", validAt: null }],
    }),
    entity: vi.fn(),
    ingest: vi.fn(),
    graph: vi.fn(),
    removeFact: vi.fn(),
    removeEntity: vi.fn(),
    transferEntity: vi.fn(),
  },
  graphitiStore: {},
}));

// memory_ingest's queue hop (Inngest event or the INNGEST_BYPASS local path) is
// infra, not MCP/access-control behavior — mocked the same way a route test
// would mock any outbound side effect.
vi.mock("@/lib/inngest", () => ({
  ingestMemory: vi.fn().mockResolvedValue(undefined),
}));

import { db } from "@/lib/db";
import { ingestMemory } from "@/lib/inngest";
import { generateCapabilityToken, hashCapabilityToken, orgRootPath } from "@/services/access";
import { startMcpTestServer, type McpTestServer } from "@/mcp/http-test-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const ORG_ID = "org_mcp_route_test";
const SCOPE_PATH = orgRootPath(ORG_ID);

// Two capability tokens, exactly like a real customer would issue via
// POST /api/access/capabilities: one read-only, one read+write.
const readToken = generateCapabilityToken();
const writeToken = generateCapabilityToken();
const readHash = hashCapabilityToken(readToken);
const writeHash = hashCapabilityToken(writeToken);

// resolveCapability() — identity lookup AND the token's lifecycle gate at
// session establishment (mcp-session-expiry-gate-gap-20260918). Both rows below
// carry REAL lifecycle values — never revoked, expiry genuinely in the future —
// because that is what a live customer token looks like and it is the only
// thing that pins the door OPEN for a valid token.
//
// This matters more than it looks. Before this, every fixture in the repo that
// mocked db.capability.findUnique simply omitted revokedAt/expiresAt, so the
// door's comparison ran against `undefined` and was never really evaluated. A
// door that rejected any token carrying an expiry at all (`row.expiresAt`
// instead of `row.expiresAt <= new Date()`) kept the entire 149-file suite
// green — while denying every capability token in production, since
// Capability.expiresAt is NOT NULL in prisma/schema.prisma. Verified by
// differential, not reasoned: see qa/item-mcp-session-expiry-door-coverage.
vi.mocked(db.capability.findUnique).mockImplementation(((args: unknown) => {
  const hash = (args as { where: { tokenHash: string } }).where.tokenHash;
  const live = { revokedAt: null, expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000) };
  if (hash === readHash)
    return Promise.resolve({ orgId: ORG_ID, agentId: "agent-read", scopePath: SCOPE_PATH, ...live });
  if (hash === writeHash)
    return Promise.resolve({ orgId: ORG_ID, agentId: "agent-write", scopePath: SCOPE_PATH, ...live });
  return Promise.resolve(null);
}) as never);

// check()'s real enforcement query — permission ranking per token.
vi.mocked(db.$queryRaw).mockImplementation(((_strings: unknown, ...values: unknown[]) => {
  const hash = values[1];
  if (hash === readHash) return Promise.resolve([{ permission: "read", createdBy: null, agentId: "agent-read" }]);
  if (hash === writeHash) return Promise.resolve([{ permission: "write", createdBy: null, agentId: "agent-write" }]);
  return Promise.resolve([]);
}) as never);

let server: McpTestServer;

beforeAll(async () => {
  server = await startMcpTestServer();
});

afterAll(async () => {
  await server.close();
});

async function connectClient(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "generic-mcp-check", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

function auditCalls(decision: "allow" | "deny", action: string) {
  return vi
    .mocked(db.auditLog.create)
    .mock.calls.filter(([arg]) => {
      const data = (arg as { data: { decision: string; action: string; actorId: string } }).data;
      return data.decision === decision && data.action === action;
    })
    .map(([arg]) => (arg as { data: { actorId: string } }).data);
}

describe("hosted MCP endpoint (app/api/mcp/route.ts) via a plain MCP-SDK client", () => {
  it("initialize -> tools/list exposes the documented tool set", async () => {
    const client = await connectClient(readToken);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(
        [
          "contact_read",
          "contact_search",
          "contact_upsert",
          "fact_link_source",
          "get_my_brief",
          "memory_changes",
          "memory_entity",
          "memory_ingest",
          "memory_note",
          "memory_query",
          "memory_stale",
          "memory_version",
          "send_feedback",
        ].sort(),
      );
    } finally {
      await client.close();
    }
  });

  it("memory_query with a read-scoped token is allowed and audited", async () => {
    vi.mocked(db.auditLog.create).mockClear();
    const client = await connectClient(readToken);
    try {
      const result = await client.callTool({
        name: "memory_query",
        arguments: { query: "what do we know about Acme?" },
      });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/Austin office/);
    } finally {
      await client.close();
    }
    const allows = auditCalls("allow", "memory.read");
    expect(allows.length).toBeGreaterThan(0);
    expect(allows[0].actorId).toBe("agent-read");
  });

  it("memory_ingest with a READ-ONLY token is denied and audited — mcp/README.md's documented default-deny", async () => {
    vi.mocked(db.auditLog.create).mockClear();
    vi.mocked(ingestMemory).mockClear();
    const client = await connectClient(readToken);
    try {
      const result = await client.callTool({
        name: "memory_ingest",
        arguments: { content: "Acme is opening a new Austin office", name: "Acme Corp" },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/Access denied/i);
    } finally {
      await client.close();
    }
    // The write must never reach the ingest pipeline once denied.
    expect(ingestMemory).not.toHaveBeenCalled();
    const denies = auditCalls("deny", "memory.write");
    expect(denies.length).toBeGreaterThan(0);
    expect(denies[0].actorId).toBe("agent-read");
  });

  it("memory_ingest with a write-scoped token is allowed, audited, and queues the real ingest pipeline", async () => {
    vi.mocked(db.auditLog.create).mockClear();
    vi.mocked(ingestMemory).mockClear();
    const client = await connectClient(writeToken);
    try {
      const result = await client.callTool({
        name: "memory_ingest",
        arguments: { content: "Acme is opening a new Austin office", name: "Acme Corp" },
      });
      expect(result.isError).not.toBe(true);
    } finally {
      await client.close();
    }
    expect(ingestMemory).toHaveBeenCalledTimes(1);
    expect(ingestMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: ORG_ID,
        content: "Acme is opening a new Austin office",
        name: "Acme Corp",
        actorType: "agent",
        actorId: "agent-write",
        source: "mcp",
      }),
    );
    const allows = auditCalls("allow", "memory.write");
    expect(allows.length).toBeGreaterThan(0);
    expect(allows[0].actorId).toBe("agent-write");
  });

  it("rejects a request with no bearer token (401, before any tool runs)", async () => {
    const res = await fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "no-auth", version: "0" } },
      }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects an unknown bearer token (401) without an audit row: it names no org to record against", async () => {
    vi.mocked(db.auditLog.create).mockClear();
    const res = await fetch(server.url, {
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
    expect(res.status).toBe(401);
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });
});
