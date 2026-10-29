// Independent compact-context review against isolated Postgres: retained cursors,
// token denial/recovery, and standing rules on a missing primary version.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { hashCapabilityToken } from "@/services/access/capabilities";
import { EmptyGraphMemoryService } from "./memory-service-stub.testsupport";

vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
}));

const QA_URL = process.env.QA_DATABASE_URL;
// memory_query reads only scopes under the org's own root, org_<orgId>.
const ORG = "qactxindependent";
const ROOT = `org_${ORG}`;
const SALES = `${ROOT}.sales`;
const WRITER = "agent-writer";
const DENIED = "agent-denied";
const READER = "agent-reader";

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

describe.skipIf(!QA_URL)("independent compact lifecycle review against a real database", () => {
  let db: PrismaClient;
  let createBrief: (typeof import("@/services/memory/create-brief"))["createBrief"];
  let registerWillderTools: (typeof import("./tools"))["registerWillderTools"];
  const openClients: Client[] = [];
  const memoryService = new EmptyGraphMemoryService();

  async function mintCapability(
    agentId: string,
    scopePath: string,
    grantGoverned = false,
    permission: "read" | "write" = "read",
  ) {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath,
        permission,
        grantGoverned,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    return token;
  }

  async function connectAs(agentId: string, token: string, scopePath: string): Promise<Client> {
    const server = new McpServer({ name: "willder-qa", version: "0.0.0" });
    registerWillderTools(
      server,
      { orgId: ORG, actor: { type: "agent", id: agentId, capabilityToken: token }, origin: "mcp" as const },
      { orgId: ORG, agentId, scopePath },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "qa-client", version: "0.0.0" });
    await client.connect(clientTransport);
    openClients.push(client);
    return client;
  }

  const call = (client: Client, name: string, args: Record<string, unknown>, meta?: Record<string, unknown>) =>
    client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) }) as Promise<ToolResult>;

  const writeBrief = (title: string) =>
    createBrief(
      { orgId: ORG, type: "handoff", scopePath: SALES, title, summary: "s", sections: [] },
      { actorType: "agent", actorId: WRITER, origin: "agent-run" },
    );

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    process.env.GRAPHITI_SERVICE_URL = await memoryService.start();
    process.env.GRAPHITI_SERVICE_API_KEY = "test-key";
    const inngestModule = await import("@/lib/inngest");
    vi.spyOn(inngestModule.inngest, "send").mockImplementation((async () => ({ ids: ["job"] })) as never);
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ createBrief } = await import("@/services/memory/create-brief"));
    ({ registerWillderTools } = await import("./tools"));
  });

  afterAll(async () => {
    await Promise.all(openClients.splice(0).map((c) => c.close()));
    await memoryService.stop();
    await db.$disconnect();
  });

  beforeEach(async () => {
    await Promise.all(openClients.splice(0).map((c) => c.close()));
    await db.taskStartDelivery.deleteMany({ where: { orgId: ORG } });
    await db.convention.deleteMany({ where: { orgId: ORG, supersedesId: { not: null } } });
    await db.convention.deleteMany({ where: { orgId: ORG } });
    for (const table of [
      "factEdge",
      "factVersionRead",
      "memoryIngestKey",
      "memoryChunk",
      "auditLog",
      "changeEvent",
      "agentCursor",
      "capability",
      "brief",
      "grant",
      "scope",
    ] as const) {
      await (db[table] as unknown as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({
        where: { orgId: ORG },
      });
    }
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
  });

  it("successful compact reads keep an established cursor exactly in place until explicit drain", async () => {
    await writeBrief("already read");
    const reader = await connectAs(READER, await mintCapability(READER, SALES), SALES);
    await call(reader, "memory_changes", {});
    const cursorBefore = await db.agentCursor.findFirstOrThrow({ where: { orgId: ORG, agentId: READER } });
    await writeBrief("pending after established cursor");
    for (let i = 0; i < 3; i++) {
      const compact = await call(reader, "get_my_brief", { briefId: "missing" }, { "willder/context": "compact" });
      expect(compact.isError).not.toBe(true);
      expect(compact.content.map((part) => part.text).join("\n")).toContain("Change notices deferred");
      const now = await db.agentCursor.findFirstOrThrow({ where: { orgId: ORG, agentId: READER } });
      expect(now.lastSeq).toBe(cursorBefore.lastSeq);
      expect(now.deniedSince).toBeNull();
    }
    const drained = await call(reader, "memory_changes", {}, { "willder/context": "compact" });
    expect(drained.content[0]!.text).toContain("pending after established cursor");
    expect(drained.content[0]!.text).not.toContain("already read");
    expect((await db.agentCursor.findFirstOrThrow({ where: { orgId: ORG, agentId: READER } })).lastSeq).toBeGreaterThan(
      cursorBefore.lastSeq,
    );
  });

  it.each(["revoked", "expired"] as const)(
    "compact preserves denied history and audits when a token is %s then restored",
    async (condition) => {
      const token = await mintCapability(DENIED, SALES);
      const reader = await connectAs(DENIED, token, SALES);
      const where = { tokenHash: hashCapabilityToken(token) };
      await db.capability.updateMany({
        where,
        data: condition === "revoked" ? { revokedAt: new Date() } : { expiresAt: new Date(0) },
      });
      await writeBrief("history while token invalid");
      const denied = await call(reader, "get_my_brief", { briefId: "missing" }, { "willder/context": "compact" });
      expect(denied.isError).toBe(true);
      expect(denied.content.map((part) => part.text).join("\n")).not.toContain("deferred");
      expect(await db.auditLog.count({ where: { orgId: ORG, actorId: DENIED, decision: "deny" } })).toBe(2);
      expect(
        (await db.agentCursor.findFirstOrThrow({ where: { orgId: ORG, agentId: DENIED } })).deniedSince,
      ).not.toBeNull();
      await db.capability.updateMany({ where, data: { revokedAt: null, expiresAt: new Date(Date.now() + 3_600_000) } });
      const recovered = await call(reader, "get_my_brief", { briefId: "missing" }, { "willder/context": "compact" });
      expect(recovered.isError).not.toBe(true);
      expect(
        (await db.agentCursor.findFirstOrThrow({ where: { orgId: ORG, agentId: DENIED } })).deniedSince,
      ).toBeNull();
      await writeBrief("history after token restored");
      const feed = (await call(reader, "memory_changes", {})).content[0]!.text;
      expect(feed).toContain("history after token restored");
      expect(feed).not.toContain("history while token invalid");
    },
  );

  it("compact delivers standing rules on primary missing-version responses and keeps feed pending", async () => {
    const { recordConvention } = await import("@/services/memory/conventions");
    const token = await mintCapability(WRITER, SALES, false, "write");
    await recordConvention(
      { orgId: ORG, actor: { type: "agent", id: WRITER, capabilityToken: token }, origin: "mcp" },
      {
        kind: "convention",
        subject: "Independent standing rule",
        text: "Every export requires a review of its scope.",
        scopePath: SALES,
      },
    );
    const reader = await connectAs(READER, await mintCapability(READER, SALES), SALES);
    const result = await call(
      reader,
      "memory_version",
      { versionId: "missing-version" },
      { "willder/context": "compact" },
    );
    expect(result.content[0]!.text).toBe("Version not found.");
    expect(result.content.map((part) => part.text).join("\n")).toContain(
      "Every export requires a review of its scope.",
    );
    expect(await db.agentCursor.findFirst({ where: { orgId: ORG, agentId: READER } })).toBeNull();
    const again = await call(
      reader,
      "memory_version",
      { versionId: "missing-version" },
      { "willder/context": "compact" },
    );
    expect(again.content.map((part) => part.text).join("\n")).not.toContain(
      "Every export requires a review of its scope.",
    );
    expect((await call(reader, "memory_changes", {})).content[0]!.text).toContain("Independent standing rule");
  });
});
