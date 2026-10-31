// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The locks around deleting a `users` row
// (deleteUsersWithoutMembership, recordMembershipRemoved, cancelOrgDeletion), driven
// deterministically by a second connection holding a row lock.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { seedMember } from "@/services/access/member.testsupport";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const A = "qar3a";
const B = "qar3b";
const ADMIN = "u-qar3-admin";
const KEPT = "u-qar3-kept";
const LEAVER = "u-qar3-leaver";
const PEOPLE = [ADMIN, KEPT, LEAVER];
const clerk = (userId: string) => `clerk_${userId}`;
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe.skipIf(!QA_URL)("QA r3: users-row deletion races", { timeout: 60_000 }, () => {
  let db: PrismaClient;
  let access: typeof import("@/services/access");
  let svc: typeof import("./request");

  async function reset() {
    await deleteOrgsWithRetry(db, { where: { id: { in: [A, B] } } });
    await db.user.deleteMany({ where: { id: { in: PEOPLE } } });
    await db.orgDeletion.deleteMany({ where: { orgId: { in: [A, B] } } });
    await db.orgAdminDeparture.deleteMany({ where: { clerkUserId: { in: PEOPLE.map(clerk) } } });
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
  /** Wait until `count` backends wait on `locker`, or `done()` holds, whichever is first. */
  async function untilBlockedOrDone(probe: Client, locker: Client, count: number, done: () => boolean) {
    const { rows: me } = await locker.query("SELECT pg_backend_pid() AS pid");
    for (let i = 0; i < 100; i += 1) {
      if (done()) return;
      const { rows } = await probe.query(
        `WITH w AS (SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity)
         SELECT count(*)::int AS n FROM w
         WHERE $1 = ANY(w.blockers) OR EXISTS (SELECT 1 FROM w ahead WHERE ahead.pid = ANY(w.blockers) AND $1 = ANY(ahead.blockers))`,
        [me[0].pid],
      );
      if (rows[0].n >= count) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`neither done nor ${count} backends blocked`);
  }
  async function withLocker<T>(fn: (locker: Client, probe: Client) => Promise<T>): Promise<T> {
    const locker = new Client({ connectionString: QA_URL });
    const probe = new Client({ connectionString: QA_URL });
    await locker.connect();
    await probe.connect();
    try {
      return await fn(locker, probe);
    } finally {
      await locker.end().catch(() => {});
      await probe.end().catch(() => {});
    }
  }
  /** An owner's pending deletion of `orgId`, opened an hour ago. */
  async function openDeletion(orgId: string): Promise<string> {
    const requestedAt = new Date(Date.now() - HOUR);
    const row = await db.orgDeletion.create({
      data: {
        orgId,
        orgName: `Org ${orgId}`,
        trigger: "owner",
        requestedBy: ADMIN,
        recipientClerkIds: [clerk(ADMIN)],
        requestedAt,
        effectiveAt: new Date(requestedAt.getTime() + 7 * DAY),
        revokedCapabilityIds: [],
      },
    });
    return row.id;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    access = await import("@/services/access");
    svc = await import("./request");
  });
  beforeEach(reset);
  afterAll(async () => {
    await reset();
    await db.$disconnect();
  });

  // DPA s10: "A member removed during the seven days keeps their member record until the
  // deletion takes effect ... or is cancelled, when it is deleted at once."
  it("race: a removal landing while a cancel commits leaves no users row with no membership and no deletion open", async () => {
    await db.org.create({ data: { id: A, name: `Org ${A}`, clerkOrgId: `clerk_org_${A}` } });
    await seedMember(db, { orgId: A, userId: ADMIN, role: "admin" });
    await seedMember(db, { orgId: A, userId: KEPT, role: "member" });
    await seedMember(db, { orgId: A, userId: LEAVER, role: "admin" });
    const id = await openDeletion(A);
    // KEPT left during the window and kept their row for the deletion.
    await access.recordMembershipRemoved({ orgId: A, userId: KEPT, removedAt: new Date(Date.now() - 30 * 60_000) });
    expect(await db.user.count({ where: { id: KEPT } })).toBe(1);

    await withLocker(async (locker, probe) => {
      // Hold KEPT's row, so the cancel stops inside its transaction after it has marked the
      // deletion cancelled and chosen whom to delete, before it commits.
      await locker.query("BEGIN");
      await locker.query(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [KEPT]);
      const cancel = svc.cancelOrgDeletion(id, clerk(ADMIN));
      await untilBlocked(probe, locker);
      // Clerk's organizationMembership.deleted for LEAVER, delivered now, before the cancel
      // commits. Unserialized, it reads the deletion as still open and keeps the row, and
      // the cancel, which chose whom to delete before this removal, never deletes it.
      let removed = false;
      const removal = access
        .recordMembershipRemoved({ orgId: A, userId: LEAVER, removedAt: new Date() })
        .finally(() => {
          removed = true;
        });
      // Done (it did not wait for the cancel), or waiting behind it.
      await untilBlockedOrDone(probe, locker, 2, () => removed);
      await locker.query("COMMIT");
      await removal;
      expect((await cancel).status).toBe("cancelled");
    });

    expect(await db.orgDeletion.count({ where: { orgId: A, status: { in: ["pending", "deleting"] } } })).toBe(0);
    expect(await db.orgMembership.count({ where: { userId: LEAVER, removedAt: null } })).toBe(0);
    // Expected: with the org staying and LEAVER belonging to no org, their row goes, as the
    // cancel did for KEPT, and their admin departure is kept.
    expect({
      kept: await db.user.count({ where: { id: KEPT } }),
      leaver: await db.user.count({ where: { id: LEAVER } }),
      leaverDeparture: await db.orgAdminDeparture.count({ where: { orgId: A, clerkUserId: clerk(LEAVER) } }),
    }).toEqual({ kept: 0, leaver: 0, leaverDeparture: 1 });
  });

  // The other order of the tested rejoin race: the helper holds the row and memberships
  // first. The membership write must fail loudly, never leave a membership with no row
  // or a row deleted under a live membership.
  it("race: a membership written after the helper has locked the row fails and leaves nothing half-written", async () => {
    await db.org.create({ data: { id: A, name: `Org ${A}`, clerkOrgId: `clerk_org_${A}` } });
    await db.org.create({ data: { id: B, name: `Org ${B}`, clerkOrgId: `clerk_org_${B}` } });
    await seedMember(db, { orgId: A, userId: LEAVER, role: "admin" });
    await db.orgMembership.update({
      where: { orgId_userId: { orgId: A, userId: LEAVER } },
      data: { removedAt: new Date(Date.now() - HOUR) },
    });
    const account = await db.account.create({ data: { orgId: A, name: "A-Acme", ownerId: LEAVER } });

    let membershipError: unknown = null;
    await withLocker(async (locker, probe) => {
      // Hold the account LEAVER owns: the helper's delete stops at its ON DELETE SET NULL,
      // after it has locked LEAVER's row and memberships.
      await locker.query("BEGIN");
      await locker.query(`SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE`, [account.id]);
      const deleting = db.$transaction((tx) => access.deleteUsersWithoutMembership(tx, { id: LEAVER }));
      await untilBlocked(probe, locker);
      const joining = access
        .recordMembership({ orgId: B, userId: LEAVER, role: "member", assertedAt: new Date() })
        .catch((e: unknown) => {
          membershipError = e;
        });
      await untilBlocked(probe, locker, 2);
      await locker.query("COMMIT");
      expect(await deleting).toBe(1);
      await joining;
    });

    expect(membershipError).not.toBeNull();
    expect({
      row: await db.user.count({ where: { id: LEAVER } }),
      memberships: await db.orgMembership.count({ where: { userId: LEAVER } }),
      departure: await db.orgAdminDeparture.count({ where: { orgId: A, clerkUserId: clerk(LEAVER) } }),
      owner: (await db.account.findUniqueOrThrow({ where: { id: account.id } })).ownerId,
    }).toEqual({ row: 0, memberships: 0, departure: 1, owner: null });
  });
});
