// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A Clerk removal (recordMembershipRemoved) racing each change to an org's deletion: a
// cancel, the job's claim, the job deleting the org row, Clerk's organization.deleted
// starting one or joining one. Each must leave no `users` row with no membership and no
// deletion to remove it, and must not lose an admin's departure. Races are driven by a
// second connection holding a row lock and pg_blocking_pids, never by timing. Also the
// order the set locks are taken in, which keeps two callers from deadlocking.
// Doubles as in races.realdb.test.ts: Blob (in-memory map), graph, Clerk, Inngest send.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { seedMember } from "@/services/access/member.testsupport";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const hooks = vi.hoisted(() => ({
  onPurge: null as null | (() => Promise<unknown>),
  onHelper: null as null | (() => Promise<unknown>),
  helperFails: false,
}));

// The job's own calls of the helper can be made to fail once, as a run dying there would.
vi.mock("@/services/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/access")>();
  return {
    ...actual,
    deleteUsersWithoutMembership: async (...args: Parameters<typeof actual.deleteUsersWithoutMembership>) => {
      await hooks.onHelper?.();
      if (hooks.helperFails) {
        hooks.helperFails = false;
        return Promise.reject(new Error("connection lost"));
      }
      return actual.deleteUsersWithoutMembership(...args);
    },
  };
});

vi.mock("@/lib/blob-storage", () => ({
  putPrivateBlob: async (pathname: string) => ({ url: `https://blob.test/${pathname}` }),
  deletePrivateBlob: async () => {},
  readPrivateBlob: async () => null,
  listPrivateBlobs: async () => [],
}));
vi.mock("@/services/memory/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory/store")>()),
  graphitiStore: {
    // Day 7 clears the graph after moving people and fixing the recipients, and before
    // it deletes the org row: the hook runs a removal in that window.
    purgeOrg: async () => {
      await hooks.onPurge?.();
      return { nodes: 0, relationships: 0 };
    },
    orgResidue: async () => ({ nodes: 0, relationships: 0 }),
  },
}));
vi.mock("@/services/memory/org-deletion/clerk-org", () => ({ deleteClerkOrganization: async () => {} }));
vi.mock("@/lib/inngest/org-deletion", () => ({ queueFinalExport: async () => {} }));

const A = "rmra";
const B = "rmrb";
const OWNER = "u-rmr-owner";
const U = "u-rmr-u";
const W = "u-rmr-w";
// Inserted in this order, so their physical order is the reverse of their id order.
const LATE_ID = "u-rmr-zz";
const EARLY_ID = "u-rmr-aa";
const V = "u-rmr-v";
const K = "u-rmr-k";
const PEOPLE = [OWNER, U, W, V, K, LATE_ID, EARLY_ID];
const clerk = (userId: string) => `clerk_${userId}`;
const DAY = 86_400_000;
const T0 = new Date("2026-11-02T10:00:00.000Z");
const at = (days: number, ms = 0) => new Date(T0.getTime() + days * DAY + ms);

describe.skipIf(!QA_URL)("a removal racing an org deletion, real Postgres", { timeout: 60_000 }, () => {
  let db: PrismaClient;
  let access: typeof import("@/services/access");
  let svc: typeof import("./request");
  let run: typeof import("./run");

  async function reset() {
    hooks.onPurge = null;
    hooks.onHelper = null;
    hooks.helperFails = false;
    await deleteOrgsWithRetry(db, { where: { id: { in: [A, B] } } });
    await db.user.deleteMany({ where: { id: { in: PEOPLE } } });
    await db.orgDeletion.deleteMany({ where: { orgId: { in: [A, B] } } });
    await db.orgAdminDeparture.deleteMany({ where: { clerkUserId: { in: PEOPLE.map(clerk) } } });
  }
  async function seedOrgs() {
    await db.org.create({ data: { id: A, name: `Org ${A}`, clerkOrgId: `clerk_org_${A}` } });
    await db.org.create({ data: { id: B, name: `Org ${B}`, clerkOrgId: `clerk_org_${B}` } });
    await seedMember(db, { orgId: A, userId: OWNER, role: "owner" });
  }
  /** The owner's deletion of A, requested at T0. */
  async function startA(): Promise<string> {
    const started = await svc.startOrgDeletion(
      { trigger: "owner", orgId: A, requestedBy: OWNER, requesterClerkId: clerk(OWNER) },
      T0,
    );
    return started!.deletion.id;
  }
  async function pidOf(client: Client): Promise<number> {
    const { rows } = await client.query("SELECT pg_backend_pid() AS pid");
    return rows[0].pid as number;
  }
  /** Backends waiting on `locker`, directly or behind one that does. */
  async function blockedOn(probe: Client, locker: Client): Promise<number> {
    const { rows } = await probe.query(
      `WITH w AS (SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity)
       SELECT count(*)::int AS n FROM w
       WHERE $1 = ANY(w.blockers) OR EXISTS (SELECT 1 FROM w ahead WHERE ahead.pid = ANY(w.blockers) AND $1 = ANY(ahead.blockers))`,
      [await pidOf(locker)],
    );
    return rows[0].n as number;
  }
  /** Wait until `count` backends wait on `locker`, or `done()` holds, whichever is first. */
  async function untilBlockedOrDone(probe: Client, locker: Client, count: number, done: () => boolean = () => false) {
    for (let i = 0; i < 100; i += 1) {
      if (done()) return;
      if ((await blockedOn(probe, locker)) >= count) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`neither done nor ${count} backends blocked`);
  }
  /** Whether another transaction could take this row lock right now (NOWAIT, rolled back). */
  async function lockable(probe: Client, sql: string, params: unknown[]): Promise<boolean> {
    await probe.query("BEGIN");
    try {
      await probe.query(`${sql} FOR UPDATE NOWAIT`, params);
      return true;
    } catch (error) {
      if ((error as { code?: string }).code === "55P03") return false;
      throw error;
    } finally {
      await probe.query("ROLLBACK");
    }
  }
  async function withClients<T>(fn: (locker: Client, probe: Client) => Promise<T>): Promise<T> {
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
  const settle = <T>(p: Promise<T>) => {
    const state = { done: false };
    const settled = p.finally(() => {
      state.done = true;
    });
    return { settled, done: () => state.done };
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    access = await import("@/services/access");
    svc = await import("./request");
    run = await import("./run");
  });
  beforeEach(reset);
  afterAll(async () => {
    await reset();
    await db.$disconnect();
  });

  // --- Removal against day 7.

  it("day 7: a person moved to B and removed from B while the job runs is deleted with the org, keeping B's departure", async () => {
    await seedOrgs();
    await seedMember(db, { orgId: A, userId: U, role: "member" });
    await seedMember(db, { orgId: B, userId: U, role: "admin" });
    const id = await startA();
    // After the job moved U to B, Clerk ends U's membership of B. U's only live
    // membership is now A's, whose rows are about to go: the row stays homed in B.
    hooks.onPurge = async () => {
      expect((await db.user.findUniqueOrThrow({ where: { id: U } })).orgId).toBe(B);
      await access.recordMembershipRemoved({ orgId: B, userId: U, removedAt: at(7) });
      expect((await db.user.findUniqueOrThrow({ where: { id: U } })).orgId).toBe(B);
    };
    expect((await run.runOrgDeletion(id, at(7)))?.status).toBe("deleted");
    expect({
      row: await db.user.count({ where: { id: U } }),
      departure: await db.orgAdminDeparture.count({ where: { orgId: B, clerkUserId: clerk(U) } }),
    }).toEqual({ row: 0, departure: 1 });
  });

  it("day 7: a member homed in B whose B membership ends while the job runs is deleted once A goes, keeping B's departure", async () => {
    await seedOrgs();
    await seedMember(db, { orgId: B, userId: U, role: "admin" });
    await seedMember(db, { orgId: A, userId: U, role: "member" });
    expect((await db.user.findUniqueOrThrow({ where: { id: U } })).orgId).toBe(B);
    const id = await startA();
    hooks.onPurge = () => access.recordMembershipRemoved({ orgId: B, userId: U, removedAt: at(7) });
    expect((await run.runOrgDeletion(id, at(7)))?.status).toBe("deleted");
    expect({
      row: await db.user.count({ where: { id: U } }),
      departure: await db.orgAdminDeparture.count({ where: { orgId: B, clerkUserId: clerk(U) } }),
    }).toEqual({ row: 0, departure: 1 });
  });

  it("day 7 resumed after the org row went still deletes a member homed elsewhere whom the cascade left with no org", async () => {
    await seedOrgs();
    await seedMember(db, { orgId: B, userId: U, role: "admin" });
    await seedMember(db, { orgId: A, userId: U, role: "member" });
    const id = await startA();
    hooks.onPurge = () => access.recordMembershipRemoved({ orgId: B, userId: U, removedAt: at(7) });
    // The first run dies right after the org row is deleted, before the people it left go.
    hooks.helperFails = true;
    await expect(run.runOrgDeletion(id, at(7))).rejects.toThrow(/connection lost/);
    expect(await db.org.count({ where: { id: A } })).toBe(0);
    hooks.onPurge = null;
    expect((await run.runOrgDeletion(id, at(7, 60_000)))?.status).toBe("deleted");
    expect(await db.user.count({ where: { id: U } })).toBe(0);
  });

  it("day 7 records the members homed elsewhere on the deletion when it deletes the org row, before deleting anyone", async () => {
    await seedOrgs();
    await seedMember(db, { orgId: B, userId: U, role: "admin" });
    await seedMember(db, { orgId: A, userId: U, role: "member" });
    const id = await startA();
    // A run killed here, the org row gone and no chance to record anything, must still find U.
    let stored: unknown = null;
    hooks.onHelper = async () => {
      stored = (await db.orgDeletion.findUniqueOrThrow({ where: { id } })).progress;
    };
    expect((await run.runOrgDeletion(id, at(7)))?.status).toBe("deleted");
    expect(stored).toEqual(expect.objectContaining({ membersHomedElsewhere: [U] }));
    // Still in B, so the row stays.
    expect(await db.user.count({ where: { id: U } })).toBe(1);
  });

  it("day 7: a member who joins A after the job read its people, then leaves B, is deleted once A goes", async () => {
    await seedOrgs();
    await seedMember(db, { orgId: B, userId: V, role: "member" });
    const id = await startA();
    await withClients(async (locker, probe) => {
      // Stop the job at the people it locks before the org row.
      await locker.query("BEGIN");
      await locker.query(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [OWNER]);
      const job = settle(run.runOrgDeletion(id, at(7)));
      await untilBlockedOrDone(probe, locker, 1, job.done);
      expect(job.done()).toBe(false);
      // A late organizationMembership.created for A, then V leaves B: V's only live org is
      // A, whose deletion has started, so the row stays in B.
      await access.recordMembership({ orgId: A, userId: V, role: "member", assertedAt: at(6) });
      await access.recordMembershipRemoved({ orgId: B, userId: V, removedAt: at(7) });
      await locker.query("COMMIT");
      expect((await job.settled)?.status).toBe("deleted");
    });
    expect(await db.user.count({ where: { id: V } })).toBe(0);
  });

  it("race: day 7 waits for a membership of A being written when it locks the org row, and reads that person too", async () => {
    await seedOrgs();
    await seedMember(db, { orgId: B, userId: V, role: "member" });
    const id = await startA();
    await withClients(async (locker, probe) => {
      // In flight: V joins A and leaves B, so V's only live org will be A.
      await locker.query("BEGIN");
      await locker.query(
        `INSERT INTO org_memberships ("orgId", "userId", role, "assertedAt", "createdAt", "updatedAt")
         VALUES ($1, $2, 'member', $3, now(), now())`,
        [A, V, at(6)],
      );
      await locker.query(
        `UPDATE org_memberships SET "removedAt" = $3, "assertedAt" = $3 WHERE "orgId" = $1 AND "userId" = $2`,
        [B, V, at(7)],
      );
      const job = settle(run.runOrgDeletion(id, at(7)));
      await untilBlockedOrDone(probe, locker, 1, job.done);
      expect(job.done()).toBe(false);
      await locker.query("COMMIT");
      expect((await job.settled)?.status).toBe("deleted");
    });
    // Read after the write committed, V is among A's people and goes once A is gone.
    expect(await db.user.count({ where: { id: V } })).toBe(0);
  });

  it("race: day 7 and a removal deleting a late admin of A both finish, without a deadlock", async () => {
    await seedOrgs();
    await seedMember(db, { orgId: B, userId: V, role: "member" });
    const account = await db.account.create({ data: { orgId: B, name: "B-Acme-rmr", ownerId: V } });
    const id = await startA();
    const locker2 = new Client({ connectionString: QA_URL });
    await locker2.connect();
    try {
      await withClients(async (locker, probe) => {
        await locker.query("BEGIN");
        await locker.query(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [OWNER]);
        const job = settle(run.runOrgDeletion(id, at(7)));
        await untilBlockedOrDone(probe, locker, 1, job.done);
        // V joins A late as an admin and leaves it: a tombstone of A, the row stays in B.
        await access.recordMembership({ orgId: A, userId: V, role: "admin", assertedAt: at(6) });
        await access.recordMembershipRemoved({ orgId: A, userId: V, removedAt: at(7) });
        // V leaves B, their last org: the removal deletes V's row, holding V and V's
        // memberships, and stops at the account V owns before it writes A's departure.
        await locker2.query("BEGIN");
        await locker2.query(`SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE`, [account.id]);
        const removal = settle(access.recordMembershipRemoved({ orgId: B, userId: V, removedAt: at(7, 1000) }));
        await untilBlockedOrDone(probe, locker2, 1, removal.done);
        await locker.query("COMMIT");
        // The job reads V among A's people and waits on V's row, holding nothing the
        // removal needs.
        await untilBlockedOrDone(probe, locker2, 2, job.done);
        await locker2.query("COMMIT");
        const [j, r] = await Promise.allSettled([job.settled, removal.settled]);
        expect({ job: j.status, removal: r.status }).toEqual({ job: "fulfilled", removal: "fulfilled" });
      });
    } finally {
      await locker2.end().catch(() => {});
    }
    expect({
      row: await db.user.count({ where: { id: V } }),
      org: await db.org.count({ where: { id: A } }),
    }).toEqual({ row: 0, org: 0 });
  });

  it("day 7 stops, and the next run finishes, when a person of another org is re-homed into A after the move", async () => {
    await seedOrgs();
    await seedMember(db, { orgId: B, userId: U, role: "member" });
    await seedMember(db, { orgId: A, userId: U, role: "member" });
    const id = await startA();
    // A signed-in request naming A after the job moved people out (lib/tenant.ts).
    hooks.onPurge = async () => {
      await db.user.update({ where: { id: U }, data: { orgId: A } });
    };
    await expect(run.runOrgDeletion(id, at(7))).rejects.toThrow(/the next run moves them/);
    expect(await db.org.count({ where: { id: A } })).toBe(1);
    hooks.onPurge = null;
    expect((await run.runOrgDeletion(id, at(7, 60_000)))?.status).toBe("deleted");
    expect({
      row: await db.user.count({ where: { id: U } }),
      liveB: await db.orgMembership.count({ where: { orgId: B, userId: U, removedAt: null } }),
    }).toEqual({ row: 1, liveB: 1 });
  });

  it("race: day 7 moving a person into B waits for B's cancel in flight, so the person is not left with no org", async () => {
    await seedOrgs();
    // U is homed in A and once belonged to B, so the job moves U to B.
    await seedMember(db, { orgId: A, userId: U, role: "member" });
    await seedMember(db, { orgId: B, userId: U, role: "member" });
    await db.orgMembership.update({ where: { orgId_userId: { orgId: B, userId: U } }, data: { removedAt: T0 } });
    await seedMember(db, { orgId: B, userId: K, role: "member" });
    const aId = await startA();
    const bId = (await svc.startOrgDeletion(
      { trigger: "owner", orgId: B, requestedBy: OWNER, requesterClerkId: clerk(OWNER) },
      at(1),
    ))!.deletion.id;
    // K left B during its seven days and was kept for it.
    await access.recordMembershipRemoved({ orgId: B, userId: K, removedAt: at(2) });
    await withClients(async (locker, probe) => {
      // B's cancel stops at the rows it deletes (K), having chosen them before U was moved.
      await locker.query("BEGIN");
      await locker.query(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [K]);
      const cancel = settle(svc.cancelOrgDeletion(bId, OWNER, at(7)));
      await untilBlockedOrDone(probe, locker, 1, cancel.done);
      const job = settle(run.runOrgDeletion(aId, at(7)));
      await untilBlockedOrDone(probe, locker, 2, job.done);
      await locker.query("COMMIT");
      expect((await cancel.settled).status).toBe("cancelled");
      expect((await job.settled)?.status).toBe("deleted");
    });
    expect({ u: await db.user.count({ where: { id: U } }), k: await db.user.count({ where: { id: K } }) }).toEqual({
      u: 0,
      k: 0,
    });
  });

  it("another org's day 7 never deletes a row kept for A's open deletion", async () => {
    await seedOrgs();
    await seedMember(db, { orgId: A, userId: U, role: "admin" });
    await seedMember(db, { orgId: B, userId: U, role: "member" });
    const aId = await startA();
    const bStarted = await svc.startOrgDeletion(
      { trigger: "owner", orgId: B, requestedBy: OWNER, requesterClerkId: clerk(OWNER) },
      T0,
    );
    await db.orgDeletion.update({ where: { id: bStarted!.deletion.id }, data: { status: "deleting" } });
    // U leaves A during its seven days; their only other org is being cleared, so the row
    // stays in A.
    await access.recordMembershipRemoved({ orgId: A, userId: U, removedAt: at(1) });
    expect((await run.runOrgDeletion(bStarted!.deletion.id, at(2)))?.status).toBe("deleted");
    expect((await db.orgDeletion.findUniqueOrThrow({ where: { id: aId } })).status).toBe("pending");
    // DPA s10: kept until A's deletion takes effect or is cancelled.
    expect({
      row: await db.user.count({ where: { id: U } }),
      tombstone: await db.orgMembership.count({ where: { orgId: A, userId: U } }),
    }).toEqual({ row: 1, tombstone: 1 });
    // A cancel then deletes it at once.
    await svc.cancelOrgDeletion(aId, OWNER, at(3));
    expect(await db.user.count({ where: { id: U } })).toBe(0);
  });

  it("race: a removal reading the job's claim of the org it would move the person to waits for it, and keeps the row where it is", async () => {
    await seedOrgs();
    await seedMember(db, { orgId: B, userId: U, role: "admin" });
    await seedMember(db, { orgId: A, userId: U, role: "member" });
    const id = await startA();
    await withClients(async (locker, probe) => {
      // The job's claim of A, in flight: the deletion row is locked, its status still pending.
      await locker.query("BEGIN");
      await locker.query(`SELECT 1 FROM org_deletions WHERE id = $1 FOR UPDATE`, [id]);
      const removal = settle(access.recordMembershipRemoved({ orgId: B, userId: U, removedAt: new Date() }));
      await untilBlockedOrDone(probe, locker, 1, removal.done);
      await locker.query(`UPDATE org_deletions SET status = 'deleting' WHERE id = $1`, [id]);
      await locker.query("COMMIT");
      await removal.settled;
    });
    // Moved to A, the row would go with A's cascade and B's departure with it.
    expect((await db.user.findUniqueOrThrow({ where: { id: U } })).orgId).toBe(B);
  });

  it("day 7 locks the people it deletes before the org row, so a removal holding one waits without holding up the org", async () => {
    await seedOrgs();
    await seedMember(db, { orgId: A, userId: W, role: "member" });
    const id = await startA();
    await withClients(async (locker, probe) => {
      await locker.query("BEGIN");
      await locker.query(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [W]);
      const job = settle(run.runOrgDeletion(id, at(7)));
      await untilBlockedOrDone(probe, locker, 1, job.done);
      // Waiting on W's row, it holds neither the org row nor W's membership: a removal of W,
      // which locks W and then the membership, cannot be waiting on it in return.
      expect({
        org: await lockable(probe, `SELECT 1 FROM orgs WHERE id = $1`, [A]),
        membership: await lockable(probe, `SELECT 1 FROM org_memberships WHERE "orgId" = $1 AND "userId" = $2`, [A, W]),
      }).toEqual({ org: true, membership: true });
      await locker.query("COMMIT");
      expect((await job.settled)?.status).toBe("deleted");
    });
    expect(await db.user.count({ where: { id: W } })).toBe(0);
  });

  // --- Removal against a cancel.

  it("race: a redelivered removal and a cancel deleting the same kept row both finish, without a deadlock", async () => {
    await seedOrgs();
    await seedMember(db, { orgId: A, userId: U, role: "admin" });
    const cap = await db.capability.create({
      data: {
        orgId: A,
        agentId: "agent-1",
        tokenHash: "rmr-token",
        scopePath: `org_${A}`,
        permission: "read",
        expiresAt: at(30),
        createdBy: "system:test",
      },
    });
    const id = await startA();
    const removedAt = at(1);
    await access.recordMembershipRemoved({ orgId: A, userId: U, removedAt });
    expect(await db.user.count({ where: { id: U } })).toBe(1);

    await withClients(async (locker, probe) => {
      // Hold the token the cancel restores: it stops having claimed the deletion row,
      // before it locks the rows it deletes, U's among them.
      await locker.query("BEGIN");
      await locker.query(`SELECT 1 FROM capabilities WHERE id = $1 FOR UPDATE`, [cap.id]);
      const cancel = settle(svc.cancelOrgDeletion(id, OWNER, at(2)));
      await untilBlockedOrDone(probe, locker, 1, cancel.done);
      // Clerk redelivers U's removal. Had it locked U before the org's deletion lock, the
      // cancel would wait on U while it waited on the cancel.
      const redelivery = settle(access.recordMembershipRemoved({ orgId: A, userId: U, removedAt }));
      await untilBlockedOrDone(probe, locker, 2, redelivery.done);
      await locker.query("COMMIT");
      expect((await cancel.settled).status).toBe("cancelled");
      // The cancel deleted U first: the redelivery finds no row and changes nothing.
      await redelivery.settled;
    });
    expect({
      row: await db.user.count({ where: { id: U } }),
      memberships: await db.orgMembership.count({ where: { userId: U } }),
      departure: await db.orgAdminDeparture.count({ where: { orgId: A, clerkUserId: clerk(U) } }),
    }).toEqual({ row: 0, memberships: 0, departure: 1 });
  });

  // --- Removal against Clerk's organization.deleted.

  it("race: a removal under way when organization.deleted arrives goes first: no row is left and the admin is named", async () => {
    await seedOrgs();
    await seedMember(db, { orgId: A, userId: U, role: "admin" });
    await withClients(async (locker, probe) => {
      await locker.query("BEGIN");
      await locker.query(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [U]);
      // The removal has found A with no deletion open and waits on U's row.
      const removal = settle(access.recordMembershipRemoved({ orgId: A, userId: U, removedAt: new Date() }));
      await untilBlockedOrDone(probe, locker, 1);
      const start = settle(
        svc.startOrgDeletion({ trigger: "clerk", orgId: A, clerkEventId: "evt-rmr-1", deletedAt: new Date() }),
      );
      // The deletion waits for the removal, so it reads U's departure, not a membership
      // that is ending under it.
      await untilBlockedOrDone(probe, locker, 2, start.done);
      await locker.query("COMMIT");
      await removal.settled;
      expect((await start.settled)?.started).toBe(true);
    });
    const open = await svc.openDeletion(A);
    expect({
      row: await db.user.count({ where: { id: U } }),
      departure: await db.orgAdminDeparture.count({ where: { orgId: A, clerkUserId: clerk(U) } }),
      recipient: open?.recipientClerkIds.includes(clerk(U)),
    }).toEqual({ row: 0, departure: 1, recipient: true });
  });

  it("race: a removal arriving while organization.deleted starts a deletion waits for it, then keeps the row for it", async () => {
    await seedOrgs();
    await seedMember(db, { orgId: A, userId: U, role: "admin" });
    const cap = await db.capability.create({
      data: {
        orgId: A,
        agentId: "agent-1",
        tokenHash: "rmr-token-2",
        scopePath: `org_${A}`,
        permission: "read",
        expiresAt: at(30),
        createdBy: "system:test",
      },
    });
    await withClients(async (locker, probe) => {
      // The start stops at revoking A's tokens, its deletion row written but not committed.
      await locker.query("BEGIN");
      await locker.query(`SELECT 1 FROM capabilities WHERE id = $1 FOR UPDATE`, [cap.id]);
      const start = settle(
        svc.startOrgDeletion({ trigger: "clerk", orgId: A, clerkEventId: "evt-rmr-3", deletedAt: new Date() }),
      );
      await untilBlockedOrDone(probe, locker, 1, start.done);
      const removal = settle(access.recordMembershipRemoved({ orgId: A, userId: U, removedAt: new Date() }));
      await untilBlockedOrDone(probe, locker, 2, removal.done);
      await locker.query("COMMIT");
      expect((await start.settled)?.started).toBe(true);
      await removal.settled;
    });
    // DPA s10: removed during the seven days, belonging to no other org, U keeps the
    // member record until the deletion takes effect.
    const open = await svc.openDeletion(A);
    expect({
      row: await db.user.count({ where: { id: U } }),
      live: await db.orgMembership.count({ where: { userId: U, removedAt: null } }),
      recipient: open?.recipientClerkIds.includes(clerk(U)),
    }).toEqual({ row: 1, live: 0, recipient: true });
  });

  it("race: a removal waits for organization.deleted joining an owner's deletion, then keeps the row for it", async () => {
    await seedOrgs();
    await seedMember(db, { orgId: A, userId: U, role: "admin" });
    const id = await startA();
    await withClients(async (locker, probe) => {
      // Clerk's event joining the deletion, in flight: it holds the org's deletion lock.
      await locker.query("BEGIN");
      await locker.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`org-deletion-recipients:${A}`]);
      const removal = settle(access.recordMembershipRemoved({ orgId: A, userId: U, removedAt: new Date() }));
      await untilBlockedOrDone(probe, locker, 1, removal.done);
      expect(removal.done()).toBe(false);
      await locker.query(
        `UPDATE org_deletions SET "clerkEventId" = 'evt-rmr-2', "clerkDeletedAt" = now() WHERE id = $1`,
        [id],
      );
      await locker.query("COMMIT");
      await removal.settled;
    });
    expect({
      row: await db.user.count({ where: { id: U } }),
      live: await db.orgMembership.count({ where: { userId: U, removedAt: null } }),
    }).toEqual({ row: 1, live: 0 });
  });

  // --- The order set locks are taken in.

  it("the helper locks rows in id order, whatever order they are stored in", async () => {
    await seedOrgs();
    for (const id of [LATE_ID, EARLY_ID]) {
      await seedMember(db, { orgId: B, userId: id, role: "member" });
      await db.orgMembership.update({ where: { orgId_userId: { orgId: B, userId: id } }, data: { removedAt: T0 } });
    }
    await withClients(async (locker, probe) => {
      await locker.query("BEGIN");
      await locker.query(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [EARLY_ID]);
      const deleting = settle(
        db.$transaction((tx) => access.deleteUsersWithoutMembership(tx, { id: { in: [LATE_ID, EARLY_ID] } }, T0)),
      );
      await untilBlockedOrDone(probe, locker, 1, deleting.done);
      // Waiting on the first id, it has not yet taken the second.
      expect(await lockable(probe, `SELECT 1 FROM users WHERE id = $1`, [LATE_ID])).toBe(true);
      await locker.query("COMMIT");
      expect(await deleting.settled).toBe(2);
    });
  });

  it("the helper locks one person's memberships in org order, whatever order they are stored in", async () => {
    await seedOrgs();
    // B's membership stored first, then A's.
    await seedMember(db, { orgId: B, userId: U, role: "member" });
    await seedMember(db, { orgId: A, userId: U, role: "member" });
    await db.orgMembership.updateMany({ where: { userId: U }, data: { removedAt: T0 } });
    await withClients(async (locker, probe) => {
      await locker.query("BEGIN");
      await locker.query(`SELECT 1 FROM org_memberships WHERE "orgId" = $1 AND "userId" = $2 FOR UPDATE`, [A, U]);
      const deleting = settle(db.$transaction((tx) => access.deleteUsersWithoutMembership(tx, { id: U }, T0)));
      await untilBlockedOrDone(probe, locker, 1, deleting.done);
      expect(await lockable(probe, `SELECT 1 FROM org_memberships WHERE "orgId" = $1 AND "userId" = $2`, [B, U])).toBe(
        true,
      );
      await locker.query("COMMIT");
      expect(await deleting.settled).toBe(1);
    });
  });
});
