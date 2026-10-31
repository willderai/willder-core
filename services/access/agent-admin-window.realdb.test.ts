// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// An agent token with `admin` lives at most two hours from minting, by the
// database's clock, and only a person can issue one.
//
// Seams under test, all real:
//   - the `capabilities` insert and update, where the trigger from migration
//     20261014210000_capability_admin_window holds the window for every writer;
//   - issueCapability(), the one mint path a person or an OAuth connect reaches;
//   - check(), which decides every agent call by the database clock;
//   - POST /api/access/grants and POST /api/access/capabilities, which must not
//     accept a bearer token in place of a signed-in person.
//
// Every expected time is computed here from the database's own `now()`, never
// from the code under test, and the clock edges sit exactly on the window's end
// and one second either side of it.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never a live one.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "./check";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn(async () => null) }));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qa_admin_window";
const OTHER_ORG = "qa_admin_window_other";
const ROOT = `org_${ORG}`;
const OTHER_ROOT = `org_${OTHER_ORG}`;
/** `eng_x` is a sibling of `eng` that a prefix match would wrongly cover. */
const SCOPES = [
  { orgId: ORG, path: ROOT },
  { orgId: ORG, path: `${ROOT}.eng` },
  { orgId: ORG, path: `${ROOT}.eng.api` },
  { orgId: ORG, path: `${ROOT}.eng_x` },
  { orgId: ORG, path: `${ROOT}.sales` },
  { orgId: OTHER_ORG, path: OTHER_ROOT },
];
const ADMIN = "u-qa-aw-admin";
const OTHER_ADMIN = "u-qa-aw-other-admin";

const SECOND = 1000;
const HOUR = 60 * 60 * SECOND;
const WINDOW = 2 * HOUR;
/**
 * issueCapability() sets `expiresAt` from the application clock just before the
 * insert, and the database stamps an admin row's `createdAt` at the insert, so an
 * issued token's lifetime is the asked one less that gap, never more. Rows this file
 * inserts directly are held to the exact edge instead.
 */
const ISSUE_LATENCY = 5 * SECOND;

const lifetime = (row: { createdAt: Date; expiresAt: Date }) => row.expiresAt.getTime() - row.createdAt.getTime();

describe.skipIf(!QA_URL)("an agent's admin window is two hours from minting, real Postgres", () => {
  let db: PrismaClient;
  let check: (typeof import("./check"))["check"];
  let issueCapability: (typeof import("./issue-capability"))["issueCapability"];
  let hashCapabilityToken: (typeof import("./capabilities"))["hashCapabilityToken"];
  let grantsPOST: (typeof import("@/app/api/access/grants/route"))["POST"];
  let capabilitiesPOST: (typeof import("@/app/api/access/capabilities/route"))["POST"];
  let seq = 0;

  const person = (id: string, orgId: string): AccessContext => ({
    orgId,
    actor: { type: "human", id, role: "admin" },
    origin: "app",
  });
  const agent = (agentId: string, token: string, orgId = ORG): AccessContext => ({
    orgId,
    actor: { type: "agent", id: agentId, capabilityToken: token },
    origin: "mcp",
  });

  /** The database's clock, in the form the timestamp(3) columns hold: UTC wall-clock
   * time, rounded to the millisecond the way storing it in a column rounds it. */
  async function dbNow(client: Pick<PrismaClient, "$queryRaw"> = db): Promise<Date> {
    const [{ now }] = await client.$queryRaw<{ now: Date }[]>`SELECT (now() AT TIME ZONE 'UTC')::timestamp(3) AS now`;
    return now;
  }

  /** Insert a capability row directly, the way every mint path ends. */
  async function insert(
    data: {
      permission: "read" | "write" | "admin";
      expiresAt: Date;
      createdAt?: Date;
      scopePath?: string;
      orgId?: string;
    },
    client: Pick<PrismaClient, "capability"> = db,
  ) {
    const token = `qa-admin-window-${++seq}`;
    const agentId = `agent-qa-aw-${seq}`;
    const orgId = data.orgId ?? ORG;
    const row = await client.capability.create({
      data: {
        orgId,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath: data.scopePath ?? (orgId === ORG ? ROOT : OTHER_ROOT),
        permission: data.permission,
        expiresAt: data.expiresAt,
        createdBy: orgId === ORG ? ADMIN : OTHER_ADMIN,
        ...(data.createdAt ? { createdAt: data.createdAt } : {}),
      },
    });
    return { row, token, agentId };
  }

  /**
   * An admin token minted at `mintedAt`. The trigger stamps a new admin row with the
   * database clock, so a token minted in the past is made the only way the database
   * allows: minted as `read` at that time, then promoted, which keeps its mint time.
   */
  async function adminMintedAt(mintedAt: Date) {
    const minted = await insert({
      permission: "read",
      createdAt: mintedAt,
      expiresAt: new Date(mintedAt.getTime() + 24 * HOUR),
    });
    const row = await db.capability.update({ where: { id: minted.row.id }, data: { permission: "admin" } });
    return { ...minted, row };
  }

  async function reads(ctx: AccessContext, scope = ROOT) {
    return (await check(ctx, { action: "memory.read", scope })).allowed;
  }

  async function wipe() {
    const orgs = { in: [ORG, OTHER_ORG] };
    await db.auditLog.deleteMany({ where: { orgId: orgs } });
    await db.capability.deleteMany({ where: { orgId: orgs } });
    await db.grant.deleteMany({ where: { orgId: orgs } });
    await db.scope.deleteMany({ where: { orgId: orgs } });
    await db.user.deleteMany({ where: { orgId: orgs } });
    await deleteOrgsWithRetry(db, { where: { id: orgs } });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ check } = await import("./check"));
    ({ issueCapability } = await import("./issue-capability"));
    ({ hashCapabilityToken } = await import("./capabilities"));
    ({ POST: grantsPOST } = await import("@/app/api/access/grants/route"));
    ({ POST: capabilitiesPOST } = await import("@/app/api/access/capabilities/route"));

    await wipe();
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.org.create({ data: { id: OTHER_ORG, name: OTHER_ORG } });
    for (const s of SCOPES) await db.scope.create({ data: { orgId: s.orgId, path: s.path, name: s.path } });
    await db.user.create({
      data: { id: ADMIN, orgId: ORG, clerkId: `clerk-${ADMIN}`, email: `${ADMIN}@example.test`, role: "admin" },
    });
    await db.user.create({
      data: {
        id: OTHER_ADMIN,
        orgId: OTHER_ORG,
        clerkId: `clerk-${OTHER_ADMIN}`,
        email: `${OTHER_ADMIN}@example.test`,
        role: "admin",
      },
    });
    for (const [orgId, path] of [
      [ORG, ROOT],
      [OTHER_ORG, OTHER_ROOT],
    ] as const) {
      const scope = await db.scope.findUniqueOrThrow({ where: { orgId_path: { orgId, path } } });
      await db.grant.create({
        data: { orgId, scopeId: scope.id, granteeType: "role", granteeId: "admin", permission: "admin" },
      });
    }
  });

  beforeEach(async () => {
    await db.auditLog.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    if (db) await wipe();
    await db?.$disconnect();
  });

  describe("the database holds the window for every writer", () => {
    it("cuts a new admin row to exactly two hours from the database's clock, at the edges and either side", async () => {
      // One transaction, so now() is one instant for the read and the inserts.
      const results = await db.$transaction(async (tx) => {
        const now = await dbNow(tx);
        const asked = [WINDOW - SECOND, WINDOW, WINDOW + SECOND, 90 * 24 * HOUR];
        const rows = [];
        for (const ms of asked)
          rows.push((await insert({ permission: "admin", expiresAt: new Date(now.getTime() + ms) }, tx)).row);
        return { now, rows };
      });
      const { now, rows } = results;
      const stored = rows.map((r) => r.expiresAt.getTime() - now.getTime());
      expect(stored).toEqual([WINDOW - SECOND, WINDOW, WINDOW, WINDOW]);
      for (const r of rows) expect(r.createdAt.getTime()).toBe(now.getTime());
    });

    it("stamps an admin row with the database's clock, not a writer's skewed one", async () => {
      const writerClock = new Date((await dbNow()).getTime() + 3 * HOUR);
      const { row } = await insert({
        permission: "admin",
        createdAt: writerClock,
        expiresAt: new Date(writerClock.getTime() + WINDOW),
      });
      const after = await dbNow();
      expect(row.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
      expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(WINDOW);
    });

    it("stamps UTC whatever the session's time zone, west or east of UTC", async () => {
      for (const zone of ["America/Los_Angeles", "Asia/Tokyo"]) {
        const row = await db.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${zone}'`);
          return (await insert({ permission: "admin", expiresAt: new Date(Date.now() + 90 * 24 * HOUR) }, tx)).row;
        });
        // Prisma reads the column back as UTC; a stamp in local time would be hours off.
        expect(Math.abs(row.createdAt.getTime() - Date.now())).toBeLessThan(60 * SECOND);
        expect(lifetime(row)).toBe(WINDOW);
      }
    });

    it("refuses to extend or refresh an admin token after it is minted", async () => {
      const { row } = await insert({ permission: "admin", expiresAt: new Date(Date.now() + WINDOW) });
      const end = row.createdAt.getTime() + WINDOW;

      const extended = await db.capability.update({
        where: { id: row.id },
        data: { expiresAt: new Date(end + 24 * HOUR) },
      });
      expect(extended.expiresAt.getTime()).toBe(end);

      const refreshed = await db.capability.update({
        where: { id: row.id },
        data: { createdAt: new Date(end), expiresAt: new Date(end + WINDOW) },
      });
      expect(refreshed.createdAt.getTime()).toBe(row.createdAt.getTime());
      expect(refreshed.expiresAt.getTime()).toBe(end);
    });

    it("bounds a token promoted to admin by when it was first minted", async () => {
      const mintedAt = new Date((await dbNow()).getTime() - 3 * HOUR);
      const { row } = await adminMintedAt(mintedAt);
      expect(row.expiresAt.getTime()).toBe(mintedAt.getTime() + WINDOW);
    });

    it("leaves read and write tokens exactly as written", async () => {
      const createdAt = new Date((await dbNow()).getTime() - 3 * HOUR);
      const expiresAt = new Date(createdAt.getTime() + 90 * 24 * HOUR);
      for (const permission of ["read", "write"] as const) {
        const { row } = await insert({ permission, createdAt, expiresAt });
        expect([row.createdAt.getTime(), row.expiresAt.getTime()]).toEqual([createdAt.getTime(), expiresAt.getTime()]);
      }
    });
  });

  describe("the migration's backfill", () => {
    it("expires existing admin tokens older than two hours, trims younger ones, and leaves the rest", async () => {
      const migration = readFileSync(
        join(process.cwd(), "prisma/migrations/20261014210000_capability_admin_window/migration.sql"),
        "utf8",
      );
      const backfill = /^UPDATE "capabilities"[\s\S]*?;$/m.exec(migration)?.[0];
      expect(backfill).toBeDefined();

      const rolledBack = new Error("roll back the backfill fixture");
      let after: { old: number; young: number; write: number } | undefined;
      await db
        .$transaction(async (tx) => {
          // Rows as they stood before the migration: the trigger did not exist yet.
          await tx.$executeRawUnsafe(`ALTER TABLE "capabilities" DISABLE TRIGGER "capabilities_admin_window"`);
          const now = await dbNow(tx);
          const at = (ms: number) => new Date(now.getTime() + ms);
          const old = await insert(
            { permission: "admin", createdAt: at(-30 * 24 * HOUR), expiresAt: at(60 * 24 * HOUR) },
            tx,
          );
          const young = await insert({ permission: "admin", createdAt: at(-HOUR), expiresAt: at(89 * 24 * HOUR) }, tx);
          const write = await insert(
            { permission: "write", createdAt: at(-30 * 24 * HOUR), expiresAt: at(60 * 24 * HOUR) },
            tx,
          );
          await tx.$executeRawUnsafe(backfill!);
          const read = async (id: string) =>
            (await tx.capability.findUniqueOrThrow({ where: { id } })).expiresAt.getTime() - now.getTime();
          after = { old: await read(old.row.id), young: await read(young.row.id), write: await read(write.row.id) };
          throw rolledBack;
        })
        .catch((error) => {
          if (error !== rolledBack) throw error;
        });
      expect(after).toEqual({ old: -30 * 24 * HOUR + WINDOW, young: -HOUR + WINDOW, write: 60 * 24 * HOUR });
    });
  });

  describe("check() decides by the database clock, the same way every time", () => {
    it("refuses an admin token at exactly two hours and one second past, allows it one second before", async () => {
      const now = await dbNow();
      const atEdge = await adminMintedAt(new Date(now.getTime() - WINDOW));
      const pastEdge = await adminMintedAt(new Date(now.getTime() - WINDOW - SECOND));
      const beforeEdge = await adminMintedAt(new Date(now.getTime() - WINDOW + SECOND));

      const decisions = [];
      for (let run = 0; run < 3; run++) {
        decisions.push([
          await reads(agent(atEdge.agentId, atEdge.token)),
          await reads(agent(pastEdge.agentId, pastEdge.token)),
        ]);
      }
      expect(decisions).toEqual([
        [false, false],
        [false, false],
        [false, false],
      ]);
      // The one live edge is asked once and first-hand: the window closes within a second.
      expect(await reads(agent(beforeEdge.agentId, beforeEdge.token))).toBe(true);
    });

    it("refuses an expired admin token rather than downgrading it to read", async () => {
      const expired = await adminMintedAt(new Date((await dbNow()).getTime() - 3 * HOUR));
      const decision = await check(agent(expired.agentId, expired.token), { action: "memory.read", scope: ROOT });
      expect(decision.allowed).toBe(false);
    });

    it("ignores a skewed application clock: a live token stays live, an expired one stays refused", async () => {
      const live = await insert({ permission: "admin", expiresAt: new Date(Date.now() + WINDOW) });
      const expired = await adminMintedAt(new Date((await dbNow()).getTime() - 3 * HOUR));
      vi.useFakeTimers({ toFake: ["Date"] });
      for (const skew of [-3 * HOUR, 3 * HOUR]) {
        vi.setSystemTime(Date.now() + skew);
        expect(await reads(agent(live.agentId, live.token))).toBe(true);
        expect(await reads(agent(expired.agentId, expired.token))).toBe(false);
        vi.useRealTimers();
        vi.useFakeTimers({ toFake: ["Date"] });
      }
    });

    it("keeps an admin token inside its own scope: no sibling, no parent, no other tenant", async () => {
      const { agentId, token } = await insert({
        permission: "admin",
        scopePath: `${ROOT}.eng`,
        expiresAt: new Date(Date.now() + WINDOW),
      });
      const ctx = agent(agentId, token);
      expect(await reads(ctx, `${ROOT}.eng`)).toBe(true);
      expect(await reads(ctx, `${ROOT}.eng.api`)).toBe(true);
      expect(await reads(ctx, `${ROOT}.eng_x`)).toBe(false);
      expect(await reads(ctx, `${ROOT}.sales`)).toBe(false);
      expect(await reads(ctx, ROOT)).toBe(false);
      expect(await reads(agent(agentId, token, OTHER_ORG), OTHER_ROOT)).toBe(false);
    });

    it("marks every decision taken under an admin token on its audit row, and only those", async () => {
      const admin = await insert({ permission: "admin", expiresAt: new Date(Date.now() + WINDOW) });
      const write = await insert({ permission: "write", expiresAt: new Date(Date.now() + WINDOW) });
      await check(agent(admin.agentId, admin.token), { action: "memory.read", scope: ROOT });
      await check(agent(admin.agentId, admin.token), { action: "access.manage", scope: ROOT });
      await check(agent(write.agentId, write.token), { action: "memory.read", scope: ROOT });
      const rows = await db.auditLog.findMany({
        where: { orgId: ORG, actorId: { in: [admin.agentId, write.agentId] } },
        select: { actorId: true, action: true, metadata: true },
      });
      const marked = (actorId: string) =>
        rows
          .filter((r) => r.actorId === actorId)
          .map((r) => (r.metadata as { agentAdmin?: boolean }).agentAdmin === true);
      expect(marked(admin.agentId)).toEqual([true, true]);
      expect(marked(write.agentId)).toEqual([false]);
    });
  });

  describe("issueCapability(): only a person issues, and admin gets two hours", () => {
    it("issues admin for two hours by default and caps a longer ask, by the stored row", async () => {
      for (const ttlHours of [undefined, 720, 2, 24 * 90 * 10]) {
        const issued = await issueCapability(person(ADMIN, ORG), {
          agentRef: "agent-qa-aw-issued",
          permission: "admin",
          ttlHours,
        });
        if (!issued.ok) throw new Error(issued.error);
        const row = await db.capability.findUniqueOrThrow({ where: { id: issued.capability.id } });
        expect(lifetime(row)).toBeLessThanOrEqual(WINDOW);
        expect(lifetime(row)).toBeGreaterThan(WINDOW - ISSUE_LATENCY);
        expect(issued.capability.expiresAt.getTime()).toBe(row.expiresAt.getTime());
      }
    });

    it("keeps a shorter admin ask and leaves write tokens on their own default", async () => {
      const short = await issueCapability(person(ADMIN, ORG), {
        agentRef: "agent-qa-aw-short",
        permission: "admin",
        ttlHours: 1,
      });
      const write = await issueCapability(person(ADMIN, ORG), { agentRef: "agent-qa-aw-write", permission: "write" });
      if (!short.ok || !write.ok) throw new Error("issue refused");
      const [s, w] = await Promise.all(
        [short, write].map((i) => db.capability.findUniqueOrThrow({ where: { id: i.capability.id } })),
      );
      expect(lifetime(s)).toBeLessThanOrEqual(HOUR);
      expect(lifetime(s)).toBeGreaterThan(HOUR - ISSUE_LATENCY);
      expect(lifetime(w)).toBeLessThanOrEqual(7 * 24 * HOUR);
      expect(lifetime(w)).toBeGreaterThan(7 * 24 * HOUR - ISSUE_LATENCY);
    });

    it("issues admin by the database clock even when the application clock is skewed", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 3 * HOUR);
      const issued = await issueCapability(person(ADMIN, ORG), { agentRef: "agent-qa-aw-skewed", permission: "admin" });
      vi.useRealTimers();
      if (!issued.ok) throw new Error(issued.error);
      const after = await dbNow();
      expect(issued.capability.expiresAt.getTime()).toBeLessThanOrEqual(after.getTime() + WINDOW);
    });

    it("refuses an agent holding a live admin token, for itself or another agent, at any permission, and audits it", async () => {
      const { agentId, token } = await insert({ permission: "admin", expiresAt: new Date(Date.now() + WINDOW) });
      const asks = [
        { agentRef: agentId, permission: "admin", ttlHours: 2 },
        { agentRef: agentId, permission: "admin", ttlHours: 720 },
        { agentRef: "agent-qa-aw-other", permission: "admin" },
        { agentRef: "agent-qa-aw-other", permission: "read" },
      ];
      const before = await db.capability.count({ where: { orgId: ORG } });
      for (const ask of asks) {
        const issued = await issueCapability(agent(agentId, token), ask);
        expect(issued).toMatchObject({ ok: false, status: 403 });
      }
      expect(await db.capability.count({ where: { orgId: ORG } })).toBe(before);
      const denies = await db.auditLog.count({
        where: { orgId: ORG, actorId: agentId, action: "access.manage", decision: "deny" },
      });
      expect(denies).toBe(asks.length);
    });
  });

  describe("the routes that grant or issue never take a bearer token for a person", () => {
    it("refuses an admin token presented to POST /api/access/grants and POST /api/access/capabilities", async () => {
      const { agentId, token } = await insert({ permission: "admin", expiresAt: new Date(Date.now() + WINDOW) });
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
      const grant = await grantsPOST(
        new Request("http://localhost/api/access/grants", {
          method: "POST",
          headers,
          body: JSON.stringify({ scopePath: ROOT, granteeType: "agent", granteeId: agentId, permission: "admin" }),
        }),
      );
      const issue = await capabilitiesPOST(
        new Request("http://localhost/api/access/capabilities", {
          method: "POST",
          headers,
          body: JSON.stringify({ agentId, permission: "admin", ttlHours: 720 }),
        }),
      );
      expect([grant.status, issue.status]).toEqual([401, 401]);
      expect(await db.grant.count({ where: { orgId: ORG, granteeType: "agent" } })).toBe(0);
    });
  });
});
