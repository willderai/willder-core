// The agents dashboard's routes against a real Postgres: GET /api/agents/dashboard,
// /api/agents/roster and /api/agents/activity. Every run they count, list or chart
// is one the caller may read; connected agents and agent access decisions reach
// only an access manager; allowed and denied count one set; another org's rows
// never appear. Authentication is mocked. Set QA_DATABASE_URL to an isolated test
// database (never the inherited DATABASE_URL); the suite skips without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "agentdash";
const OTHER_ORG = "agentdashother";
const ROOT = `org_${ORG}`;
const SALES = `${ROOT}.dept_sales`;
// Differs from SALES only where SALES has `_`, a LIKE wildcard: a grant on SALES must not cover it.
const SIBLING = `${ROOT}.deptXsales`;
const OTHER_ROOT = `org_${OTHER_ORG}`;

const MEMBER = "u-ad-member";
const ADMIN = "u-ad-admin";
const OUTSIDER = "u-ad-outsider";
const CREDENTIAL = "Bearer qa-target-secret";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

type Handler = (req: Request) => Promise<Response>;

describe.skipIf(!QA_URL)("the agents dashboard counts and lists only what the caller may see", () => {
  let db: PrismaClient;
  let requireAccessContext: ReturnType<typeof vi.fn>;
  let dashboard: () => Promise<Response>;
  let roster: Handler;
  let activity: Handler;
  let handoff: string;
  let qa: string;
  let custom: string;
  let paused: string;
  let seq = BigInt(0);
  let minutesAgo = 600;

  function actAs(orgId: string, userId: string, role = "member") {
    requireAccessContext.mockResolvedValue({
      org: { id: orgId },
      user: { id: userId },
      ctx: { orgId, actor: { type: "human", id: userId, role } },
    } as never);
  }

  async function json<T>(res: Response, status = 200): Promise<T> {
    expect(res.status).toBe(status);
    return (await res.json()) as T;
  }

  /** A run at `scope`, each newer than the last; `at` overrides when it started. */
  async function run(agentId: string, scope: string, status: "running" | "completed" | "failed", at?: Date) {
    minutesAgo -= 1;
    const startedAt = at ?? new Date(Date.now() - minutesAgo * 60_000);
    const created = await db.agentRun.create({
      data: {
        orgId: ORG,
        agentId,
        status,
        meta: {
          scopePath: scope,
          campaignName: `run at ${scope}`,
          target: { baseUrl: "https://x.test", authHeader: CREDENTIAL },
        },
        startedAt,
        finishedAt: status === "running" ? null : startedAt,
      },
    });
    // A running run with no events looks abandoned an hour after it starts; keep live ones live.
    if (status === "running") {
      await db.agentRunEvent.create({ data: { runId: created.id, seq: 1, type: "plan", payload: {} } });
    }
    return created.id;
  }

  async function audit(
    orgId: string,
    actorId: string,
    decision: "allow" | "deny",
    at = new Date(),
    action = "memory.read",
  ) {
    await db.auditLog.create({
      data: { orgId, actorType: "agent", actorId, action, target: `org_${orgId}`, decision, at },
    });
  }

  async function fact(orgId: string, scopePath: string, actorType: string) {
    seq += BigInt(1);
    await db.changeEvent.create({
      data: {
        orgId,
        seq,
        scopePath,
        recordType: "fact",
        recordId: `f${seq}`,
        op: "create",
        actorId: "handoff-agent",
        actorType,
        summary: "s",
      },
    });
  }

  async function token(
    orgId: string,
    agentId: string,
    scopePath: string,
    state: "live" | "revoked" | "expired" = "live",
  ) {
    await db.capability.create({
      data: {
        orgId,
        agentId,
        tokenHash: `hash-${orgId}-${agentId}-${scopePath}-${state}-${Math.random()}`,
        scopePath,
        permission: "read",
        expiresAt: new Date(Date.now() + (state === "expired" ? -1 : 1) * 86_400_000),
        revokedAt: state === "revoked" ? new Date() : null,
      },
    });
  }

  async function clear() {
    for (const org of [ORG, OTHER_ORG]) {
      await db.agentRunEvent.deleteMany({ where: { run: { orgId: org } } });
      await db.agentRun.deleteMany({ where: { orgId: org } });
      for (const t of ["changeEvent", "capability", "agent", "grant", "scope", "user"] as const) {
        await (db[t] as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where: { orgId: org } });
      }
      // The audit log is append-only by trigger; the org's cascade is the one way to drop it.
      await deleteOrgsWithRetry(db, { where: { id: org } });
    }
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    requireAccessContext = vi.mocked((await import("@/lib/access-context")).requireAccessContext);
    dashboard = (await import("@/app/api/agents/dashboard/route")).GET;
    roster = (await import("@/app/api/agents/roster/route")).GET;
    activity = (await import("@/app/api/agents/activity/route")).GET;
  });

  beforeEach(async () => {
    await clear();
    seq = BigInt(0);
    minutesAgo = 600;
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.org.create({ data: { id: OTHER_ORG, name: OTHER_ORG } });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    const sales = await db.scope.create({ data: { orgId: ORG, path: SALES, name: "sales" } });
    await db.scope.create({ data: { orgId: ORG, path: SIBLING, name: "sibling" } });
    await db.user.create({ data: { id: MEMBER, orgId: ORG, email: "m@ad.test", role: "member", clerkId: "c-ad-m" } });
    await db.user.create({ data: { id: ADMIN, orgId: ORG, email: "a@ad.test", role: "admin", clerkId: "c-ad-a" } });
    await db.user.create({
      data: { id: OUTSIDER, orgId: OTHER_ORG, email: "o@ad.test", role: "member", clerkId: "c-ad-o" },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: sales.id, granteeType: "user", granteeId: MEMBER, permission: "read" },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });

    const agent = async (agentKey: string, role: "handoff" | "qa" | "custom" | "architecture", active = true) =>
      (await db.agent.create({ data: { orgId: ORG, agentKey, name: agentKey, role, active } })).id;
    handoff = await agent("handoff-agent", "handoff");
    qa = await agent("qa-agent", "qa");
    custom = await agent("custom-notes", "custom");
    paused = await agent("architecture-agent", "architecture", false);
    // Another org's agent with the same key: its runs and calls must never count here.
    const foreign = (
      await db.agent.create({
        data: { orgId: OTHER_ORG, agentKey: "handoff-agent", name: "handoff-agent", role: "handoff" },
      })
    ).id;
    await db.agentRun.create({
      data: { orgId: OTHER_ORG, agentId: foreign, status: "failed", meta: { scopePath: OTHER_ROOT } },
    });
    await audit(OTHER_ORG, "mcp-client", "deny");
    await token(OTHER_ORG, "mcp-client", OTHER_ROOT);
  });

  afterAll(async () => {
    await clear();
    await db.$disconnect();
  });

  it("counts a member's runs and facts only in scopes they read, and gives them no audit numbers", async () => {
    await run(handoff, SALES, "completed");
    await run(handoff, SALES, "failed");
    await run(qa, SIBLING, "failed");
    await run(qa, ROOT, "completed");
    await run(handoff, SALES, "completed", new Date(Date.now() - 3 * 86_400_000));
    await fact(ORG, SALES, "agent");
    await fact(ORG, SIBLING, "agent");
    await fact(ORG, SALES, "human");
    await audit(ORG, "handoff-agent", "deny");

    actAs(ORG, MEMBER);
    const body = await json<Record<string, unknown>>(await dashboard());
    expect(body.runs).toEqual({
      day: { total: 2, completed: 1, failed: 1, running: 0, waiting: 0, stalled: 0 },
      week: { total: 3, completed: 2, failed: 1, running: 0, waiting: 0, stalled: 0 },
    });
    expect(body.factsWritten).toBe(1);
    expect(body.decisions).toBeNull();
    expect(body.agents).toEqual({ own: { total: 4, active: 3 }, connected: null });
  });

  it("gives an access manager allowed and denied over one set, and every connected agent", async () => {
    await run(qa, SIBLING, "failed");
    await fact(ORG, SIBLING, "agent");
    await audit(ORG, "handoff-agent", "allow");
    await audit(ORG, "handoff-agent", "deny");
    await audit(ORG, "mcp-client", "allow");
    await audit(ORG, "mcp-client", "deny", new Date(Date.now() - 8 * 86_400_000));
    // Plumbing rows the audit page never shows are never counted either.
    await audit(ORG, "mcp-client", "allow", new Date(), "memory.write.applied");
    await token(ORG, "mcp-client", SALES);
    await token(ORG, "old-mcp", SALES, "revoked");
    await token(ORG, "expired-mcp", SALES, "expired");
    // A token minted for an Agent row, by key and by id, is that agent's, not a connected one.
    await token(ORG, "handoff-agent", SALES);
    await token(ORG, qa, SALES);

    actAs(ORG, ADMIN, "admin");
    const body = await json<Record<string, unknown>>(await dashboard());
    expect(body.decisions).toEqual({ allowed: 2, denied: 1 });
    expect(body.factsWritten).toBe(1);
    expect((body.runs as { week: { failed: number } }).week.failed).toBe(1);
    expect(body.agents).toEqual({ own: { total: 4, active: 3 }, connected: { total: 3, live: 1 } });
  });

  it("lists connected agents to an access manager only, and a connected filter is empty for a member", async () => {
    await token(ORG, "mcp-client", SALES);
    await token(ORG, "old-mcp", SALES, "revoked");
    await token(ORG, "handoff-agent", SALES);
    await audit(ORG, "mcp-client", "allow", new Date(Date.now() - 2 * 86_400_000));
    await audit(ORG, "mcp-client", "deny");

    actAs(ORG, MEMBER);
    const member = await json<{ rows: { kind: string }[]; total: number }>(
      await roster(new Request("http://t/api/agents/roster")),
    );
    expect(member.total).toBe(4);
    expect(member.rows.every((row) => row.kind !== "connected")).toBe(true);
    expect(await json(await roster(new Request("http://t/api/agents/roster?kind=connected")))).toMatchObject({
      rows: [],
      total: 0,
    });

    actAs(ORG, ADMIN, "admin");
    const admin = await json<{ rows: Record<string, unknown>[]; total: number }>(
      await roster(new Request("http://t/api/agents/roster?kind=connected")),
    );
    expect(admin.total).toBe(2);
    const claude = admin.rows.find((row) => row.key === "mcp-client");
    expect(claude).toMatchObject({
      status: "failing",
      activity: 2,
      scopes: [SALES],
      permission: "read",
      liveTokens: 1,
    });
    expect(claude?.series).toEqual([
      { total: 0, failed: 0 },
      { total: 0, failed: 0 },
      { total: 0, failed: 0 },
      { total: 0, failed: 0 },
      { total: 1, failed: 0 },
      { total: 0, failed: 0 },
      { total: 1, failed: 1 },
    ]);
    expect(admin.rows.find((row) => row.key === "old-mcp")).toMatchObject({
      status: "revoked",
      scopes: [],
      permission: null,
    });
  });

  it("gives each connected agent its last allowed and last denied call, and filters and sorts by them", async () => {
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
    // Denied after its last success: failing, and its success stays visible.
    await token(ORG, "mcp-client", SALES);
    await audit(ORG, "mcp-client", "allow", daysAgo(2));
    await audit(ORG, "mcp-client", "allow", daysAgo(3));
    await audit(ORG, "mcp-client", "deny", daysAgo(1));
    // A live token not used for 40 days, its one refusal too old for "denied this week".
    await token(ORG, "stale-mcp", SALES);
    await audit(ORG, "stale-mcp", "allow", daysAgo(40));
    await audit(ORG, "stale-mcp", "deny", daysAgo(9));
    // A live token never used, and a revoked one: only the live one is unused.
    await token(ORG, "fresh-mcp", SALES);
    await token(ORG, "old-mcp", SALES, "revoked");
    // A newer refusal the audit page never shows is not a denial here either.
    await audit(ORG, "fresh-mcp", "deny", new Date(), "memory.write.applied");
    // Another org's call by the same agent id never counts.
    await audit(OTHER_ORG, "stale-mcp", "allow");

    actAs(ORG, ADMIN, "admin");
    type Row = {
      key: string;
      status: string;
      lastAllowedAt: string | null;
      lastDeniedAt: string | null;
      lastActiveAt: string | null;
    };
    const rows = async (query: string) =>
      (await json<{ rows: Row[] }>(await roster(new Request(`http://t/api/agents/roster?${query}`)))).rows;
    const byKey = Object.fromEntries((await rows("kind=connected")).map((row) => [row.key, row]));
    const day = (iso: string | null) => (iso ? Math.round((Date.now() - Date.parse(iso)) / 86_400_000) : null);
    expect(byKey["mcp-client"]).toMatchObject({ status: "failing" });
    expect([
      day(byKey["mcp-client"].lastAllowedAt),
      day(byKey["mcp-client"].lastDeniedAt),
      day(byKey["mcp-client"].lastActiveAt),
    ]).toEqual([2, 1, 1]);
    expect([day(byKey["stale-mcp"].lastAllowedAt), day(byKey["stale-mcp"].lastDeniedAt)]).toEqual([40, 9]);
    expect(byKey["stale-mcp"].status).toBe("failing");
    expect(byKey["fresh-mcp"]).toMatchObject({
      status: "idle",
      lastAllowedAt: null,
      lastDeniedAt: null,
      lastActiveAt: null,
    });

    expect((await rows("use=denied")).map((row) => row.key)).toEqual(["mcp-client"]);
    expect((await rows("use=unused")).map((row) => row.key)).toEqual(["fresh-mcp", "stale-mcp"]);
    expect((await rows("kind=connected&sort=lastAllowed")).map((row) => row.key)).toEqual([
      "mcp-client",
      "stale-mcp",
      "fresh-mcp",
      "old-mcp",
    ]);
    expect((await rows("kind=connected&sort=lastDenied&order=asc")).map((row) => row.key)).toEqual([
      "stale-mcp",
      "mcp-client",
      "fresh-mcp",
      "old-mcp",
    ]);

    // A member sees no connected agent, so neither filter can say anything about one.
    actAs(ORG, MEMBER);
    expect(await rows("use=unused")).toEqual([]);
    expect(await rows("use=denied")).toEqual([]);
  });

  it("reads token calls only from the agent itself, and counts a refusal at the same instant as a success as the newer", async () => {
    const at = new Date(Date.now() - 86_400_000);
    // A person whose user id equals an agent's key: their calls are not that agent's.
    await token(ORG, "shared-id", SALES);
    await audit(ORG, "shared-id", "allow", new Date(Date.now() - 5 * 86_400_000));
    await db.auditLog.create({
      data: {
        orgId: ORG,
        actorType: "human",
        actorId: "shared-id",
        action: "memory.read",
        target: `org_${ORG}`,
        decision: "allow",
        at: new Date(),
      },
    });
    await db.auditLog.create({
      data: {
        orgId: ORG,
        actorType: "human",
        actorId: "shared-id",
        action: "memory.read",
        target: `org_${ORG}`,
        decision: "deny",
        at: new Date(),
      },
    });
    // Allowed and denied at the same instant: the refusal wins, so the agent reads as failing.
    await token(ORG, "tied-mcp", SALES);
    await audit(ORG, "tied-mcp", "allow", at);
    await audit(ORG, "tied-mcp", "deny", at);

    actAs(ORG, ADMIN, "admin");
    type Row = { key: string; status: string; lastAllowedAt: string | null; lastDeniedAt: string | null };
    const { rows } = await json<{ rows: Row[] }>(
      await roster(new Request("http://t/api/agents/roster?kind=connected")),
    );
    const shared = rows.find((row) => row.key === "shared-id")!;
    expect(Math.round((Date.now() - Date.parse(shared.lastAllowedAt!)) / 86_400_000)).toBe(5);
    expect(shared).toMatchObject({ lastDeniedAt: null, status: "idle" });
    expect(rows.find((row) => row.key === "tied-mcp")).toMatchObject({ status: "failing" });
  });

  it("derives each agent's status from the runs the caller can read", async () => {
    await run(handoff, SALES, "failed");
    await run(qa, SALES, "completed");
    await run(qa, SALES, "running");
    await run(custom, SIBLING, "failed");

    actAs(ORG, MEMBER);
    const { rows } = await json<{
      rows: { key: string; status: string; activity: number; lastRunStatus: string | null }[];
    }>(await roster(new Request("http://t/api/agents/roster")));
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));
    expect(byKey["handoff-agent"]).toMatchObject({ status: "failing", activity: 1 });
    expect(byKey["qa-agent"]).toMatchObject({ status: "running", activity: 2 });
    // The custom agent's only run is in a scope the member cannot read: idle, zero, no last run.
    expect(byKey["custom-notes"]).toMatchObject({ status: "idle", activity: 0, lastRunStatus: null });
    expect(byKey["architecture-agent"]).toMatchObject({ status: "paused" });
    expect(paused).toBeTruthy();
  });

  it("searches, filters, sorts and pages in the query, and counts the full match", async () => {
    for (let i = 0; i < 14; i += 1) {
      await db.agent.create({
        data: {
          orgId: ORG,
          agentKey: `custom-bulk-${String(i).padStart(2, "0")}`,
          name: `Bulk ${String(i).padStart(2, "0")}`,
          role: "custom",
        },
      });
    }
    await run(qa, SALES, "completed");
    actAs(ORG, MEMBER);
    const first = await json<{ rows: { name: string }[]; total: number; pageSize: number }>(
      await roster(new Request("http://t/api/agents/roster?q=bulk")),
    );
    expect(first.total).toBe(14);
    expect(first.rows).toHaveLength(first.pageSize);
    expect(first.rows[0].name).toBe("Bulk 00");
    const second = await json<{ rows: { name: string }[]; total: number }>(
      await roster(new Request("http://t/api/agents/roster?q=bulk&page=2")),
    );
    expect(second.rows.map((row) => row.name)).toEqual(["Bulk 12", "Bulk 13"]);
    expect(await json(await roster(new Request("http://t/api/agents/roster?q=bulk&page=9")))).toMatchObject({
      rows: [],
      total: 14,
    });

    const custom = await json<{ total: number }>(await roster(new Request("http://t/api/agents/roster?kind=custom")));
    expect(custom.total).toBe(15);
    const recent = await json<{ rows: { key: string }[] }>(
      await roster(new Request("http://t/api/agents/roster?sort=lastActive")),
    );
    expect(recent.rows[0].key).toBe("qa-agent");
    // `_` and `%` are literal: no agent name contains either.
    expect(await json(await roster(new Request("http://t/api/agents/roster?q=Bulk_0")))).toMatchObject({ total: 0 });
    expect(await json(await roster(new Request("http://t/api/agents/roster?q=%25")))).toMatchObject({ total: 0 });
  });

  it("refuses bad parameters with 400, not a server error", async () => {
    actAs(ORG, MEMBER);
    for (const query of [
      "kind=robot",
      "status=asleep",
      "use=sometimes",
      "sort=size",
      "order=up",
      "page=0",
      "page=x",
      "q=%00",
    ]) {
      expect((await roster(new Request(`http://t/api/agents/roster?${query}`))).status).toBe(400);
    }
    for (const query of ["status=asleep", "before=nonsense", "before=2026-01-01T00:00:00.000Z_bad%20id"]) {
      expect((await activity(new Request(`http://t/api/agents/activity?${query}`))).status).toBe(400);
    }
  });

  it("feeds readable runs across agents newest first, paging by cursor without repeats", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(await run(i % 2 ? handoff : qa, SALES, i === 2 ? "failed" : "completed"));
    await run(custom, SIBLING, "completed");

    actAs(ORG, MEMBER);
    const seen: string[] = [];
    let url = "http://t/api/agents/activity?limit=2";
    for (;;) {
      const page = await json<{ runs: { id: string; meta: unknown }[]; next: string | null }>(
        await activity(new Request(url)),
      );
      seen.push(...page.runs.map((r) => r.id));
      expect(JSON.stringify(page)).not.toContain(CREDENTIAL);
      if (!page.next) break;
      url = `http://t/api/agents/activity?limit=2&before=${encodeURIComponent(page.next)}`;
    }
    expect(seen).toEqual([...ids].reverse());
    await db.agentRunEvent.create({
      data: { runId: ids[2], seq: 1, type: "error", payload: { type: "error", message: "Memory read was denied" } },
    });
    const failed = await json<{ runs: { id: string; error: string | null }[] }>(
      await activity(new Request("http://t/api/agents/activity?status=failed")),
    );
    expect(failed.runs).toEqual([expect.objectContaining({ id: ids[2], error: "Memory read was denied" })]);

    actAs(OTHER_ORG, OUTSIDER);
    expect(await json(await activity(new Request("http://t/api/agents/activity")))).toEqual({ runs: [], next: null });
  });

  it("pages runs that started in the same instant without repeating or skipping one", async () => {
    const at = new Date(Date.now() - 60_000);
    const tied = [
      await run(qa, SALES, "completed", at),
      await run(handoff, SALES, "failed", at),
      await run(qa, SALES, "completed", at),
    ];
    actAs(ORG, MEMBER);
    const seen: string[] = [];
    let url = "http://t/api/agents/activity?limit=1";
    for (;;) {
      const page = await json<{ runs: { id: string }[]; next: string | null }>(await activity(new Request(url)));
      seen.push(...page.runs.map((r) => r.id));
      if (!page.next) break;
      url = `http://t/api/agents/activity?limit=1&before=${encodeURIComponent(page.next)}`;
    }
    expect([...seen].sort()).toEqual([...tied].sort());
  });

  // Run this file with `?options=-c%20timezone%3DAsia/Tokyo` on QA_DATABASE_URL too: the
  // windows are compared in UTC, so the session's time zone must not move a run in or out.
  it("puts a run in the 24-hour and 7-day windows by its age alone", async () => {
    await run(handoff, SALES, "completed", new Date(Date.now() - 23 * 3_600_000));
    await run(handoff, SALES, "completed", new Date(Date.now() - 25 * 3_600_000));
    await run(handoff, SALES, "completed", new Date(Date.now() - 6.9 * 86_400_000));
    await run(handoff, SALES, "completed", new Date(Date.now() - 7.1 * 86_400_000));
    actAs(ORG, MEMBER);
    const body = await json<{ runs: { day: { total: number }; week: { total: number } } }>(await dashboard());
    expect([body.runs.day.total, body.runs.week.total]).toEqual([1, 3]);
  });

  it("counts an agent's roster activity over the same seven days as its sparkline", async () => {
    await run(handoff, SALES, "completed", new Date(Date.now() - 6.9 * 86_400_000));
    await run(handoff, SALES, "completed", new Date(Date.now() - 8 * 86_400_000));
    actAs(ORG, MEMBER);
    const { rows } = await json<{ rows: { key: string; activity: number; series: { total: number }[] }[] }>(
      await roster(new Request("http://t/api/agents/roster")),
    );
    const handoffRow = rows.find((row) => row.key === "handoff-agent");
    expect(handoffRow?.activity).toBe(1);
    expect(handoffRow?.series.reduce((sum, day) => sum + day.total, 0)).toBe(1);
  });

  it("keeps every count exact at 1,200 runs", async () => {
    const now = Date.now();
    await db.agentRun.createMany({
      data: Array.from({ length: 1200 }, (_, i) => ({
        orgId: ORG,
        agentId: i % 3 === 0 ? qa : handoff,
        status: i % 10 === 0 ? ("failed" as const) : ("completed" as const),
        meta: { scopePath: i % 4 === 0 ? SIBLING : SALES },
        startedAt: new Date(now - (i % 144) * 60 * 60_000 - 60_000),
      })),
    });
    actAs(ORG, MEMBER);
    const body = await json<{ runs: { week: { total: number; failed: number } } }>(await dashboard());
    // Visible: the 900 runs in SALES (i % 4 !== 0), of which failed are i % 10 === 0 and i % 4 !== 0.
    const visible = Array.from({ length: 1200 }, (_, i) => i).filter((i) => i % 4 !== 0);
    expect(body.runs.week.total).toBe(visible.length);
    expect(body.runs.week.failed).toBe(visible.filter((i) => i % 10 === 0).length);
    const { rows } = await json<{ rows: { key: string; activity: number; series: { total: number }[] }[] }>(
      await roster(new Request("http://t/api/agents/roster?sort=runs")),
    );
    const qaRow = rows.find((row) => row.key === "qa-agent");
    expect(qaRow?.activity).toBe(visible.filter((i) => i % 3 === 0).length);
    expect(qaRow?.series.reduce((sum, day) => sum + day.total, 0)).toBe(qaRow?.activity);
  });

  it("keeps token-use filters, time sorts and totals exact at 1,050 connected agents in two orgs", async () => {
    const N = 1050;
    const now = Date.now();
    const key = (i: number) => `bulk-${String(i).padStart(4, "0")}`;
    const minutes = (n: number) => new Date(now - n * 60_000);
    const days = (n: number) => new Date(now - n * 86_400_000);
    const live = { scopePath: SALES, permission: "read" as const, expiresAt: days(-1) };
    await db.capability.createMany({
      data: Array.from({ length: N }, (_, i) => ({
        orgId: ORG,
        agentId: key(i),
        tokenHash: `bulk-${ORG}-${i}`,
        ...live,
      })),
    });
    // The other org holds one token under an agent id that also exists here.
    await db.capability.create({
      data: { orgId: OTHER_ORG, agentId: key(1), tokenHash: "bulk-other-1", ...live, scopePath: OTHER_ROOT },
    });
    const calls: {
      orgId: string;
      actorType: string;
      actorId: string;
      action: string;
      target: string;
      decision: "allow" | "deny";
      at: Date;
    }[] = [];
    const call = (orgId: string, i: number, decision: "allow" | "deny", at: Date) =>
      calls.push({
        orgId,
        actorType: "agent",
        actorId: key(i),
        action: "memory.read",
        target: `org_${orgId}`,
        decision,
        at,
      });
    for (let i = 0; i < N; i++) {
      // i % 3: 0 never allowed, 1 allowed 40 days ago, 2 allowed i minutes ago.
      if (i % 3 === 1) call(ORG, i, "allow", days(40));
      if (i % 3 === 2) call(ORG, i, "allow", minutes(i + 1));
      // Every agent has an old refusal; even ones also have one i+1 minutes ago, the newest.
      call(ORG, i, "deny", days(20));
      if (i % 2 === 0) call(ORG, i, "deny", minutes(i + 1));
      // The other org refuses every id this week; none of it may count here.
      call(OTHER_ORG, i, "deny", minutes(1));
    }
    await db.auditLog.createMany({ data: calls });

    type Page = { rows: { key: string; lastDeniedAt: string | null }[]; total: number; pageSize: number };
    const page = async (query: string) => json<Page>(await roster(new Request(`http://t/api/agents/roster?${query}`)));
    const all = async (query: string) => {
      const first = await page(query);
      const keys = first.rows.map((row) => row.key);
      for (let p = 2; p <= Math.ceil(first.total / first.pageSize); p++)
        keys.push(...(await page(`${query}&page=${p}`)).rows.map((row) => row.key));
      return { total: first.total, keys };
    };
    const ids = (pick: (i: number) => boolean) =>
      Array.from({ length: N }, (_, i) => i)
        .filter(pick)
        .map(key);

    actAs(ORG, ADMIN, "admin");
    // Denied this week: the even ids, newest refusal first, every one exactly once across the pages.
    const denied = await all("use=denied&sort=lastDenied");
    expect(denied.total).toBe(N / 2);
    expect(denied.keys).toEqual(ids((i) => i % 2 === 0));
    // Unused: never allowed or last allowed 40 days ago.
    const unused = await page("use=unused");
    expect(unused.total).toBe(ids((i) => i % 3 !== 2).length);
    // Newest allowed first; the never-allowed ones go last whatever the order.
    const allowed = await page("kind=connected&sort=lastAllowed");
    expect(allowed.total).toBe(N);
    expect(allowed.rows.map((row) => row.key)).toEqual(ids((i) => i % 3 === 2).slice(0, allowed.pageSize));
    const oldestAllowedLast = await page(
      `kind=connected&sort=lastAllowed&order=asc&page=${Math.ceil(N / allowed.pageSize)}`,
    );
    expect(oldestAllowedLast.rows.every((row) => ids((i) => i % 3 === 0).includes(row.key))).toBe(true);

    // A member sees no connected agent, so the filters count nothing.
    actAs(ORG, MEMBER);
    expect((await page("use=denied")).total).toBe(0);
    // The other org's admin sees its one token and its own refusal, nothing of this org's.
    // (beforeEach gives it a refused "mcp-client" call too.)
    const otherRoot = await db.scope.create({ data: { orgId: OTHER_ORG, path: OTHER_ROOT, name: "root" } });
    await db.user.create({
      data: { id: "u-ad-other-admin", orgId: OTHER_ORG, email: "oa@ad.test", role: "admin", clerkId: "c-ad-oa" },
    });
    await db.grant.create({
      data: {
        orgId: OTHER_ORG,
        scopeId: otherRoot.id,
        granteeType: "user",
        granteeId: "u-ad-other-admin",
        permission: "admin",
      },
    });
    actAs(OTHER_ORG, "u-ad-other-admin", "admin");
    const other = await page("use=denied&sort=lastDenied");
    expect([other.total, other.rows.map((row) => row.key)]).toEqual([2, ["mcp-client", key(1)]]);
  }, 60_000);
});
