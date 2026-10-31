// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// QA for the since-your-last-session line (services/memory/since-last-session.ts): the edges
// the builder's suites leave open. Access that narrowed while the agent was away, a writer
// seen only in a hidden scope, a cap that hidden changes could fill, the 30-minute boundary on
// both sides, and the prune's bound with many agents and many sessions.
//
// Set QA_DATABASE_URL to an ISOLATED test database, never the inherited DATABASE_URL.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel, which builds the `@/lib/db` singleton
// at import time, before beforeAll points DATABASE_URL at the QA database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import { SINCE_LAST_SESSION_OPENING } from "./task-start-headings";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-since-last-session";
const SALES = "org_1.sales";
const SALES_EMEA = "org_1.sales.emea";
const SALES_US = "org_1.sales.us";
const ENGINEERING = "org_1.engineering";
const RETURNER = "agent-returner";
const WRITER = "agent-writer";
const HIDDEN_WRITER = "agent-hidden-writer";
const MINUTE = 60 * 1000;

describe.skipIf(!QA_URL)("QA: the since line under narrowed access, hidden writers, the cap and the prune", () => {
  let db: PrismaClient;
  let toolCallNotice: (typeof import("./change-notices"))["toolCallNotice"];
  let recordChangeEvent: (typeof import("@/services/memory/change-events"))["recordChangeEvent"];
  let pruneIdleTaskStartDeliveries: (typeof import("@/services/memory/task-start"))["pruneIdleTaskStartDeliveries"];
  let SESSION_IDLE_MS: number;

  async function mint(scopePath: string, grantGoverned = false): Promise<string> {
    const raw = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId: RETURNER,
        tokenHash: hashCapabilityToken(raw),
        scopePath,
        permission: "read",
        grantGoverned,
        expiresAt: new Date(Date.now() + 60 * MINUTE),
      },
    });
    return raw;
  }

  const ctxFor = (bearer: string): AccessContext => ({
    orgId: ORG,
    actor: { type: "agent", id: RETURNER, capabilityToken: bearer },
    origin: "mcp",
  });

  async function change(opts: { scopePath?: string; actorId?: string; minutesAgo?: number } = {}): Promise<void> {
    const { id } = await db.$transaction((tx) =>
      recordChangeEvent(tx, {
        orgId: ORG,
        scopePath: opts.scopePath ?? SALES,
        recordType: "fact",
        recordId: `rec-${Math.random().toString(36).slice(2)}`,
        op: "create",
        actorId: opts.actorId ?? WRITER,
        actorType: "agent",
        origin: "mcp",
        title: "a change",
      }),
    );
    await db.changeEvent.update({
      where: { id },
      data: { createdAt: new Date(Date.now() - (opts.minutesAgo ?? 10) * MINUTE) },
    });
  }

  async function earlierSession(
    minutesAgo: number,
    agentId = RETURNER,
    sessionKey = `mcp:earlier-${Math.random()}`,
  ): Promise<void> {
    const lastCallAt = new Date(Date.now() - minutesAgo * MINUTE);
    await db.taskStartDelivery.create({
      data: {
        orgId: ORG,
        agentId,
        sessionKey,
        scopePath: SALES,
        taskKey: "",
        revision: "earlier",
        deliveredAt: lastCallAt,
        lastCallAt,
      },
    });
  }

  const firstCall = (bearer: string, scopePath = SALES) =>
    toolCallNotice(ctxFor(bearer), scopePath, { taskStart: { sessionKey: `mcp:now-${Math.random()}`, taskText: "" } });

  const sinceLineOf = (text: string | null) =>
    (text ?? "").split("\n").find((line) => line.startsWith(SINCE_LAST_SESSION_OPENING));

  async function clean(): Promise<void> {
    await db.taskStartItemUse.deleteMany({ where: { orgId: ORG } });
    await db.taskStartServedItem.deleteMany({ where: { orgId: ORG } });
    await db.taskStartDelivery.deleteMany({ where: { orgId: ORG } });
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.agentCursor.deleteMany({ where: { orgId: ORG } });
    await db.grant.deleteMany({ where: { orgId: ORG } });
    await db.scope.deleteMany({ where: { orgId: ORG } });
    await db.capability.deleteMany({ where: { orgId: ORG } });
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ toolCallNotice } = await import("./change-notices"));
    ({ recordChangeEvent } = await import("@/services/memory/change-events"));
    ({ pruneIdleTaskStartDeliveries, SESSION_IDLE_MS } = await import("@/services/memory/task-start"));
  });

  afterAll(async () => {
    await clean();
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.$disconnect();
  });

  beforeEach(clean);

  it("access narrowed while away: a grant-governed agent now granted only sales.emea learns nothing of the rest of sales", async () => {
    const scopes: Record<string, string> = {};
    for (const path of [SALES, SALES_EMEA, SALES_US])
      scopes[path] = (await db.scope.create({ data: { orgId: ORG, path, name: path } })).id;
    // Its token still names all of sales; its live grant was demoted to emea while it was away.
    const token = await mint(SALES, true);
    await db.grant.create({
      data: { orgId: ORG, scopeId: scopes[SALES_EMEA]!, granteeType: "agent", granteeId: RETURNER, permission: "read" },
    });
    await earlierSession(120);
    await change({ scopePath: SALES_US, minutesAgo: 30 });
    await change({ scopePath: SALES, minutesAgo: 30 });

    const text = await firstCall(token);

    // Denied on its token's scope, it is told nothing at all, so not even a count.
    expect(text).toBeNull();
    expect(sinceLineOf(text)).toBeUndefined();
  });

  it("control for the case above: with its grant still on all of sales, the same changes are counted", async () => {
    const scope = await db.scope.create({ data: { orgId: ORG, path: SALES, name: SALES } });
    const token = await mint(SALES, true);
    await db.grant.create({
      data: { orgId: ORG, scopeId: scope.id, granteeType: "agent", granteeId: RETURNER, permission: "read" },
    });
    await earlierSession(120);
    await change({ scopePath: SALES_US, minutesAgo: 30 });
    await change({ scopePath: SALES, minutesAgo: 30 });

    expect(sinceLineOf(await firstCall(token))).toContain(": 2 changes by 1 other writer in your scope.");
  });

  it("a new token on a narrower scope after the return: only what that scope holds is counted", async () => {
    // It last called through a token on the org root; it comes back with one on sales only.
    await mint("org_1");
    await earlierSession(120);
    const narrower = await mint(SALES);
    await change({ scopePath: ENGINEERING, actorId: HIDDEN_WRITER, minutesAgo: 30 });
    await change({ scopePath: SALES, minutesAgo: 30 });

    expect(sinceLineOf(await firstCall(narrower))).toContain(": 1 change by 1 other writer in your scope.");
  });

  it("the writer count leaves out a writer whose changes are all hidden", async () => {
    const token = await mint(SALES);
    await earlierSession(120);
    await change({ scopePath: SALES, actorId: WRITER, minutesAgo: 40 });
    await change({ scopePath: SALES, actorId: WRITER, minutesAgo: 35 });
    // A second writer, busy only in a sibling scope and in another scope.
    await change({ scopePath: "org_1.sales_eu", actorId: HIDDEN_WRITER, minutesAgo: 30 });
    await change({ scopePath: ENGINEERING, actorId: HIDDEN_WRITER, minutesAgo: 30 });

    expect(sinceLineOf(await firstCall(token))).toContain(": 2 changes by 1 other writer in your scope.");
  });

  it("the cap counts readable changes only: 1000 hidden changes ahead of one visible one do not fill it", async () => {
    const token = await mint(SALES);
    await earlierSession(120);
    for (let i = 0; i < 1000; i += 100) {
      await db.$transaction(async (tx) => {
        for (let j = 0; j < 100; j++) {
          await recordChangeEvent(tx, {
            orgId: ORG,
            scopePath: ENGINEERING,
            recordType: "fact",
            recordId: `hidden-${i + j}`,
            op: "create",
            actorId: HIDDEN_WRITER,
            actorType: "agent",
            origin: "mcp",
            title: "hidden",
          });
        }
      });
    }
    await change({ scopePath: SALES, minutesAgo: 0 });

    const line = sinceLineOf(await firstCall(token));

    expect(line).toContain(": 1 change by 1 other writer in your scope.");
    expect(line).not.toContain("or more");
  }, 60_000);

  it("the 30-minute boundary: a last call one minute inside it is no return, one minute past it is", async () => {
    const token = await mint(SALES);
    const idleMinutes = SESSION_IDLE_MS / MINUTE;
    await earlierSession(idleMinutes - 1);
    await change({ minutesAgo: 0 });
    expect(sinceLineOf(await firstCall(token))).toBeUndefined();

    await db.taskStartDelivery.deleteMany({ where: { orgId: ORG } });
    await db.agentCursor.deleteMany({ where: { orgId: ORG } });
    await earlierSession(idleMinutes + 1);
    expect(sinceLineOf(await firstCall(token))).toContain(": 1 change by 1 other writer in your scope.");
  });

  it("the prune keeps one row per agent, however many agents and idle sessions there are", async () => {
    const agents = ["agent-a", "agent-b", "agent-c"];
    for (const agentId of agents) {
      for (let day = 2; day <= 6; day++) {
        await earlierSession(day * 24 * 60, agentId);
        await earlierSession(day * 24 * 60 + 5, agentId);
      }
    }
    // A fresh session of agent-a stays, and makes agent-a's idle rows all prunable.
    await earlierSession(1, "agent-a");

    await pruneIdleTaskStartDeliveries();

    const left = await db.taskStartDelivery.groupBy({ by: ["agentId"], where: { orgId: ORG }, _count: { _all: true } });
    const byAgent = Object.fromEntries(left.map((row) => [row.agentId, row._count._all]));
    expect(byAgent).toEqual({ "agent-a": 1, "agent-b": 1, "agent-c": 1 });
    // The one kept is each agent's newest.
    const kept = await db.taskStartDelivery.findMany({ where: { orgId: ORG, agentId: "agent-b" } });
    expect(Date.now() - kept[0]!.lastCallAt.getTime()).toBeLessThan(2 * 24 * 60 * MINUTE + MINUTE);

    // A second prune finds nothing more to take.
    expect(await pruneIdleTaskStartDeliveries()).toBe(0);
  });
});
