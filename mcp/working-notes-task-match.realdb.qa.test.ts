// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Working notes: a note's task is matched as a name, never as a
// pattern. Renewal, release and the collision check all find notes "on the same task".
// Task names agents use carry `_`, `%` and `\` (item ids, paths, globs), so each of those
// must mean only itself: one agent's note on one task never renews, releases or collides
// with a note on a different task.
//
// Set QA_DATABASE_URL to an ISOLATED test database, never the inherited
// DATABASE_URL, which may point at a live database. Skips cleanly without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the
// `@/lib/db` singleton at import time, before beforeAll points DATABASE_URL at
// the QA database.
import { hashCapabilityToken } from "@/services/access/capabilities";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-working-notes-task-match";
const SCOPE = "org_1.team";
const NORTH = "builder-north";
const SOUTH = "builder-south";

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

describe.skipIf(!QA_URL)("working notes match a task by name, never as a pattern", () => {
  let db: PrismaClient;
  let registerWillderTools: (typeof import("./tools"))["registerWillderTools"];
  const openClients: Client[] = [];

  async function connectAs(agentId: string): Promise<Client> {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath: SCOPE,
        permission: "write",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const server = new McpServer({ name: "willder-test", version: "0.0.0" });
    registerWillderTools(
      server,
      { orgId: ORG, actor: { type: "agent", id: agentId, capabilityToken: token }, origin: "mcp" },
      { orgId: ORG, agentId, scopePath: SCOPE },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);
    openClients.push(client);
    return client;
  }

  async function note(client: Client, args: Record<string, unknown>): Promise<ToolResult> {
    return (await client.callTool({
      name: "memory_note",
      arguments: args,
      _meta: { "willder/session": "work" },
    })) as ToolResult;
  }

  async function liveNotes(agentId: string) {
    return db.workingNote.findMany({
      where: { orgId: ORG, agentId, releasedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "asc" },
    });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ registerWillderTools } = await import("./tools"));
  });

  afterAll(async () => {
    await Promise.all(openClients.splice(0).map((client) => client.close()));
    await db.$disconnect();
  });

  beforeEach(async () => {
    await Promise.all(openClients.splice(0).map((client) => client.close()));
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.agentCursor.deleteMany({ where: { orgId: ORG } });
    await db.taskStartDelivery.deleteMany({ where: { orgId: ORG } });
    await db.workingNote.deleteMany({ where: { orgId: ORG } });
    await db.capability.deleteMany({ where: { orgId: ORG } });
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
  });

  it("posts a new note on a task with % in its name instead of renewing the agent's note on another task", async () => {
    const north = await connectAs(NORTH);
    await note(north, { kind: "claim", task: "item-42 retry dedupe", body: "fixing the retry dedupe" });

    const second = await note(north, { kind: "claim", task: "item-%", body: "sweeping every item" });

    expect(second.isError).toBeFalsy();
    expect(second.content[0]!.text).toMatch(/^Posted claim /);
    const live = await liveNotes(NORTH);
    expect(live.map((n) => [n.task, n.body])).toEqual([
      ["item-42 retry dedupe", "fixing the retry dedupe"],
      ["item-%", "sweeping every item"],
    ]);
  });

  it("does not treat _ as any character: item_9 and item-9 are two tasks", async () => {
    const north = await connectAs(NORTH);
    const south = await connectAs(SOUTH);
    await note(north, { kind: "claim", task: "item-9", body: "on item-9" });

    const renewedOrPosted = await note(north, { kind: "claim", task: "item_9", body: "on item_9" });
    const southClaim = await note(south, { kind: "claim", task: "item_9", body: "taking item_9" });

    expect(renewedOrPosted.content[0]!.text).toMatch(/^Posted claim /);
    expect((await liveNotes(NORTH)).map((n) => n.task)).toEqual(["item-9", "item_9"]);
    // South is told of north's claim on item_9 only, never of the one on item-9.
    const reply = southClaim.content[0]!.text;
    expect(reply).toContain("Detected 1 earlier live claim on this task by another agent.");
    expect(reply).toContain(": on item_9");
    expect(reply).not.toContain(": on item-9");
  });

  it("releases only the note on the named task when the name holds a wildcard character", async () => {
    const north = await connectAs(NORTH);
    await note(north, { kind: "status", task: "announce once", body: "migration written" });

    const released = await note(north, { kind: "status", task: "%", action: "release" });

    expect(released.content[0]!.text).toMatch(/^You have no live status on "%"/);
    expect((await liveNotes(NORTH)).map((n) => n.task)).toEqual(["announce once"]);
  });

  it("renews, releases and collides on a task whose name holds a backslash", async () => {
    const north = await connectAs(NORTH);
    const south = await connectAs(SOUTH);
    const task = String.raw`fix scripts\build.sh`;
    await note(north, { kind: "claim", task, body: "first pass" });

    const renewed = await note(north, { kind: "claim", task, body: "second pass" });
    const southClaim = await note(south, { kind: "claim", task, body: "also on it" });

    expect(renewed.content[0]!.text).toMatch(/^Renewed claim /);
    expect((await liveNotes(NORTH)).map((n) => n.body)).toEqual(["second pass"]);
    expect(southClaim.content[0]!.text).toContain("Detected 1 earlier live claim on this task by another agent.");

    const released = await note(north, { kind: "claim", task, action: "release" });
    expect(released.content[0]!.text).toMatch(/^Released claim /);
    expect(await liveNotes(NORTH)).toEqual([]);
  });

  it("still matches a task without regard to case", async () => {
    const north = await connectAs(NORTH);
    const south = await connectAs(SOUTH);
    await note(north, { kind: "claim", task: "Rework on Item_7", body: "on it" });

    const renewed = await note(north, { kind: "claim", task: "rework on item_7", body: "still on it" });
    const southClaim = await note(south, { kind: "claim", task: "REWORK ON ITEM_7", body: "me too" });

    expect(renewed.content[0]!.text).toMatch(/^Renewed claim /);
    expect(southClaim.content[0]!.text).toContain("Detected 1 earlier live claim on this task by another agent.");
  });
});
