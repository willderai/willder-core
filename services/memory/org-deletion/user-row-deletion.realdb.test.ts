// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// deleteUsersWithoutMembership (services/access/membership.ts), the one way a `users`
// row is deleted outside an org's own cascade, and its removal caller: the three-day
// boundary under any session time zone, a departure never moved back to an older end,
// and two races driven deterministically by a second connection holding a lock.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { seedMember } from "@/services/access/member.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const A = "rtdela";
const B = "rtdelb";
const X = "u-rt-x";
const PEOPLE = [X];
const clerk = (userId: string) => `clerk_${userId}`;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe.skipIf(!QA_URL)("deleting a users row", { timeout: 60_000 }, () => {
  let db: PrismaClient;
  let access: typeof import("@/services/access");

  async function reset() {
    await db.org.deleteMany({ where: { id: { in: [A, B] } } });
    await db.user.deleteMany({ where: { id: { in: PEOPLE } } });
    await db.orgAdminDeparture.deleteMany({ where: { clerkUserId: { in: PEOPLE.map(clerk) } } });
  }
  async function seedOrgs() {
    await db.org.create({ data: { id: A, name: `Org ${A}`, clerkOrgId: `clerk_org_${A}` } });
    await db.org.create({ data: { id: B, name: `Org ${B}`, clerkOrgId: `clerk_org_${B}` } });
  }
  /** X homed in A: admin of A until a minute ago, admin of B until `bEndedAt`; no live membership. */
  async function seedXLeftB(bEndedAt: Date) {
    await seedOrgs();
    await seedMember(db, { orgId: A, userId: X, role: "admin" });
    await seedMember(db, { orgId: B, userId: X, role: "admin" });
    await db.orgMembership.update({
      where: { orgId_userId: { orgId: B, userId: X } },
      data: { removedAt: bEndedAt, assertedAt: bEndedAt },
    });
    await db.orgMembership.update({
      where: { orgId_userId: { orgId: A, userId: X } },
      data: { removedAt: new Date(Date.now() - MINUTE) },
    });
  }
  /** Wait until `count` backends wait on `locker`, directly or behind another that does. */
  async function untilBlocked(probe: Client, locker: Client, count = 1) {
    const { rows: me } = await locker.query("SELECT pg_backend_pid() AS pid");
    for (let i = 0; i < 100; i += 1) {
      const { rows } = await probe.query(
        `WITH w AS (SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity)
         SELECT count(*)::int AS n FROM w
         WHERE $1 = ANY(w.blockers) OR EXISTS (SELECT 1 FROM w ahead WHERE ahead.pid = ANY(w.blockers) AND $1 = ANY(ahead.blockers))`,
        [me[0].pid],
      );
      if (rows[0].n >= count) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`fewer than ${count} backends blocked`);
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    access = await import("@/services/access");
  });
  beforeEach(reset);
  afterAll(async () => {
    await reset();
    await db.$disconnect();
  });

  // --- Class 14: the module promises UTC columns "whatever the session's time zone is".

  it("tz: a departure 3 days minus 1 hour old is kept when the session time zone is UTC+14", async () => {
    const now = new Date();
    await seedXLeftB(new Date(now.getTime() - 3 * DAY + HOUR));
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'Pacific/Kiritimati'`);
      expect(await access.deleteUsersWithoutMembership(tx, { id: X }, now)).toBe(1);
    });
    expect(
      (await db.orgAdminDeparture.findMany({ where: { clerkUserId: clerk(X) } })).map((d) => d.orgId).sort(),
    ).toEqual([A, B]);
  });

  it("tz: a departure 3 days plus 1 hour old is not kept when the session time zone is UTC-10", async () => {
    const now = new Date();
    await seedXLeftB(new Date(now.getTime() - 3 * DAY - HOUR));
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'Pacific/Honolulu'`);
      expect(await access.deleteUsersWithoutMembership(tx, { id: X }, now)).toBe(1);
    });
    expect((await db.orgAdminDeparture.findMany({ where: { clerkUserId: clerk(X) } })).map((d) => d.orgId)).toEqual([
      A,
    ]);
  });

  // --- Class 7: the upsert overwrites a newer departure with an older end.

  it("upsert: an existing newer departure for the same org and person is not moved back to an older end", async () => {
    const now = new Date();
    const newer = new Date(now.getTime() - MINUTE);
    await seedXLeftB(new Date(now.getTime() - HOUR));
    await db.orgAdminDeparture.create({ data: { orgId: B, clerkUserId: clerk(X), removedAt: newer } });
    await db.$transaction((tx) => access.deleteUsersWithoutMembership(tx, { id: X }, now));
    const kept = await db.orgAdminDeparture.findUniqueOrThrow({
      where: { orgId_clerkUserId: { orgId: B, clerkUserId: clerk(X) } },
    });
    expect(kept.removedAt.getTime()).toBe(newer.getTime());
  });

  // --- Class 7: two removals of a person's last two memberships at once.

  it("race: two concurrent removals of a person's last two memberships delete the row and keep both departures", async () => {
    await seedOrgs();
    await seedMember(db, { orgId: A, userId: X, role: "admin" });
    await seedMember(db, { orgId: B, userId: X, role: "admin" });
    const locker = new Client({ connectionString: QA_URL });
    const probe = new Client({ connectionString: QA_URL });
    await locker.connect();
    await probe.connect();
    try {
      const t = Date.now();
      // Both removals start while X's row is held, so neither has read anything when the
      // other runs: unserialized, the removal from A re-homes the row to B after the
      // removal from B has read it homed in A and left it.
      await locker.query("BEGIN");
      await locker.query(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [X]);
      const fromA = access.recordMembershipRemoved({ orgId: A, userId: X, removedAt: new Date(t - 2_000) });
      const fromB = access.recordMembershipRemoved({ orgId: B, userId: X, removedAt: new Date(t - 1_000) });
      await untilBlocked(probe, locker, 2);
      await locker.query("COMMIT");
      await Promise.all([fromA, fromB]);
    } finally {
      await locker.end().catch(() => {});
      await probe.end().catch(() => {});
    }
    expect(await db.orgMembership.count({ where: { userId: X, removedAt: null } })).toBe(0);
    // Expected: no live membership, so the row is gone and both departures are kept.
    expect({
      row: await db.user.count({ where: { id: X } }),
      departures: (await db.orgAdminDeparture.findMany({ where: { clerkUserId: clerk(X) } }))
        .map((d) => d.orgId)
        .sort(),
    }).toEqual({ row: 0, departures: [A, B] });
  });

  // --- Class 7: a membership created while the removal deletes the row.

  it("race: a live membership committed while a removal deletes the row is not deleted with it", async () => {
    await seedOrgs();
    await seedMember(db, { orgId: A, userId: X, role: "admin" });
    const locker = new Client({ connectionString: QA_URL });
    const probe = new Client({ connectionString: QA_URL });
    await locker.connect();
    await probe.connect();
    try {
      // Clerk's organizationMembership.created for B, in flight: its insert holds the
      // users row's KEY SHARE lock until it commits.
      await locker.query("BEGIN");
      await locker.query(
        `INSERT INTO org_memberships ("orgId","userId","role","assertedAt","removedAt","createdAt","updatedAt")
         VALUES ($1, $2, 'member', (now() AT TIME ZONE 'UTC'), NULL, (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC'))`,
        [B, X],
      );
      const removal = access.recordMembershipRemoved({ orgId: A, userId: X, removedAt: new Date() });
      await untilBlocked(probe, locker);
      await locker.query("COMMIT");
      await removal;
    } finally {
      await locker.end().catch(() => {});
      await probe.end().catch(() => {});
    }
    // Expected: X belongs to B, so neither the row nor B's live membership goes.
    expect({
      liveB: await db.orgMembership.count({ where: { orgId: B, userId: X, removedAt: null } }),
      row: await db.user.count({ where: { id: X } }),
    }).toEqual({ liveB: 1, row: 1 });
  });

  // A cancel or day 7 calls the helper with no removal's lock ahead of it.
  for (const rejoin of ["joins another org", "rejoins an org they left"] as const) {
    it(`race: a person who ${rejoin} while a cancel or day 7 deletes their row keeps the row and the membership`, async () => {
      await seedOrgs();
      await seedMember(db, { orgId: A, userId: X, role: "admin" });
      if (rejoin === "rejoins an org they left") await seedMember(db, { orgId: B, userId: X, role: "admin" });
      await db.orgMembership.updateMany({ where: { userId: X }, data: { removedAt: new Date(Date.now() - HOUR) } });
      const locker = new Client({ connectionString: QA_URL });
      const probe = new Client({ connectionString: QA_URL });
      await locker.connect();
      await probe.connect();
      try {
        await locker.query("BEGIN");
        // recordMembership's two forms: a new row, or a tombstone made live again.
        await locker.query(
          `INSERT INTO org_memberships ("orgId","userId","role","assertedAt","removedAt","createdAt","updatedAt")
           VALUES ($1, $2, 'member', (now() AT TIME ZONE 'UTC'), NULL, (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC'))
           ON CONFLICT ("orgId","userId") DO UPDATE SET "removedAt" = NULL`,
          [B, X],
        );
        const deleting = db.$transaction((tx) => access.deleteUsersWithoutMembership(tx, { id: X }));
        await untilBlocked(probe, locker);
        await locker.query("COMMIT");
        expect(await deleting).toBe(0);
      } finally {
        await locker.end().catch(() => {});
        await probe.end().catch(() => {});
      }
      expect(await db.user.count({ where: { id: X } })).toBe(1);
      expect(await db.orgMembership.count({ where: { orgId: B, userId: X, removedAt: null } })).toBe(1);
    });
  }
});
