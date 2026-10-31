// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test Postgres;
// without it every test in this file is skipped, not failed.
//
// The served-vs-used log (services/memory/task-start-served.ts), through the real /api/mcp
// handler: what a block's serving logs, which later calls count as using a served item, and
// which never do. Two orgs share an agent id, a session key and an item id string; two scopes
// of one org are sibling prefixes (`.b` and `.bc`), so a filter written as a prefix match fails.
//
// Real: Postgres, capability tokens, check(), the task-start read, the delivery claim that logs
// the serving, the tool wrapper that records uses, memory_version and get_my_brief. Stood in:
// the ingest queue (unused here). Time: a serving is moved back with an UPDATE of its servedAt,
// so "a later call" needs no sleep; the call that served the block is never moved.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { hashCapabilityToken } from "@/services/access/capabilities";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

vi.mock("@/lib/inngest", () => ({ ingestMemory: vi.fn().mockResolvedValue(undefined) }));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG_A = "qa_served_a";
const ORG_B = "qa_served_b";
const SCOPE_A = `org_${ORG_A}.b`;
const SIBLING_A = `org_${ORG_A}.bc`;
const SCOPE_B = `org_${ORG_B}.b`;
const AGENT = "served-agent";
const OTHER_AGENT = "served-agent-2";
const TASK = "TASK-41";
const RULE_A = "qaservedrulea1";
const FACT_A = "qaservedfacta1";
const BRIEF_A = "qaservedbriefa1";
const RULE_SIBLING = "qaservedrulebc1";
const RULE_B = "qaservedruleb1";

describe.skipIf(!QA_URL)("the task-start served-vs-used log, through /api/mcp", () => {
  let db: PrismaClient;
  let POST: (typeof import("@/app/api/mcp/route"))["POST"];
  let pruneTaskStartLog: (typeof import("./task-start-served"))["pruneTaskStartLog"];
  let USE_AFTER_SERVE_MARGIN_MS: number;
  const tokens: Record<string, string> = {};

  async function reset(): Promise<void> {
    for (const orgId of [ORG_A, ORG_B]) {
      await db.taskStartItemUse.deleteMany({ where: { orgId } });
      await db.taskStartServedItem.deleteMany({ where: { orgId } });
      await db.taskStartDelivery.deleteMany({ where: { orgId } });
      await db.convention.deleteMany({ where: { orgId } });
      await db.auditLog.deleteMany({ where: { orgId } });
      await db.changeEvent.deleteMany({ where: { orgId } });
      await db.factVersionRead.deleteMany({ where: { orgId } });
      await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${orgId}`;
      await db.agentCursor.deleteMany({ where: { orgId } });
      await db.capability.deleteMany({ where: { orgId } });
      await deleteOrgsWithRetry(db, { where: { id: orgId } });
    }
  }

  async function capability(name: string, orgId: string, agentId: string, scopePath: string) {
    tokens[name] = `wcap_test_${name}_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId,
        agentId,
        tokenHash: hashCapabilityToken(tokens[name]!),
        scopePath,
        permission: "read",
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
  }

  let seq = 0;
  const event = (
    orgId: string,
    scopePath: string,
    recordType: string,
    recordId: string,
    summary: string,
    task: string | null = TASK,
  ) => ({
    id: randomUUID(),
    orgId,
    seq: BigInt(++seq),
    scopePath,
    recordType,
    recordId,
    op: "create" as const,
    actorId: "writer",
    summary,
    task,
  });

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ POST } = await import("@/app/api/mcp/route"));
    ({ pruneTaskStartLog, USE_AFTER_SERVE_MARGIN_MS } = await import("./task-start-served"));
  });

  afterAll(async () => {
    if (!db) return;
    await reset();
    await db.$disconnect();
  });

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await reset();
    for (const orgId of [ORG_A, ORG_B]) await db.org.create({ data: { id: orgId, name: orgId } });
    await capability("a", ORG_A, AGENT, SCOPE_A);
    await capability("a2", ORG_A, OTHER_AGENT, SCOPE_A);
    await capability("sibling", ORG_A, AGENT, SIBLING_A);
    await capability("b", ORG_B, AGENT, SCOPE_B);
    await db.convention.createMany({
      data: [
        {
          id: RULE_A,
          orgId: ORG_A,
          scopePath: SCOPE_A,
          kind: "convention",
          subject: "Deploy checklist",
          text: "Run the migration check before every release.",
          actorId: "author",
        },
        {
          id: RULE_SIBLING,
          orgId: ORG_A,
          scopePath: SIBLING_A,
          kind: "convention",
          subject: "Sibling rule",
          text: "Only the sibling scope sees this.",
          actorId: "author",
        },
        {
          id: RULE_B,
          orgId: ORG_B,
          scopePath: SCOPE_B,
          kind: "convention",
          subject: "Other org rule",
          text: "Only org B sees this.",
          actorId: "author",
        },
      ],
    });
    await db.memoryChunk.create({
      data: {
        id: FACT_A,
        orgId: ORG_A,
        scopePath: SCOPE_A,
        entityName: "Migration lock",
        content: "Root cause: the migration took a lock the deploy waited on.",
        actorId: "writer",
        actorType: "agent",
      },
    });
    await db.changeEvent.createMany({
      data: [
        event(ORG_A, SCOPE_A, "fact", FACT_A, "Root cause of the deploy hang"),
        event(ORG_A, SCOPE_A, "brief", BRIEF_A, `Handoff for ${TASK}`),
        // Org B holds a change about a record with org A's fact id: an id string is not an org's.
        event(ORG_B, SCOPE_B, "brief", FACT_A, `Unrelated record in org B for ${TASK}`),
      ],
    });
  });

  /** One tools/call on /api/mcp as `token`, in `session` when given, naming TASK. */
  async function call(
    token: string,
    name: string,
    args: Record<string, unknown>,
    session?: string,
  ): Promise<{ text: string; isError: boolean }> {
    const _meta: Record<string, string> = { "willder/task": TASK };
    if (session !== undefined) _meta["willder/session"] = session;
    const response = await POST(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args, _meta } }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { content: { text: string }[]; isError?: boolean } };
    return { text: body.result.content.map((c) => c.text).join("\n\n"), isError: body.result.isError === true };
  }

  const servedFor = (orgId: string, sessionKey: string) =>
    db.taskStartServedItem.findMany({
      where: { orgId, sessionKey },
      orderBy: [{ servedAt: "asc" }, { position: "asc" }, { namedId: "asc" }],
    });
  const usesFor = (orgId: string, sessionKey: string) =>
    db.taskStartItemUse.findMany({ where: { orgId, sessionKey }, orderBy: [{ namedId: "asc" }, { field: "asc" }] });
  /** Moves every serving of `sessionKey` back by `ms`, as if the block was served that long ago. */
  const servedAgo = (orgId: string, sessionKey: string, ms: number) =>
    db.$executeRaw`UPDATE "task_start_served" SET "servedAt" = "servedAt" - make_interval(secs => ${ms / 1000}::float8) WHERE "orgId" = ${orgId} AND "sessionKey" = ${sessionKey}`;

  it("logs each item line at the position the block's '- ' lines give it, naming what the line names", async () => {
    const { text } = await call(tokens.a!, "get_my_brief", { briefId: "no-such-brief" }, "s-pos");
    // The block is one run of lines; the change notices follow it after a blank line.
    const block = text.slice(text.indexOf("Before you start")).split("\n\n")[0]!;
    const itemLines = block.split("\n").filter((line) => line.startsWith("- "));
    const rows = await servedFor(ORG_A, "s-pos");

    expect(itemLines.length).toBeGreaterThanOrEqual(3);
    expect(new Set(rows.map((r) => r.servingId)).size).toBe(1);
    expect(Math.max(...rows.map((r) => r.position))).toBe(itemLines.length);
    for (const row of rows) expect(itemLines[row.position - 1]).toContain(row.namedId);
    expect(rows.every((r) => r.scopePath === SCOPE_A && r.taskKey === TASK && r.agentId === AGENT)).toBe(true);

    const byNamed = new Map(rows.map((r) => [r.namedId, r]));
    expect(byNamed.get(RULE_A)).toMatchObject({ itemType: "convention", itemId: RULE_A, versionId: null });
    // A change line names the record it changed, and shows the fact version a fact's create stored.
    expect(byNamed.get(BRIEF_A)).toMatchObject({ itemType: "change", versionId: null });
    expect(byNamed.get(BRIEF_A)!.itemId).not.toBe(BRIEF_A);
    expect(byNamed.get(FACT_A)).toMatchObject({ versionId: FACT_A });
    // Nothing of another scope or org.
    expect(rows.some((r) => [RULE_SIBLING, RULE_B].includes(r.namedId))).toBe(false);
  });

  it("logs no second serving for a session already served, and one serving under concurrent first calls", async () => {
    await call(tokens.a!, "get_my_brief", { briefId: "x" }, "s-once");
    await call(tokens.a!, "get_my_brief", { briefId: "x" }, "s-once");
    expect(new Set((await servedFor(ORG_A, "s-once")).map((r) => r.servingId)).size).toBe(1);

    await Promise.all(Array.from({ length: 8 }, () => call(tokens.a!, "get_my_brief", { briefId: "x" }, "s-race")));
    const raced = await servedFor(ORG_A, "s-race");
    expect(new Set(raced.map((r) => r.servingId)).size).toBe(1);
    expect(raced.length).toBe((await servedFor(ORG_A, "s-once")).length);
  });

  it("records a later call of the same session naming a served id, by the argument it was in, and its reply", async () => {
    await call(tokens.a!, "get_my_brief", { briefId: "x" }, "s-use");
    await servedAgo(ORG_A, "s-use", 10_000);
    await call(tokens.a!, "memory_version", { versionId: FACT_A }, "s-use");
    await call(tokens.a!, "get_my_brief", { briefId: RULE_A }, "s-use");

    // Each reply echoes the id it was asked for; the call had already named it, so one use, not two.
    const uses = await usesFor(ORG_A, "s-use");
    expect(uses.map((u) => [u.namedId, u.field])).toEqual([
      [FACT_A, "versionId"],
      [RULE_A, "briefId"],
    ]);
    expect(uses.find((u) => u.namedId === FACT_A)!.versionId).toBe(FACT_A);
    expect(uses.every((u) => u.agentId === AGENT)).toBe(true);
  });

  it("records a served id the tool's own reply returned without the call naming it, as a result", async () => {
    await call(tokens.a!, "get_my_brief", { briefId: "x" }, "s-result");
    await servedAgo(ORG_A, "s-result", 10_000);
    await db.changeEvent.create({
      data: {
        ...event(ORG_A, SCOPE_A, "fact", FACT_A, "Updated root cause", null),
        op: "update",
        actorId: "someone-else",
      },
    });
    // memory_changes is itself the change feed: the line naming the fact is its own reply.
    const { text } = await call(tokens.a!, "memory_changes", {}, "s-result");
    expect(text).toContain(FACT_A);
    expect((await usesFor(ORG_A, "s-result")).map((u) => [u.namedId, u.field])).toEqual([[FACT_A, "result"]]);
  });

  it("never counts the call that served the block, nor a call sent within the margin after it", async () => {
    // The first call of a session names the fact: its own block serves the fact, after the call began.
    await call(tokens.a!, "memory_version", { versionId: FACT_A }, "s-same");
    expect((await servedFor(ORG_A, "s-same")).some((r) => r.namedId === FACT_A)).toBe(true);
    expect(await usesFor(ORG_A, "s-same")).toEqual([]);

    // A call that began half the margin after the serving: sent before the block could be read.
    await servedAgo(ORG_A, "s-same", USE_AFTER_SERVE_MARGIN_MS / 2);
    await call(tokens.a!, "memory_version", { versionId: FACT_A }, "s-same");
    expect(await usesFor(ORG_A, "s-same")).toEqual([]);
  });

  it("never counts a use by another session, another agent, another org, or a session with no name", async () => {
    await call(tokens.a!, "get_my_brief", { briefId: "x" }, "s-shared");
    await call(tokens.b!, "get_my_brief", { briefId: "x" }, "s-shared");
    await call(tokens.a!, "get_my_brief", { briefId: "x" });
    for (const orgId of [ORG_A, ORG_B]) {
      await servedAgo(orgId, "s-shared", 10_000);
      await servedAgo(orgId, "", 10_000);
    }

    await call(tokens.a!, "get_my_brief", { briefId: RULE_A }, "s-never-served");
    await call(tokens.a2!, "get_my_brief", { briefId: RULE_A }, "s-shared");
    // Org B's agent, with org A's session key, names org A's rule and the id string both orgs hold.
    await call(tokens.b!, "get_my_brief", { briefId: `${RULE_A} ${FACT_A}` }, "s-shared");
    await call(tokens.a!, "get_my_brief", { briefId: RULE_A });

    expect(await usesFor(ORG_A, "s-never-served")).toEqual([]);
    expect(await usesFor(ORG_A, "s-shared")).toEqual([]);
    expect(await usesFor(ORG_A, "")).toEqual([]);
    expect((await servedFor(ORG_A, "")).length).toBeGreaterThan(0);
    // Org B's own serving named FACT_A as a change line; its session named it, so org B counts it, once.
    expect((await usesFor(ORG_B, "s-shared")).map((u) => [u.namedId, u.agentId])).toEqual([[FACT_A, AGENT]]);
  });

  it("matches an id only as a whole token, never inside a longer id", async () => {
    await call(tokens.a!, "get_my_brief", { briefId: "x" }, "s-whole");
    await servedAgo(ORG_A, "s-whole", 10_000);
    for (const briefId of [`${RULE_A}x`, `x${RULE_A}`, `${RULE_A}-2`, `${RULE_A}_old`, RULE_A.toUpperCase()]) {
      await call(tokens.a!, "get_my_brief", { briefId }, "s-whole");
    }
    expect(await usesFor(ORG_A, "s-whole")).toEqual([]);
    await call(tokens.a!, "get_my_brief", { briefId: `see (${RULE_A}).` }, "s-whole");
    expect((await usesFor(ORG_A, "s-whole")).map((u) => u.namedId)).toEqual([RULE_A]);
  });

  it("reads the tool's own reply, not the change notices appended to it", async () => {
    await call(tokens.a!, "get_my_brief", { briefId: "x" }, "s-notice");
    await servedAgo(ORG_A, "s-notice", 10_000);
    // Another writer changes the served fact: the next call's notice names it.
    await db.changeEvent.create({
      data: {
        ...event(ORG_A, SCOPE_A, "fact", FACT_A, "Updated root cause", null),
        op: "update",
        actorId: "someone-else",
      },
    });
    const { text } = await call(tokens.a!, "get_my_brief", { briefId: "unrelated" }, "s-notice");
    expect(text).toContain(FACT_A);
    expect(await usesFor(ORG_A, "s-notice")).toEqual([]);
  });

  it("records nothing for a call that failed", async () => {
    await call(tokens.a!, "get_my_brief", { briefId: "x" }, "s-error");
    await servedAgo(ORG_A, "s-error", 10_000);
    // The handler runs and the store refuses the NUL: an error reply, whatever the call named.
    const { isError, text } = await call(tokens.a!, "memory_version", { versionId: `${RULE_A}\u0000` }, "s-error");
    expect(isError).toBe(true);
    expect(text).not.toContain("Before you start");
    expect(await usesFor(ORG_A, "s-error")).toEqual([]);
    // The same id in a call that succeeds is a use: the refusal, not the id, is why nothing was recorded.
    await call(tokens.a!, "get_my_brief", { briefId: RULE_A }, "s-error");
    expect((await usesFor(ORG_A, "s-error")).map((u) => u.namedId)).toEqual([RULE_A]);
  });

  it("keeps a served version's rows only while the version exists", async () => {
    await call(tokens.a!, "get_my_brief", { briefId: "x" }, "s-gone");
    await servedAgo(ORG_A, "s-gone", 10_000);
    await call(tokens.a!, "memory_version", { versionId: FACT_A }, "s-gone");
    expect((await usesFor(ORG_A, "s-gone")).length).toBeGreaterThan(0);

    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG_A} AND id = ${FACT_A}`;
    expect((await servedFor(ORG_A, "s-gone")).some((r) => r.versionId === FACT_A)).toBe(false);
    expect(await usesFor(ORG_A, "s-gone")).toEqual([]);
    expect((await servedFor(ORG_A, "s-gone")).some((r) => r.namedId === RULE_A)).toBe(true);
  });

  it("prunes rows older than the retention in every org, and keeps the rest", async () => {
    await call(tokens.a!, "get_my_brief", { briefId: "x" }, "s-old");
    await call(tokens.b!, "get_my_brief", { briefId: "x" }, "s-old");
    await call(tokens.a!, "get_my_brief", { briefId: "x" }, "s-new");
    for (const orgId of [ORG_A, ORG_B]) await servedAgo(orgId, "s-old", 91 * 86_400_000);
    await servedAgo(ORG_A, "s-new", 89 * 86_400_000);
    await db.taskStartItemUse.create({
      data: {
        orgId: ORG_A,
        agentId: AGENT,
        sessionKey: "s-old",
        namedId: RULE_A,
        field: "briefId",
        calledAt: new Date(Date.now() - 91 * 86_400_000),
      },
    });
    await db.taskStartItemUse.create({
      data: {
        orgId: ORG_A,
        agentId: AGENT,
        sessionKey: "s-new",
        namedId: RULE_A,
        field: "briefId",
        calledAt: new Date(Date.now() - 89 * 86_400_000),
      },
    });

    const pruned = await pruneTaskStartLog();
    expect(pruned.uses).toBe(1);
    expect(pruned.served).toBeGreaterThan(0);
    expect(await servedFor(ORG_A, "s-old")).toEqual([]);
    expect(await servedFor(ORG_B, "s-old")).toEqual([]);
    expect((await servedFor(ORG_A, "s-new")).length).toBeGreaterThan(0);
    expect((await usesFor(ORG_A, "s-new")).length).toBe(1);
    await expect(pruneTaskStartLog(0)).rejects.toThrow(/at least 1/);
    await expect(pruneTaskStartLog(Number.NaN)).rejects.toThrow(/at least 1/);
  });
});
