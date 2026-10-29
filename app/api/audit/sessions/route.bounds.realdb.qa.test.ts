// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// GET /api/audit/sessions: three rules route.realdb.test.ts leaves
// unpinned, each of which a one-line change to services/memory/task-start-sessions.ts
// could drop without any other test going red.
//
// - A serving's uses are bounded by the next serving of the same session and task in the
//   same scope. Viewed from the org
//   root, a serving of the same session and task in a sibling scope does not cut it short.
// - A use counts only for the agent that was served: another agent sharing the session key
//   is not credited.
// - A line links to the newest change that wrote its record, not the first.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "qa_sessions_bounds";
const ROOT = `org_${ORG}`;
const SCOPE = `${ROOT}.b`;
const SIBLING = `${ROOT}.c`;
const ADMIN = "u-admin-sessions-bounds";
const AGENT = "bounds-agent";
const OTHER_AGENT = "bounds-other-agent";
const SESSION = "mcp:bounds-conn";
const RULE = "qa-bounds-rule";
const SECOND_RULE = "qa-bounds-second-rule";
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 14, 12, minutes, 0));

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

describe.skipIf(!QA_URL)("GET /api/audit/sessions use bounds, real Postgres", () => {
  let db: PrismaClient;
  let GET: (typeof import("./route"))["GET"];
  const FIRST_CHANGE = randomUUID();
  const NEWEST_CHANGE = randomUUID();

  async function wipe() {
    await db.taskStartItemUse.deleteMany({ where: { orgId: ORG } });
    await db.taskStartServedItem.deleteMany({ where: { orgId: ORG } });
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.grant.deleteMany({ where: { orgId: ORG } });
    await db.scope.deleteMany({ where: { orgId: ORG } });
    await db.user.deleteMany({ where: { id: ADMIN } });
    await db.org.deleteMany({ where: { id: ORG } });
  }

  async function serve(scopePath: string, minutes: number, itemIds: string[]) {
    const servingId = randomUUID();
    await db.taskStartServedItem.createMany({
      data: itemIds.map((itemId, i) => ({
        orgId: ORG,
        agentId: AGENT,
        sessionKey: SESSION,
        scopePath,
        taskKey: "TASK-B",
        servingId,
        position: i + 1,
        lineCount: itemIds.length,
        itemType: "convention",
        itemId,
        namedId: itemId,
        servedAt: at(minutes),
      })),
    });
    return servingId;
  }

  async function use(namedId: string, minutes: number, agentId = AGENT) {
    await db.taskStartItemUse.create({
      data: { orgId: ORG, agentId, sessionKey: SESSION, namedId, field: "query", calledAt: at(minutes) },
    });
  }

  async function servingFrom(scope: string, servingId: string) {
    const res = await GET(new Request(`http://t/api/audit/sessions?scope=${scope}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessions: { servingId: string; lines: { namedIds: string[]; use: string | null; changeId: string | null }[] }[];
    };
    const serving = body.sessions.find((s) => s.servingId === servingId);
    expect(serving).toBeDefined();
    return serving!;
  }

  let early: string;
  let sibling: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ GET } = await import("./route"));
    const { requireAccessContext } = (await import("@/lib/access-context")) as never as {
      requireAccessContext: ReturnType<typeof vi.fn>;
    };

    await wipe();
    const org = await db.org.create({ data: { id: ORG, name: "Sessions bounds QA" } });
    const admin = await db.user.create({
      data: {
        id: ADMIN,
        orgId: ORG,
        email: "a@bounds.test",
        role: "admin",
        clerkId: "clerk-sessions-bounds",
        name: "Ada",
      },
    });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    requireAccessContext.mockResolvedValue({
      org,
      user: admin,
      ctx: { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" } },
    });

    // The rule was written twice; the line must open the later write.
    await db.changeEvent.create({
      data: {
        id: FIRST_CHANGE,
        orgId: ORG,
        seq: 1,
        scopePath: SCOPE,
        recordType: "convention",
        recordId: RULE,
        op: "create",
        actorId: "w",
        summary: "first",
      },
    });
    await db.changeEvent.create({
      data: {
        id: NEWEST_CHANGE,
        orgId: ORG,
        seq: 2,
        scopePath: SCOPE,
        recordType: "convention",
        recordId: RULE,
        op: "update",
        actorId: "w",
        summary: "newest",
      },
    });

    // One session and task, served in .b at :00 and in the sibling .c at :10, and again in .b at :30.
    early = await serve(SCOPE, 0, [RULE, SECOND_RULE]);
    sibling = await serve(SIBLING, 10, [RULE]);
    await serve(SCOPE, 30, [RULE]);
    // At :15, after the sibling serving but before .b's next one: the early serving's use.
    await use(SECOND_RULE, 15);
    // At :05, a different agent on the same session key names the rule: nobody's use here.
    await use(RULE, 5, OTHER_AGENT);
  });

  afterAll(async () => {
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  it("bounds a serving by its own scope's next serving, not a sibling scope's, viewed from the root", async () => {
    const fromRoot = await servingFrom(ROOT, early);
    const fromScope = await servingFrom(SCOPE, early);
    expect(fromRoot.lines.map((l) => [l.namedIds[0], l.use])).toEqual([
      [RULE, null],
      [SECOND_RULE, "named"],
    ]);
    expect(fromRoot.lines).toEqual(fromScope.lines);
  });

  it("does not credit the sibling scope's serving with a use of an item it never served", async () => {
    const fromRoot = await servingFrom(ROOT, sibling);
    expect(fromRoot.lines.map((l) => [l.namedIds[0], l.use])).toEqual([[RULE, null]]);
  });

  it("does not credit a use by another agent that shares the session key", async () => {
    const line = (await servingFrom(SCOPE, early)).lines.find((l) => l.namedIds[0] === RULE);
    expect(line?.use).toBeNull();
  });

  it("links a line to the newest change that wrote its record", async () => {
    const line = (await servingFrom(SCOPE, early)).lines.find((l) => l.namedIds[0] === RULE);
    expect(line?.changeId).toBe(NEWEST_CHANGE);
  });
});
