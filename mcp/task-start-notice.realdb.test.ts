// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The task-start block on MCP tool results, against a real database.
//
// The scenario: an agent starts a session, calls whatever tool it
// was going to call anyway, and that first result carries the scope's current rules
// and the recent writes its task touches, without the agent asking. Everything below
// runs for real: an MCP client and server over an in-memory transport, the real tool
// registrations, check(), the ltree filter, the supersede constraint and the
// delivered_to claim. Only the ingest queue is replaced, since memory_ingest's graph
// write is not what these tests are about.
//
// Set QA_DATABASE_URL to an ISOLATED test database, never the inherited
// DATABASE_URL, which may point at a live database. Skips cleanly without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withoutSources } from "./task-start-headings";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the
// `@/lib/db` singleton at import time, before beforeAll points DATABASE_URL at
// the QA database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";

vi.mock("@/lib/inngest", () => ({ ingestMemory: vi.fn().mockResolvedValue(undefined) }));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-task-start";
const OTHER_ORG = "org-qa-task-start-other";
const SALES = "org_1.sales";
// A sibling of `sales`, not a descendant: an unescaped LIKE would match it.
const SALES_SIBLING = "org_1.sales_eu";
const ENGINEERING = "org_1.engineering";

const AUTHOR = "agent-author";
const WORKER = "agent-worker";

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

describe.skipIf(!QA_URL)("task-start block on MCP tool results, against a real database", () => {
  let db: PrismaClient;
  let registerWillderTools: (typeof import("./tools"))["registerWillderTools"];
  let recordConvention: (typeof import("@/services/memory/conventions"))["recordConvention"];
  let createBrief: (typeof import("@/services/memory/create-brief"))["createBrief"];
  let SESSION_IDLE_MS: number;
  let TASK_START_TOKEN_BUDGET: number;
  let estimateTokens: (text: string) => number;

  const openClients: Client[] = [];

  async function mintCapability(
    agentId: string,
    scopePath: string,
    permission: "read" | "write" = "read",
    orgId = ORG,
  ): Promise<string> {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath,
        permission,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return token;
  }

  const ctxFor = (agentId: string, token: string, orgId = ORG): AccessContext => ({
    orgId,
    actor: { type: "agent", id: agentId, capabilityToken: token },
    origin: "mcp",
  });

  async function connectAs(agentId: string, token: string, scopePath: string): Promise<Client> {
    const server = new McpServer({ name: "willder-test", version: "0.0.0" });
    registerWillderTools(server, ctxFor(agentId, token), { orgId: ORG, agentId, scopePath });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);
    openClients.push(client);
    return client;
  }

  /** Record a rule as the author, who holds write on `scopePath`. */
  async function rule(scopePath: string, subject: string, text: string, supersedes?: string): Promise<string> {
    const token = await mintCapability(AUTHOR, scopePath, "write");
    return recordConvention(ctxFor(AUTHOR, token), { kind: "convention", subject, text, scopePath, supersedes });
  }

  /** A tool call that does unrelated work, in the named session. */
  async function firstCall(client: Client, session?: string, task?: string): Promise<ToolResult> {
    const _meta: Record<string, string> = {};
    if (session !== undefined) _meta["willder/session"] = session;
    if (task !== undefined) _meta["willder/task"] = task;
    return (await client.callTool({
      name: "get_my_brief",
      arguments: { briefId: "no-such-brief" },
      _meta,
    })) as ToolResult;
  }

  /** The task-start block in a result, if any, without the change notices after it. */
  const blockOf = (result: ToolResult): string | undefined =>
    result.content
      .map((c) => c.text)
      .find((text) => text.startsWith("Before you start"))
      ?.split("\n\nChanged in your scope")[0];

  /** Move `agentId`'s change-feed cursor past everything written so far, so the change
   * notices stay quiet and only the task-start block can add to a call. */
  async function feedCaughtUp(agentId: string): Promise<void> {
    const latest = await db.changeEvent.aggregate({ where: { orgId: ORG }, _max: { seq: true } });
    const lastSeq = latest._max.seq ?? BigInt(0);
    await db.agentCursor.upsert({
      where: { orgId_agentId: { orgId: ORG, agentId } },
      update: { lastSeq },
      create: { orgId: ORG, agentId, lastSeq },
    });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ registerWillderTools } = await import("./tools"));
    ({ recordConvention } = await import("@/services/memory/conventions"));
    ({ createBrief } = await import("@/services/memory/create-brief"));
    ({ SESSION_IDLE_MS } = await import("@/services/memory/task-start"));
    ({ TASK_START_TOKEN_BUDGET, estimateTokens } = await import("./task-start-notice"));
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  beforeEach(async () => {
    await Promise.all(openClients.splice(0).map((client) => client.close()));
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.taskStartDelivery.deleteMany({ where: { orgId } });
      // Replacements first: a rule cannot be deleted while another row supersedes it.
      await db.convention.deleteMany({ where: { orgId, supersedesId: { not: null } } });
      await db.convention.deleteMany({ where: { orgId } });
      await db.auditLog.deleteMany({ where: { orgId } });
      await db.changeEvent.deleteMany({ where: { orgId } });
      await db.agentCursor.deleteMany({ where: { orgId } });
      await db.capability.deleteMany({ where: { orgId } });
      await db.brief.deleteMany({ where: { orgId } });
      await db.org.upsert({ where: { id: orgId }, update: {}, create: { id: orgId, name: orgId } });
    }
  });

  it("serves the scope's rules on the first call of a session, after the tool's own answer", async () => {
    const id = await rule(SALES, "Account dedupe", "Dedupe accounts by email domain, never by company name.");
    const worker = await connectAs(WORKER, await mintCapability(WORKER, SALES), SALES);
    await feedCaughtUp(WORKER);

    const result = await firstCall(worker, "run-1");

    expect(result.content[0]!.text).toBe("Brief no-such-brief not found.");
    expect(result.content[1]!.text).toBe(
      "Before you start: what Willder holds for this task; each line says what backs it.\n" +
        "Settled in your scope (rules in force):\n" +
        // An agent recorded the rule: it stays in force, and says so.
        `- [convention ${id}] [agent-recorded] Account dedupe: Dedupe accounts by email domain, never by company name. — ${AUTHOR}, ${new Date().toISOString().slice(5, 10)}`,
    );
  });

  it("serves a session once, and a new session again", async () => {
    await rule(SALES, "Account dedupe", "By domain.");
    const worker = await connectAs(WORKER, await mintCapability(WORKER, SALES), SALES);

    expect(blockOf(await firstCall(worker, "run-1"))).toBeDefined();
    expect(blockOf(await firstCall(worker, "run-1"))).toBeUndefined();
    expect(blockOf(await firstCall(worker, "run-2"))).toBeDefined();
  });

  it("serves a client that names no session again only after the idle window", async () => {
    await rule(SALES, "Account dedupe", "By domain.");
    const worker = await connectAs(WORKER, await mintCapability(WORKER, SALES), SALES);

    expect(blockOf(await firstCall(worker))).toBeDefined();
    expect(blockOf(await firstCall(worker))).toBeUndefined();

    await db.taskStartDelivery.updateMany({
      where: { orgId: ORG, agentId: WORKER, sessionKey: "" },
      data: { lastCallAt: new Date(Date.now() - SESSION_IDLE_MS - 1000) },
    });
    expect(blockOf(await firstCall(worker))).toBeDefined();
  });

  it("delivers once when two first calls of a session race", async () => {
    await rule(SALES, "Account dedupe", "By domain.");
    const worker = await connectAs(WORKER, await mintCapability(WORKER, SALES), SALES);

    const results = await Promise.all(Array.from({ length: 5 }, () => firstCall(worker, "racing")));

    expect(results.filter((r) => blockOf(r) !== undefined)).toHaveLength(1);
  });

  it("serves only the current version of a superseded rule", async () => {
    const old = await rule(SALES, "Account dedupe", "Dedupe by company name.");
    const current = await rule(SALES, "Account dedupe", "Dedupe by email domain.", old);
    const worker = await connectAs(WORKER, await mintCapability(WORKER, SALES), SALES);

    const block = blockOf(await firstCall(worker, "run-1"));

    expect(block).toContain(current);
    expect(block).toContain("Dedupe by email domain.");
    expect(block).not.toContain(old);
    expect(block).not.toContain("company name");
  });

  it("refuses a second replacement of the same rule, and one the writer cannot reach, alike", async () => {
    const old = await rule(SALES, "Account dedupe", "By company name.");
    await rule(SALES, "Account dedupe", "By domain.", old);

    await expect(rule(SALES, "Account dedupe", "By phone.", old)).rejects.toThrow(/no active convention/);

    const engineeringRule = await rule(ENGINEERING, "Deploys", "Deploy on Tuesdays.");
    const salesWriter = await mintCapability(AUTHOR, SALES, "write");
    await expect(
      recordConvention(ctxFor(AUTHOR, salesWriter), {
        kind: "decision",
        subject: "Deploys",
        text: "Deploy whenever.",
        scopePath: SALES,
        supersedes: engineeringRule,
      }),
    ).rejects.toThrow(/no active convention/);
    await expect(
      recordConvention(ctxFor(AUTHOR, salesWriter), {
        kind: "decision",
        subject: "Deploys",
        text: "Deploy whenever.",
        scopePath: SALES,
        supersedes: "no-such-rule",
      }),
    ).rejects.toThrow(/no active convention/);
  });

  it("never serves a rule from a sibling scope, another scope or another org", async () => {
    await rule(SALES_SIBLING, "Sibling rule", "Seen by sales_eu only.");
    await rule(ENGINEERING, "Engineering rule", "Seen by engineering only.");
    const otherOrgWriter = await mintCapability(AUTHOR, SALES, "write", OTHER_ORG);
    await recordConvention(ctxFor(AUTHOR, otherOrgWriter, OTHER_ORG), {
      kind: "convention",
      subject: "Other org rule",
      text: "Same scope string, other tenant.",
      scopePath: SALES,
    });
    const own = await rule(`${SALES}.eu`, "Descendant rule", "Inside sales.");
    const worker = await connectAs(WORKER, await mintCapability(WORKER, SALES), SALES);

    const block = blockOf(await firstCall(worker, "run-1"));

    expect(block).toContain(own);
    expect(block).not.toContain("Sibling rule");
    expect(block).not.toContain("Engineering rule");
    expect(block).not.toContain("Other org rule");
  });

  it("serves recent writes that mention the task, and not the ones that do not", async () => {
    await createBrief(
      {
        orgId: ORG,
        type: "handoff",
        scopePath: SALES,
        title: "Handoff for item-42: pricing page copy",
        summary: "s",
        sections: [],
      },
      { actorType: "agent", actorId: AUTHOR, origin: "agent-run" },
    );
    await createBrief(
      {
        orgId: ORG,
        type: "handoff",
        scopePath: SALES,
        title: "Unrelated onboarding notes",
        summary: "s",
        sections: [],
      },
      { actorType: "agent", actorId: AUTHOR, origin: "agent-run" },
    );
    await createBrief(
      {
        orgId: ORG,
        type: "handoff",
        scopePath: SALES_SIBLING,
        title: "Sibling scope item-42 note",
        summary: "s",
        sections: [],
      },
      { actorType: "agent", actorId: AUTHOR, origin: "agent-run" },
    );
    await createBrief(
      {
        orgId: OTHER_ORG,
        type: "handoff",
        scopePath: SALES,
        title: "Other tenant item-42 note",
        summary: "s",
        sections: [],
      },
      { actorType: "agent", actorId: AUTHOR, origin: "agent-run" },
    );
    const worker = await connectAs(WORKER, await mintCapability(WORKER, SALES), SALES);

    const block = blockOf(await firstCall(worker, "run-1", "Continue item-42"));

    expect(block).toContain("Related to this task:");
    expect(block).toContain("Handoff for item-42: pricing page copy");
    expect(block).not.toContain("Unrelated onboarding notes");
    expect(block).not.toContain("Sibling scope");
    expect(block).not.toContain("Other tenant");
  });

  it("records a fact version its recent-write lines show as a sighting for the agent served", async () => {
    const { recordIngestApplied } = await import("@/services/memory/fact-change-event");
    const content = "item-42 pricing goes live on Monday.";
    await db.$executeRaw`
      INSERT INTO "memory_chunks" ("id","orgId","content","source","actorType","actorId","entityName","scopePath")
      VALUES ('v-task-start-sighting', ${ORG}, ${content}, 'mcp', 'agent', ${AUTHOR}, 'Pricing', ${SALES})
    `;
    try {
      await recordIngestApplied(
        {
          groupId: ORG,
          content,
          name: "Pricing",
          actorType: "agent",
          actorId: AUTHOR,
          origin: "mcp",
          scopePath: SALES,
        },
        "v-task-start-sighting",
      );
      // The change notice would show the same line; caught up, only the block can.
      await feedCaughtUp(WORKER);
      const worker = await connectAs(WORKER, await mintCapability(WORKER, SALES), SALES);

      expect(blockOf(await firstCall(worker, "run-1", "Continue item-42"))).toContain(
        "create fact v-task-start-sighting",
      );
      const recorded = await db.factVersionRead.findMany({
        where: { orgId: ORG, agentId: WORKER },
        select: { versionId: true, sightingOnly: true },
      });
      expect(recorded).toEqual([{ versionId: "v-task-start-sighting", sightingOnly: true }]);
    } finally {
      await db.$executeRaw`DELETE FROM "memory_chunks" WHERE "orgId" = ${ORG}`;
    }
  });

  it("leaves out of the change notices a fact version the block on the same result shows, and only that", async () => {
    const { recordIngestApplied } = await import("@/services/memory/fact-change-event");
    const content = "item-42 pricing goes live on Monday.";
    await db.$executeRaw`
      INSERT INTO "memory_chunks" ("id","orgId","content","source","actorType","actorId","entityName","scopePath")
      VALUES ('v-task-start-repeat', ${ORG}, ${content}, 'mcp', 'agent', ${AUTHOR}, 'Pricing', ${SALES})
    `;
    try {
      await feedCaughtUp(WORKER);
      await recordIngestApplied(
        {
          groupId: ORG,
          content,
          name: "Pricing",
          actorType: "agent",
          actorId: AUTHOR,
          origin: "mcp",
          scopePath: SALES,
        },
        "v-task-start-repeat",
      );
      // A change the block does not show: a brief that does not mention the task.
      await createBrief(
        {
          orgId: ORG,
          type: "handoff",
          scopePath: SALES,
          title: "Unrelated onboarding notes",
          summary: "s",
          sections: [],
        },
        { actorType: "agent", actorId: AUTHOR, origin: "agent-run" },
      );
      const worker = await connectAs(WORKER, await mintCapability(WORKER, SALES), SALES);

      const result = await firstCall(worker, "run-1", "Continue item-42");
      const piggyback = result.content[1]!.text;
      const notices = piggyback.slice(piggyback.indexOf("Changed in your scope since your last call:"));
      expect(blockOf(result)).toContain("create fact v-task-start-repeat");
      expect(notices).toContain("Changed in your scope since your last call:");
      expect(notices).toContain("Unrelated onboarding notes");
      expect(notices).not.toContain("v-task-start-repeat");
      // Consumed with the rest: the session's next call does not announce it either.
      const next = await firstCall(worker, "run-1", "Continue item-42");
      expect(next.content.map((c) => c.text).join("\n")).not.toContain("v-task-start-repeat");
    } finally {
      await db.$executeRaw`DELETE FROM "memory_chunks" WHERE "orgId" = ${ORG}`;
    }
  });

  it("audits a delivered block once and a quiet session not at all", async () => {
    const quiet = await connectAs(WORKER, await mintCapability(WORKER, SALES), SALES);
    await firstCall(quiet, "quiet");
    await firstCall(quiet, "quiet");
    // Only get_my_brief's own miss-path check(), once per call.
    expect(await db.auditLog.count({ where: { orgId: ORG } })).toBe(2);

    await rule(SALES, "Account dedupe", "By domain.");
    await feedCaughtUp(WORKER);
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    const served = await connectAs(WORKER, await mintCapability(WORKER, SALES), SALES);
    expect(blockOf(await firstCall(served, "served"))).toBeDefined();
    // get_my_brief's own row plus exactly one for the delivered block.
    expect(await db.auditLog.count({ where: { orgId: ORG } })).toBe(2);
  });

  it("serves nothing to a revoked token and leaves its session unserved", async () => {
    await rule(SALES, "Account dedupe", "By domain.");
    const token = await mintCapability(WORKER, SALES);
    await db.capability.updateMany({ where: { orgId: ORG, agentId: WORKER }, data: { revokedAt: new Date() } });
    const worker = await connectAs(WORKER, token, SALES);

    expect(blockOf(await firstCall(worker, "run-1"))).toBeUndefined();
    expect(await db.taskStartDelivery.count({ where: { orgId: ORG, agentId: WORKER } })).toBe(0);
  });

  it("keeps a crowded block inside its token budget and says what it left out", async () => {
    for (let i = 0; i < 30; i++) await rule(SALES, `Rule ${i}`, "x".repeat(250));
    const worker = await connectAs(WORKER, await mintCapability(WORKER, SALES), SALES);

    const block = blockOf(await firstCall(worker, "run-1"))!;

    expect(estimateTokens(withoutSources(block))).toBeLessThanOrEqual(TASK_START_TOKEN_BUDGET);
    expect(block).toMatch(/\(\d+ more left out: ask memory_query for them\)$/);
  });

  it("records a rule through memory_ingest and serves it to the next session", async () => {
    const author = await connectAs(AUTHOR, await mintCapability(AUTHOR, SALES, "write"), SALES);
    const stored = (await author.callTool({
      name: "memory_ingest",
      arguments: { name: "Refund policy", content: "Refunds over $500 need a human.", kind: "decision" },
    })) as ToolResult;
    expect(stored.isError).toBeFalsy();
    // An agent's decision is a proposal until a person confirms it, and the reply says so.
    expect(stored.content[0]!.text).toMatch(/^Recorded decision \S+; it is proposed in \S+, not yet a standing rule/);
    expect(stored.content[0]!.text).toMatch(/\/memory\/confirm\/\S+ and choose Confirm decision\./);

    const worker = await connectAs(WORKER, await mintCapability(WORKER, SALES), SALES);
    expect(blockOf(await firstCall(worker, "run-1"))).toContain("Refund policy: Refunds over $500 need a human.");
  });

  it("refuses supersedes without kind, before anything is written", async () => {
    const author = await connectAs(AUTHOR, await mintCapability(AUTHOR, SALES, "write"), SALES);
    const refused = (await author.callTool({
      name: "memory_ingest",
      arguments: { name: "Refund policy", content: "Anything goes.", supersedes: "some-rule" },
    })) as ToolResult;

    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toBe("supersedes needs kind: only a convention or decision can replace one.");
    expect(await db.convention.count({ where: { orgId: ORG } })).toBe(0);
  });
});
