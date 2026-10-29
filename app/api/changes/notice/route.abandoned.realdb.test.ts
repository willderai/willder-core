// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test Postgres;
// without it every test in this file is skipped, not failed.
//
// A task-start block whose reply nobody reads is not used up (TaskStartRequest.abandoned,
// mcp/connection-session.ts). On a cold start the block can take longer than the 2 s the
// Claude Code hook waits for GET /api/changes/notice; claimed anyway, the session was never
// told it and never would be. Here the block's read is held past that wait by a lock on the
// conventions table it reads, which is released on a timer.
//
// Real: the installed hook's own fetchNotice with its own timeout, the notice route on a real
// socket, the MCP route, Postgres, the delivery claim and the served-vs-used log. Stood in: the
// slow cold start, by the table lock.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { hashCapabilityToken } from "@/services/access/capabilities";
import { fetchNotice } from "@/cli/hooks/willder-changes.mjs";
import { NOTICE_TIMEOUT_MS } from "@/cli/hooks/willder-capture.mjs";

vi.mock("@/lib/inngest", () => ({ ingestMemory: vi.fn().mockResolvedValue(undefined) }));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qa_notice_abandoned";
const SCOPE = `org_${ORG}.web`;
const AGENT = "abandoned-reader";
const RULE = "qaabandonedrule1";
const SESSION = "claude-session-cold";

describe.skipIf(!QA_URL)("a task-start block whose reply is abandoned is told on the session's next call", () => {
  let db: PrismaClient;
  let notice: typeof import("./route");
  let mcp: typeof import("@/app/api/mcp/route");
  let token = "";
  let server: Server;
  let origin = "";
  /** Every notice request the socket server is still handling. */
  const handling = new Set<Promise<unknown>>();

  /**
   * Hold the conventions table, which the block reads, for `ms`. Resolves once it is held, to
   * a promise of its release (wrapped, since an async function would wait for that too).
   */
  async function holdConventions(ms: number): Promise<{ released: Promise<void> }> {
    const client = new pg.Client({ connectionString: QA_URL });
    await client.connect();
    await client.query("BEGIN");
    await client.query('LOCK TABLE "conventions" IN ACCESS EXCLUSIVE MODE');
    const released = new Promise<void>((resolve) =>
      setTimeout(() => {
        void client
          .query("COMMIT")
          .then(() => client.end())
          .then(resolve);
      }, ms),
    );
    return { released };
  }

  const env = () => ({ WILLDER_TOKEN: token, WILLDER_URL: origin });
  const servings = async (sessionKey: string) =>
    new Set((await db.taskStartServedItem.findMany({ where: { orgId: ORG, sessionKey } })).map((r) => r.servingId))
      .size;
  const claimed = (sessionKey: string) => db.taskStartDelivery.count({ where: { orgId: ORG, sessionKey } });

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL! }) });
    notice = await import("./route");
    mcp = await import("@/app/api/mcp/route");
    server = createServer((req, res) => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(key, value);
      const handled = notice
        .GET(new Request(`${origin}${req.url}`, { headers }))
        .then(async (response) => {
          res.writeHead(response.status, { "content-type": "application/json" });
          res.end(await response.text());
        })
        .catch(() => res.destroy());
      handling.add(handled);
      void handled.finally(() => handling.delete(handled));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    if (!db) return;
    await db.taskStartServedItem.deleteMany({ where: { orgId: ORG } });
    await db.taskStartDelivery.deleteMany({ where: { orgId: ORG } });
    await db.$disconnect();
  });

  beforeEach(async () => {
    await db.taskStartItemUse.deleteMany({ where: { orgId: ORG } });
    await db.taskStartServedItem.deleteMany({ where: { orgId: ORG } });
    await db.taskStartDelivery.deleteMany({ where: { orgId: ORG } });
    await db.convention.deleteMany({ where: { orgId: ORG } });
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.agentCursor.deleteMany({ where: { orgId: ORG } });
    await db.capability.deleteMany({ where: { orgId: ORG } });
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
    token = `wcap_test_abandoned_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId: AGENT,
        tokenHash: hashCapabilityToken(token),
        scopePath: SCOPE,
        permission: "read",
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    await db.convention.create({
      data: {
        id: RULE,
        orgId: ORG,
        scopePath: SCOPE,
        kind: "decision",
        subject: "Session store",
        text: "We store sessions in Postgres, not Redis.",
        actorId: "author",
      },
    });
  });

  it("leaves a block the hook gave up on for its next poll, and tells it once", async () => {
    const { released } = await holdConventions(NOTICE_TIMEOUT_MS + 700);
    const started = Date.now();
    expect(await fetchNotice(env(), fetch, SESSION)).toBeNull();
    expect(Date.now() - started).toBeLessThan(NOTICE_TIMEOUT_MS + 500);
    await released;
    // The server finished the slow block after the hook left, and claimed nothing.
    await Promise.all(handling);
    expect(await claimed(SESSION)).toBe(0);

    const next = await fetchNotice(env(), fetch, SESSION);
    expect(next).toMatch(/^Before you start/);
    expect(next).toContain("We store sessions in Postgres, not Redis.");
    expect(await fetchNotice(env(), fetch, SESSION)).toBeNull();
    expect(await servings(SESSION)).toBe(1);
  }, 20_000);

  it("claims a slow block that still arrives in time, and does not tell it again", async () => {
    const { released } = await holdConventions(400);
    expect(await fetchNotice(env(), fetch, SESSION)).toMatch(/^Before you start/);
    await released;
    expect(await fetchNotice(env(), fetch, SESSION)).toBeNull();
    expect(await servings(SESSION)).toBe(1);
  }, 20_000);

  it("leaves a block for the next poll when the hook hangs up before the budget runs out", async () => {
    const { released } = await holdConventions(800);
    const hangUp = new AbortController();
    const pending = notice.GET(
      new Request(`${origin}/api/changes/notice`, {
        headers: { authorization: `Bearer ${token}`, "x-willder-session": SESSION },
        signal: hangUp.signal,
      }),
    );
    setTimeout(() => hangUp.abort(), 200);
    await pending;
    await released;
    expect(await claimed(SESSION)).toBe(0);
    expect(await fetchNotice(env(), fetch, SESSION)).toMatch(/^Before you start/);
  }, 20_000);

  it("leaves a block for a connection's next tool call when its client hung up on the call", async () => {
    const init = await mcp.POST(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
        }),
      }),
    );
    const id = init.headers.get("mcp-session-id")!;
    const call = (signal?: AbortSignal) =>
      mcp.POST(
        new Request("http://localhost/api/mcp", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-session-id": id,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "get_my_brief", arguments: { briefId: "no-such-brief" } },
          }),
          signal,
        }),
      );
    const blockOf = async (response: Response) =>
      ((await response.json()) as { result: { content: { text: string }[] } }).result.content
        .map((c) => c.text)
        .find((t) => t.startsWith("Before you start"));

    const { released } = await holdConventions(800);
    const hangUp = new AbortController();
    const pending = call(hangUp.signal);
    setTimeout(() => hangUp.abort(), 200);
    await pending;
    await released;
    expect(await claimed(`mcp:${id}`)).toBe(0);

    expect(await blockOf(await call())).toContain(`[decision ${RULE}]`);
    expect(await blockOf(await call())).toBeUndefined();
  }, 20_000);
});
