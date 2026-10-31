// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The task-start block serves what decides a task before what
// only records how far it got, when the writers said which is which (memory_ingest's
// optional `role`, services/memory/fact-roles.ts).
//
// The workflow: agent A works task PAY-88 (refunds posted twice). Early in the session it
// records the decision it made, then the cause it found, then a long tail of progress
// notes, and a few facts without a role. Agent B picks the task up in a fresh session.
// Ranked without roles, B's block would open on A's last progress notes and the decision,
// written first, would fall past the task's fact limit. B must be served the cause and
// the decision first. A second task whose writer never declares a role, read with words that
// rank none of its facts above another, must be served newest first, as before roles existed.
//
// Real: the hosted MCP endpoint over a socket, one MCP session per agent, check() against
// live capabilities, the write-through store into Postgres and the task-start read. A
// fake memory service answers the embedding call with one fixed vector and the graph
// with nothing; the queue is a no-op, since graph extraction is not what is measured here.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the `@/lib/db`
// singleton at import time, before beforeAll points DATABASE_URL at the test database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import { EmptyGraphMemoryService } from "./memory-service-stub.testsupport";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
}));
vi.mock("@/lib/llm", () => ({
  createLLMClient: () => ({
    chat: {
      completions: {
        create: async () => {
          throw new Error("no llm in this test");
        },
      },
    },
  }),
  LLM_MODEL_EXTRACT: "test-model",
  LLM_MODEL_ORCHESTRATOR: "test-model",
}));

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "factrole";
const ROOT = `org_${ORG}`;
const PAYMENTS = `${ROOT}.payments`;

const TASK = "PAY-88";
/** A task whose writer declares no role on any write. */
const NO_ROLE_TASK = "PAY-91";

const DECISION = {
  name: "Refund dedupe",
  content: "Dedupe refunds on the processor's refund id, never on the order id.",
  role: "decision",
};
const CAUSE = {
  name: "Double refunds",
  content: "Refunds post twice because the retry job re-sends after a gateway timeout.",
  role: "cause",
};
/** More progress notes than the task's fact limit, so newest-first alone would drop the decision. */
const PROGRESS = Array.from({ length: 24 }, (_, i) => ({
  name: `Refund backfill step ${i}`,
  content: `Backfill step ${i}: reconciled batch ${i} of the October refunds.`,
  role: "progress",
}));
const NO_ROLE = Array.from({ length: 3 }, (_, i) => ({
  name: `Refund note ${i}`,
  content: `Refund note ${i}: support forwarded ${i + 2} more double-refund tickets.`,
}));
/** A task whose fact with no role is written before its progress notes, so recency alone would serve it last. */
const EARLY_NO_ROLE_TASK = "PAY-93";
const EARLY_NO_ROLE = {
  name: "Chargeback note",
  content: "Chargebacks on refunded orders are filed by the card network, not by us.",
};
const LATE_PROGRESS = Array.from({ length: 3 }, (_, i) => ({
  name: `Chargeback step ${i}`,
  content: `Chargeback step ${i}: matched ${i + 1} chargebacks to their refunds.`,
  role: "progress",
}));
const UNRANKED = Array.from({ length: 5 }, (_, i) => ({
  name: `Payout note ${i}`,
  content: `Payout note ${i}: the payout export ran ${i + 1} minutes late.`,
}));

describe.skipIf(!QA_URL)("a task's deciding facts are served before its progress notes", () => {
  const service = new EmptyGraphMemoryService();
  const clients: Client[] = [];
  let db: PrismaClient;
  let mcpUrl: string;
  let closeMcp: () => Promise<void>;
  let ClientClass: (typeof import("@modelcontextprotocol/sdk/client/index.js"))["Client"];
  let Transport: (typeof import("@modelcontextprotocol/sdk/client/streamableHttp.js"))["StreamableHTTPClientTransport"];

  /** The fact lines of B's block, in order. */
  let handoffFacts: string[];
  let noRoleFacts: string[];
  let earlyNoRoleFacts: string[];
  let writer: Client;

  async function connect(agentId: string): Promise<Client> {
    const token = `wcap_test_${agentId}_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath: PAYMENTS,
        permission: "write",
        grantGoverned: false,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const client: Client = new ClientClass({ name: agentId, version: "0.0.0" });
    await client.connect(
      new Transport(new URL(mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
    );
    clients.push(client);
    return client;
  }

  async function call(
    client: Client,
    name: string,
    args: Record<string, unknown>,
    meta: { session: string; task?: string },
  ) {
    const _meta: Record<string, string> = { "willder/session": meta.session };
    if (meta.task !== undefined) _meta["willder/task"] = meta.task;
    const result = await client.callTool({ name, arguments: args, _meta });
    const [answer = "", ...extra] = (result.content as { text?: string }[]).map((part) => part.text ?? "");
    return { isError: Boolean(result.isError), answer, extra };
  }

  async function ingest(
    client: Client,
    args: Record<string, unknown>,
    meta: { session: string; task?: string },
  ): Promise<void> {
    const { isError, answer } = await call(client, "memory_ingest", args, meta);
    expect(isError, answer).toBe(false);
  }

  /**
   * The line the block serves for `fact`, with the version id and day `line` shows: status, text, id, name and source. No
   * capture of the writing session backs any of these (services/memory/claim-status.ts), so a cause or
   * a constraint is served as its role, a decision as an untested plan, and anything else as a plan;
   * the role still orders them.
   */
  const labelOf = (role?: string) =>
    role === "cause" || role === "constraint"
      ? `[${role} · proposed]`
      : role === "decision"
        ? "[untested plan: verify before following]"
        : "[plan · proposed]";
  const factLine = (line: string, fact: { name: string; content: string; role?: string }) =>
    `- ${labelOf(fact.role)} ${fact.content} [fact ${line.match(/\[fact (\S+)\]/)?.[1]}] ${fact.name} — agent-a, ${line.match(/, (\d\d-\d\d)$/)?.[1]}`;

  /** The fact lines of the task-start block a fresh session of `task` is served. */
  async function factLinesServedTo(agentId: string, task: string): Promise<string[]> {
    const { extra } = await call(
      await connect(agentId),
      "memory_query",
      { query: "Where did the refunds work leave off?" },
      { session: `${agentId}-1`, task },
    );
    const block =
      extra.find((text) => text.startsWith("Before you start"))?.split("\n\nChanged in your scope")[0] ?? "";
    return block.split("\n").filter((line) => line.startsWith("- ") && line.includes(" [fact "));
  }

  beforeAll(async () => {
    if (QA_URL === undefined) return;
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    process.env.GRAPHITI_SERVICE_URL = await service.start();
    process.env.GRAPHITI_SERVICE_API_KEY = "test-key";
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });

    const inngestModule = await import("@/lib/inngest");
    vi.spyOn(inngestModule.inngest, "send").mockImplementation((async () => ({ ids: ["job"] })) as never);
    ({ Client: ClientClass } = await import("@modelcontextprotocol/sdk/client/index.js"));
    ({ StreamableHTTPClientTransport: Transport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js"));
    const { startMcpTestServer } = await import("./http-test-server");
    const mcp = await startMcpTestServer();
    mcpUrl = mcp.url;
    closeMcp = mcp.close;

    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: ORG } });
    for (const path of [ROOT, PAYMENTS]) await db.scope.create({ data: { orgId: ORG, path, name: path } });

    // In write order: the decision first, the cause, the progress tail, then facts with no role.
    writer = await connect("agent-a");
    const onTask = { session: "a-1", task: TASK };
    for (const fact of [DECISION, CAUSE, ...PROGRESS, ...NO_ROLE]) await ingest(writer, fact, onTask);
    for (const fact of UNRANKED) await ingest(writer, fact, { session: "a-2", task: NO_ROLE_TASK });

    for (const fact of [EARLY_NO_ROLE, ...LATE_PROGRESS])
      await ingest(writer, fact, { session: "a-4", task: EARLY_NO_ROLE_TASK });

    handoffFacts = await factLinesServedTo("agent-b", TASK);
    earlyNoRoleFacts = await factLinesServedTo("agent-d", EARLY_NO_ROLE_TASK);
    noRoleFacts = await factLinesServedTo("agent-c", NO_ROLE_TASK);
  }, 120_000);

  afterAll(async () => {
    if (QA_URL === undefined) return;
    await Promise.all(clients.map((client) => client.close()));
    await closeMcp?.();
    await service.stop();
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.$disconnect();
  });

  it("stores each declared role on the fact's version, and none where the writer declared none", async () => {
    const rows = await db.memoryChunk.findMany({ where: { orgId: ORG }, select: { entityName: true, role: true } });
    const roleOf = new Map(rows.map((row) => [row.entityName, row.role]));
    expect(roleOf.get(DECISION.name)).toBe("decision");
    expect(roleOf.get(CAUSE.name)).toBe("cause");
    expect(roleOf.get(PROGRESS[0]!.name)).toBe("progress");
    expect(roleOf.get(NO_ROLE[0]!.name)).toBeNull();
    expect(roleOf.get(UNRANKED[0]!.name)).toBeNull();
  });

  it("serves the cause and the decision first, though the decision was written first and the progress tail outnumbers the fact limit", () => {
    expect(handoffFacts.length).toBeGreaterThanOrEqual(3);
    // Both decide the task; the cause, a finding, comes before the decision, a plan nothing tested.
    expect(handoffFacts[0]).toBe(factLine(handoffFacts[0]!, CAUSE));
    expect(handoffFacts[1]).toBe(factLine(handoffFacts[1]!, DECISION));
  });

  it("serves facts with no role after the deciding ones and before any progress note", () => {
    const at = (text: string) => handoffFacts.findIndex((line) => line.includes(text));
    const noRoleAt = NO_ROLE.map((fact) => at(fact.content)).filter((i) => i >= 0);
    const progressAt = PROGRESS.map((fact) => at(fact.content)).filter((i) => i >= 0);
    // Newest first among the facts with no role, all three ahead of the first progress note.
    expect(noRoleAt).toEqual([4, 3, 2]);
    expect(progressAt.length).toBeGreaterThan(0);
    expect(Math.min(...progressAt)).toBe(5);
  });

  it("serves a fact with no role ahead of progress notes written after it", () => {
    expect(earlyNoRoleFacts).toHaveLength(1 + LATE_PROGRESS.length);
    expect(earlyNoRoleFacts[0]).toBe(factLine(earlyNoRoleFacts[0]!, EARLY_NO_ROLE));
    expect(earlyNoRoleFacts.slice(1).every((line) => LATE_PROGRESS.some((fact) => line.includes(fact.content)))).toBe(
      true,
    );
  });

  it("serves a task whose writer declared no role newest first, as before roles existed", () => {
    expect(noRoleFacts).toHaveLength(UNRANKED.length);
    noRoleFacts.forEach((line, i) => {
      const fact = UNRANKED[UNRANKED.length - 1 - i]!;
      expect(line).toBe(factLine(line, fact));
    });
  });

  it("refuses a role on a convention or decision, which is already a rule", async () => {
    const { isError, answer } = await call(
      writer,
      "memory_ingest",
      {
        name: "Refund policy",
        content: "Refunds over 500 USD need a second approver.",
        kind: "decision",
        role: "decision",
      },
      { session: "a-3" },
    );
    expect(isError).toBe(true);
    expect(answer).toContain("role is for a fact");
    expect(await db.convention.count({ where: { orgId: ORG } })).toBe(0);
  });

  it("refuses a role that is not one of the five", async () => {
    const { isError } = await call(
      writer,
      "memory_ingest",
      { name: "Refund guess", content: "Maybe it is the cron.", role: "hunch" },
      { session: "a-3" },
    );
    expect(isError).toBe(true);
    expect(await db.memoryChunk.count({ where: { orgId: ORG, entityName: "Refund guess" } })).toBe(0);
  });

  it("refuses an idempotency key retried with a different role, as with any other changed argument", async () => {
    const write = {
      name: "Refund owner",
      content: "The payments on-call owns the refund backfill.",
      idempotencyKey: "a-3-owner",
    };
    await ingest(writer, { ...write, role: "decision" }, { session: "a-3" });
    const retried = await call(writer, "memory_ingest", { ...write, role: "progress" }, { session: "a-3" });
    expect(retried.isError).toBe(true);
    expect(retried.answer).toContain("already used for a different write");
  });
});
