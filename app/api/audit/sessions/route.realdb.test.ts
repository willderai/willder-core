// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// GET /api/audit/sessions against a real Postgres: the route runs with the shipping check()
// and real SQL over the served-vs-used log; only the Clerk session is stubbed. The log rows
// are seeded directly, since how they are written is proven in
// services/memory/task-start-served.realdb.test.ts.
//
// What this proves: the tenant boundary holds (two orgs share an agent id, a session key and
// an item id), sibling scopes stay apart (`.b` and `.bc`, a prefix-match trap), a use counts
// only for the serving it followed, a session with no name never claims a use, an erased fact
// version is not shown, each line links to the change that wrote its record, a member is
// refused, and reading the view writes an audit row. The date range keeps `from` and drops
// `to`, and narrows the list without moving where a serving's uses end.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "qa_sessions_a";
const OTHER_ORG = "qa_sessions_b";
const ROOT = `org_${ORG}`;
const SCOPE = `${ROOT}.b`;
const SIBLING = `${ROOT}.bc`;
const ADMIN = "u-admin-sessions";
const MEMBER = "u-member-sessions";
const AGENT = "sessions-agent";
const SESSION = "mcp:conn-1";
const RULE = "qa-sessions-rule";
const FACT_KEPT = "qa-sessions-fact-kept";
const FACT_ERASED = "qa-sessions-fact-erased";
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 14, 10, minutes, 0));

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

describe.skipIf(!QA_URL)("GET /api/audit/sessions, real Postgres", () => {
  let db: PrismaClient;
  let GET: (typeof import("./route"))["GET"];
  let signIn: (userId: string, role: "admin" | "member") => Promise<void>;
  const RULE_CHANGE = randomUUID();
  const FACT_CHANGE = randomUUID();

  async function wipe() {
    const orgs = { in: [ORG, OTHER_ORG] };
    await db.taskStartItemUse.deleteMany({ where: { orgId: orgs } });
    await db.taskStartServedItem.deleteMany({ where: { orgId: orgs } });
    await db.auditLog.deleteMany({ where: { orgId: orgs } });
    await db.changeEvent.deleteMany({ where: { orgId: orgs } });
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ANY (${[ORG, OTHER_ORG]}::text[])`;
    await db.grant.deleteMany({ where: { orgId: orgs } });
    await db.scope.deleteMany({ where: { orgId: orgs } });
    await db.user.deleteMany({ where: { id: { in: [ADMIN, MEMBER] } } });
    await db.org.deleteMany({ where: { id: orgs } });
  }

  /** One block served: one row per line, all sharing a serving id. */
  async function serve(
    orgId: string,
    opts: {
      scopePath: string;
      minutes: number;
      sessionKey?: string;
      task?: string;
      lines: { itemType: string; itemId: string; versionId?: string }[];
    },
  ) {
    const servingId = randomUUID();
    await db.taskStartServedItem.createMany({
      data: opts.lines.map((line, i) => ({
        orgId,
        agentId: AGENT,
        sessionKey: opts.sessionKey ?? SESSION,
        scopePath: opts.scopePath,
        taskKey: opts.task ?? "TASK-1",
        servingId,
        position: i + 1,
        lineCount: opts.lines.length,
        itemType: line.itemType,
        itemId: line.itemId,
        namedId: line.itemId,
        versionId: line.versionId ?? null,
        servedAt: at(opts.minutes),
      })),
    });
    return servingId;
  }

  async function use(orgId: string, namedId: string, minutes: number, field = "query", sessionKey = SESSION) {
    await db.taskStartItemUse.create({
      data: { orgId, agentId: AGENT, sessionKey, namedId, field, calledAt: at(minutes) },
    });
  }

  async function sessionsFor(scope: string, range = "") {
    const res = await GET(new Request(`http://t/api/audit/sessions?scope=${scope}${range}`));
    expect(res.status).toBe(200);
    return (await res.json()) as {
      total: number;
      sessions: {
        servingId: string;
        sessionKey: string;
        lineCount: number;
        lines: { namedIds: string[]; use: string | null; changeId: string | null }[];
      }[];
    };
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ GET } = await import("./route"));
    const { requireAccessContext } = (await import("@/lib/access-context")) as never as {
      requireAccessContext: ReturnType<typeof vi.fn>;
    };

    await wipe();
    await db.org.create({ data: { id: ORG, name: "Sessions QA" } });
    await db.org.create({ data: { id: OTHER_ORG, name: "Sessions QA other" } });
    const admin = await db.user.create({
      data: {
        id: ADMIN,
        orgId: ORG,
        email: "a@sessions.test",
        role: "admin",
        clerkId: "clerk-sessions-a",
        name: "Ada",
      },
    });
    const member = await db.user.create({
      data: {
        id: MEMBER,
        orgId: ORG,
        email: "m@sessions.test",
        role: "member",
        clerkId: "clerk-sessions-m",
        name: "Max",
      },
    });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    signIn = async (userId, role) => {
      requireAccessContext.mockResolvedValue({
        org: await db.org.findUnique({ where: { id: ORG } }),
        user: userId === ADMIN ? admin : member,
        ctx: { orgId: ORG, actor: { type: "human", id: userId, role } },
      });
    };

    for (const id of [FACT_KEPT, FACT_ERASED]) {
      await db.$executeRaw`INSERT INTO memory_chunks ("id", "orgId", "content", "scopePath") VALUES (${id}, ${ORG}, ${"text of " + id}, ${SCOPE})`;
    }
    await db.changeEvent.create({
      data: {
        id: RULE_CHANGE,
        orgId: ORG,
        seq: 1,
        scopePath: SCOPE,
        recordType: "convention",
        recordId: RULE,
        op: "create",
        actorId: "w",
        summary: "rule",
      },
    });
    // The other org wrote a record with the same id, later in its own sequence: never linked here.
    await db.changeEvent.create({
      data: {
        id: randomUUID(),
        orgId: OTHER_ORG,
        seq: 9,
        scopePath: `org_${OTHER_ORG}.b`,
        recordType: "convention",
        recordId: RULE,
        op: "create",
        actorId: "w",
        summary: "other",
      },
    });
    await db.changeEvent.create({
      data: {
        id: FACT_CHANGE,
        orgId: ORG,
        seq: 2,
        scopePath: SCOPE,
        recordType: "fact",
        recordId: FACT_KEPT,
        op: "create",
        actorId: "w",
        summary: "fact",
      },
    });

    // Two servings of one session and task: a use between them is the first's, after the second the second's.
    await serve(ORG, {
      scopePath: SCOPE,
      minutes: 0,
      lines: [
        { itemType: "convention", itemId: RULE },
        { itemType: "fact", itemId: FACT_KEPT, versionId: FACT_KEPT },
      ],
    });
    await serve(ORG, {
      scopePath: SCOPE,
      minutes: 30,
      lines: [
        { itemType: "convention", itemId: RULE },
        { itemType: "fact", itemId: FACT_ERASED, versionId: FACT_ERASED },
      ],
    });
    await use(ORG, RULE, -5); // before any serving: nobody's use
    await use(ORG, FACT_KEPT, 6);
    await use(ORG, RULE, 40, "result");
    // A session with no name, served the same rule; the stray use row must never be credited to it.
    await serve(ORG, {
      scopePath: SCOPE,
      minutes: 50,
      sessionKey: "",
      lines: [{ itemType: "convention", itemId: RULE }],
    });
    await use(ORG, RULE, 55, "query", "");
    // The sibling scope and the other org use the same agent, session and item ids.
    await serve(ORG, { scopePath: SIBLING, minutes: 10, lines: [{ itemType: "convention", itemId: RULE }] });
    await serve(OTHER_ORG, {
      scopePath: `org_${OTHER_ORG}.b`,
      minutes: 20,
      lines: [{ itemType: "convention", itemId: RULE }],
    });
    await use(OTHER_ORG, RULE, 21);

    // The erasure removes the version, and the served row about it goes with it.
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG} AND "id" = ${FACT_ERASED}`;
    await signIn(ADMIN, "admin");
  });

  afterAll(async () => {
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  it("lists the scope's sessions, newest first, and nothing from a sibling scope or another org", async () => {
    const body = await sessionsFor(SCOPE);
    expect(body.total).toBe(3);
    expect(body.sessions.map((s) => s.sessionKey)).toEqual(["", SESSION, SESSION]);
    const root = await sessionsFor(ROOT);
    expect(root.total).toBe(4);
    const sibling = await sessionsFor(SIBLING);
    expect(sibling.total).toBe(1);
  });

  it("credits each use to the serving it followed, and says how it was used", async () => {
    const [, later, earlier] = (await sessionsFor(SCOPE)).sessions;
    expect(earlier!.lines.map((l) => [l.namedIds[0], l.use])).toEqual([
      [RULE, null],
      [FACT_KEPT, "named"],
    ]);
    expect(later!.lines.map((l) => [l.namedIds[0], l.use])).toEqual([[RULE, "returned"]]);
  });

  it("never credits a use to a session with no name", async () => {
    const [unnamed] = (await sessionsFor(SCOPE)).sessions;
    expect(unnamed!.lines.map((l) => l.use)).toEqual([null]);
  });

  it("leaves an erased version out but keeps the line count it was served with", async () => {
    const [, later] = (await sessionsFor(SCOPE)).sessions;
    expect(later!.lineCount).toBe(2);
    expect(JSON.stringify(later)).not.toContain(FACT_ERASED);
  });

  it("links each line to the change that wrote its record, and never returns record text", async () => {
    const [, , earlier] = (await sessionsFor(SCOPE)).sessions;
    expect(earlier!.lines.map((l) => l.changeId)).toEqual([RULE_CHANGE, FACT_CHANGE]);
    expect(JSON.stringify(await sessionsFor(ROOT))).not.toContain("text of");
  });

  it("keeps the sessions served from `from`, inclusive, to `to`, exclusive", async () => {
    const fromLater = await sessionsFor(SCOPE, "&from=2026-10-14T10:30:00Z");
    expect(fromLater.total).toBe(2);
    expect(fromLater.sessions.map((s) => s.sessionKey)).toEqual(["", SESSION]);
    const beforeLater = await sessionsFor(SCOPE, "&from=2026-10-14T10:00:00Z&to=2026-10-14T10:30:00Z");
    expect(beforeLater.total).toBe(1);
    expect(beforeLater.sessions.map((s) => s.lineCount)).toEqual([2]);
    const wholeDay = await sessionsFor(SCOPE, "&from=2026-10-14&to=2026-10-15");
    expect(wholeDay.total).toBe(3);
    const dayBefore = await sessionsFor(SCOPE, "&to=2026-10-14");
    expect(dayBefore).toMatchObject({ total: 0, sessions: [] });
  });

  it("ends a serving's uses at the next serving even when the range leaves that one out", async () => {
    // The later serving is outside the range, so the rule's 10:40 answer is still its use, not the earlier serving's.
    const [earlier] = (await sessionsFor(SCOPE, "&to=2026-10-14T10:20:00Z")).sessions;
    expect(earlier!.lines.map((l) => [l.namedIds[0], l.use])).toEqual([
      [RULE, null],
      [FACT_KEPT, "named"],
    ]);
  });

  it("refuses a range it cannot read: a timestamp with no zone, an impossible day, or from not before to", async () => {
    for (const range of [
      "&from=2026-10-14T10:00:00",
      "&to=2026-02-30",
      "&from=2026-10-14&to=2026-10-14",
      "&from=2026-10-15&to=2026-10-14",
    ]) {
      const res = await GET(new Request(`http://t/api/audit/sessions?scope=${SCOPE}${range}`));
      expect(res.status, range).toBe(400);
    }
  });

  it("refuses a scope outside the org", async () => {
    const res = await GET(new Request(`http://t/api/audit/sessions?scope=org_${OTHER_ORG}.b`));
    expect(res.status).toBe(400);
  });

  it("refuses a member and records both decisions in the audit log", async () => {
    await signIn(MEMBER, "member");
    try {
      const res = await GET(new Request(`http://t/api/audit/sessions`));
      expect(res.status).toBe(403);
    } finally {
      await signIn(ADMIN, "admin");
    }
    const rows = await db.auditLog.findMany({
      where: { orgId: ORG, action: "access.manage", target: { contains: "audit:sessions" } },
    });
    expect(rows.some((r) => r.actorId === MEMBER && r.decision === "deny")).toBe(true);
    expect(rows.some((r) => r.actorId === ADMIN && r.decision === "allow")).toBe(true);
  });
});
