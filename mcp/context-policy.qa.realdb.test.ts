// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// QA for compact read context (mcp/context-policy.ts), against real change_events,
// agent_cursors, capabilities and check(). Two questions the mocked suite cannot answer:
//
// 1. Access parity. The change feed moves a denied agent's cursor past everything written
//    while it was denied, so a grant restored later reveals changes from then on and not
//    the history it could not read (services/memory/change-feed.ts, recordDeniedRead). A
//    compact read must not change what that agent is later told.
// 2. What compact saves. Tokens per read (characters over four, the product's own
//    estimate) for the same read in full and compact, on the same database state: a
//    session's first read with a task-start block and a 1000+ change backlog, and a
//    follow-up read with only change notices.
//
// Before the fix the two compact access-parity cases failed: a compact read skips the feed's
// denial bookkeeping (recordDeniedRead), so the regranted agent's feed serves what was
// written while it was denied, and the denial's start goes unaudited.
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
const ORG = "qactxpolicy";
const ROOT = `org_${ORG}`;
const SALES = `${ROOT}.sales`;
const WRITER = "agent-writer";
const DENIED = "agent-denied";
const READER = "agent-reader";

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

const tokensOf = (text: string) => Math.ceil(text.length / 4);

describe.skipIf(!QA_URL)("compact read context, against a real database (QA)", () => {
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

  async function grantRead(agentId: string) {
    const scope = await db.scope.upsert({
      where: { orgId_path: { orgId: ORG, path: SALES } },
      update: {},
      create: { orgId: ORG, path: SALES, name: "sales" },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: scope.id, granteeType: "agent", granteeId: agentId, permission: "read" },
    });
  }

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

  // The full-mode baseline of this is change-notices.realdb.test.ts, "is not told what was
  // written while it was denied, once granted again". Here the denied agent's calls are
  // compact. The feed itself (memory_changes' own answer, its first content block) is what
  // is compared; the task-start block after it serves what is readable now, by design.
  it.each([
    ["full", undefined],
    ["compact", { "willder/context": "compact" }],
  ] as const)(
    "a %s reader denied its scope is not later told, by the feed, what was written while it was denied",
    async (_mode, meta) => {
      const token = await mintCapability(DENIED, SALES, true);
      const denied = await connectAs(DENIED, token, SALES);
      await writeBrief("written while denied");
      const whileDenied = await call(denied, "get_my_brief", { briefId: "no-such-brief" }, meta);
      expect(whileDenied.isError).toBe(true);

      await grantRead(DENIED);
      await writeBrief("written after grant");
      const feed = (await call(denied, "memory_changes", {})).content[0]!.text;

      expect(feed).toContain("written after grant");
      expect(feed).not.toContain("written while denied");
    },
  );

  // Full mode audits the denial once when it starts, beside each call's own denial row
  // (change-notices.realdb.test.ts, "writes one notice denial across many real tool calls").
  it.each([
    ["full", undefined],
    ["compact", { "willder/context": "compact" }],
  ] as const)("a %s reader's denial is audited when it starts", async (_mode, meta) => {
    const denied = await connectAs(DENIED, await mintCapability(DENIED, SALES, true), SALES);
    for (let i = 0; i < 3; i++) await call(denied, "get_my_brief", { briefId: "no-such-brief" }, meta);
    const rows = await db.auditLog.count({ where: { orgId: ORG, actorId: DENIED, decision: "deny" } });
    expect(rows).toBe(3 + 1);
  });

  it.each(["full", "compact"] as const)("a %s reader ends denial so a later revoke is audited again", async (mode) => {
    const denied = await connectAs(DENIED, await mintCapability(DENIED, SALES, true), SALES);
    const meta = { "willder/context": mode };
    await call(denied, "get_my_brief", { briefId: "missing" }, meta);
    await grantRead(DENIED);
    const recovered = await call(denied, "get_my_brief", { briefId: "missing" }, meta);
    expect(recovered.isError).not.toBe(true);
    await db.grant.deleteMany({ where: { orgId: ORG, granteeId: DENIED } });
    const deniedAgain = await call(denied, "get_my_brief", { briefId: "missing" }, meta);
    expect(deniedAgain.isError).toBe(true);
    expect(deniedAgain.content.map((part) => part.text).join("\n")).not.toContain("deferred");
    expect(await db.auditLog.count({ where: { orgId: ORG, actorId: DENIED, decision: "deny" } })).toBe(4);
  });

  it.each(["full", "compact"] as const)(
    "a %s reader widening scope sees only readable history after its retained position",
    async (mode) => {
      await createBrief(
        {
          orgId: ORG,
          type: "handoff",
          scopePath: `${ROOT}.engineering`,
          title: "earlier engineering change",
          summary: "s",
          sections: [],
        },
        { actorType: "agent", actorId: WRITER, origin: "agent-run" },
      );
      const narrow = await connectAs(READER, await mintCapability(READER, SALES), SALES);
      const first = await call(narrow, "get_my_brief", { briefId: "missing" }, { "willder/context": mode });
      expect(first.content.map((part) => part.text).join("\n")).not.toContain("earlier engineering change");
      const wider = await connectAs(READER, await mintCapability(READER, ROOT), ROOT);
      const feed = (await call(wider, "memory_changes", {}, { "willder/context": mode })).content[0]!.text;
      if (mode === "compact") expect(feed).toContain("earlier engineering change");
      else expect(feed).not.toContain("earlier engineering change");
    },
  );

  it("compact without task/session serves standing rules once before subsequent reads", async () => {
    const { recordConvention } = await import("@/services/memory/conventions");
    const token = await mintCapability(WRITER, SALES, false, "write");
    await recordConvention(
      { orgId: ORG, actor: { type: "agent", id: WRITER, capabilityToken: token }, origin: "mcp" },
      {
        kind: "convention",
        subject: "Release migrations",
        text: "Every migration needs a dry run first.",
        scopePath: SALES,
      },
    );
    const reader = await connectAs(READER, await mintCapability(READER, SALES), SALES);
    const first = await call(reader, "get_my_brief", { briefId: "missing" }, { "willder/context": "compact" });
    expect(first.content.map((part) => part.text).join("\n")).toContain("Every migration needs a dry run first.");
    const followup = await call(reader, "get_my_brief", { briefId: "missing" }, { "willder/context": "compact" });
    expect(followup.content.map((part) => part.text).join("\n")).not.toContain(
      "Every migration needs a dry run first.",
    );
  });

  it("measures tokens per read, full versus compact, on the same state", async () => {
    const writer = await connectAs(WRITER, await mintCapability(WRITER, SALES, false, "write"), SALES);
    // Records the reader's task can be served: decisions and a convention for this scope.
    const facts = [
      [
        "release-decision",
        "Decision: release 4.2 ships Thursday after the migration dry run; owner is the platform team.",
      ],
      [
        "release-convention",
        "Convention for release work: every migration is additive and gets a dry run on staging first.",
      ],
      ["release-rollback", "Rollback plan for release 4.2: revert the deploy and keep the additive columns in place."],
      ["release-risk", "Known risk for release 4.2: the billing webhook retries for an hour after a deploy."],
      ["release-owner", "The release captain for 4.2 is the platform on-call engineer of that week."],
    ];
    for (const [name, content] of facts) {
      const r = await call(writer, "memory_ingest", { name, content, scopePath: SALES });
      expect(r.isError, r.content[0]!.text).toBeFalsy();
    }
    // More than a thousand unread changes by another agent.
    for (let i = 0; i < 1_050; i++) await writeBrief(`backlog brief ${i}`);

    // memory_query reads a scope the org holds; and a rule in force for the task's scope.
    await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    await db.scope.create({ data: { orgId: ORG, path: SALES, name: "sales" } });
    const { recordConvention } = await import("@/services/memory/conventions");
    const author = await mintCapability(WRITER, SALES, false, "write");
    await recordConvention(
      { orgId: ORG, actor: { type: "agent", id: WRITER, capabilityToken: author }, origin: "mcp" as const },
      {
        kind: "convention",
        subject: "Release migrations",
        text: "Every migration is additive and gets a staging dry run first.",
        scopePath: SALES,
      },
    );
    const reader = await connectAs(READER, await mintCapability(READER, SALES), SALES);
    const query = { query: "When does release 4.2 ship and what is the rollback plan?", limit: 10 };
    const task = { "willder/task": "Prepare release 4.2" };
    const rows: string[] = [];
    const measure = async (
      label: string,
      meta: Record<string, unknown>,
      compactMeta: Record<string, unknown> = meta,
    ) => {
      const compact = await call(reader, "memory_query", query, { ...compactMeta, "willder/context": "compact" });
      // Both unnamed reads must begin before delivery: compact now serves rules too.
      if (!meta["willder/session"] && !compactMeta["willder/session"]) {
        await db.taskStartDelivery.deleteMany({ where: { orgId: ORG, agentId: READER } });
      }
      const full = await call(reader, "memory_query", query, meta);
      expect(compact.isError, `${label}: compact query failed`).not.toBe(true);
      expect(full.isError, `${label}: full query failed`).not.toBe(true);
      const primaryFull = full.content[0]!.text;
      expect(compact.content[0]!.text, `${label}: compact must not change the primary answer`).toBe(primaryFull);
      const total = (r: ToolResult) => r.content.reduce((n, c) => n + tokensOf(c.text), 0);
      rows.push(
        `${label}: primary=${tokensOf(primaryFull)} full=${total(full)} compact=${total(compact)} saved=${total(full) - total(compact)} (${Math.round((100 * (total(full) - total(compact))) / total(full))}%)`,
      );
      return { full, compact };
    };

    // A first read with no task/session: both serve the block; compact defers only notices.
    await measure("first read, nothing named", {});
    for (let i = 0; i < 20; i++) await writeBrief(`refill brief ${i}`);
    // A session's first read naming only the session: compact keeps the block, defers notices.
    await measure("first read, session named", { "willder/session": "s1" }, { "willder/session": "s0" });
    // Backlog refilled: the full read above consumed a page of it.
    for (let i = 0; i < 20; i++) await writeBrief(`second backlog brief ${i}`);
    // Follow-up read in an existing session: notices only.
    await measure("follow-up read", { "willder/session": "s1" });
    // A named task: compact keeps the block, so only notices are saved.
    for (let i = 0; i < 20; i++) await writeBrief(`third backlog brief ${i}`);
    // Compact claims its own session's block, so it gets a fresh session of its own.
    const named = await measure(
      "first read, named task",
      { "willder/session": "s2", ...task },
      { "willder/session": "s3", ...task },
    );
    expect(named.compact.content.length).toBeGreaterThan(1);

    // Keep measurements in the test log without requiring a local output fixture.
    console.info(rows.join("\n"));
    expect(rows).toHaveLength(4);
  }, 600_000);
});
