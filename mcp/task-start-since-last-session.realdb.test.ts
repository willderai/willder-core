// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The line a returning session is opened with: what changed in its scope while the agent was
// away (services/memory/since-last-session.ts, rendered by mcp/task-start-notice.ts).
//
// Driven through toolCallNotice, the one function both the MCP route and the prompt hook's
// route (GET /api/changes/notice) attach to what they return, plus one case through the
// hook's route itself, which is how a person returning to their coding agent meets the line.
// Real: Postgres, the change feed and its cursor, the task-start delivery claim, can() and the
// audited check(). The agent's earlier session is a task_start_deliveries row whose last call
// is backdated, exactly what an earlier session leaves behind.
//
// Set QA_DATABASE_URL to an ISOLATED test database, never the inherited DATABASE_URL, which may
// point at a live database. Skips cleanly without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the `@/lib/db`
// singleton at import time, before beforeAll points DATABASE_URL at the QA database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import { SINCE_LAST_SESSION_OPENING } from "./task-start-headings";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-since-last-session";
const OTHER_ORG = "org-qa-since-last-session-other";
const SALES = "org_1.sales";
const SALES_EMEA = "org_1.sales.emea";
// A sibling of `sales`, not a descendant: an unescaped LIKE on `sales%` would match it.
const SALES_SIBLING = "org_1.sales_eu";
const ENGINEERING = "org_1.engineering";

const RETURNER = "agent-returner";
const WRITER = "agent-writer";
const PERSON = "user-dana";
const TASK = "PRICING-12";
const ERASED_NAME = "Orla Vennick";

const MINUTE = 60 * 1000;

describe.skipIf(!QA_URL)("the since-your-last-session line, against a real database", () => {
  let db: PrismaClient;
  let toolCallNotice: (typeof import("./change-notices"))["toolCallNotice"];
  let taskStartNotice: (typeof import("./task-start-notice"))["taskStartNotice"];
  let recordChangeEvent: (typeof import("@/services/memory/change-events"))["recordChangeEvent"];
  let recordSuppressions: (typeof import("@/services/memory/erasure-suppression"))["recordSuppressions"];
  let hookGET: (typeof import("@/app/api/changes/notice/route"))["GET"];
  let SESSION_IDLE_MS: number;
  let pruneIdleTaskStartDeliveries: (typeof import("@/services/memory/task-start"))["pruneIdleTaskStartDeliveries"];
  let token = "";

  async function mint(orgId: string, agentId: string, scopePath: string, grantGoverned = false): Promise<string> {
    const raw = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId,
        agentId,
        tokenHash: hashCapabilityToken(raw),
        scopePath,
        permission: "read",
        grantGoverned,
        expiresAt: new Date(Date.now() + 60 * MINUTE),
      },
    });
    return raw;
  }

  const ctxFor = (bearer: string, orgId = ORG, agentId = RETURNER): AccessContext => ({
    orgId,
    actor: { type: "agent", id: agentId, capabilityToken: bearer },
    origin: "mcp",
  });

  /** A change event as a real write records it, made `minutesAgo` ago. Returns its seq. */
  async function change(
    opts: {
      scopePath?: string;
      actorId?: string;
      actorType?: "agent" | "human" | "extraction";
      recordType?: string;
      recordId?: string;
      task?: string;
      title?: string;
      minutesAgo?: number;
      createdAt?: Date;
      orgId?: string;
    } = {},
  ): Promise<bigint> {
    const orgId = opts.orgId ?? ORG;
    const { id, seq } = await db.$transaction((tx) =>
      recordChangeEvent(tx, {
        orgId,
        scopePath: opts.scopePath ?? SALES,
        recordType: opts.recordType ?? "fact",
        recordId: opts.recordId ?? `rec-${Math.random().toString(36).slice(2)}`,
        op: "create",
        actorId: opts.actorId ?? WRITER,
        actorType: opts.actorType ?? "agent",
        origin: "mcp",
        title: opts.title ?? "a change",
        ...(opts.task ? { task: opts.task } : {}),
      }),
    );
    const createdAt =
      opts.createdAt ?? (opts.minutesAgo === undefined ? undefined : new Date(Date.now() - opts.minutesAgo * MINUTE));
    if (createdAt !== undefined) await db.changeEvent.update({ where: { id }, data: { createdAt } });
    return seq;
  }

  /** What an earlier session leaves: a delivery whose last call was `minutesAgo` ago. */
  async function earlierSession(minutesAgo: number, orgId = ORG, agentId = RETURNER): Promise<Date> {
    const lastCallAt = new Date(Date.now() - minutesAgo * MINUTE);
    await db.taskStartDelivery.create({
      data: {
        orgId,
        agentId,
        sessionKey: `mcp:earlier-${Math.random().toString(36).slice(2)}`,
        scopePath: SALES,
        taskKey: "",
        revision: "earlier",
        deliveredAt: lastCallAt,
        lastCallAt,
      },
    });
    return lastCallAt;
  }

  /** The first call of a new session, as both routes make it. */
  const firstCall = (opts: { session?: string; task?: string; ctx?: AccessContext; scopePath?: string } = {}) =>
    toolCallNotice(opts.ctx ?? ctxFor(token), opts.scopePath ?? SALES, {
      taskStart: { sessionKey: opts.session ?? "mcp:now", taskText: opts.task ?? "", taskKey: opts.task },
    });

  const sinceLineOf = (text: string | null): string | undefined =>
    (text ?? "").split("\n").find((line) => line.startsWith(SINCE_LAST_SESSION_OPENING));

  const auditRows = (orgId = ORG) => db.auditLog.count({ where: { orgId } });

  async function clean(orgId: string): Promise<void> {
    await db.taskStartItemUse.deleteMany({ where: { orgId } });
    await db.taskStartServedItem.deleteMany({ where: { orgId } });
    await db.taskStartDelivery.deleteMany({ where: { orgId } });
    await db.auditLog.deleteMany({ where: { orgId } });
    await db.changeEvent.deleteMany({ where: { orgId } });
    await db.agentCursor.deleteMany({ where: { orgId } });
    await db.erasureSuppression.deleteMany({ where: { orgId } });
    await db.capability.deleteMany({ where: { orgId } });
    await db.org.upsert({ where: { id: orgId }, update: {}, create: { id: orgId, name: orgId } });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ toolCallNotice } = await import("./change-notices"));
    ({ taskStartNotice } = await import("./task-start-notice"));
    ({ recordChangeEvent } = await import("@/services/memory/change-events"));
    ({ recordSuppressions } = await import("@/services/memory/erasure-suppression"));
    ({ GET: hookGET } = await import("@/app/api/changes/notice/route"));
    ({ SESSION_IDLE_MS, pruneIdleTaskStartDeliveries } = await import("@/services/memory/task-start"));
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  beforeEach(async () => {
    await clean(ORG);
    await clean(OTHER_ORG);
    token = await mint(ORG, RETURNER, SALES);
  });

  it("nothing changed: a returning session gets no line, and a block with nothing else to say writes no audit row", async () => {
    await earlierSession(3 * 24 * 60);
    const before = await auditRows();

    const text = await firstCall();

    expect(text).toBeNull();
    expect(await auditRows()).toBe(before);
  });

  it("changed: says when the last call was and counts the changes, the other writers and the task's share", async () => {
    const lastCallAt = await earlierSession(2 * 24 * 60);
    await change({ task: TASK, minutesAgo: 600 });
    await change({ actorId: PERSON, actorType: "human", minutesAgo: 300 });
    // Inside a descendant of the scope: the scope covers it.
    await change({ scopePath: SALES_EMEA, task: TASK, minutesAgo: 60 });

    const line = sinceLineOf(await firstCall({ task: TASK }));

    const at = lastCallAt.toISOString().slice(0, 16).replace("T", " ");
    expect(line).toBe(
      `${SINCE_LAST_SESSION_OPENING} (last call ${at} UTC): 3 changes by 2 other writers in your scope, 2 on this task.`,
    );
  });

  it("the line is said once per return: the session's next call does not repeat it", async () => {
    await earlierSession(120);
    await change({ minutesAgo: 30 });
    expect(sinceLineOf(await firstCall())).toBeDefined();

    await change();
    expect(sinceLineOf(await firstCall())).toBeUndefined();
  });

  it("an audited read: the block that carries the line writes exactly one allowed memory.read row", async () => {
    await earlierSession(120);
    await change({ minutesAgo: 30 });
    const before = await db.auditLog.count({ where: { orgId: ORG, action: "memory.read", decision: "allow" } });

    // The block alone, without the change notices after it, which audit their own read.
    expect(
      sinceLineOf(await taskStartNotice(ctxFor(token), { scopePath: SALES, sessionKey: "mcp:now", taskText: "" })),
    ).toBeDefined();

    expect(await db.auditLog.count({ where: { orgId: ORG, action: "memory.read", decision: "allow" } })).toBe(
      before + 1,
    );
  });

  it("changed in a hidden scope only: a sibling scope, another scope and another tenant never show, not even as a count", async () => {
    await earlierSession(120);
    await earlierSession(120, OTHER_ORG);
    await change({ scopePath: SALES_SIBLING, minutesAgo: 30 });
    await change({ scopePath: ENGINEERING, minutesAgo: 30 });
    // Another tenant, the very same scope path, and the same agent id there.
    await change({ orgId: OTHER_ORG, minutesAgo: 30 });

    expect(await firstCall()).toBeNull();
  });

  it("changed in a hidden scope and in the agent's own: counts only its own", async () => {
    await earlierSession(120);
    await change({ scopePath: SALES_SIBLING, minutesAgo: 30 });
    await change({ orgId: OTHER_ORG, minutesAgo: 30 });
    await change({ minutesAgo: 30 });

    expect(sinceLineOf(await firstCall())).toContain(": 1 change by 1 other writer in your scope.");
  });

  it("another tenant's sessions are not this agent's last call here: an agent new to this org gets no line", async () => {
    // The same agent id worked in another org two days ago; in this org it never called.
    await earlierSession(2 * 24 * 60, OTHER_ORG);
    await change({ minutesAgo: 60 });

    expect(sinceLineOf(await firstCall())).toBeUndefined();
  });

  it("another tenant's recent session does not hide a return here", async () => {
    await earlierSession(2 * 24 * 60);
    await earlierSession(1, OTHER_ORG);
    await change({ minutesAgo: 60 });

    expect(sinceLineOf(await firstCall())).toContain(": 1 change by 1 other writer");
  });

  it("counts no change of the agent's own, and no working-note post", async () => {
    await earlierSession(120);
    await change({ actorId: RETURNER, minutesAgo: 30 });
    await change({ recordType: "note", minutesAgo: 30 });

    expect(sinceLineOf(await firstCall())).toBeUndefined();
  });

  it("counts no change made before the last call, even one the agent was never served", async () => {
    await earlierSession(120);
    await change({ minutesAgo: 180 });

    expect(sinceLineOf(await firstCall())).toBeUndefined();
  });

  it("counts no change the agent was already told about: its cursor has passed it", async () => {
    await earlierSession(120);
    const seen = await change({ minutesAgo: 30 });
    await db.agentCursor.create({ data: { orgId: ORG, agentId: RETURNER, lastSeq: seen } });

    expect(sinceLineOf(await firstCall())).toBeUndefined();
  });

  it("counts a change stamped in the last call's own millisecond, which that call was not told", async () => {
    const lastCallAt = await earlierSession(120);
    await change({ createdAt: lastCallAt });

    expect(sinceLineOf(await firstCall())).toContain(": 1 change by 1 other writer in your scope.");
  });

  it("an agent back after days is still told, once the daily prune of idle deliveries has run", async () => {
    // The prune must not delete the last call's rows just because they are idle a day.
    await earlierSession(3 * 24 * 60);
    await earlierSession(2 * 24 * 60);
    await change({ minutesAgo: 60 });

    await pruneIdleTaskStartDeliveries();

    expect(await db.taskStartDelivery.count({ where: { orgId: ORG, agentId: RETURNER } })).toBe(1);
    expect(sinceLineOf(await firstCall())).toContain(": 1 change by 1 other writer in your scope.");
  });

  it("a first session ever is not a return: no earlier call, no line", async () => {
    await change({ minutesAgo: 30 });

    expect(sinceLineOf(await firstCall())).toBeUndefined();
  });

  it("a reconnect inside the idle window is the same stretch of work: no line", async () => {
    await earlierSession(SESSION_IDLE_MS / MINUTE - 5);
    await change({ minutesAgo: 1 });

    expect(sinceLineOf(await firstCall())).toBeUndefined();
  });

  it("the last call is the newest of the agent's sessions here, whichever session it was", async () => {
    await earlierSession(3 * 24 * 60);
    const newest = await earlierSession(90);
    await change({ minutesAgo: 120 }); // before the newest session: not since it
    await change({ minutesAgo: 60 });

    const line = sinceLineOf(await firstCall());

    expect(line).toContain(`(last call ${newest.toISOString().slice(0, 16).replace("T", " ")} UTC)`);
    expect(line).toContain(": 1 change by 1 other writer");
  });

  it("counts on this task only the changes made under the session's own task, and none when it names no task", async () => {
    await earlierSession(120);
    await change({ task: TASK, minutesAgo: 30 });
    await change({ task: `${TASK}-other`, minutesAgo: 30 });
    await change({ task: TASK.toLowerCase(), minutesAgo: 30 });

    expect(sinceLineOf(await firstCall({ task: TASK }))).toContain(
      ": 3 changes by 1 other writer in your scope, 1 on this task.",
    );
  });

  it("says no task share when the session names no task, whatever task the changes were made under", async () => {
    await earlierSession(120);
    await change({ task: TASK, minutesAgo: 30 });
    await change({ minutesAgo: 30 });

    expect(sinceLineOf(await firstCall())).toContain(": 2 changes by 1 other writer in your scope.");
  });

  it("past the cap, says 1000 or more and stops counting", async () => {
    await earlierSession(120);
    const createdAt = new Date(Date.now() - 30 * MINUTE);
    await db.changeEvent.createMany({
      data: Array.from({ length: 1001 }, (_, i) => ({
        orgId: ORG,
        seq: BigInt(i + 1),
        scopePath: SALES,
        recordType: "fact",
        recordId: `bulk-${i}`,
        op: "create" as const,
        actorId: `${WRITER}-${i % 3}`,
        summary: "bulk",
        createdAt,
      })),
    });

    expect(sinceLineOf(await firstCall())).toContain(": 1000 or more changes by others in your scope.");
  });

  it("an agent that may no longer read its scope gets no line and learns nothing, however much changed", async () => {
    const denied = await mint(ORG, "agent-revoked", SALES, true);
    await earlierSession(120, ORG, "agent-revoked");
    await change({ minutesAgo: 30 });

    expect(await firstCall({ ctx: ctxFor(denied, ORG, "agent-revoked") })).toBeNull();
  });

  it("an erased person: the change is counted, and nothing the agent is told names them", async () => {
    await earlierSession(120);
    await change({ title: `${ERASED_NAME} asked for a refund`, task: `call ${ERASED_NAME}`, minutesAgo: 30 });
    // What the erasure leaves (services/memory/person-erasure.ts): the person on the suppression
    // list and every change summary naming them blanked. The event itself stays in the feed.
    await recordSuppressions(db, ORG, "qa-erasure", { emails: [], names: [ERASED_NAME.toLowerCase()], contactIds: [] });
    await db.changeEvent.updateMany({ where: { orgId: ORG }, data: { summary: "" } });

    const text = await firstCall({ task: TASK });

    expect(sinceLineOf(text)).toContain(": 1 change by 1 other writer in your scope.");
    expect(text).not.toMatch(/orla|vennick/i);
  });

  it("two first calls racing at the start of one return are told the line once", async () => {
    await earlierSession(120);
    await change({ minutesAgo: 30 });

    const results = await Promise.all([firstCall(), firstCall()]);

    expect(results.filter((text) => sinceLineOf(text) !== undefined)).toHaveLength(1);
  });

  it("a person returning to their coding agent meets the line on their first prompt, through the hook's route", async () => {
    await earlierSession(2 * 24 * 60);
    await change({ actorId: PERSON, actorType: "human", task: TASK, minutesAgo: 60 });

    const res = await hookGET(
      new Request("https://willder.test/api/changes/notice", {
        headers: { authorization: `Bearer ${token}`, "x-willder-session": "cli-session-2", "x-willder-task": TASK },
      }),
    );
    const { notice } = (await res.json()) as { notice: string | null };

    expect(res.status).toBe(200);
    expect(sinceLineOf(notice)).toContain(": 1 change by 1 other writer in your scope, 1 on this task.");
  });
});
