// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Raw SQL that reads or writes "now" agrees with Prisma when the database session's
// TimeZone is not UTC.
//
// Prisma stores DateTime as UTC in `timestamp(3) without time zone`. Postgres
// `now()` is a `timestamptz`, and assigning or comparing it against such a column
// converts through the session TimeZone. The suite runs twice, once per side of UTC:
//
// - America/Los_Angeles, as a self-hosted Postgres on a Pacific-time laptop would
//   run. A bare now() reads seven or eight hours behind what Prisma wrote, so an
//   expired token or grant still reads as live.
// - Asia/Tokyo. A bare now() reads nine hours ahead, so a live token reads as
//   expired: check() refuses it, and revoking its grant skips it, leaving a token
//   that comes back to life once the clocks agree.
//
// Each test below failed in at least one of the two zones before lib/sql-utc-now.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@/lib/generated/prisma/client";
// Leaf modules, not the `@/services/access` barrel: nothing may build the `@/lib/db`
// singleton before beforeAll points DATABASE_URL at the QA database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access/check";
import { seedMember } from "@/services/access/member.testsupport";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;
const SESSION_TIME_ZONES = ["America/Los_Angeles", "Asia/Tokyo"];

const ORG = "org-qa-sql-utc-now";
const ROOT = "org_qa_sql_utc_now";
const AGENT = "agent-qa-sql-utc-now";
const GOVERNED_AGENT = "agent-qa-sql-utc-now-governed";
const USER = "u-qa-sql-utc-now";
const ADMIN = "u-qa-sql-utc-now-admin";
const HOUR = 60 * 60 * 1000;

/** QA_URL with every connection's session TimeZone set to `zone`. */
function inTimeZone(url: string, zone: string): string {
  const u = new URL(url);
  u.searchParams.set("options", `-c TimeZone=${zone}`);
  return u.toString();
}

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

describe.skipIf(!QA_URL).each(SESSION_TIME_ZONES)(
  `raw SQL "now" on a session in %s, real Postgres`,
  (SESSION_TIME_ZONE) => {
    let db: PrismaClient;
    let tasks: typeof import("@/services/memory/task-start");
    let feed: typeof import("@/services/memory/change-feed");
    let check: (typeof import("@/services/access/check"))["check"];
    let anotherLiveAgentGrantCoversSql: (typeof import("@/services/access/check"))["anotherLiveAgentGrantCoversSql"];
    let flattenSql: (typeof import("@/services/access/scope-containment"))["flattenSql"];
    let revokeGrant: (typeof import("@/app/api/access/grants/[id]/route"))["DELETE"];
    let rootScopeId: string;

    const agentCtx = (token: string, id = AGENT): AccessContext => ({
      orgId: ORG,
      actor: { type: "agent", id, capabilityToken: token },
      origin: "mcp",
    });

    async function capability(
      token: string,
      expiresAt: Date,
      opts: { agentId?: string; grantGoverned?: boolean } = {},
    ) {
      return db.capability.create({
        data: {
          orgId: ORG,
          agentId: opts.agentId ?? AGENT,
          tokenHash: hashCapabilityToken(token),
          scopePath: ROOT,
          expiresAt,
          grantGoverned: opts.grantGoverned ?? false,
        },
      });
    }

    /** How far `at` is from this process's clock, in hours. */
    const hoursOff = (at: Date | null | undefined) => Math.abs((at?.getTime() ?? 0) - Date.now()) / HOUR;

    beforeAll(async () => {
      const url = inTimeZone(QA_URL!, SESSION_TIME_ZONE);
      process.env.DATABASE_URL = url;
      // A fresh module graph and a fresh shared client per zone: lib/db.ts caches its
      // client on globalThis, which would otherwise keep the previous zone's session.
      const cached = globalThis as unknown as { prisma?: PrismaClient };
      await cached.prisma?.$disconnect();
      cached.prisma = undefined;
      vi.resetModules();
      db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
      tasks = await import("@/services/memory/task-start");
      feed = await import("@/services/memory/change-feed");
      ({ check, anotherLiveAgentGrantCoversSql } = await import("@/services/access/check"));
      ({ flattenSql } = await import("@/services/access/scope-containment"));
      ({ DELETE: revokeGrant } = await import("@/app/api/access/grants/[id]/route"));
      const { requireAccessContext } = await import("@/lib/access-context");
      vi.mocked(requireAccessContext).mockResolvedValue({
        org: { id: ORG },
        user: { id: ADMIN },
        ctx: { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" } },
      } as never);
      const { db: shared } = await import("@/lib/db");
      // The precondition every test relies on: the code under test really runs off UTC.
      const [{ TimeZone }] = await shared.$queryRaw<{ TimeZone: string }[]>`SHOW TimeZone`;
      expect(TimeZone).toBe(SESSION_TIME_ZONE);
    });

    beforeEach(async () => {
      await db.taskStartDelivery.deleteMany({ where: { orgId: ORG } });
      await db.agentCursor.deleteMany({ where: { orgId: ORG } });
      await db.auditLog.deleteMany({ where: { orgId: ORG } });
      await db.capability.deleteMany({ where: { orgId: ORG } });
      await db.grant.deleteMany({ where: { orgId: ORG } });
      await db.scope.deleteMany({ where: { orgId: ORG } });
      await deleteOrgsWithRetry(db, { where: { id: ORG } });
      await db.org.create({ data: { id: ORG, name: ORG } });
      rootScopeId = (await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } })).id;
      // check() reads a person's access through their membership of the org.
      for (const userId of [USER, ADMIN, "u-qa-sql-utc-now-live"]) {
        await seedMember(db, { orgId: ORG, userId, role: userId === ADMIN ? "admin" : "member" });
      }
    });

    afterAll(async () => {
      if (!db) return;
      await deleteOrgsWithRetry(db, { where: { id: ORG } });
      await db.$disconnect();
    });

    const RUN_1 = { sessionKey: "run-1", scopePath: "", taskKey: "" };

    it("a session served the task-start block is not served it again on its next call", async () => {
      const ctx = agentCtx("unused");
      expect(await tasks.claimTaskStartDelivery(ctx, RUN_1, "rev-1")).toBe(true);

      expect(await tasks.sessionAlreadyServed(ctx, RUN_1)).toBe(true);
      expect(await tasks.claimTaskStartDelivery(ctx, RUN_1, "rev-1")).toBe(false);
      const row = await db.taskStartDelivery.findFirstOrThrow({ where: { orgId: ORG, sessionKey: "run-1" } });
      expect(hoursOff(row.lastCallAt)).toBeLessThan(0.01);
      expect(hoursOff(row.deliveredAt)).toBeLessThan(0.01);
    });

    it("a session idle past the window is served again", async () => {
      const ctx = agentCtx("unused");
      await tasks.claimTaskStartDelivery(ctx, RUN_1, "rev-1");
      await db.taskStartDelivery.updateMany({
        where: { orgId: ORG, sessionKey: "run-1" },
        data: { lastCallAt: new Date(Date.now() - tasks.SESSION_IDLE_MS - 60_000) },
      });

      expect(await tasks.sessionAlreadyServed(ctx, RUN_1)).toBe(false);
      expect(await tasks.claimTaskStartDelivery(ctx, RUN_1, "rev-2")).toBe(true);
    });

    it("a session served again after going idle is not served a third time on its next call", async () => {
      const ctx = agentCtx("unused");
      await tasks.claimTaskStartDelivery(ctx, RUN_1, "rev-1");
      await db.taskStartDelivery.updateMany({
        where: { orgId: ORG, sessionKey: "run-1" },
        data: { lastCallAt: new Date(Date.now() - tasks.SESSION_IDLE_MS - 60_000) },
      });
      expect(await tasks.claimTaskStartDelivery(ctx, RUN_1, "rev-2")).toBe(true);

      // The re-claim takes the ON CONFLICT branch, which writes lastCallAt itself.
      expect(await tasks.sessionAlreadyServed(ctx, RUN_1)).toBe(true);
      expect(await tasks.claimTaskStartDelivery(ctx, RUN_1, "rev-2")).toBe(false);
      const row = await db.taskStartDelivery.findFirstOrThrow({ where: { orgId: ORG, sessionKey: "run-1" } });
      expect(hoursOff(row.deliveredAt)).toBeLessThan(0.01);
    });

    it("an expired capability token is refused, and a live one allowed", async () => {
      await capability("expired-token", new Date(Date.now() - HOUR));
      await capability("live-token", new Date(Date.now() + HOUR));

      expect((await check(agentCtx("expired-token"), { action: "memory.read", scope: ROOT })).allowed).toBe(false);
      expect((await check(agentCtx("live-token"), { action: "memory.read", scope: ROOT })).allowed).toBe(true);
    });

    it("a live human grant gives access, and an expired one does not", async () => {
      const live = "u-qa-sql-utc-now-live";
      await db.grant.create({
        data: {
          orgId: ORG,
          scopeId: rootScopeId,
          granteeType: "user",
          granteeId: live,
          permission: "read",
          expiresAt: new Date(Date.now() + HOUR),
        },
      });
      const human: AccessContext = { orgId: ORG, actor: { type: "human", id: live, role: "member" }, origin: "app" };

      expect((await check(human, { action: "memory.read", scope: ROOT })).allowed).toBe(true);
    });

    it("revoking an agent's grant revokes its live token and leaves its expired one alone", async () => {
      await db.grant.create({
        data: { orgId: ORG, scopeId: rootScopeId, granteeType: "user", granteeId: ADMIN, permission: "admin" },
      });
      const grant = await db.grant.create({
        data: { orgId: ORG, scopeId: rootScopeId, granteeType: "agent", granteeId: AGENT, permission: "read" },
      });
      const live = await capability("cascade-live-token", new Date(Date.now() + HOUR));
      const expired = await capability("cascade-expired-token", new Date(Date.now() - HOUR));

      const res = await revokeGrant(new Request("http://t", { method: "DELETE" }), {
        params: Promise.resolve({ id: grant.id }),
      });

      expect(res.status).toBe(200);
      expect((await db.capability.findUniqueOrThrow({ where: { id: live.id } })).revokedAt).not.toBeNull();
      expect((await db.capability.findUniqueOrThrow({ where: { id: expired.id } })).revokedAt).toBeNull();
      expect((await check(agentCtx("cascade-live-token"), { action: "memory.read", scope: ROOT })).allowed).toBe(false);
    });

    it("an expired human grant gives no access", async () => {
      await db.grant.create({
        data: {
          orgId: ORG,
          scopeId: rootScopeId,
          granteeType: "user",
          granteeId: USER,
          permission: "read",
          expiresAt: new Date(Date.now() - HOUR),
        },
      });
      const human: AccessContext = { orgId: ORG, actor: { type: "human", id: USER, role: "member" }, origin: "app" };

      expect((await check(human, { action: "memory.read", scope: ROOT })).allowed).toBe(false);
    });

    it("an expired agent grant no longer covers a grant-governed token", async () => {
      await capability("governed-token", new Date(Date.now() + HOUR), { agentId: GOVERNED_AGENT, grantGoverned: true });
      await db.grant.create({
        data: {
          orgId: ORG,
          scopeId: rootScopeId,
          granteeType: "agent",
          granteeId: GOVERNED_AGENT,
          permission: "read",
          expiresAt: new Date(Date.now() - HOUR),
        },
      });

      const decision = await check(agentCtx("governed-token", GOVERNED_AGENT), { action: "memory.read", scope: ROOT });
      expect(decision.allowed).toBe(false);
      const covered = await db.$queryRaw<{ id: string }[]>(
        ...flattenSql(
          Prisma.sql`SELECT "id" FROM "capabilities" WHERE "orgId" = ${ORG} AND ${anotherLiveAgentGrantCoversSql()}`,
        ),
      );
      expect(covered).toEqual([]);
    });

    it("a denied change-feed read records the instant it started", async () => {
      expect(await feed.recordDeniedRead(agentCtx("unused"))).toBe(true);

      const cursor = await db.agentCursor.findUniqueOrThrow({
        where: { orgId_agentId: { orgId: ORG, agentId: AGENT } },
      });
      expect(hoursOff(cursor.deniedSince)).toBeLessThan(0.01);
      expect(hoursOff(cursor.updatedAt)).toBeLessThan(0.01);
    });
  },
);

// SQL functions and triggers live in migrations, which the lint gate
// (eslint.sql-utc-now.mjs) cannot read, and run with the caller's session TimeZone.
// This reads the functions the migrated schema actually holds.
describe.skipIf(!QA_URL)("SQL functions in the migrated schema, real Postgres", () => {
  it("never compare against the session-local clock", async () => {
    const { SESSION_TIME_SQL } = await import("../eslint.sql-utc-now.mjs");
    const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL! }) });
    try {
      const functions = await db.$queryRaw<{ name: string; source: string }[]>`
        SELECT p.proname AS name, p.prosrc AS source
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = current_schema() AND p.prolang <> (SELECT oid FROM pg_language WHERE lanname = 'c')
      `;
      const offenders = functions.filter((f) => SESSION_TIME_SQL.test(f.source)).map((f) => f.name);
      expect(offenders).toEqual([]);
    } finally {
      await db.$disconnect();
    }
  });
});
