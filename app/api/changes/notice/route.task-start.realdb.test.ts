// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The task-start block through GET /api/changes/notice, the route the Claude Code hook
// polls.
//
// A coding agent that spends its session in files and shell commands may never call a
// Willder tool, so a block carried only on a tool result never reaches it. The hook asks this route on the session's first prompt, so the
// block arrives before the agent decides anything, whether or not it ever calls a tool.
//
// What only a real database can show: that the block the route serves is the one the MCP
// path serves, for the task the hook names; and that one session is told once, whichever
// of the two paths asks first, through the same delivered_to claim, when neither names a
// session. The last test runs
// the installed hook as Claude Code would, a separate process, against the route on a
// real socket.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never an inherited DATABASE_URL
// that points at a live database. Skips cleanly without it.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PrismaClient } from "@/lib/generated/prisma/client";
// Leaf module, not the `@/services/access` barrel: the barrel builds the `@/lib/db`
// singleton at import time, before beforeAll can point DATABASE_URL at the QA database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import { init } from "@/cli/willder.mjs";

vi.mock("@/lib/inngest", () => ({ ingestMemory: vi.fn().mockResolvedValue(undefined) }));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-notice-task-start";
const SCOPE = "org_1.web";
const TASK = "WEB-412";
const AUTHOR = "agent-a";
const READER = "agent-b";

const DECISION = {
  subject: "Webhook retries",
  text: "Retry a failed Stripe webhook with exponential backoff, at most 5 attempts; never retry a 4xx other than 429.",
};

describe.skipIf(!QA_URL)("the task-start block through GET /api/changes/notice, against a real database", () => {
  let db: PrismaClient;
  let GET: (typeof import("./route"))["GET"];
  let registerWillderTools: (typeof import("@/mcp/tools"))["registerWillderTools"];
  let recordConvention: (typeof import("@/services/memory/conventions"))["recordConvention"];
  let readerToken = "";
  const openClients: Client[] = [];

  async function mint(agentId: string, permission: "read" | "write"): Promise<string> {
    const raw = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId,
        tokenHash: hashCapabilityToken(raw),
        scopePath: SCOPE,
        permission,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return raw;
  }

  const ctxFor = (agentId: string, token: string): AccessContext => ({
    orgId: ORG,
    actor: { type: "agent", id: agentId, capabilityToken: token },
    origin: "mcp",
  });

  const poll = async (headers: Record<string, string> = {}): Promise<string | null> => {
    const res = await GET(
      new Request("https://willder.test/api/changes/notice", {
        headers: { authorization: `Bearer ${readerToken}`, ...headers },
      }),
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as { notice: string | null }).notice;
  };

  /** The reader's first MCP tool call, naming the task the way the connect page's header does. */
  async function firstToolCall(): Promise<string> {
    const server = new McpServer({ name: "willder-test", version: "0.0.0" });
    registerWillderTools(
      server,
      ctxFor(READER, readerToken),
      { orgId: ORG, agentId: READER, scopePath: SCOPE },
      { task: TASK },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);
    openClients.push(client);
    const result = (await client.callTool({ name: "get_my_brief", arguments: { briefId: "no-such-brief" } })) as {
      content: { text: string }[];
    };
    return result.content.map((c) => c.text).join("\n\n");
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ GET } = await import("./route"));
    ({ registerWillderTools } = await import("@/mcp/tools"));
    ({ recordConvention } = await import("@/services/memory/conventions"));
  });

  afterAll(async () => {
    await Promise.all(openClients.map((client) => client.close()));
    await db.$disconnect();
  });

  beforeEach(async () => {
    await db.taskStartDelivery.deleteMany({ where: { orgId: ORG } });
    await db.convention.deleteMany({ where: { orgId: ORG } });
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.agentCursor.deleteMany({ where: { orgId: ORG } });
    await db.capability.deleteMany({ where: { orgId: ORG } });
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });

    // Agent A's session on the task left one decision behind.
    const authorToken = await mint(AUTHOR, "write");
    await recordConvention(ctxFor(AUTHOR, authorToken), {
      kind: "decision",
      ...DECISION,
      scopePath: SCOPE,
      task: TASK,
    });
    readerToken = await mint(READER, "read");
  });

  it("serves the task's decision on the session's first poll, before any tool call", async () => {
    const notice = await poll({ "x-willder-task": TASK });

    expect(notice).toMatch(/^Before you start/);
    // An agent recorded it, so it is a lead, never settled.
    expect(notice).toContain("Leads to verify (earlier sessions left these; memory_version opens a fact whole):");
    expect(notice).toContain(DECISION.text);
  });

  it("serves the scope's records when the hook names no task, an agent's decision among them only as a lead", async () => {
    const notice = await poll();

    expect(notice).toMatch(/^Before you start/);
    expect(notice).toContain("Leads to verify (earlier sessions left these; memory_version opens a fact whole):");
    expect(notice).not.toContain("Settled for this task:");
  });

  it("tells a session once: a poll that served the block leaves none for the first tool call", async () => {
    expect(await poll({ "x-willder-task": TASK })).toContain(DECISION.text);

    expect(await poll({ "x-willder-task": TASK })).toBeNull();
    expect(await firstToolCall()).not.toContain("Before you start");
  });

  it("leaves the block to the first tool call when the tool call asks first", async () => {
    expect(await firstToolCall()).toContain(DECISION.text);

    expect(await poll({ "x-willder-task": TASK })).toBeNull();
  });

  it("tells each session the hook names once, so the next session on the task is told again", async () => {
    const asSession = (session: string) => ({ "x-willder-task": TASK, "x-willder-session": session });

    expect(await poll(asSession("claude-session-1"))).toContain(DECISION.text);
    expect(await poll(asSession("claude-session-1"))).toBeNull();
    expect(await poll(asSession("claude-session-2"))).toContain(DECISION.text);
  });

  describe("ranked by the prompt the hook sends", () => {
    const MARKER = "zebracorn7781";
    const OLD_RULE = {
      subject: "Ledger writes",
      text: "Every ledger write carries an idempotency key, checked before the insert.",
    };

    beforeEach(async () => {
      const authorToken = await mint(AUTHOR, "write");
      await recordConvention(ctxFor(AUTHOR, authorToken), { kind: "convention", ...OLD_RULE, scopePath: SCOPE });
      // Twenty newer rules on other work, long enough that the block has no room for all of them.
      for (let i = 0; i < 20; i++) {
        await recordConvention(ctxFor(AUTHOR, authorToken), {
          kind: "convention",
          subject: `Release step ${i}`,
          text: `Step ${i} of every release: tag the build, attach the changelog and post the checklist before noon.`,
          scopePath: SCOPE,
        });
      }
    });

    const prompt = `Add an idempotency key to the ledger write ${MARKER}`;

    it("serves a rule the prompt's words name that the task's name alone leaves out", async () => {
      // The block only, without the change notices that ride after it.
      const block = (notice: string | null) => notice!.split("\n\nChanged in your scope")[0]!;
      const withoutPrompt = block(await poll({ "x-willder-task": TASK, "x-willder-session": "s-without" }));
      const withPrompt = block(
        await poll({
          "x-willder-task": TASK,
          "x-willder-session": "s-with",
          "x-willder-prompt": encodeURIComponent(prompt),
        }),
      );

      expect(withoutPrompt).not.toContain(OLD_RULE.subject);
      expect(withPrompt).toContain(`] ${OLD_RULE.subject}: ${OLD_RULE.text}`);
      // The task's own records are chosen by its name alone, whatever the prompt says.
      expect(withPrompt).toContain(DECISION.text);
    });

    it("ranks by the names the task's own records hold too, when the task's name shares no word with the rule", async () => {
      const authorToken = await mint(AUTHOR, "write");
      // Older than every release rule, and sharing no word with the task's name: only the 429
      // the task's own decision names can bring it into the block.
      const RETRY_RULE = { subject: "Rate limits", text: "Read Retry-After on a 429 before the next attempt." };
      await db.convention.updateMany({
        where: { orgId: ORG, subject: OLD_RULE.subject },
        data: { createdAt: new Date(Date.now() - 60_000) },
      });
      const id = await recordConvention(ctxFor(AUTHOR, authorToken), {
        kind: "convention",
        ...RETRY_RULE,
        scopePath: SCOPE,
      });
      await db.convention.update({ where: { id }, data: { createdAt: new Date(Date.now() - 120_000) } });

      const block = (await poll({ "x-willder-task": TASK }))!.split("\n\nChanged in your scope")[0]!;

      expect(block).toContain(`] ${RETRY_RULE.subject}: ${RETRY_RULE.text}`);
      expect(block).not.toContain(OLD_RULE.subject);
    });

    it("keeps the prompt nowhere: no row in any table holds it after the block is served", async () => {
      expect(await poll({ "x-willder-task": TASK, "x-willder-prompt": encodeURIComponent(prompt) })).toContain(
        OLD_RULE.subject,
      );

      const tables = await db.$queryRaw<{ name: string }[]>`
        SELECT quote_ident(table_name) AS name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`;
      const holding: string[] = [];
      for (const { name } of tables) {
        const [row] = await db.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM ${name} t WHERE row_to_json(t)::text LIKE '%' || $1 || '%'`,
          MARKER,
        );
        if (row!.n > 0) holding.push(name);
      }
      expect(tables.length).toBeGreaterThan(10);
      expect(holding).toEqual([]);
    });
  });

  describe("through the hook `willder init` installs", () => {
    let server: Server;
    let origin = "";
    let projectDir = "";
    let hookPath = "";

    beforeAll(async () => {
      // Forwards exactly what the hook sends, so a header the hook leaves out never arrives.
      server = createServer((req, res) => {
        void (async () => {
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers[name] = value;
          const response = await GET(new Request(`${origin}${req.url}`, { headers }));
          res.writeHead(response.status, { "content-type": "application/json" });
          res.end(await response.text());
        })();
      });
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      projectDir = mkdtempSync(join(tmpdir(), "willder-init-task-start-"));
      ({ hookPath } = init({ projectDir, url: origin }));
    });

    afterAll(async () => {
      await new Promise((done) => server.close(done));
      rmSync(projectDir, { recursive: true, force: true });
    });

    it("hands Claude Code the block on the first prompt, for the task WILLDER_TASK names", async () => {
      const stdout = await new Promise<string>((done, fail) => {
        const child = execFile(
          process.execPath,
          [hookPath],
          { env: { NODE_ENV: "test", WILLDER_URL: origin, WILLDER_TOKEN: readerToken, WILLDER_TASK: TASK } },
          (error, out) => (error ? fail(error) : done(out)),
        );
        child.stdin!.end(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s1" }));
      });
      const context = JSON.parse(stdout).hookSpecificOutput.additionalContext as string;

      expect(context).toContain("Leads to verify (earlier sessions left these; memory_version opens a fact whole):");
      expect(context).toContain(DECISION.text);
    }, 30_000);
  });
});
