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
vi.mock("@/services/memory/dependencies", async (original) => ({
  ...(await original<typeof import("@/services/memory/dependencies")>()),
  staleReport: vi.fn(async () => ({ stale: [], recommend: [], truncated: false })),
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
import { AccessDeniedError } from "@/services/access";
import { ingestMemory } from "@/lib/inngest";
import { staleReport } from "@/services/memory/dependencies";
import { readChanges, skipUnshownChanges, recordDeniedRead, endDeniedRead } from "@/services/memory/change-feed";
import { readMemoryVersion } from "@/services/memory/versions";
import { UnreadVersionError } from "@/services/memory/fact-reads";
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

describe.each(["http", "stdio"] as const)("%s supplementary context", (kind) => {
  it("keeps full notices as the default", async () => {
    const result = await call(await connect(kind));
    expect(text(result)).toContain("Before you start");
    expect(text(result)).toContain("1000 or more changes");
  });

  it("compact reads retain task rules while leaving the feed untouched", async () => {
    const client = await connect(kind);
    for (let n = 0; n < 2; n++) {
      const result = await call(client, "memory_version", { versionId: "v1" }, { "willder/context": "compact" });
      expect(text(result)).toContain("superseded by: v2");
      expect(text(result)).toContain("Before you start");
      expect(text(result)).not.toContain("1000 or more");
      expect(text(result)).toContain("memory_changes");
    }
    expect(taskStartNotice).toHaveBeenCalled();
    expect(skipUnshownChanges).not.toHaveBeenCalled();
    expect(endDeniedRead).toHaveBeenCalled();
    expect(readChanges).not.toHaveBeenCalled();
    const full = await call(client, "memory_query", { query: "release" }, { "willder/context": "full" });
    expect(text(full)).toContain("Before you start");
    expect(text(full)).toContain("Release changed");
  });

  it.each([
    ["memory_stale", {}, "Nothing stale"],
    ["memory_entity", { entityId: "missing" }, "Entity not found"],
    ["get_my_brief", { briefId: "missing" }, "not found"],
    ["contact_search", {}, "No contacts found"],
    ["contact_read", { contactId: "missing" }, "Contact not found"],
  ])("%s honors compact without changing its answer", async (name, args, expected) => {
    const result = await call(await connect(kind), name as string, args as Record<string, unknown>, {
      "willder/context": "compact",
    });
    expect(result.isError).not.toBe(true);
    expect(text(result)).toContain(expected);
    expect(text(result)).toContain("Before you start");
    expect(readChanges).not.toHaveBeenCalled();
  });

  it.each([
    ["memory_ingest", { name: "release", content: "Friday" }],
    [
      "fact_link_source",
      { graphitiFactUuid: "f1", sourceType: "file", sourceRef: "README.md", scopePath: "invalid/path" },
    ],
    ["contact_upsert", { idempotencyKey: "test-write", name: "Test contact" }],
    ["memory_note", { kind: "claim" }],
  ])("%s keeps pre-existing notices despite compact", async (name, args) => {
    const result = await call(await connect(kind), name as string, args as Record<string, unknown>, {
      "willder/context": "compact",
    });
    expect(text(result)).toContain("Before you start");
    expect(text(result)).toContain("Release changed");
    expect(readChanges).toHaveBeenCalledTimes(1);
  });

  it("memory_stale keeps its source warning and incomplete-report notice in compact mode", async () => {
    vi.mocked(staleReport).mockResolvedValueOnce({
      stale: [],
      truncated: true,
      recommend: [
        {
          recordId: "brief-to-refresh",
          dependents: 2,
          staleSources: 1,
          latest: {
            sourceId: "old-source",
            kind: "cites",
            reason: {
              kind: "superseded",
              byId: "new-source",
              at: new Date("2026-10-16T12:00:00Z"),
            },
          },
        },
      ],
    });
    const result = await call(await connect(kind), "memory_stale", { limit: 5 }, { "willder/context": "compact" });
    expect(result.isError).not.toBe(true);
    expect(text(result)).toContain("brief-to-refresh: cites old-source, replaced by new-source");
    expect(text(result)).toContain("older records in org_context_policy were not checked");
    expect(text(result)).toContain("Before you start");
    expect(taskStartNotice).toHaveBeenCalled();
    expect(readChanges).not.toHaveBeenCalled();
  });

  it("compact unchanged receipts retain revision metadata", async () => {
    const client = await connect(kind);
    const meta = { "willder/context": "compact" };
    const first = await call(client, "memory_query", { query: "release" }, meta);
    const unchanged = await call(
      client,
      "memory_query",
      { query: "release", ifRevision: first._meta?.["willder/revision"] },
      meta,
    );
    expect(unchanged._meta?.["willder/unchanged"]).toBe(true);
    expect(text(unchanged)).toContain("Unchanged since revision");
    expect(text(unchanged)).toContain("Before you start");
    expect(readChanges).not.toHaveBeenCalled();
  });

  it("compact still delivers explicitly named task context", async () => {
    const result = await call(
      await connect(kind),
      "memory_query",
      { query: "release" },
      {
        "willder/context": "compact",
        "willder/task": "release-review",
      },
    );
    expect(text(result)).toContain("Before you start");
    expect(taskStartNotice).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ taskKey: "release-review" }),
    );
    expect(readChanges).not.toHaveBeenCalled();
  });

  it("compact preserves a first block explicitly requested by session metadata", async () => {
    const result = await call(
      await connect(kind),
      "memory_query",
      { query: "release" },
      {
        "willder/context": "compact",
        "willder/session": "explicit-session",
      },
    );
    expect(text(result)).toContain("Before you start");
    expect(taskStartNotice).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sessionKey: "explicit-session" }),
    );
    expect(readChanges).not.toHaveBeenCalled();
  });

  it("memory_changes explicitly drains the feed in compact mode", async () => {
    const result = await call(await connect(kind), "memory_changes", {}, { "willder/context": "compact" });
    expect(text(result)).toContain("Release changed");
    expect(text(result)).toContain("more changes waiting");
    expect(readChanges).toHaveBeenCalledTimes(1);
    expect(taskStartNotice).toHaveBeenCalled();
  });

  it("invalid preferences cannot silently opt out", async () => {
    const client = await connect(kind);
    for (const value of ["", "none", "COMPACT", true, { mode: "compact" }]) {
      expect(text(await call(client, "memory_query", { query: "release" }, { "willder/context": value }))).toContain(
        "Release changed",
      );
    }
  });

  it("compact does not bypass read access or expose context on denial", async () => {
    const client = await connect(kind);
    vi.mocked(db.$queryRaw).mockResolvedValue([] as never);
    const result = await call(client, "memory_query", { query: "release" }, { "willder/context": "compact" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Access denied");
    expect(text(result)).not.toContain("Release changed");
    expect(text(result)).not.toContain("deferred");
    expect(recordDeniedRead).toHaveBeenCalled();
    expect(taskStartNotice).not.toHaveBeenCalled();
    expect(readChanges).not.toHaveBeenCalled();
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ decision: "deny" }) }),
    );
  });

  it("compact does not append a deferred marker after access is revoked during task-start", async () => {
    vi.mocked(taskStartNotice).mockImplementationOnce(async () => {
      vi.mocked(db.$queryRaw).mockResolvedValue([] as never);
      throw new AccessDeniedError({ allowed: false, reason: "revoked during notice" });
    });
    const result = await call(
      await connect(kind),
      "memory_query",
      { query: "release" },
      { "willder/context": "compact" },
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Access denied");
    expect(text(result)).not.toContain("deferred");
    expect(recordDeniedRead).toHaveBeenCalled();
    expect(readChanges).not.toHaveBeenCalled();
  });

  it("discarded session captures never consume supplementary context", async () => {
    const result = await call(
      await connect(kind),
      "memory_ingest",
      { name: "capture", content: "Done" },
      {
        "willder/capture": "session-state",
        "willder/context": "full",
        "willder/task": "release-review",
      },
    );
    expect(text(result)).toContain("Stored");
    expect(taskStartNotice).not.toHaveBeenCalled();
    expect(readChanges).not.toHaveBeenCalled();
  });

  it("compact does not hide a refused primary write", async () => {
    vi.mocked(ingestMemory).mockRejectedValueOnce(
      new UnreadVersionError({ entityName: "release", eventScopePath: ORG }, { unreadVersionId: "new-current" }),
    );
    const result = await call(
      await connect(kind),
      "memory_ingest",
      { name: "release", content: "Friday" },
      { "willder/context": "compact" },
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("stale_version");
    expect(text(result)).toContain("new-current");
  });
});

it("HTTP compact header is overridden by an explicit full call", async () => {
  const client = await connect("http", { "X-Willder-Context": "compact" });
  expect(text(await call(client))).toContain("Before you start");
  expect(readChanges).not.toHaveBeenCalled();
  expect(text(await call(client, "memory_query", { query: "release" }, { "willder/context": "full" }))).toContain(
    "Before you start",
  );
});

it("HTTP compact header preserves the named connection task", async () => {
  const client = await connect("http", { "X-Willder-Context": "compact", "X-Willder-Task": "release-review" });
  expect(text(await call(client))).toContain("Before you start");
  expect(taskStartNotice).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ taskKey: "release-review" }),
  );
  expect(readChanges).not.toHaveBeenCalled();
});

it("an invalid per-call mode overrides a compact HTTP header safely to full", async () => {
  const result = await call(
    await connect("http", { "X-Willder-Context": "compact" }),
    "memory_query",
    { query: "release" },
    { "willder/context": "none" },
  );
  expect(text(result)).toContain("Before you start");
  expect(text(result)).toContain("Release changed");
});
