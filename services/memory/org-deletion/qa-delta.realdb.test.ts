// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Attacks on the org deletion's fixes, on the same harness as
// clerk-events.realdb.test.ts: the 60 s window to the millisecond, a promotion after
// Clerk's deletion, the admin departures (scope, cascade, cancel), the lookup, and day 7's
// Clerk organization step for the wrong org or a cancelled deletion. Each test names the
// claim it attacks.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Webhook } from "svix";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { seedMember } from "@/services/access/member.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const blobs = vi.hoisted(() => new Map<string, { pathname: string; body: string }>());
const session = vi.hoisted(() => ({ clerkId: null as string | null, orgId: null as string | null }));
/** Clerk's organizations: the ids that exist, every delete asked for, and a hook run on each. */
const clerkOrgs = vi.hoisted(() => ({
  existing: new Set<string>(),
  deletes: [] as string[],
  onDelete: null as null | ((id: string) => Promise<void>),
}));

vi.mock("@/lib/blob-storage", () => {
  let n = 0;
  return {
    putPrivateBlob: async (pathname: string, body: unknown) => {
      const url = `https://blob.test/${pathname}-${(n += 1)}`;
      blobs.set(url, {
        pathname,
        body: body instanceof ReadableStream ? await new Response(body).text() : String(body),
      });
      return { url };
    },
    deletePrivateBlob: async (url: string) => {
      blobs.delete(url);
    },
    readPrivateBlob: async (url: string) => {
      const blob = blobs.get(url);
      return blob ? new Response(blob.body).body : null;
    },
    listPrivateBlobs: async (prefix: string) =>
      [...blobs.entries()]
        .filter(([, b]) => b.pathname.startsWith(prefix))
        .map(([url, b]) => ({ url, pathname: b.pathname, size: b.body.length, uploadedAt: new Date() })),
  };
});
vi.mock("@/services/memory/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory/store")>()),
  graphitiStore: {
    purgeOrg: async () => ({ nodes: 0, relationships: 0 }),
    orgResidue: async () => ({ nodes: 0, relationships: 0 }),
  },
}));
vi.mock("@clerk/nextjs/server", async () => {
  const { ClerkAPIResponseError } = await import("@clerk/nextjs/errors");
  return {
    auth: async () => ({ userId: session.clerkId, orgId: session.orgId ? `clerk_org_${session.orgId}` : null }),
    clerkClient: async () => ({
      organizations: {
        deleteOrganization: async (id: string) => {
          clerkOrgs.deletes.push(id);
          if (!clerkOrgs.existing.delete(id)) throw new ClerkAPIResponseError("Not Found", { data: [], status: 404 });
          if (clerkOrgs.onDelete) await clerkOrgs.onDelete(id);
          return { id };
        },
      },
    }),
  };
});
vi.mock("@/lib/inngest/org-deletion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/inngest/org-deletion")>()),
  queueFinalExport: async () => {},
}));
vi.mock("@/lib/access-context", () => ({
  requireAccessContext: async () => {
    const { db } = await import("@/lib/db");
    const { liveMembership } = await import("@/services/access");
    if (!session.clerkId || !session.orgId) return null;
    const org = await db.org.findUnique({ where: { id: session.orgId } });
    const user = await db.user.findUnique({ where: { clerkId: session.clerkId } });
    if (!org || !user) return null;
    const membership = await liveMembership(org.id, user.id);
    if (!membership) return null;
    return {
      org,
      user: { ...user, role: membership.role },
      ctx: { orgId: org.id, actor: { type: "human", id: user.id, role: membership.role }, origin: "app" },
    };
  },
}));

const A = "qadla";
const B = "qadlb";
const ADMIN_A = "u-qad-admin-a";
const ADMIN_A2 = "u-qad-admin-a2";
const MEMBER_A = "u-qad-member-a";
const ADMIN_B = "u-qad-admin-b";
const PEOPLE = [ADMIN_A, ADMIN_A2, MEMBER_A, ADMIN_B];
const clerk = (userId: string) => `clerk_${userId}`;
const MINUTE = 60_000;
const DAY = 86_400_000;
const SECRET = `whsec_${Buffer.from("willder-test-signing-key-0123456789").toString("base64")}`;

describe.skipIf(!QA_URL)(
  "QA delta: org deletion recipients, departures, lookup, Clerk step",
  { timeout: 60_000 },
  () => {
    let db: PrismaClient;
    let svc: typeof import("./request");
    let run: typeof import("./run");
    let exp: typeof import("./final-export");
    let orgRoute: typeof import("@/app/api/org-deletion/route");
    let mineRoute: typeof import("@/app/api/org-deletion/mine/route");
    let viewRoute: typeof import("@/app/api/org-deletion/[id]/route");
    let cancelRoute: typeof import("@/app/api/org-deletion/[id]/cancel/route");
    let exportRoute: typeof import("@/app/api/org-deletion/[id]/export/route");
    let webhook: typeof import("@/app/api/webhooks/clerk/route");

    const params = (id: string) => ({ params: Promise.resolve({ id }) });
    const signIn = (userId: string | null, orgId: string | null = null) => {
      session.clerkId = userId ? clerk(userId) : null;
      session.orgId = orgId;
    };
    const download = (id: string) => exportRoute.GET(new Request("http://localhost"), params(id));
    const view = (id: string) => viewRoute.GET(new Request("http://localhost"), params(id));
    const cancelReq = (id: string) => cancelRoute.POST(new Request("http://localhost", { method: "POST" }), params(id));
    const mine = async () => {
      const res = await mineRoute.GET();
      return { status: res.status, body: await res.json() };
    };
    const recipients = async (orgId = A) =>
      (await db.orgDeletion.findFirstOrThrow({ where: { orgId } })).recipientClerkIds;

    async function reset() {
      await db.org.deleteMany({ where: { id: { in: [A, B] } } });
      await db.user.deleteMany({ where: { id: { in: PEOPLE } } });
      await db.orgDeletion.deleteMany({ where: { orgId: { in: [A, B] } } });
      blobs.clear();
      clerkOrgs.existing = new Set([`clerk_org_${A}`, `clerk_org_${B}`]);
      clerkOrgs.deletes = [];
      clerkOrgs.onDelete = null;
    }

    async function seedOrg(orgId: string, admin: string) {
      await db.org.create({ data: { id: orgId, name: `Org ${orgId}`, clerkOrgId: `clerk_org_${orgId}` } });
      const root = await db.scope.create({ data: { orgId, path: `org_${orgId}`, name: "root" } });
      await db.grant.create({
        data: { orgId, scopeId: root.id, granteeType: "role", granteeId: "admin", permission: "admin" },
      });
      await seedMember(db, { orgId, userId: admin, role: "admin" });
      await db.$executeRaw`
      INSERT INTO memory_chunks (id, "orgId", content, source, "actorType", "actorId", "scopePath", "factVersion")
      VALUES (${`${orgId}-fact`}, ${orgId}, 'Renewal is in March.', 'text', 'agent', 'agent-1', ${`org_${orgId}`}, true)`;
    }

    /** An owner's request through the route, as `admin` with the org open. */
    async function ownerRequest(orgId: string, admin: string): Promise<string> {
      signIn(admin, orgId);
      const res = await orgRoute.POST(
        new Request("http://localhost", { method: "POST", body: JSON.stringify({ confirm: `Org ${orgId}` }) }),
      );
      expect(res.status).toBe(202);
      return (await res.json()).deletion.id as string;
    }

    /** Deliver one signed Clerk event, as Svix would. */
    async function deliver(svixId: string, payload: unknown) {
      vi.stubEnv("CLERK_WEBHOOK_SECRET", SECRET);
      vi.stubEnv("CLERK_WEBHOOK_SECRET_2", "");
      const body = JSON.stringify(payload);
      const sent = new Date();
      const res = await webhook.POST(
        new Request("http://localhost/api/webhooks/clerk", {
          method: "POST",
          headers: {
            "svix-id": svixId,
            "svix-timestamp": String(Math.floor(sent.getTime() / 1000)),
            "svix-signature": new Webhook(SECRET).sign(svixId, sent, body),
          },
          body,
        }),
      );
      vi.unstubAllEnvs();
      return res.status;
    }
    const orgDeleted = (orgId: string, timestamp: number) => ({
      type: "organization.deleted",
      timestamp,
      data: { id: `clerk_org_${orgId}`, deleted: true },
    });
    const membership = (
      type: "deleted" | "updated",
      orgId: string,
      userId: string,
      timestamp: number,
      role = "org:admin",
    ) => ({
      type: `organizationMembership.${type}`,
      timestamp,
      data: {
        id: `orgmem_${orgId}_${userId}`,
        role,
        organization: { id: `clerk_org_${orgId}`, name: `Org ${orgId}` },
        public_user_data: { user_id: clerk(userId), identifier: `${userId}@member.test` },
      },
    });

    beforeAll(async () => {
      process.env.DATABASE_URL = QA_URL;
      db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
      svc = await import("./request");
      run = await import("./run");
      exp = await import("./final-export");
      orgRoute = await import("@/app/api/org-deletion/route");
      mineRoute = await import("@/app/api/org-deletion/mine/route");
      viewRoute = await import("@/app/api/org-deletion/[id]/route");
      cancelRoute = await import("@/app/api/org-deletion/[id]/cancel/route");
      exportRoute = await import("@/app/api/org-deletion/[id]/export/route");
      webhook = await import("@/app/api/webhooks/clerk/route");
    });

    beforeEach(async () => {
      vi.useRealTimers();
      await reset();
    });

    afterAll(async () => {
      await reset();
      await db.$disconnect();
    });

    // --- The 60 s window, to the millisecond (DPA s10: "ended in the minute before the request").

    it("claim: an admin whose role ended exactly 60 s before Clerk's deletion is a recipient, 60.001 s is not, through either record", async () => {
      await seedOrg(A, ADMIN_A);
      await seedOrg(B, ADMIN_B);
      // ADMIN_A2 also belongs to B, so their row survives and the tombstone is read;
      // MEMBER_A belongs only to A, so their row goes and the departure is read.
      await seedMember(db, { orgId: A, userId: ADMIN_A2, role: "admin" });
      await seedMember(db, { orgId: B, userId: ADMIN_A2, role: "member" });
      await seedMember(db, { orgId: A, userId: MEMBER_A, role: "admin" });
      const deletedAt = Date.now();
      expect(await deliver("msg_edge_t", membership("deleted", A, ADMIN_A2, deletedAt - 60_000))).toBe(200);
      expect(await deliver("msg_edge_d", membership("deleted", A, MEMBER_A, deletedAt - 60_000))).toBe(200);
      expect(await db.user.count({ where: { id: MEMBER_A } })).toBe(0);
      expect(await db.orgAdminDeparture.count({ where: { orgId: A, clerkUserId: clerk(MEMBER_A) } })).toBe(1);
      expect(await deliver("msg_edge_del", orgDeleted(A, deletedAt))).toBe(200);
      expect(await recipients()).toEqual([clerk(ADMIN_A), clerk(ADMIN_A2), clerk(MEMBER_A)].sort());
    });

    it("claim: one millisecond earlier than the minute is before the deletion, for the tombstone and for the departure", async () => {
      await seedOrg(A, ADMIN_A);
      await seedOrg(B, ADMIN_B);
      await seedMember(db, { orgId: A, userId: ADMIN_A2, role: "admin" });
      await seedMember(db, { orgId: B, userId: ADMIN_A2, role: "member" });
      await seedMember(db, { orgId: A, userId: MEMBER_A, role: "admin" });
      const deletedAt = Date.now();
      expect(await deliver("msg_edge_t", membership("deleted", A, ADMIN_A2, deletedAt - 60_001))).toBe(200);
      expect(await deliver("msg_edge_d", membership("deleted", A, MEMBER_A, deletedAt - 60_001))).toBe(200);
      expect(await deliver("msg_edge_del", orgDeleted(A, deletedAt))).toBe(200);
      expect(await recipients()).toEqual([clerk(ADMIN_A)]);
    });

    it("claim: the same boundary holds when the removal is delivered after organization.deleted", async () => {
      await seedOrg(A, ADMIN_A);
      await seedMember(db, { orgId: A, userId: ADMIN_A2, role: "admin" });
      await seedMember(db, { orgId: A, userId: MEMBER_A, role: "admin" });
      const deletedAt = Date.now();
      expect(await deliver("msg_edge_del", orgDeleted(A, deletedAt))).toBe(200);
      expect(await deliver("msg_edge_in", membership("deleted", A, ADMIN_A2, deletedAt - 60_000))).toBe(200);
      expect(await deliver("msg_edge_out", membership("deleted", A, MEMBER_A, deletedAt - 60_001))).toBe(200);
      expect(await recipients()).toEqual([clerk(ADMIN_A), clerk(ADMIN_A2)].sort());
      // Both rows stay for the window (the org is being deleted).
      expect(await db.user.count({ where: { id: { in: [ADMIN_A2, MEMBER_A] } } })).toBe(2);
    });

    // --- A promotion after Clerk's deletion.

    it("claim: a member promoted after Clerk deleted the org gets no export, no lookup entry and no cancel", async () => {
      await seedOrg(A, ADMIN_A);
      await seedMember(db, { orgId: A, userId: MEMBER_A, role: "member" });
      const deletedAt = Date.now();
      expect(await deliver("msg_p_del", orgDeleted(A, deletedAt))).toBe(200);
      const id = (await db.orgDeletion.findFirstOrThrow({ where: { orgId: A } })).id;
      await exp.produceFinalExport(id);
      expect(await deliver("msg_p_up", membership("updated", A, MEMBER_A, deletedAt + 5_000, "org:admin"))).toBe(200);
      expect(await recipients()).toEqual([clerk(ADMIN_A)]);
      signIn(MEMBER_A);
      expect((await download(id)).status).toBe(404);
      expect((await mine()).body).toEqual({ deletions: [] });
      expect((await cancelReq(id)).status).toBe(409);
      // Still an admin in Willder's records, so the deletion is visible by id, as the API doc says
      // ("the org's current owners and admins"); its receipt is not, once the org is gone.
      expect((await view(id)).status).toBe(200);
      await run.runOrgDeletion(id, new Date(Date.now() + 8 * DAY));
      expect((await view(id)).status).toBe(404);
      signIn(ADMIN_A);
      expect((await view(id)).status).toBe(200);
    });

    // --- Admin departures.

    it("claim: a departure is recorded only for owners and admins, at Clerk's time, and is never read for another org", async () => {
      await seedOrg(A, ADMIN_A);
      await seedOrg(B, ADMIN_B);
      await seedMember(db, { orgId: B, userId: MEMBER_A, role: "member" });
      const removedAt = Date.now() - 5_000;
      // ADMIN_B leaves B (their only org); MEMBER_A, a plain member, leaves B too.
      expect(await deliver("msg_dep_b", membership("deleted", B, ADMIN_B, removedAt))).toBe(200);
      expect(await deliver("msg_dep_m", membership("deleted", B, MEMBER_A, removedAt, "org:member"))).toBe(200);
      const deps = await db.orgAdminDeparture.findMany({ where: { orgId: { in: [A, B] } } });
      expect(
        deps.map((d) => ({ orgId: d.orgId, clerkUserId: d.clerkUserId, removedAt: d.removedAt.getTime() })),
      ).toEqual([{ orgId: B, clerkUserId: clerk(ADMIN_B), removedAt }]);
      // Clerk deletes A seconds later: B's departed admin is not one of A's recipients.
      expect(await deliver("msg_dep_del", orgDeleted(A, Date.now()))).toBe(200);
      expect(await recipients(A)).toEqual([clerk(ADMIN_A)]);
      signIn(ADMIN_B);
      expect((await mine()).body).toEqual({ deletions: [] });
    });

    it("claim: an org's departures go with the org, and leave no trace in the receipt's readers", async () => {
      await seedOrg(A, ADMIN_A);
      await seedMember(db, { orgId: A, userId: ADMIN_A2, role: "admin" });
      expect(await deliver("msg_dep_a2", membership("deleted", A, ADMIN_A2, Date.now() - 10 * MINUTE))).toBe(200);
      expect(await db.orgAdminDeparture.count({ where: { orgId: A } })).toBe(1);
      const id = await ownerRequest(A, ADMIN_A);
      const done = await run.runOrgDeletion(id, new Date(Date.now() + 8 * DAY));
      expect(done?.status).toBe("deleted");
      expect(await db.orgAdminDeparture.count({ where: { orgId: A } })).toBe(0);
      expect(done?.recipientClerkIds).toEqual([clerk(ADMIN_A)]);
    });

    // DPA s10 last bullet: "When an owner or admin's last membership ends, Willder keeps their
    // sign-in identifier and the time they left for three days, so that a deletion at the
    // sign-in provider made at the same time still lets them download the final export."
    it("claim: a cancel landing between Clerk's membership events and its organization.deleted keeps Clerk's admins as recipients", async () => {
      // Clerk deletes A at T while A's owner cancels the in-app deletion. Clerk's
      // membership.deleted for ADMIN_A2 (A is their only org) is delivered first, the cancel
      // commits, then organization.deleted arrives. ADMIN_A2 was an admin at T.
      await seedOrg(A, ADMIN_A);
      await seedMember(db, { orgId: A, userId: ADMIN_A2, role: "admin" });
      const id = await ownerRequest(A, ADMIN_A);
      const deletedAt = Date.now();
      expect(await deliver("msg_c_rm", membership("deleted", A, ADMIN_A2, deletedAt))).toBe(200);
      signIn(ADMIN_A, A);
      expect((await cancelReq(id)).status).toBe(200);
      // The cancel deleted the row the window had kept, and with it the admin tombstone.
      expect(await db.user.count({ where: { id: ADMIN_A2 } })).toBe(0);
      expect(await deliver("msg_c_del", orgDeleted(A, deletedAt))).toBe(200);
      const open = await db.orgDeletion.findFirstOrThrow({ where: { orgId: A, status: "pending" } });
      expect(open.recipientClerkIds).toEqual([clerk(ADMIN_A), clerk(ADMIN_A2)].sort());
    });

    // --- The trigger's one exception.

    it("claim: the account exception never lets a row in, nor changes a row that has no owner", async () => {
      await seedOrg(A, ADMIN_A);
      const ownerless = await db.account.create({ data: { orgId: A, name: "Ownerless" } });
      await ownerRequest(A, ADMIN_A);
      await expect(
        db.$executeRaw`INSERT INTO accounts (id, "orgId", name, "ownerId", "createdAt", "updatedAt") VALUES ('qa-acc-new', ${A}, 'New', NULL, now(), now())`,
      ).rejects.toThrow(/being deleted/);
      await expect(
        db.$executeRaw`UPDATE accounts SET "ownerId" = NULL, name = 'Renamed' WHERE id = ${ownerless.id}`,
      ).rejects.toThrow(/being deleted/);
      // The same exception on a table it does not name changes nothing.
      await expect(
        db.$executeRaw`UPDATE memory_chunks SET content = 'changed' WHERE id = ${`${A}-fact`}`,
      ).rejects.toThrow(/being deleted/);
      // Prisma's own update stamps updatedAt, so even an owner-only change through the client is refused.
      await seedMember(db, { orgId: A, userId: MEMBER_A, role: "member" });
      const owned = await db.$transaction(async (tx) => {
        await tx.$executeRaw`ALTER TABLE accounts DISABLE TRIGGER "org_deletion_refuse_write"`;
        const row = await tx.account.create({ data: { orgId: A, name: "Owned", ownerId: MEMBER_A } });
        await tx.$executeRaw`ALTER TABLE accounts ENABLE TRIGGER "org_deletion_refuse_write"`;
        return row;
      });
      await expect(db.account.update({ where: { id: owned.id }, data: { ownerId: null } })).rejects.toThrow(
        /being deleted/,
      );
    });

    // --- Day 7's Clerk step.

    it("claim: day 7 deletes only the deleted org's Clerk organization, though another org's deletion is open, and a cancelled run makes no call", async () => {
      await seedOrg(A, ADMIN_A);
      await seedOrg(B, ADMIN_B);
      const idA = await ownerRequest(A, ADMIN_A);
      // B's deletion opens two days later, so it is not due when A's is.
      const idB = (await svc.startOrgDeletion(
        { trigger: "owner", orgId: B, requestedBy: ADMIN_B, requesterClerkId: clerk(ADMIN_B) },
        new Date(Date.now() + 2 * DAY),
      ))!.deletion.id;
      const result = await run.sweepOrgDeletions(new Date(Date.now() + 7 * DAY + MINUTE));
      expect(result.deleted).toEqual([idA]);
      expect(clerkOrgs.deletes).toEqual([`clerk_org_${A}`]);
      expect(clerkOrgs.existing.has(`clerk_org_${B}`)).toBe(true);
      // B is cancelled; running it by hand, even past its date, claims nothing and calls nothing.
      signIn(ADMIN_B, B);
      expect((await cancelReq(idB)).status).toBe(200);
      expect(await run.runOrgDeletion(idB, new Date(Date.now() + 30 * DAY))).toBeNull();
      expect(clerkOrgs.deletes).toEqual([`clerk_org_${A}`]);
      expect(await db.org.count({ where: { id: B } })).toBe(1);
    });

    it("claim: Clerk's event arriving while day 7 runs (after the claim) does not stop the Clerk step, and the step's 404 finishes it", async () => {
      await seedOrg(A, ADMIN_A);
      const id = await ownerRequest(A, ADMIN_A);
      // The graph purge is where day 7 spends its time: Clerk's own deletion lands in it.
      const day8 = new Date(Date.now() + 8 * DAY);
      const claimed = await db.orgDeletion.updateMany({ where: { id }, data: { status: "deleting" } });
      expect(claimed.count).toBe(1);
      clerkOrgs.existing.delete(`clerk_org_${A}`);
      expect(await deliver("msg_mid_del", orgDeleted(A, Date.now()))).toBe(200);
      expect((await db.orgDeletion.findUniqueOrThrow({ where: { id } })).clerkEventId).toBeNull();
      expect((await run.runOrgDeletion(id, day8))?.status).toBe("deleted");
      expect(clerkOrgs.deletes).toEqual([`clerk_org_${A}`]);
      expect(await db.orgDeletion.count({ where: { orgId: A } })).toBe(1);
    });

    // --- The lookup.

    it("claim: the lookup never names a removed requester once the job has fixed the list, and lists nothing for a Clerk id differing in case", async () => {
      await seedOrg(A, ADMIN_A);
      await seedMember(db, { orgId: A, userId: ADMIN_A2, role: "admin" });
      const id = await ownerRequest(A, ADMIN_A);
      session.clerkId = clerk(ADMIN_A).toUpperCase();
      expect((await mine()).body).toEqual({ deletions: [] });
      expect(await deliver("msg_l_rm", membership("deleted", A, ADMIN_A, Date.now()))).toBe(200);
      signIn(ADMIN_A);
      // Before the job: listed, readable, no export link.
      const before = await mine();
      expect(before.body.deletions).toHaveLength(1);
      expect(before.body.deletions[0].links.export).toBeNull();
      await run.runOrgDeletion(id, new Date(Date.now() + 8 * DAY));
      expect((await mine()).body).toEqual({ deletions: [] });
      expect((await view(id)).status).toBe(404);
    });
  },
);
