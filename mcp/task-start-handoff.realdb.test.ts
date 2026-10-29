// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A handoff between two agents on one task, through the task-start block.
//
// The workflow: agent A works task WEB-412 (duplicate orders from a checkout webhook) in
// one session, recording a decision and the facts it established, changing its mind on
// one of them and having another corrected by a reviewer. It also writes notes on the
// same task into scopes the next agent may not read. Agent B then starts the same task
// in a fresh session and calls the tool it was going to call anyway. B's first result
// must carry what decides the task: A's decision and the current version of every fact
// A touched, inside the block's budget, and nothing B may not read. An agent starting a
// different task in the same scope must not be handed A's facts.
//
// The scope is crowded the way a team's real scope is: two dozen standing rules and a
// hundred and twenty notes from four other agents on other tasks, one of them a task key
// that is a prefix of A's, written while A is working. Before this behaviour the block
// was the same for every task in such a scope: the standing rules filled the budget and
// none of A's facts, which never mention the task key, were served.
//
// Real: the hosted MCP endpoint over a socket, one MCP session per agent, check()
// against live capabilities, the write-through store into Postgres, the winner rule and
// based updates under the per-org lock, and the task-start read. A fake memory
// service answers the embedding call with one fixed vector and the graph search with
// nothing; the queue is a no-op, since graph extraction is not what is measured here.
// Not simulated: a revoke mid-run, out-of-order timestamps, and a real recorded agent
// session (the notes are scripted).
//
// The second suite below calls the task-start read directly on seeded rows, to pin the
// filters on the task sections that the handoff above never exercises.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withoutSources } from "./task-start-headings";
import { PrismaPg } from "@prisma/adapter-pg";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the `@/lib/db`
// singleton at import time, before beforeAll points DATABASE_URL at the test database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import { CONFLICT_OPENING, TASK_START_PREMISE_CHECK } from "./task-start-headings";

// This suite moves one agent across sibling or parent and child scopes in one session, which
// the derived-write rule refuses by design; that rule is tested in mcp/derived-write.realdb.test.ts.
vi.mock("@/services/access/derived-writes", () => import("@/services/access/derived-writes.testsupport"));
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
const ORG = "handoff";
const ROOT = `org_${ORG}`;
/** The team scope both agents work in. */
const WEB = `${ROOT}.web`;
/** A sibling of `web`, not a descendant: an unescaped prefix match would take it in. */
const WEB_INTERNAL = `${ROOT}.web_internal`;
const FINANCE = `${ROOT}.finance`;

const TASK = "WEB-412";
/** Another task whose key is a prefix of TASK's. */
const PREFIX_TASK = "WEB-41";
const UNRELATED_TASK = "WEB-377";

/** A's decision as first recorded, then as the team lead replaced it. */
const DECISION_FIRST = {
  name: "Webhook retry policy",
  content: "Retry a failed Stripe webhook up to 3 times, one minute apart.",
};
const DECISION = {
  name: "Webhook retry policy",
  content:
    "Retry a failed Stripe webhook with exponential backoff, at most 5 attempts; never retry a 4xx other than 429.",
};
const ROOT_CAUSE = {
  name: "Duplicate orders",
  content:
    "Duplicate orders come from the checkout webhook acknowledging Stripe only after the order insert; Stripe retries on the timeout and the handler is not idempotent.",
};
const IDEMPOTENCY_KEY = {
  name: "Webhook idempotency key",
  content:
    "Use the Stripe event id as the idempotency key, stored in processed_webhook_events under a unique index; a duplicate insert means the event was already handled.",
};
const RELEASE_PLAN = "Release plan";
const RELEASE_PLAN_FIRST = "Ship the fix behind CHECKOUT_WEBHOOK_V2 on Thursday.";
const RELEASE_PLAN_NOW = "Ship the fix behind CHECKOUT_WEBHOOK_V2 on Monday, after the payments freeze lifts.";
const TEST_COMMAND = "Webhook test command";
const TEST_COMMAND_FIRST = "Run the webhook tests with the default npm script before pushing.";
const TEST_COMMAND_NOW =
  "Run npx vitest run app/api/webhooks with QA_DATABASE_URL set; the default npm script skips the database suite.";
/** Written by A and by the reviewer at the same moment: the winner rule keeps one current. */
const ROLLOUT_OWNER = "Rollout owner";
const ROLLOUT_OWNER_CLAIMS = ["Agent A owns the rollout until Monday.", "The payments on-call owns the rollout."];
/** An oversized, non-ASCII note: served cut short, never split mid-character, never dropped for its size. */
const MERCHANT_LOGS = {
  name: "Händler-Logs (Zahlungen)",
  content: `Die Händler-Logs zeigen doppelte Zahlungen für Bestellungen zwischen 02:00 und 02:15 UTC — ${"Bestellung ✓ bestätigt, Zahlung erneut gebucht. ".repeat(14)}`,
};

/** Written on the same task into scopes B cannot read. */
const SIBLING_NOTE = {
  name: "Duplicate orders",
  content: "Internal only: Acme lost 4,210 USD to duplicate charges; do not share outside the team.",
};
const FINANCE_NOTE = {
  name: "Refund batch",
  content: "Finance refunded 37 duplicate charges on 2026-10-06 from the reserve account.",
};

/** The team's standing rules: what any agent in the scope is told, whatever its task. */
const STANDING_RULES: [subject: string, text: string][] = [
  ["Pull requests", "Keep each change small enough to review in fifteen minutes and say what it does not prove."],
  ["Pull requests", "Name the owner and the rollback in the description before asking for review."],
  ["Tests", "Write the failing test first and link the CI run that shows it red."],
  ["Tests", "Database tests run against a local scratch Postgres, never a shared one."],
  ["Migrations", "Migrations are additive; never rename or drop a column in the same release that stops using it."],
  ["Migrations", "Every migration gets a timestamp later than every existing one, checked against open branches."],
  ["Logging", "Log the request id on every error line; never log a token, a card number or an email body."],
  ["Logging", "Warnings that nobody acts on are deleted, not silenced."],
  [
    "Feature flags",
    "New behaviour ships behind a flag that defaults off, with its removal date in the flag description.",
  ],
  ["Feature flags", "A flag older than thirty days is removed or promoted in the next sprint."],
  ["Code review", "A reviewer runs the change locally when it touches payments or authentication."],
  ["Code review", "Comments that block a merge start with 'blocking:'; everything else is a suggestion."],
  ["Dependencies", "Pin exact versions; upgrades go in their own pull request with the changelog linked."],
  ["Dependencies", "No new runtime dependency without a note on what it replaces and its licence."],
  ["Incidents", "Open an incident channel for any customer-visible error rate above one percent for five minutes."],
  ["Incidents", "Write the timeline the same day; the review names causes, never people."],
  ["Secrets", "Secrets live in the deployment's environment settings, never in the repository or a ticket."],
  ["Secrets", "Rotate a key the same day it is pasted anywhere outside the secret store."],
  ["Releases", "Releases go out Monday to Thursday before 15:00 UTC, never during the payments freeze."],
  ["Releases", "Every release note links the pull requests it contains."],
  ["API", "Public endpoints return problem+json errors with a stable code and a sentence naming the fix."],
  ["API", "Breaking changes get a new version path; the old one stays for ninety days."],
  ["Frontend", "Every new screen is checked at 375 pixels wide before review."],
  ["Frontend", "Copy changes go through the product owner, not straight to main."],
];

/** Notes four other agents write while A works, each on its own task, none about A's facts. */
function otherTaskNotes(agent: number): { name: string; content: string; task: string }[] {
  const topics = ["search latency", "invoice PDF layout", "signup email copy", "dashboard caching"];
  return Array.from({ length: 30 }, (_, i) => ({
    name: `${topics[agent]} note ${i}`,
    content: `Finding ${i} on ${topics[agent]}: measured ${100 + i * 7} ms on the staging run, owner agent ${agent}.`,
    task: agent === 0 ? PREFIX_TASK : `WEB-3${agent}${i % 10}`,
  }));
}

/** A memory service on a real socket: a fixed embedding, an accepted ingest, an empty graph. */
class EmptyGraphMemoryService {
  private server: Server | null = null;

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      void this.handle(req).then(
        ([status, body]) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body)),
        (e: unknown) => res.writeHead(500).end(String(e)),
      );
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("memory service did not bind");
    return `http://127.0.0.1:${address.port}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private async handle(req: IncomingMessage): Promise<[number, unknown]> {
    req.resume();
    const path = new URL(req.url ?? "/", "http://memory").pathname;
    if (path === "/embed") return [200, { embedding: new Array(384).fill(0.01) }];
    if (path === "/ingest") return [200, { episode_id: "ep-1" }];
    if (path === "/search") return [200, { facts: [] }];
    if (path === "/graph") return [200, { nodes: [], edges: [] }];
    return [404, { detail: `no route ${path}` }];
  }
}

describe.skipIf(!QA_URL)("a second agent continuing a task starts from what the first decided and wrote", () => {
  const service = new EmptyGraphMemoryService();
  const clients: Client[] = [];
  let db: PrismaClient;
  let mcpUrl: string;
  let closeMcp: () => Promise<void>;
  let ClientClass: (typeof import("@modelcontextprotocol/sdk/client/index.js"))["Client"];
  let Transport: (typeof import("@modelcontextprotocol/sdk/client/streamableHttp.js"))["StreamableHTTPClientTransport"];
  let TASK_START_TOKEN_BUDGET: number;
  let TASK_START_MAX_TOKENS: number;
  let estimateTokens: (text: string) => number;

  /** What B's first result carried, read once by every assertion below. */
  let handoffBlock: string;
  let unrelatedBlock: string;
  /** What sessions naming the task by the X-Willder-Task header, as an IDE client does, were served. */
  let headerBlock: string;
  let metaOverHeaderBlock: string;
  let blankHeaderBlock: string;
  let noTaskBlock: string;
  let placeholderHeaderBlock: string;
  let versionIds: { releasePlanFirst: string; testCommandFirst: string };

  async function mint(agentId: string, scopePath: string): Promise<string> {
    const token = `wcap_test_${agentId}_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath,
        permission: "write",
        grantGoverned: false,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return token;
  }

  /** An MCP session as `agentId`; `taskHeader` is sent as X-Willder-Task on every request, as an IDE client's config does. */
  async function connect(agentId: string, scopePath: string, taskHeader?: string): Promise<Client> {
    const token = await mint(agentId, scopePath);
    const client: Client = new ClientClass({ name: agentId, version: "0.0.0" });
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (taskHeader !== undefined) headers["X-Willder-Task"] = taskHeader;
    await client.connect(new Transport(new URL(mcpUrl), { requestInit: { headers } }));
    clients.push(client);
    return client;
  }

  /**
   * One tool call: its answer, and every block it carried. `meta` names the session and
   * task in `_meta`; without it the call carries no `_meta`, as an IDE client's does.
   */
  async function call(
    client: Client,
    name: string,
    args: Record<string, unknown>,
    meta?: { session: string; task?: string },
  ): Promise<{ isError: boolean; answer: string; extra: string[] }> {
    let _meta: Record<string, string> | undefined;
    if (meta !== undefined) {
      _meta = { "willder/session": meta.session };
      if (meta.task !== undefined) _meta["willder/task"] = meta.task;
    }
    const result = await client.callTool({ name, arguments: args, ...(_meta && { _meta }) });
    const [answer = "", ...extra] = (result.content as { text?: string }[]).map((part) => part.text ?? "");
    return { isError: Boolean(result.isError), answer, extra };
  }

  async function ingest(
    client: Client,
    args: Record<string, unknown>,
    meta?: { session: string; task?: string },
  ): Promise<string> {
    const { isError, answer } = await call(client, "memory_ingest", args, meta);
    expect(isError, answer).toBe(false);
    return answer;
  }

  const versionIn = (reply: string) => /Version: (\S+)\./.exec(reply)?.[1] ?? "";

  /** The task-start block among a result's extra blocks, without the change notices after it. */
  const blockOf = (extra: string[]) =>
    extra.find((text) => text.startsWith("Before you start"))?.split("\n\nChanged in your scope")[0] ?? "";

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
    ({ TASK_START_TOKEN_BUDGET, TASK_START_MAX_TOKENS, estimateTokens } = await import("./task-start-notice"));
    const { startMcpTestServer } = await import("./http-test-server");
    const mcp = await startMcpTestServer();
    mcpUrl = mcp.url;
    closeMcp = mcp.close;

    await db.org.deleteMany({ where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: ORG } });
    for (const path of [ROOT, WEB, WEB_INTERNAL, FINANCE])
      await db.scope.create({ data: { orgId: ORG, path, name: path } });

    // The team lead's standing rules, recorded before the task starts.
    const lead = await connect("team-lead", WEB);
    for (const [subject, text] of STANDING_RULES) {
      await ingest(lead, { name: subject, content: text, kind: "convention" }, { session: "lead-setup" });
    }

    // A works the task in one session while four other agents write about their own tasks.
    const agentA = await connect("agent-a", ROOT);
    const reviewer = await connect("reviewer", WEB);
    const others = await Promise.all([0, 1, 2, 3].map((n) => connect(`other-agent-${n}`, WEB)));
    const onTask = { session: "a-run-1", task: TASK };

    const workTheTask = async () => {
      const decisionFirst = /^Recorded decision (\S+);/.exec(
        await ingest(agentA, { ...DECISION_FIRST, scopePath: WEB, kind: "decision" }, onTask),
      )![1];
      // The root-cause note is sent twice with one key, the way a client retries a call whose reply it lost.
      const rootCause = { ...ROOT_CAUSE, scopePath: WEB, idempotencyKey: "a-run-1-root-cause" };
      await ingest(agentA, rootCause, onTask);
      await ingest(agentA, rootCause, onTask);
      await ingest(agentA, { ...IDEMPOTENCY_KEY, scopePath: WEB }, onTask);
      const releasePlanFirst = versionIn(
        await ingest(agentA, { name: RELEASE_PLAN, content: RELEASE_PLAN_FIRST, scopePath: WEB }, onTask),
      );
      await ingest(
        agentA,
        { name: RELEASE_PLAN, content: RELEASE_PLAN_NOW, scopePath: WEB, baseVersion: releasePlanFirst },
        onTask,
      );
      const testCommandFirst = versionIn(
        await ingest(agentA, { name: TEST_COMMAND, content: TEST_COMMAND_FIRST, scopePath: WEB }, onTask),
      );
      await ingest(agentA, { ...MERCHANT_LOGS, scopePath: WEB }, onTask);
      await ingest(agentA, { ...SIBLING_NOTE, scopePath: WEB_INTERNAL }, onTask);
      await ingest(agentA, { ...FINANCE_NOTE, scopePath: FINANCE }, onTask);
      // A reviewer, working no task, corrects A's test command from the version it read.
      await ingest(
        reviewer,
        { name: TEST_COMMAND, content: TEST_COMMAND_NOW, scopePath: WEB, baseVersion: testCommandFirst },
        { session: "review-1" },
      );
      // The team lead, working no task, replaces A's decision.
      await ingest(lead, { ...DECISION, kind: "decision", supersedes: decisionFirst }, { session: "lead-review" });
      // A and the reviewer name the rollout owner at the same moment.
      await Promise.all([
        ingest(agentA, { name: ROLLOUT_OWNER, content: ROLLOUT_OWNER_CLAIMS[0], scopePath: WEB }, onTask),
        ingest(
          reviewer,
          { name: ROLLOUT_OWNER, content: ROLLOUT_OWNER_CLAIMS[1], scopePath: WEB },
          { session: "review-1" },
        ),
      ]);
      return { releasePlanFirst, testCommandFirst };
    };
    const writeOtherTasks = (client: Client, n: number) =>
      otherTaskNotes(n).reduce(
        (previous, note) =>
          previous.then(() =>
            ingest(client, { name: note.name, content: note.content }, { session: `other-${n}`, task: note.task }).then(
              () => undefined,
            ),
          ),
        Promise.resolve(),
      );
    [versionIds] = await Promise.all([workTheTask(), ...others.map(writeOtherTasks)]);

    // B continues the task in a fresh session; C starts an unrelated one in the same scope.
    const agentB = await connect("agent-b", WEB);
    const handoff = await call(
      agentB,
      "memory_query",
      { query: "Where did the duplicate orders fix leave off?" },
      { session: "b-run-1", task: TASK },
    );
    expect(handoff.isError, handoff.answer).toBe(false);
    handoffBlock = blockOf(handoff.extra);
    const agentC = await connect("agent-c", WEB);
    const unrelated = await call(
      agentC,
      "memory_query",
      { query: "What is slow on the dashboard?" },
      { session: "c-run-1", task: UNRELATED_TASK },
    );
    unrelatedBlock = blockOf(unrelated.extra);

    // The same handoff from IDE clients, which send no `_meta`: the task comes from the
    // connection's X-Willder-Task header. One more agent per case, each on its first call.
    const question = { query: "Where did the duplicate orders fix leave off?" };
    headerBlock = blockOf((await call(await connect("ide-b", WEB, TASK), "memory_query", question)).extra);
    metaOverHeaderBlock = blockOf(
      (
        await call(await connect("ide-meta", WEB, TASK), "memory_query", question, {
          session: "meta-run-1",
          task: UNRELATED_TASK,
        })
      ).extra,
    );
    blankHeaderBlock = blockOf((await call(await connect("ide-blank", WEB, "   "), "memory_query", question)).extra);
    noTaskBlock = blockOf((await call(await connect("ide-none", WEB), "memory_query", question)).extra);
    placeholderHeaderBlock = blockOf(
      (await call(await connect("ide-placeholder", WEB, "${env:WILLDER_TASK}"), "memory_query", question)).extra,
    );
  }, 120_000);

  afterAll(async () => {
    if (QA_URL === undefined) return;
    await Promise.all(clients.map((client) => client.close()));
    await closeMcp?.();
    await service.stop();
    await db.org.deleteMany({ where: { id: ORG } });
    await db.$disconnect();
  });

  it("serves A's decision and the current version of every fact A touched", () => {
    expect(handoffBlock.split(DECISION.content)).toHaveLength(2);
    expect(handoffBlock).toContain(ROOT_CAUSE.content);
    expect(handoffBlock).toContain(IDEMPOTENCY_KEY.content);
    expect(handoffBlock).toContain(RELEASE_PLAN_NOW);
    expect(handoffBlock).toContain(TEST_COMMAND_NOW);
    expect(handoffBlock).toContain(MERCHANT_LOGS.content.slice(0, 120));
  });

  it("serves both versions of a fact the winner rule decided, together under the line that asks, and none a based update retired", async () => {
    const owners = await db.memoryChunk.findMany({
      where: { orgId: ORG, entityName: ROLLOUT_OWNER },
      select: { id: true, content: true },
    });
    const retired = new Set(
      (
        await db.factEdge.findMany({ where: { orgId: ORG, kind: "supersedes", toId: { in: owners.map((o) => o.id) } } })
      ).map((e) => e.toId),
    );
    expect(retired.size).toBe(1);
    // The product recorded a winner; the block names none. Both claims follow the one line that
    // names both writers and asks the person, and neither is marked superseded.
    const lines = handoffBlock.split("\n");
    const ask = lines.findIndex((line) => line.startsWith(`${CONFLICT_OPENING} "${ROLLOUT_OWNER}"`));
    expect(ask).toBeGreaterThan(0);
    expect(lines[ask]).toMatch(
      /from (agent-a|reviewer), \d\d-\d\d and (agent-a|reviewer), \d\d-\d\d: ask the person which holds before acting on either\.$/,
    );
    expect(
      lines
        .slice(ask + 1, ask + 3)
        .map((line) => owners.find((owner) => line.includes(owner.content))?.id)
        .sort(),
    ).toEqual(owners.map((o) => o.id).sort());
    expect(handoffBlock).not.toMatch(/superseded|resolved/i);

    expect(handoffBlock).not.toContain(DECISION_FIRST.content);
    expect(handoffBlock).not.toContain(RELEASE_PLAN_FIRST);
    expect(handoffBlock).not.toContain(TEST_COMMAND_FIRST);
    expect(handoffBlock).not.toContain(versionIds.releasePlanFirst);
    expect(handoffBlock).not.toContain(versionIds.testCommandFirst);
  });

  it("serves nothing A wrote on the task into a scope B cannot read, nor another task's notes", () => {
    expect(handoffBlock).not.toContain(SIBLING_NOTE.content);
    expect(handoffBlock).not.toContain(FINANCE_NOTE.content);
    for (const note of otherTaskNotes(0)) expect(handoffBlock).not.toContain(note.content);
  });

  it("puts the task's deciding context ahead of the scope's standing rules, inside the budget", () => {
    // The premise check shows no record, so it is added on top of the records' budget.
    expect(
      estimateTokens(withoutSources(handoffBlock.replace(`\n${TASK_START_PREMISE_CHECK}`, ""))),
    ).toBeLessThanOrEqual(TASK_START_TOKEN_BUDGET);
    expect(estimateTokens(handoffBlock)).toBeLessThanOrEqual(TASK_START_MAX_TOKENS);
    const deciding = [
      DECISION.content,
      ROOT_CAUSE.content,
      IDEMPOTENCY_KEY.content,
      RELEASE_PLAN_NOW,
      TEST_COMMAND_NOW,
    ];
    const decidingAt = deciding.map((text) => handoffBlock.indexOf(text));
    expect(decidingAt.every((at) => at >= 0)).toBe(true);
    const rulesAt = STANDING_RULES.map(([, text]) => handoffBlock.indexOf(text)).filter((at) => at >= 0);
    for (const at of rulesAt) expect(at).toBeGreaterThan(Math.max(...decidingAt));
  });

  it("hands an agent starting a different task in the same scope none of A's facts", () => {
    expect(unrelatedBlock).not.toBe("");
    for (const fact of [ROOT_CAUSE.content, IDEMPOTENCY_KEY.content, RELEASE_PLAN_NOW, TEST_COMMAND_NOW]) {
      expect(unrelatedBlock).not.toContain(fact);
    }
  });

  describe("when an IDE client names the task with the X-Willder-Task header instead of _meta", () => {
    it("serves the session the same deciding context, and nothing from a scope it cannot read", () => {
      for (const text of [
        DECISION.content,
        ROOT_CAUSE.content,
        IDEMPOTENCY_KEY.content,
        RELEASE_PLAN_NOW,
        TEST_COMMAND_NOW,
      ]) {
        expect(headerBlock).toContain(text);
      }
      expect(headerBlock).not.toContain(SIBLING_NOTE.content);
      expect(headerBlock).not.toContain(FINANCE_NOTE.content);
      expect(headerBlock).not.toContain(DECISION_FIRST.content);
    });

    it("lets a call's own _meta task win over the connection's header", () => {
      expect(metaOverHeaderBlock).not.toBe("");
      for (const fact of [ROOT_CAUSE.content, IDEMPOTENCY_KEY.content, RELEASE_PLAN_NOW, TEST_COMMAND_NOW]) {
        expect(metaOverHeaderBlock).not.toContain(fact);
      }
    });

    it("treats a blank header as naming no task, exactly as a blank _meta task", () => {
      expect(blankHeaderBlock).not.toBe("");
      expect(blankHeaderBlock).toBe(noTaskBlock);
      expect(blankHeaderBlock).not.toContain(IDEMPOTENCY_KEY.content);
    });

    it("treats a header left as an unexpanded ${...} placeholder as naming no task", () => {
      expect(placeholderHeaderBlock).toBe(noTaskBlock);
      expect(placeholderHeaderBlock).not.toContain(IDEMPOTENCY_KEY.content);
    });

    it("records no task on a write whose header or _meta task is an unexpanded placeholder", async () => {
      // A client that does not expand its config sends the same literal from every
      // session; recorded as a task, it would hand each session the others' context.
      const byHeader = await connect("ide-placeholder-writer", WEB, " ${WILLDER_TASK:-} ");
      const byMeta = await connect("meta-placeholder-writer", WEB);
      await ingest(byHeader, { name: "Placeholder header note", content: "Written under an unexpanded header." });
      await ingest(
        byMeta,
        { name: "Placeholder meta note", content: "Written under an unexpanded _meta task." },
        { session: "p-1", task: "${WILLDER_TASK}" },
      );
      const events = await db.changeEvent.findMany({
        where: {
          orgId: ORG,
          actorId: { in: ["ide-placeholder-writer", "meta-placeholder-writer"] },
          recordType: "fact",
        },
        select: { actorId: true, task: true },
      });
      expect(events).toHaveLength(2);
      for (const event of events) expect(event.task, event.actorId).toBeNull();
    });

    it("records a write under the header's task, trimmed and cut to the same length as a _meta task", async () => {
      const longTask = `  ${"T".repeat(600)}  `;
      const byHeader = await connect("ide-writer", WEB, longTask);
      const byMeta = await connect("meta-writer", WEB);
      await ingest(byHeader, {
        name: "Header writer note",
        content: "Written by a session that names its task by header.",
      });
      await ingest(
        byMeta,
        { name: "Meta writer note", content: "Written by a session that names its task in _meta." },
        { session: "m-1", task: longTask },
      );
      const events = await db.changeEvent.findMany({
        where: { orgId: ORG, actorId: { in: ["ide-writer", "meta-writer"] }, recordType: "fact" },
        select: { actorId: true, task: true },
      });
      expect(events).toHaveLength(2);
      for (const event of events) expect(event.task, event.actorId).toBe("T".repeat(512));
    });
  });
});

// The task sections of the task-start read (services/memory/task-start.ts, readTaskStartUnchecked):
// what earlier sessions of a named task decided and wrote.
//
// Three predicates in that read had no test that fails when they are removed:
// - the scope filter on the decision in force now. A decision is followed along
//   `supersedesId` to its replacement, and recordConvention lets a writer who may write
//   both scopes store the replacement in another scope than the one it replaced. The
//   task's own write is in a scope the reader may read; its replacement may not be.
// - the retired filter on that decision: a retired rule is not in force.
// - the org filter on the task's writes and on the fact versions they lead to. Scope paths
//   start with the org's root today, so this is defence in depth, pinned here so a refactor
//   cannot drop it unnoticed.
describe.skipIf(!QA_URL)("task-start task sections serve only what the reader may read and what is in force", () => {
  const SECTIONS_ORG = "taskSections";
  const OTHER_ORG = "taskSectionsOther";
  const ORGS = { in: [SECTIONS_ORG, OTHER_ORG] };
  // readTaskStartUnchecked reads but does not authorize, so the token is never presented anywhere.
  const ctx: AccessContext = {
    orgId: SECTIONS_ORG,
    actor: { type: "agent", id: "qa", capabilityToken: "unused" },
    origin: "mcp",
  };
  const base = Date.UTC(2026, 9, 7);
  const at = (seconds: number) => new Date(base + seconds * 1000);
  let db: PrismaClient;
  let readTaskStartUnchecked: (typeof import("@/services/memory/task-start"))["readTaskStartUnchecked"];

  async function cleanup(): Promise<void> {
    await db.changeEvent.deleteMany({ where: { orgId: ORGS } });
    await db.memoryChunk.deleteMany({ where: { orgId: ORGS } });
    await db.convention.updateMany({ where: { orgId: ORGS }, data: { supersedesId: null } });
    await db.convention.deleteMany({ where: { orgId: ORGS } });
    await db.org.deleteMany({ where: { id: ORGS } });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ readTaskStartUnchecked } = await import("@/services/memory/task-start"));
    await cleanup();
    for (const id of [SECTIONS_ORG, OTHER_ORG]) await db.org.create({ data: { id, name: id } });

    const rule = (id: string, orgId: string, scopePath: string, text: string, seconds: number, extra: object = {}) =>
      db.convention.create({
        data: {
          id,
          orgId,
          scopePath,
          kind: "decision",
          subject: `subject ${id}`,
          text,
          actorId: "qa",
          createdAt: at(seconds),
          ...extra,
        },
      });
    // The task's decision in web, replaced by a lead who may write both scopes with a
    // version stored in finance.
    await rule("qa-dec-web", SECTIONS_ORG, WEB, "Refund window is 14 days.", 1);
    await rule("qa-dec-finance", SECTIONS_ORG, FINANCE, "FINANCE ONLY: refund window is 30 days for enterprise.", 2, {
      supersedesId: "qa-dec-web",
    });
    await db.convention.update({ where: { id: "qa-dec-web" }, data: { supersededById: "qa-dec-finance" } });
    // A task decision someone has since retired.
    await rule("qa-dec-retired", SECTIONS_ORG, WEB, "RETIRED: deploy only on Fridays.", 3, {
      retiredAt: at(4),
      retiredBy: "qa-lead",
    });
    // A task decision still in force, in web: the control that proves the section is read.
    await rule("qa-dec-live", SECTIONS_ORG, WEB, "Use the order id as the idempotency key.", 5);
    // Another org's decision and fact under the same task key and the same scope string.
    await rule("qa-dec-other-org", OTHER_ORG, WEB, "OTHER ORG decision.", 6);

    const chunk = (id: string, orgId: string, content: string, seconds: number) =>
      db.memoryChunk.create({
        data: { id, orgId, content, entityName: "Refund owner", scopePath: WEB, createdAt: at(seconds) },
      });
    await chunk("qa-fact-web", SECTIONS_ORG, "Refund owner is the payments team.", 7);
    await chunk("qa-fact-other-org", OTHER_ORG, "OTHER ORG fact on the same entity.", 8);

    let seq = 0;
    const event = (orgId: string, scopePath: string, recordType: string, recordId: string, seconds: number) => ({
      orgId,
      seq: BigInt(++seq),
      scopePath,
      recordType,
      recordId,
      op: "create" as const,
      actorId: "qa",
      summary: recordId,
      task: TASK,
      createdAt: at(seconds),
    });
    await db.changeEvent.createMany({
      data: [
        event(SECTIONS_ORG, WEB, "convention", "qa-dec-web", 1),
        event(SECTIONS_ORG, WEB, "convention", "qa-dec-retired", 3),
        event(SECTIONS_ORG, WEB, "convention", "qa-dec-live", 5),
        event(OTHER_ORG, WEB, "convention", "qa-dec-other-org", 6),
        event(SECTIONS_ORG, WEB, "fact", "qa-fact-web", 7),
        event(OTHER_ORG, WEB, "fact", "qa-fact-other-org", 8),
      ],
    });
  });

  afterAll(async () => {
    if (QA_URL === undefined) return;
    await cleanup();
    await db.$disconnect();
  });

  async function taskSections(scopePath: string): Promise<{ decisions: string[]; facts: string[] }> {
    const { task } = await readTaskStartUnchecked(ctx, scopePath, "", TASK);
    return { decisions: task.decisions.map((d) => d.id), facts: task.facts.map((f) => f.id) };
  }

  it("serves a web reader the task's live decision and fact, and nothing else", async () => {
    expect(await taskSections(WEB)).toEqual({ decisions: ["qa-dec-live"], facts: ["qa-fact-web"] });
  });

  it("does not follow a task decision into a replacement stored in a scope the reader cannot read", async () => {
    const { decisions } = await taskSections(WEB);
    expect(decisions).not.toContain("qa-dec-finance");
    expect(decisions).not.toContain("qa-dec-web");
  });

  it("serves that replacement to a reader whose scope contains it", async () => {
    expect((await taskSections(ROOT)).decisions).toContain("qa-dec-finance");
  });

  it("does not serve a retired task decision", async () => {
    expect((await taskSections(ROOT)).decisions).not.toContain("qa-dec-retired");
  });

  it("serves nothing another org wrote under the same task key and scope string", async () => {
    const { decisions, facts } = await taskSections(ROOT);
    expect(decisions).not.toContain("qa-dec-other-org");
    expect(facts).not.toContain("qa-fact-other-org");
  });
});
