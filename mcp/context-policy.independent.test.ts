// Independent adversarial review: use the existing SDK harness to attack transitions.
// Context preferences travel through the real HTTP and stdio SDK transports and
// registered tools. Storage/queue boundaries are offline; the notice wrapper,
// access decisions and primary tool handlers are real.
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

vi.mock("@/services/access/derived-writes", () => import("@/services/access/derived-writes.testsupport"));
vi.mock("@/lib/db", () => ({
  db: {
    org: { findUnique: async () => ({ settings: {} }) },
    capability: { findUnique: vi.fn() },
    agent: { findMany: async () => [], count: async () => 0 },
    source: { findMany: async () => [] },
    brief: { findFirst: async () => null },
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    auditLog: { create: vi.fn(async () => ({ id: "audit" })), update: vi.fn() },
  },
}));
vi.mock("@/services/access/scope-registry", () => ({ strictDescendantScopePaths: async () => [] }));
vi.mock("@/services/memory/own-pending-facts", () => ({ loadOwnPendingFacts: async () => [] }));
vi.mock("@/services/memory/superseded-facts", async (original) => ({
  ...(await original<typeof import("@/services/memory/superseded-facts")>()),
  loadSupersededVersions: async () => ({ byId: new Map(), byText: new Map() }),
}));
// Graph facts here are stand-ins with no stored rows behind them, so the serve-time source
// check (services/memory/graph-fact-sources.ts) serves them as they are; it is proven against
// real rows in services/memory/graph-fact-sources.realdb.test.ts.
vi.mock("@/services/memory/graph-fact-sources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory/graph-fact-sources")>()),
  loadGraphSources: async () => ({ supports: () => true }),
}));
vi.mock("@/services/memory/store", () => ({
  memory: {
    retrieve: vi.fn(async () => ({ facts: [] })),
    entity: vi.fn(async () => null),
  },
  graphitiStore: {},
}));
vi.mock("@/services/contacts/agent-contacts", async (original) => ({
  ...(await original<typeof import("@/services/contacts/agent-contacts")>()),
  searchContacts: vi.fn(async () => []),
  getContact: vi.fn(async () => null),
  upsertContact: vi.fn(async () => {
    throw new Error("contact write refused");
  }),
}));
vi.mock("@/lib/inngest", () => ({ ingestMemory: vi.fn() }));
vi.mock("@/services/memory/task-start-served", () => ({ recordItemUses: vi.fn() }));
vi.mock("@/services/memory/fact-reads", async (original) => ({
  ...(await original<typeof import("@/services/memory/fact-reads")>()),
  recordVersionsRead: vi.fn(),
  recordVersionsSighted: vi.fn(),
}));
vi.mock("@/services/memory/versions", async (original) => ({
  ...(await original<typeof import("@/services/memory/versions")>()),
  readMemoryVersion: vi.fn(),
}));
vi.mock("./task-start-notice", async (original) => ({
  ...(await original<typeof import("./task-start-notice")>()),
  taskStartNotice: vi.fn(),
}));
vi.mock("@/services/memory/change-feed", async (original) => ({
  ...(await original<typeof import("@/services/memory/change-feed")>()),
  skipUnshownChanges: vi.fn(async () => true),
  readChanges: vi.fn(),
  countWaitingChanges: vi.fn(async () => 1000),
  factNamesOf: vi.fn(async () => new Map()),
  recordDeniedRead: vi.fn(async () => false),
  endDeniedRead: vi.fn(),
}));

import { db } from "@/lib/db";
import { ingestMemory } from "@/lib/inngest";
import { readChanges, skipUnshownChanges } from "@/services/memory/change-feed";
import { readMemoryVersion } from "@/services/memory/versions";
import { recordVersionsRead, recordVersionsSighted } from "@/services/memory/fact-reads";
import { taskStartNotice } from "./task-start-notice";
import { registerWillderTools } from "./tools";
import { startMcpTestServer } from "./http-test-server";

const ORG = "org_context_policy";
const cap = { orgId: ORG, agentId: "context-reader", scopePath: ORG };
const ctx = {
  orgId: ORG,
  actor: { type: "agent" as const, id: cap.agentId, capabilityToken: "wcap_context_test" },
  origin: "mcp" as const,
};
const cleanup: (() => Promise<void>)[] = [];
const text = (r: CallToolResult) => r.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");

async function connect(kind: "http" | "stdio", headers: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: "context-policy-test", version: "1" });
  if (kind === "http") {
    const server = await startMcpTestServer();
    cleanup.push(() => server.close());
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { Authorization: "Bearer wcap_context_test", ...headers } },
      }),
    );
  } else {
    const input = new PassThrough();
    const output = new PassThrough();
    const buffer = new ReadBuffer();
    const transport: Transport = {
      async start() {
        output.on("data", (chunk: Buffer) => {
          buffer.append(chunk);
          for (let message = buffer.readMessage(); message; message = buffer.readMessage())
            transport.onmessage?.(message);
        });
      },
      async send(message) {
        input.write(serializeMessage(message));
      },
      async close() {
        input.destroy();
        output.destroy();
      },
    };
    const server = new McpServer({ name: "willder", version: "test" });
    registerWillderTools(server, ctx, cap, { session: "stdio-test" });
    await server.connect(new StdioServerTransport(input, output));
    cleanup.push(() => server.close());
    await client.connect(transport);
  }
  cleanup.push(() => client.close());
  return client;
}

const call = (
  client: Client,
  name = "memory_query",
  args: Record<string, unknown> = { query: "release" },
  meta: Record<string, unknown> = {},
) => client.callTool({ name, arguments: args, _meta: meta }) as Promise<CallToolResult>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.capability.findUnique).mockResolvedValue({
    ...cap,
    revokedAt: null,
    expiresAt: new Date("2099-01-01"),
  } as never);
  vi.mocked(db.$queryRaw).mockResolvedValue([{ permission: "write", createdBy: null, agentId: cap.agentId }] as never);
  vi.mocked(taskStartNotice).mockResolvedValue("Before you start: current task rules");
  vi.mocked(readChanges).mockResolvedValue({
    changes: [
      {
        id: "event-1",
        recordType: "fact",
        recordId: "version-1",
        actorId: "other-writer",
        scopePath: ORG,
        op: "supersede",
        summary: "Release changed",
        createdAt: new Date(0),
        supersededById: null,
      },
    ],
    hasMore: true,
  } as never);
  vi.mocked(ingestMemory).mockResolvedValue({ readableNow: true, versionId: "written-version" } as never);
  vi.mocked(readMemoryVersion).mockResolvedValue({
    id: "v1",
    kind: "fact",
    scopePath: ORG,
    subject: "release",
    content: "Old release",
    actorId: "writer",
    createdAt: new Date(0),
    status: "superseded",
    supersededById: "v2",
    supersedesIds: [],
  });
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

describe.each(["http", "stdio"] as const)("%s independent compact review", (kind) => {
  it("compact version reads record the primary version but no deferred sightings", async () => {
    const result = await call(
      await connect(kind),
      "memory_version",
      { versionId: "v1" },
      { "willder/context": "compact" },
    );
    expect(text(result)).toContain("superseded by: v2");
    expect(recordVersionsRead).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ versionIds: ["v1"] }));
    expect(recordVersionsSighted).not.toHaveBeenCalled();
    expect(taskStartNotice).toHaveBeenCalled();
    expect(readChanges).not.toHaveBeenCalled();
    expect(skipUnshownChanges).not.toHaveBeenCalled();
  });

  it("parallel compact reads cannot consume a pending feed before explicit memory_changes", async () => {
    const client = await connect(kind);
    let reads = 0;
    vi.mocked(readChanges).mockImplementation(async () => {
      reads++;
      return {
        changes:
          reads === 1
            ? [
                {
                  id: "pending",
                  recordType: "fact",
                  recordId: "pending-version",
                  actorId: "other",
                  scopePath: ORG,
                  op: "supersede",
                  summary: "Unique pending content",
                  createdAt: new Date(0),
                  supersededById: null,
                },
              ]
            : [],
        hasMore: false,
      } as never;
    });
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        call(client, "memory_query", { query: "release" }, { "willder/context": "compact" }),
      ),
    );
    expect(results.every((result) => text(result).includes("Change notices deferred"))).toBe(true);
    expect(reads).toBe(0);
    expect(taskStartNotice).toHaveBeenCalled();
    const drain = await call(client, "memory_changes", {}, { "willder/context": "compact" });
    expect(text(drain)).toContain("Unique pending content");
    expect(reads).toBe(1);
    const empty = await call(client, "memory_changes", {}, { "willder/context": "compact" });
    expect(empty.content[0]).toEqual({ type: "text", text: "No changes." });
  });

  it("primary read failures survive compact without reading the deferred feed", async () => {
    vi.mocked(readMemoryVersion).mockRejectedValueOnce(new Error("primary storage unavailable"));
    const result = await call(
      await connect(kind),
      "memory_version",
      { versionId: "v1" },
      { "willder/context": "compact" },
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("primary storage unavailable");
    expect(readChanges).not.toHaveBeenCalled();
    expect(taskStartNotice).toHaveBeenCalled();
  });

  it("a failed named task block cannot fail the primary answer or drain the compact feed", async () => {
    vi.mocked(taskStartNotice).mockRejectedValueOnce(new Error("task storage unavailable"));
    const result = await call(
      await connect(kind),
      "memory_version",
      { versionId: "v1" },
      { "willder/context": "compact", "willder/task": "named" },
    );
    expect(result.isError).not.toBe(true);
    expect(text(result)).toContain("superseded by: v2");
    expect(text(result)).toContain("Change notices deferred");
    expect(readChanges).not.toHaveBeenCalled();
  });

  it.each([null, 0, [], ["compact"], " compact", "compact\u200b"])(
    "malformed preference %j retains full delivery",
    async (mode) => {
      const result = await call(await connect(kind), "memory_query", { query: "release" }, { "willder/context": mode });
      expect(text(result)).toContain("Release changed");
      expect(text(result)).toContain("Before you start");
      expect(text(result)).not.toContain("Change notices deferred");
    },
  );

  it("explicit feed retains its named task block but does not double-read changes", async () => {
    const result = await call(
      await connect(kind),
      "memory_changes",
      {},
      { "willder/context": "compact", "willder/session": "named-session", "willder/task": "named-task" },
    );
    expect(text(result)).toContain("Before you start");
    expect(text(result)).toContain("Release changed");
    expect(readChanges).toHaveBeenCalledTimes(1);
    expect(skipUnshownChanges).not.toHaveBeenCalled();
    expect(taskStartNotice).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sessionKey: "named-session", taskKey: "named-task" }),
    );
  });

  it("compact metadata is per-call and cannot suppress the next write's pre-handler feed", async () => {
    const client = await connect(kind);
    await call(client, "memory_query", { query: "release" }, { "willder/context": "compact" });
    expect(readChanges).not.toHaveBeenCalled();
    vi.mocked(ingestMemory).mockImplementationOnce(async () => {
      expect(readChanges).toHaveBeenCalledTimes(1);
      return { readableNow: true, versionId: "new" } as never;
    });
    const result = await call(
      client,
      "memory_ingest",
      { name: "release", content: "Friday" },
      { "willder/context": "compact" },
    );
    expect(text(result)).toContain("Release changed");
    expect(text(result)).toContain("Before you start");
    expect(text(result)).not.toContain("Change notices deferred");
  });
});

it("HTTP per-call compact overrides full header without sticking to subsequent calls", async () => {
  const client = await connect("http", { "X-Willder-Context": "full" });
  expect(text(await call(client, "memory_query", { query: "release" }, { "willder/context": "compact" }))).toContain(
    "Change notices deferred",
  );
  expect(readChanges).not.toHaveBeenCalled();
  expect(text(await call(client))).toContain("Release changed");
});

it("HTTP duplicate compact/full header cannot silently select compact", async () => {
  const result = await call(await connect("http", { "X-Willder-Context": "compact, full" }));
  expect(text(result)).toContain("Release changed");
  expect(text(result)).toContain("Before you start");
});
