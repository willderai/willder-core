// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A plan's status against the task-start read limits.
//
// A plan of the task's own is labelled by what its own session's capture recorded after it,
// linked by the session key both change events carry (services/memory/claim-status.ts). The
// captures read stops at 50, so these pin that another session's capture never decides it, and
// that past the limit it is proposed rather than labelled from the newest 50.
//
// Real: the hosted MCP endpoint over a socket, check() against live capabilities, the
// write-through store into Postgres and the task-start read. Captures are written as the hook
// writes them (renderSessionState, sessionStateName). A fake memory service answers the
// embedding call with one fixed vector and the graph with nothing.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the `@/lib/db`
// singleton at import time, before beforeAll points DATABASE_URL at the test database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import { renderSessionState, sessionStateName } from "@/cli/hooks/willder-capture.mjs";
import { EmptyGraphMemoryService } from "./memory-service-stub.testsupport";
import { TASK_START_HEADINGS } from "./task-start-headings";

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
const ORG = "planlimitqa";
const ROOT = `org_${ORG}`;
const WEB = `${ROOT}.web`;

describe.skipIf(!QA_URL)("the untested-plan label against the task-start read limit, against a real database", () => {
  const service = new EmptyGraphMemoryService();
  const clients: Client[] = [];
  let db: PrismaClient;
  let mcpUrl: string;
  let closeMcp: () => Promise<void>;
  let ClientClass: (typeof import("@modelcontextprotocol/sdk/client/index.js"))["Client"];
  let Transport: (typeof import("@modelcontextprotocol/sdk/client/streamableHttp.js"))["StreamableHTTPClientTransport"];
  const tokens: Record<string, string> = {};
  let sessions = 0;

  async function mint(agentId: string, permission: "read" | "write", scopePath = WEB): Promise<string> {
    const token = `wcap_test_${agentId}_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath,
        permission,
        grantGoverned: false,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return token;
  }

  async function connect(token: string, name: string): Promise<Client> {
    const client: Client = new ClientClass({ name, version: "0.0.0" });
    await client.connect(
      new Transport(new URL(mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
    );
    clients.push(client);
    return client;
  }

  async function call(client: Client, name: string, args: Record<string, unknown>, meta: Record<string, string>) {
    const result = await client.callTool({ name, arguments: args, _meta: meta });
    return (result.content as { text?: string }[]).map((part) => part.text ?? "");
  }

  /** The session agent A writes its plan in, and that its capture names when it is the same session. */
  const sessionOf = (task: string) => `a-${task}`;

  /** Agent A's explicit write on `task`, as an MCP client naming the task and its session sends it. */
  async function record(client: Client, task: string, args: Record<string, unknown>) {
    const [reply] = await call(client, "memory_ingest", args, {
      "willder/session": sessionOf(task),
      "willder/task": task,
    });
    expect(reply).not.toMatch(/denied|error/i);
  }

  /** A capture as the hook writes it: its name, text and role, marked, naming the task and session. */
  async function capture(
    client: Client,
    task: string,
    session: string,
    test: Parameters<typeof renderSessionState>[0]["test"],
    { files = ["next.config.ts"], lastMessage = "Stopped." }: { files?: string[]; lastMessage?: string } = {},
  ) {
    const content = renderSessionState({ trigger: "Stop", task, files, testFilesAfterRun: [], test, lastMessage });
    const [reply] = await call(
      client,
      "memory_ingest",
      { name: sessionStateName(task, session), content, role: "progress" },
      { "willder/capture": "session-state", "willder/session": session, "willder/task": task },
    );
    expect(reply).toMatch(/Version: /);
  }

  /** A passing run of the test the plan names, as the hook records it, at this instant. */
  const passingRun = () =>
    ({
      command: "npx vitest run next.config.redirects.test.ts",
      passed: true,
      line: "Tests  3 passed (3)",
      at: new Date().toISOString(),
      edited: { files: [], named: [] },
      existing: [],
    }) as never;

  /** Agent B's first block on `task`: a fresh session that asks one memory_query. */
  async function blockFor(task: string): Promise<string> {
    const b = await connect(tokens.b!, `agent-b-${++sessions}`);
    const [, ...extra] = await call(
      b,
      "memory_query",
      { query: "Where did this task leave off?" },
      { "willder/session": `b-${sessions}`, "willder/task": task },
    );
    const served = extra.find((text) => text.startsWith("Before you start")) ?? "";
    // The change notices that may ride after it are the change feed's, not the block's.
    return served.split("\n\nChanged in your scope since your last call:")[0]!;
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

    await db.org.deleteMany({ where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: ORG } });
    for (const path of [ROOT, WEB]) await db.scope.create({ data: { orgId: ORG, path, name: path } });
    tokens.a = await mint("handoff-agent-a", "write");
    tokens.b = await mint("handoff-agent-b", "read");
  }, 120_000);

  afterAll(async () => {
    if (QA_URL === undefined) return;
    await Promise.all(clients.map((client) => client.close()));
    await closeMcp?.();
    await service.stop();
    await db.org.deleteMany({ where: { id: ORG } });
    await db.$disconnect();
  });

  const PLAN = "PLAN: gate the redirect in next.config.ts. Command: npx vitest run next.config.redirects.test.ts";
  const planLineOf = (block: string) => block.split("\n").find((line) => line.includes("gate the redirect")) ?? "";

  it("labels a plan untested from its own session's capture, linked by the session both writes recorded", async () => {
    const task = "T-qa-phase1-own";
    const a = await connect(tokens.a!, "agent-a-own");
    await record(a, task, { name: "own plan", role: "decision", content: PLAN });
    await capture(a, task, sessionOf(task), undefined);
    expect(planLineOf(await blockFor(task))).toMatch(
      /^- \[untested plan: verify before following · its session ran no tests, as captured\] /,
    );
    // The link is the recorded session, not a guess: both change events carry it.
    const events = await db.changeEvent.findMany({ where: { orgId: ORG, task }, select: { sessionKey: true } });
    expect(new Set(events.map((e) => e.sessionKey))).toEqual(new Set([sessionOf(task)]));
  });

  it("labels a decision recorded as a rule by its own session's capture too, the rule's change event carrying the session", async () => {
    const task = "T-qa-phase1-rule";
    const a = await connect(tokens.a!, "agent-a-rule");
    await record(a, task, { name: "redirect approach", kind: "decision", content: PLAN });
    await capture(a, task, sessionOf(task), undefined);
    const decisionLine = (await blockFor(task)).split("\n").find((line) => line.startsWith("- [decision ")) ?? "";
    expect(decisionLine).toMatch(
      /^- \[decision \S+\] \[untested plan: verify before following · its session ran no tests, as captured\] redirect approach: /,
    );
    const ruleEvents = await db.changeEvent.findMany({
      where: { orgId: ORG, task, recordType: "convention" },
      select: { sessionKey: true },
    });
    expect(ruleEvents.map((e) => e.sessionKey)).toEqual([sessionOf(task)]);
  });

  it("serves a plan its own session tested after it, on a file it names, as tested, and still a lead", async () => {
    const task = "T-qa-phase1-tested";
    const a = await connect(tokens.a!, "agent-a-tested");
    await record(a, task, { name: "tested plan", role: "decision", content: PLAN });
    await capture(a, task, sessionOf(task), passingRun(), {
      files: ["next.config.ts", "next.config.redirects.test.ts"],
    });
    const block = await blockFor(task);
    expect(planLineOf(block)).toMatch(
      /^- \[decision · tested: its session's tests passed after it, on files it names\] /,
    );
    expect(block).not.toContain(TASK_START_HEADINGS.settled);
  });

  it("never lets another session's capture decide a plan: a passing run elsewhere neither tests it nor a silent one leaves it untested", async () => {
    const task = "T-qa-phase1-other";
    const a = await connect(tokens.a!, "agent-a-other");
    await record(a, task, { name: "other plan", role: "decision", content: PLAN });
    await capture(a, task, "s-another-session", passingRun(), {
      files: ["next.config.ts", "next.config.redirects.test.ts"],
    });
    await capture(a, task, "s-third-session", undefined);
    expect(planLineOf(await blockFor(task))).toMatch(/^- \[untested plan: verify before following\] /);
  });

  it("decides from its own session's capture though fifty other sessions captured after it, within the read's limit", async () => {
    const task = "T-qa-phase1-crowd";
    const a = await connect(tokens.a!, "agent-a-crowd");
    await record(a, task, { name: "crowd plan", role: "decision", content: PLAN });
    // Forty-nine others, then its own: the read's fifty newest hold it.
    for (let i = 0; i < 49; i++)
      await capture(a, task, `s${String(i).padStart(3, "0")}xxxx`, passingRun(), { files: ["next.config.ts"] });
    await capture(a, task, sessionOf(task), undefined);
    expect(planLineOf(await blockFor(task))).toMatch(/^- \[untested plan: verify before following · /);
  }, 180_000);

  it("is proposed, never untested by another session's silence, when its own capture is past the read's limit", async () => {
    const task = "T-qa-phase1-limit";
    const a = await connect(tokens.a!, "agent-a-limit");
    await record(a, task, { name: "limit plan", role: "decision", content: PLAN });
    await capture(a, task, sessionOf(task), passingRun(), {
      files: ["next.config.ts", "next.config.redirects.test.ts"],
    });
    for (let i = 0; i < 50; i++) await capture(a, task, `s${String(i).padStart(3, "0")}xxxx`, undefined);
    expect(planLineOf(await blockFor(task))).toMatch(/^- \[untested plan: verify before following\] /);
  }, 180_000);
});
