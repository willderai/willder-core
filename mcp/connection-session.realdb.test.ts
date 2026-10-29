// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test Postgres;
// without it every test in this file is skipped, not failed.
//
// A new MCP connection is a new session for the task-start block (mcp/connection-session.ts),
// through the real /api/mcp handlers. The client is the MCP SDK's own Streamable HTTP client,
// the one Claude Code and most hosted clients use, so "the client sends the id back" is the
// SDK's behavior, not this file's. Raw requests stand in for clients that do not.
//
// Real: Postgres, capability tokens, check(), the task-start read, the delivery claim, the
// served-vs-used log and the route's initialize handling. Stood in: the ingest queue (unused).
// Time: a session's idle window is passed with an UPDATE of its lastCallAt, never a sleep.
// Two orgs share an agent id, so a key that left out the org would collide.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { hashCapabilityToken } from "@/services/access/capabilities";

vi.mock("@/lib/inngest", () => ({ ingestMemory: vi.fn().mockResolvedValue(undefined) }));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG_A = "qa_conn_session_a";
const ORG_B = "qa_conn_session_b";
const SCOPE_A = `org_${ORG_A}.b`;
const SCOPE_B = `org_${ORG_B}.b`;
const AGENT = "conn-session-agent";
const OTHER_AGENT = "conn-session-agent-2";
const RULE_A = "qaconnrulea1";
const RULE_B = "qaconnruleb1";
const ENDPOINT = "http://localhost/api/mcp";

interface ToolResult {
  content: { type: string; text: string }[];
}

// The 5 s default is Vitest's, not a claim about this code: the first connection also pays the cold
// load of the route and its database pool, and the 5,000-row prune is database work, so on a busy
// shared runner either can pass it. Each test still fails if it hangs, at 30 s.
describe.skipIf(!QA_URL)(
  "a new MCP connection is a new task-start session, through /api/mcp",
  { timeout: 30_000 },
  () => {
    let db: PrismaClient;
    let route: typeof import("@/app/api/mcp/route");
    let SESSION_IDLE_MS: number;
    let pruneIdleTaskStartDeliveries: (typeof import("@/services/memory/task-start"))["pruneIdleTaskStartDeliveries"];
    const tokens: Record<string, string> = {};
    const openClients: Client[] = [];
    /** Every request the SDK clients sent, with the session id it carried. */
    const sent: { method: string; body: string; sessionId: string | null }[] = [];

    async function reset(): Promise<void> {
      for (const orgId of [ORG_A, ORG_B]) {
        await db.taskStartItemUse.deleteMany({ where: { orgId } });
        await db.taskStartServedItem.deleteMany({ where: { orgId } });
        await db.taskStartDelivery.deleteMany({ where: { orgId } });
        await db.convention.deleteMany({ where: { orgId } });
        await db.auditLog.deleteMany({ where: { orgId } });
        await db.agentCursor.deleteMany({ where: { orgId } });
        await db.capability.deleteMany({ where: { orgId } });
        await db.org.deleteMany({ where: { id: orgId } });
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

    /** The real route handlers behind a fetch, so the SDK client talks to them with no socket. */
    const routeFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
      // The SDK sends its body as a string. Read it from there: cloning the request to read its body
      // tees the stream, and on a busy machine the route sometimes got a body that was not its JSON.
      const req = new Request(url, init);
      const body = req.method === "POST" && typeof init?.body === "string" ? init.body : "";
      sent.push({ method: req.method, body, sessionId: req.headers.get("mcp-session-id") });
      const handler = { POST: route.POST, GET: route.GET, DELETE: route.DELETE }[req.method];
      if (!handler) return new Response(null, { status: 405 });
      return handler(req);
    };

    /** A new connection as `token`, initialized the way the SDK client does it. */
    async function connect(token: string): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
      const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
        fetch: routeFetch,
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      });
      const client = new Client({ name: "qa-client", version: "0.0.0" });
      await client.connect(transport);
      openClients.push(client);
      return { client, transport };
    }

    const anyCall = (client: Client, args: Record<string, unknown> = { briefId: "no-such-brief" }) =>
      client.callTool({ name: "get_my_brief", arguments: args }) as Promise<ToolResult>;

    /** The task-start block in a result, if any, without the change notices after it. */
    const blockOf = (result: ToolResult): string | undefined =>
      result.content
        .map((c) => c.text)
        .find((text) => text.startsWith("Before you start"))
        ?.split("\n\nChanged in your scope")[0];

    /** One raw POST as `token`, carrying `sessionId` in Mcp-Session-Id when given. */
    async function rawPost(token: string, body: unknown, sessionId?: string): Promise<Response> {
      return route.POST(
        new Request(ENDPOINT, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...(sessionId !== undefined ? { "mcp-session-id": sessionId } : {}),
          },
          body: typeof body === "string" ? body : JSON.stringify(body),
        }),
      );
    }

    const initializeBody = (id = 1) => ({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
    });
    const toolCallBody = (
      id = 1,
      args: Record<string, unknown> = { briefId: "no-such-brief" },
      meta?: Record<string, string>,
    ) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "get_my_brief", arguments: args, ...(meta ? { _meta: meta } : {}) },
    });

    /** A raw tool call's task-start block, if any. */
    async function rawCall(
      token: string,
      sessionId?: string,
      meta?: Record<string, string>,
    ): Promise<string | undefined> {
      const response = await rawPost(token, toolCallBody(1, undefined, meta), sessionId);
      expect(response.status).toBe(200);
      return blockOf(((await response.json()) as { result: ToolResult }).result);
    }

    /** A raw initialize's minted session id, or null when the response carried none. */
    async function rawInitialize(token: string): Promise<string | null> {
      const response = await rawPost(token, initializeBody());
      expect(response.status).toBe(200);
      return response.headers.get("mcp-session-id");
    }

    const deliveries = (orgId: string, agentId = AGENT) =>
      db.taskStartDelivery.findMany({ where: { orgId, agentId }, orderBy: { sessionKey: "asc" } });
    const servingsOf = async (orgId: string, sessionKey: string) =>
      new Set((await db.taskStartServedItem.findMany({ where: { orgId, sessionKey } })).map((r) => r.servingId)).size;
    /** Move `sessionKey`'s last call back past the idle window, as if the connection sat quiet. */
    const idlePast = (orgId: string, sessionKey: string, ms: number) =>
      db.$executeRaw`UPDATE "task_start_deliveries" SET "lastCallAt" = "lastCallAt" - make_interval(secs => ${ms / 1000}::float8)
      WHERE "orgId" = ${orgId} AND "sessionKey" = ${sessionKey}`;

    /**
     * Returns once a statement on task_start_deliveries is blocked by the transaction on backend
     * `holder`, which is the claim holding the idle row's lock. The test needs the prune to have
     * found the idle row and be waiting on it; a fixed sleep only hoped it had got there, and on a
     * busy machine it might not have. Fails after 10 s, inside the claim's 15 s transaction, so a
     * prune that never waits is reported as that rather than as a transaction timeout.
     */
    async function pruneIsBlockedBy(holder: number): Promise<void> {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const [{ waiting }] = await db.$queryRaw<{ waiting: number }[]>`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE ${holder}::int = ANY(pg_blocking_pids(pid)) AND query LIKE '%"task_start_deliveries"%'`;
        if (waiting > 0) return;
        if (Date.now() > deadline)
          throw new Error("The prune never waited on the claim's row lock, so the race this test pins did not happen.");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }

    /**
     * The prune, failed after `ms` with its statement cancelled. A prune that outlives its test
     * keeps the row locks of the batch it is deleting, so without the cancel the next test's
     * cleanup waits behind it and fails as a hook timeout that names the wrong test.
     */
    async function pruneWithin(ms: number, prune = pruneIdleTaskStartDeliveries()): Promise<number> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), ms)));
      try {
        const outcome = await Promise.race([prune, late]);
        if (outcome !== "late") return outcome;
      } finally {
        clearTimeout(timer);
      }
      await db.$executeRaw`
      SELECT pg_cancel_backend(pid) FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'active'
        AND query LIKE '%"task_start_deliveries"%'`;
      await prune.catch(() => undefined);
      throw new Error(
        `pruneIdleTaskStartDeliveries ran past ${ms} ms and was cancelled, so its row locks do not block the tests after this one.`,
      );
    }

    beforeAll(async () => {
      process.env.DATABASE_URL = QA_URL;
      db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
      route = await import("@/app/api/mcp/route");
      ({ SESSION_IDLE_MS, pruneIdleTaskStartDeliveries } = await import("@/services/memory/task-start"));
    }, 60_000);

    afterAll(async () => {
      if (!db) return;
      await reset();
      await db.$disconnect();
    }, 60_000);

    beforeEach(async () => {
      await Promise.all(openClients.splice(0).map((client) => client.close()));
      sent.length = 0;
      vi.spyOn(console, "warn").mockImplementation(() => {});
      await reset();
      for (const orgId of [ORG_A, ORG_B]) await db.org.create({ data: { id: orgId, name: orgId } });
      await capability("a", ORG_A, AGENT, SCOPE_A);
      await capability("a2", ORG_A, OTHER_AGENT, SCOPE_A);
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
    }, 30_000);

    it("answers an initialize with a session id, which the SDK client sends back, and serves the block on the first call", async () => {
      const { client, transport } = await connect(tokens.a!);
      const first = await anyCall(client);

      expect(transport.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      const initialize = sent.find((r) => r.body.includes('"initialize"'))!;
      expect(initialize.sessionId).toBeNull();
      const toolCall = sent.find((r) => r.body.includes('"tools/call"'))!;
      expect(toolCall.sessionId).toBe(transport.sessionId);
      expect(blockOf(first)).toContain(`[convention ${RULE_A}]`);
      expect((await deliveries(ORG_A)).map((d) => d.sessionKey)).toEqual([`mcp:${transport.sessionId}`]);
    });

    it("serves a new connection opened right after the last one, and never repeats on one connection", async () => {
      const one = await connect(tokens.a!);
      expect(blockOf(await anyCall(one.client))).toBeDefined();
      expect(blockOf(await anyCall(one.client))).toBeUndefined();

      // Session 2, seconds later: exactly what a person trying it out does.
      const two = await connect(tokens.a!);
      expect(two.transport.sessionId).not.toBe(one.transport.sessionId);
      expect(blockOf(await anyCall(two.client))).toContain(`[convention ${RULE_A}]`);
      expect(blockOf(await anyCall(two.client))).toBeUndefined();
      // Opening session 2 did not reopen session 1.
      expect(blockOf(await anyCall(one.client))).toBeUndefined();
      expect(await servingsOf(ORG_A, `mcp:${one.transport.sessionId}`)).toBe(1);
      expect(await servingsOf(ORG_A, `mcp:${two.transport.sessionId}`)).toBe(1);
    });

    it("keeps the idle rule on one connection: served again only after 30 minutes without a call", async () => {
      const { client, transport } = await connect(tokens.a!);
      const key = `mcp:${transport.sessionId}`;
      expect(blockOf(await anyCall(client))).toBeDefined();

      await idlePast(ORG_A, key, SESSION_IDLE_MS - 60_000);
      expect(blockOf(await anyCall(client))).toBeUndefined();
      // That call moved the last call forward; now the connection sits idle past the window.
      await idlePast(ORG_A, key, SESSION_IDLE_MS + 1000);
      expect(blockOf(await anyCall(client))).toBeDefined();
      expect(await servingsOf(ORG_A, key)).toBe(2);
    });

    it("keeps the idle rule alone for a client that does not send the id back", async () => {
      expect(await rawInitialize(tokens.a!)).toMatch(/^[0-9a-f-]{36}$/);
      expect(await rawCall(tokens.a!)).toBeDefined();
      // A second initialize from the same client does not reopen its unnamed session.
      expect(await rawInitialize(tokens.a!)).toMatch(/^[0-9a-f-]{36}$/);
      expect(await rawCall(tokens.a!)).toBeUndefined();
      // A blank or control-character id names no session either.
      expect(await rawCall(tokens.a!, "   ")).toBeUndefined();
      expect(await rawCall(tokens.a!, "\u0001")).toBeUndefined();
      expect((await deliveries(ORG_A)).map((d) => d.sessionKey)).toEqual([""]);

      await idlePast(ORG_A, "", SESSION_IDLE_MS + 1000);
      expect(await rawCall(tokens.a!)).toBeDefined();
    });

    it("lets a session the client names span connections", async () => {
      const meta = { "willder/session": "run-42" };
      const one = await rawInitialize(tokens.a!);
      const two = await rawInitialize(tokens.a!);
      expect(await rawCall(tokens.a!, one!, meta)).toBeDefined();
      expect(await rawCall(tokens.a!, two!, meta)).toBeUndefined();
      // A blank name names none, so the call falls back to its connection.
      expect(await rawCall(tokens.a!, two!, { "willder/session": " " })).toBeDefined();
      expect((await deliveries(ORG_A)).map((d) => d.sessionKey)).toEqual([`mcp:${two}`, "run-42"]);
    });

    it("keys a connection's session under the token's own org and agent, so a replayed id spends no one else's block", async () => {
      const id = await rawInitialize(tokens.a!);
      // Org B's agent of the same name, and another agent of org A, send org A's agent's id first.
      const inB = await rawCall(tokens.b!, id!);
      expect(inB).toContain(`[convention ${RULE_B}]`);
      expect(inB).not.toContain(RULE_A);
      expect(await rawCall(tokens.a2!, id!)).toContain(`[convention ${RULE_A}]`);
      // The agent the id was minted for is still served its own block, once.
      expect(await rawCall(tokens.a!, id!)).toContain(`[convention ${RULE_A}]`);
      expect(await rawCall(tokens.a!, id!)).toBeUndefined();
      expect((await deliveries(ORG_B)).map((d) => d.sessionKey)).toEqual([`mcp:${id}`]);
      expect((await deliveries(ORG_A, OTHER_AGENT)).map((d) => d.sessionKey)).toEqual([`mcp:${id}`]);
    });

    it("delivers once to 8 concurrent first calls of one connection", async () => {
      const id = await rawInitialize(tokens.a!);
      const blocks = await Promise.all(Array.from({ length: 8 }, () => rawCall(tokens.a!, id!)));
      expect(blocks.filter((b) => b !== undefined)).toHaveLength(1);
      expect(await servingsOf(ORG_A, `mcp:${id}`)).toBe(1);
    });

    it("serves each connection of a reconnect storm once, and leaves no row for a connection that made no call", async () => {
      const connections = 12;
      const ids = await Promise.all(Array.from({ length: connections }, () => rawInitialize(tokens.a!)));
      expect(new Set(ids).size).toBe(connections);
      // Half the connections make three calls at once; the other half never call a tool.
      const calling = ids.slice(0, connections / 2);
      const blocks = await Promise.all(
        calling.flatMap((id) => Array.from({ length: 3 }, async () => ({ id, block: await rawCall(tokens.a!, id!) }))),
      );
      for (const id of calling) expect(blocks.filter((b) => b.id === id && b.block !== undefined)).toHaveLength(1);
      expect((await deliveries(ORG_A)).map((d) => d.sessionKey).sort()).toEqual(
        calling.map((id) => `mcp:${id}`).sort(),
      );
    });

    it("logs uses under the connection's session, so a connection's later calls count as using what it was served", async () => {
      const { client, transport } = await connect(tokens.a!);
      await anyCall(client);
      const key = `mcp:${transport.sessionId}`;
      // Served long enough ago that a later call can count as using it.
      await db.$executeRaw`UPDATE "task_start_served" SET "servedAt" = "servedAt" - interval '10 seconds' WHERE "orgId" = ${ORG_A} AND "sessionKey" = ${key}`;
      await anyCall(client, { briefId: RULE_A });

      const uses = await db.taskStartItemUse.findMany({ where: { orgId: ORG_A } });
      expect(uses.map((u) => [u.sessionKey, u.namedId])).toEqual([[key, RULE_A]]);
    });

    it("sends no session id on a failed initialize or a tool call, one on a batch of one initialize, and leaves a body that is not JSON to the transport's own error", async () => {
      const batch = await rawPost(tokens.a!, [initializeBody(1), toolCallBody(2)]);
      expect(batch.status).toBe(400);
      expect(batch.headers.get("mcp-session-id")).toBeNull();

      const notJson = await rawPost(tokens.a!, "{not json");
      expect(notJson.status).toBe(400);
      expect(((await notJson.json()) as { error: { code: number } }).error.code).toBe(-32700);
      expect(notJson.headers.get("mcp-session-id")).toBeNull();

      // An initialize sent as a batch of one is still an initialize.
      const alone = await rawPost(tokens.a!, [initializeBody(1)]);
      expect(alone.status).toBe(200);
      expect(alone.headers.get("mcp-session-id")).toMatch(/^[0-9a-f-]{36}$/);

      // A tool call is no initialize, and gets no id.
      expect((await rawPost(tokens.a!, toolCallBody())).headers.get("mcp-session-id")).toBeNull();
    });

    it("prunes the delivery rows of sessions idle for a day, which decide nothing, and keeps the rest", async () => {
      const stale = await rawInitialize(tokens.a!);
      const live = await rawInitialize(tokens.a!);
      const quiet = await rawInitialize(tokens.a!);
      for (const id of [stale, live, quiet]) await rawCall(tokens.a!, id!);
      await idlePast(ORG_A, `mcp:${stale}`, 24 * 3_600_000 + 60_000);
      await idlePast(ORG_A, `mcp:${quiet}`, 23 * 3_600_000);

      expect(await pruneWithin(10_000)).toBeGreaterThanOrEqual(1);
      expect((await deliveries(ORG_A)).map((d) => d.sessionKey).sort()).toEqual([`mcp:${live}`, `mcp:${quiet}`].sort());
      // Lossless: the pruned session is told again, as it would have been with its row idle.
      expect(await rawCall(tokens.a!, stale!)).toBeDefined();
      expect(await rawCall(tokens.a!, live!)).toBeUndefined();
    });

    it("prunes past one batch of 5,000 idle rows", async () => {
      // 51 agents with 100 idle rows each: 5,049 rows to prune, more than one batch. They are spread
      // over agents because the prune's "a newer row of this agent exists" check costs the square of
      // one agent's idle rows; 5,001 rows of one agent took from 0.1 s to minutes depending on the
      // plan, which is this test hanging on its cost rather than checking the batch loop.
      const agents = 51;
      const perAgent = 100;
      await db.$executeRaw`
      INSERT INTO "task_start_deliveries" ("id", "orgId", "agentId", "sessionKey", "revision", "deliveredAt", "lastCallAt")
      SELECT 'qa-idle-' || a || '-' || n, ${ORG_A}, 'qa-idle-agent-' || a, 'mcp:idle-' || a || '-' || n, 'r',
             (now() AT TIME ZONE 'UTC') - interval '3 days', (now() AT TIME ZONE 'UTC') - interval '2 days'
      FROM generate_series(1, ${agents}::int) AS a, generate_series(1, ${perAgent}::int) AS n`;
      // The planner's statistics are whatever autovacuum last saw, often this table nearly empty. On
      // those it ran the prune as a nested loop that re-reads the whole candidate list per row.
      // Production's table is analyzed at its real size; so is this one, before the prune.
      await db.$executeRaw`ANALYZE "task_start_deliveries"`;

      expect(await pruneWithin(15_000)).toBeGreaterThanOrEqual(agents * (perAgent - 1));
      // Each agent's newest row stays: it is when the agent last called (services/memory/since-last-session.ts).
      const kept = await db.taskStartDelivery.groupBy({ by: ["agentId"], where: { orgId: ORG_A }, _count: true });
      expect(kept).toHaveLength(agents);
      expect(kept.every((agent) => agent._count === 1)).toBe(true);
    });

    it("keeps each agent's newest idle row in each org, and only that one", async () => {
      await db.$executeRaw`
      INSERT INTO "task_start_deliveries" ("id", "orgId", "agentId", "sessionKey", "revision", "deliveredAt", "lastCallAt")
      VALUES
        ('qa-keep-a-old', ${ORG_A}, ${AGENT}, 'mcp:a-old', 'r', (now() AT TIME ZONE 'UTC') - interval '9 days', (now() AT TIME ZONE 'UTC') - interval '9 days'),
        ('qa-keep-a-new', ${ORG_A}, ${AGENT}, 'mcp:a-new', 'r', (now() AT TIME ZONE 'UTC') - interval '3 days', (now() AT TIME ZONE 'UTC') - interval '3 days'),
        ('qa-keep-other-agent', ${ORG_A}, 'agent-other', 'mcp:o', 'r', (now() AT TIME ZONE 'UTC') - interval '9 days', (now() AT TIME ZONE 'UTC') - interval '9 days'),
        ('qa-keep-other-org', ${ORG_B}, ${AGENT}, 'mcp:b', 'r', (now() AT TIME ZONE 'UTC') - interval '9 days', (now() AT TIME ZONE 'UTC') - interval '9 days')`;

      await pruneWithin(10_000);

      const kept = await db.taskStartDelivery.findMany({
        where: { id: { startsWith: "qa-keep-" } },
        select: { id: true },
      });
      expect(kept.map((d) => d.id).sort()).toEqual(["qa-keep-a-new", "qa-keep-other-agent", "qa-keep-other-org"]);
    });

    it("never deletes a claim that refreshed an idle row while the prune waited on it, so the session is told once", async () => {
      const id = await rawInitialize(tokens.a!);
      const key = `mcp:${id}`;
      expect(await rawCall(tokens.a!, id!)).toBeDefined();
      // The agent's newest row is never pruned, so the idle row below is only a candidate while a
      // newer row of the same agent exists. Without this one the prune finds nothing to wait on.
      const newer = await rawInitialize(tokens.a!);
      expect(await rawCall(tokens.a!, newer!)).toBeDefined();
      await idlePast(ORG_A, key, 25 * 3_600_000);

      let prune: Promise<number> | undefined;
      await db.$transaction(
        async (tx) => {
          // What claimTaskStartDelivery's ON CONFLICT DO UPDATE does to the idle row, held open
          // while the prune runs, so the prune finds the row and then waits on its lock.
          const claimed = await tx.$executeRaw`
          UPDATE "task_start_deliveries" SET "deliveredAt" = (now() AT TIME ZONE 'UTC'), "lastCallAt" = (now() AT TIME ZONE 'UTC'), "revision" = 'refreshed'
          WHERE "orgId" = ${ORG_A} AND "sessionKey" = ${key}`;
          expect(claimed).toBe(1);
          const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          prune = pruneIdleTaskStartDeliveries();
          await pruneIsBlockedBy(pid);
        },
        { timeout: 15_000 },
      );
      await pruneWithin(10_000, prune!);

      expect(
        (await deliveries(ORG_A)).filter((d) => d.sessionKey === key).map((d) => [d.sessionKey, d.revision]),
      ).toEqual([[key, "refreshed"]]);
      expect(await rawCall(tokens.a!, id!)).toBeUndefined();
    }, 30_000);
  },
);
