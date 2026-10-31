// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// An org deletion and Clerk, through the real routes and the signed Clerk webhook. Who
// receives the final export and receipt, with Clerk's membership events in either order:
// the recipients are recorded when each trigger happens and never widened, membership
// changes during the window are recorded without touching the frozen tables, and a
// recipient finds the deletion with no org. And day 7 deleting the Clerk organization.
// Doubles stand in for the session, Clerk's API, Blob storage, the graph service and
// Inngest's send.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Webhook } from "svix";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { seedMember } from "@/services/access/member.testsupport";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

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

const A = "rcpdela";
const B = "rcpdelb";
const ADMIN_A = "u-rcp-admin-a";
const ADMIN_A2 = "u-rcp-admin-a2";
const MEMBER_A = "u-rcp-member-a";
const ADMIN_B = "u-rcp-admin-b";
const PEOPLE = [ADMIN_A, ADMIN_A2, MEMBER_A, ADMIN_B];
const clerk = (userId: string) => `clerk_${userId}`;
const MINUTE = 60_000;
const DAY = 86_400_000;
const SECRET = `whsec_${Buffer.from("willder-test-signing-key-0123456789").toString("base64")}`;

describe.skipIf(!QA_URL)("org deletion recipients", { timeout: 60_000 }, () => {
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
    await deleteOrgsWithRetry(db, { where: { id: { in: [A, B] } } });
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

  // --- Recorded at the trigger, never widened.

  it("a requester Clerk demoted before it deleted the org is not a recipient; the admin of that moment is", async () => {
    await seedOrg(A, ADMIN_A);
    await seedMember(db, { orgId: A, userId: ADMIN_A2, role: "admin" });
    const id = await ownerRequest(A, ADMIN_A);
    await exp.produceFinalExport(id);
    const deletedAt = Date.now();
    expect(await deliver("msg_demote", membership("updated", A, ADMIN_A, deletedAt - 60 * MINUTE, "org:member"))).toBe(
      200,
    );
    expect(await deliver("msg_del", orgDeleted(A, deletedAt))).toBe(200);
    expect(await recipients()).toEqual([clerk(ADMIN_A2)]);
    signIn(ADMIN_A);
    expect((await download(id)).status).toBe(404);
    expect((await view(id)).status).toBe(404);
    expect((await mine()).body).toEqual({ deletions: [] });
    signIn(ADMIN_A2);
    expect((await download(id)).status).toBe(200);
  });

  it("a removal Clerk sent before its deletion but delivered after it takes that admin off; one within the skew does not", async () => {
    await seedOrg(A, ADMIN_A);
    await seedMember(db, { orgId: A, userId: ADMIN_A2, role: "admin" });
    await seedMember(db, { orgId: A, userId: MEMBER_A, role: "admin" });
    const deletedAt = Date.now();
    expect(await deliver("msg_del", orgDeleted(A, deletedAt))).toBe(200);
    expect(await recipients()).toEqual([clerk(ADMIN_A), clerk(ADMIN_A2), clerk(MEMBER_A)].sort());
    const id = (await db.orgDeletion.findFirstOrThrow({ where: { orgId: A } })).id;
    await exp.produceFinalExport(id);

    // Removed an hour before the deletion, delivered late: never a recipient.
    expect(await deliver("msg_rm_late", membership("deleted", A, ADMIN_A2, deletedAt - 60 * MINUTE))).toBe(200);
    // Ended by Clerk's own deletion, 30 s before its event: still one.
    expect(await deliver("msg_rm_skew", membership("deleted", A, MEMBER_A, deletedAt - 30_000))).toBe(200);
    expect(await recipients()).toEqual([clerk(ADMIN_A), clerk(MEMBER_A)].sort());
    signIn(ADMIN_A2);
    expect((await download(id)).status).toBe(404);
    signIn(MEMBER_A);
    expect((await download(id)).status).toBe(200);

    // A second organization.deleted under a new id, and a re-add, widen nothing.
    expect(await deliver("msg_del_again", orgDeleted(A, Date.now()))).toBe(200);
    expect(await deliver("msg_readd", membership("updated", A, ADMIN_A2, Date.now()))).toBe(200);
    expect(await recipients()).toEqual([clerk(ADMIN_A), clerk(MEMBER_A)].sort());
    expect((await db.orgDeletion.findUniqueOrThrow({ where: { id } })).clerkDeletedAt).toEqual(new Date(deletedAt));
  });

  it("organization.deleted racing an earlier removal never makes the removed admin a recipient", async () => {
    for (let round = 0; round < 6; round += 1) {
      await reset();
      await seedOrg(A, ADMIN_A);
      await seedMember(db, { orgId: A, userId: ADMIN_A2, role: "admin" });
      const deletedAt = Date.now();
      const statuses = await Promise.all([
        deliver(`msg_race_del_${round}`, orgDeleted(A, deletedAt)),
        deliver(`msg_race_rm_${round}`, membership("deleted", A, ADMIN_A2, deletedAt - 60 * MINUTE)),
      ]);
      expect(statuses).toEqual([200, 200]);
      expect(await recipients()).toEqual([clerk(ADMIN_A)]);
    }
  });

  // --- Clerk's membership events before organization.deleted.

  it("an admin whose row went with their last membership is still a recipient, finds the deletion with no org and downloads it", async () => {
    await seedOrg(A, ADMIN_A);
    await seedMember(db, { orgId: A, userId: ADMIN_A2, role: "admin" });
    await seedMember(db, { orgId: A, userId: MEMBER_A, role: "member" });
    const deletedAt = Date.now();
    expect(await deliver("msg_rm_a", membership("deleted", A, ADMIN_A, deletedAt - 1_000))).toBe(200);
    // Two minutes before the deletion is before it: not Clerk's own ending.
    expect(await deliver("msg_rm_a2", membership("deleted", A, ADMIN_A2, deletedAt - 2 * MINUTE))).toBe(200);
    expect(await deliver("msg_rm_m", membership("deleted", A, MEMBER_A, deletedAt - 1_000, "org:member"))).toBe(200);
    // No deletion was open, so their rows went; only the admins' departures are kept.
    expect(await db.user.count({ where: { id: { in: [ADMIN_A, ADMIN_A2, MEMBER_A] } } })).toBe(0);
    expect(
      (await db.orgAdminDeparture.findMany({ where: { orgId: A }, orderBy: { clerkUserId: "asc" } })).map(
        (d) => d.clerkUserId,
      ),
    ).toEqual([clerk(ADMIN_A), clerk(ADMIN_A2)].sort());

    expect(await deliver("msg_del", orgDeleted(A, deletedAt))).toBe(200);
    expect(await recipients()).toEqual([clerk(ADMIN_A)]);
    const id = (await db.orgDeletion.findFirstOrThrow({ where: { orgId: A } })).id;
    await exp.produceFinalExport(id);

    signIn(ADMIN_A);
    const listed = await mine();
    expect(listed.status).toBe(200);
    expect(listed.body.deletions).toHaveLength(1);
    expect(listed.body.deletions[0]).toMatchObject({
      deletion: { id, trigger: "clerk", status: "pending", finalExport: { ready: true } },
      links: { deletion: `/api/org-deletion/${id}`, export: `/api/org-deletion/${id}/export` },
    });
    expect((await download(id)).status).toBe(200);
    signIn(ADMIN_A2);
    expect((await download(id)).status).toBe(404);
    expect((await mine()).body).toEqual({ deletions: [] });
  });

  it("an admin departure is kept three days and then pruned by the sweep", async () => {
    await seedOrg(A, ADMIN_A);
    const removedAt = Date.now();
    expect(await deliver("msg_rm", membership("deleted", A, ADMIN_A, removedAt))).toBe(200);
    expect(await db.orgAdminDeparture.count({ where: { orgId: A } })).toBe(1);
    await run.sweepOrgDeletions(new Date(removedAt + 3 * DAY - 1_000));
    expect(await db.orgAdminDeparture.count({ where: { orgId: A } })).toBe(1);
    expect(
      (await run.sweepOrgDeletions(new Date(removedAt + 3 * DAY + 1_000))).departuresPruned,
    ).toBeGreaterThanOrEqual(1);
    expect(await db.orgAdminDeparture.count({ where: { orgId: A } })).toBe(0);
  });

  // --- Membership changes during the window.

  it("removing a person who owns an account during the window is recorded; a cancel then removes their row as the removal would have", async () => {
    await seedOrg(A, ADMIN_A);
    await seedMember(db, { orgId: A, userId: MEMBER_A, role: "member" });
    const account = await db.account.create({ data: { orgId: A, name: "Acme", ownerId: MEMBER_A } });
    const id = await ownerRequest(A, ADMIN_A);
    expect(await deliver("msg_rm", membership("deleted", A, MEMBER_A, Date.now(), "org:member"))).toBe(200);
    expect(await db.orgMembership.count({ where: { orgId: A, userId: MEMBER_A, removedAt: null } })).toBe(0);
    // Kept while the org is frozen: deleting it would blank the account's owner.
    expect(await db.user.count({ where: { id: MEMBER_A } })).toBe(1);
    expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).ownerId).toBe(MEMBER_A);

    signIn(ADMIN_A);
    expect((await cancelRoute.POST(new Request("http://localhost", { method: "POST" }), params(id))).status).toBe(200);
    expect(await db.user.count({ where: { id: MEMBER_A } })).toBe(0);
    expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).ownerId).toBeNull();
    expect(await db.user.count({ where: { id: ADMIN_A } })).toBe(1);
  });

  it("a person who also belongs to B, removed from A during A's window, moves to B; one left with no org goes with A", async () => {
    await seedOrg(B, ADMIN_B);
    await seedOrg(A, ADMIN_A);
    await seedMember(db, { orgId: A, userId: MEMBER_A, role: "member" });
    await seedMember(db, { orgId: B, userId: MEMBER_A, role: "member" });
    await seedMember(db, { orgId: A, userId: ADMIN_A2, role: "admin" });
    await db.account.create({ data: { orgId: A, name: "Acme", ownerId: ADMIN_A2 } });
    const id = await ownerRequest(A, ADMIN_A);
    expect(await deliver("msg_rm_m", membership("deleted", A, MEMBER_A, Date.now(), "org:member"))).toBe(200);
    expect(await deliver("msg_rm_a2", membership("deleted", A, ADMIN_A2, Date.now()))).toBe(200);
    expect((await db.user.findUniqueOrThrow({ where: { id: MEMBER_A } })).orgId).toBe(B);
    expect(await db.user.count({ where: { id: ADMIN_A2 } })).toBe(1);

    expect((await run.runOrgDeletion(id, new Date(Date.now() + 8 * DAY)))?.status).toBe("deleted");
    expect(await db.user.count({ where: { id: ADMIN_A2 } })).toBe(0);
    expect(await db.orgMembership.count({ where: { orgId: B, userId: MEMBER_A, removedAt: null } })).toBe(1);
  });

  // --- The receipt.

  it("the receipt's readers are the recipients still entitled when the job clears the org, and the row keeps only what the DPA lists", async () => {
    await seedOrg(A, ADMIN_A);
    await seedMember(db, { orgId: A, userId: ADMIN_A2, role: "admin" });
    const id = await ownerRequest(A, ADMIN_A);
    await exp.produceFinalExport(id);
    await db.orgDeletion.update({ where: { id }, data: { exportError: "an earlier attempt failed" } });
    signIn(ADMIN_A);
    expect((await mine()).body.deletions.map((d: { links: { export: string | null } }) => d.links.export)).toEqual([
      `/api/org-deletion/${id}/export`,
    ]);

    // The requester is removed on day 2 (through Clerk): no export, and no receipt afterwards.
    expect(await deliver("msg_rm", membership("deleted", A, ADMIN_A, Date.now()))).toBe(200);
    expect((await download(id)).status).toBe(404);
    expect((await mine()).body.deletions.map((d: { links: { export: string | null } }) => d.links.export)).toEqual([
      null,
    ]);

    const done = await run.runOrgDeletion(id, new Date(Date.now() + 8 * DAY));
    expect(done).toMatchObject({
      status: "deleted",
      recipientClerkIds: [],
      requestedBy: null,
      revokedCapabilityIds: [],
      exportUrl: null,
      exportError: null,
      lastError: null,
    });
    expect(done!.progress).toEqual({});
    expect(done!.recipientsFixedAt).not.toBeNull();
    signIn(ADMIN_A);
    expect((await view(id)).status).toBe(404);
    expect((await mine()).body).toEqual({ deletions: [] });
  });

  it("a requester still an admin at the end reads the receipt through the list after the org is gone", async () => {
    await seedOrg(A, ADMIN_A);
    const id = await ownerRequest(A, ADMIN_A);
    expect((await run.runOrgDeletion(id, new Date(Date.now() + 8 * DAY)))?.recipientClerkIds).toEqual([clerk(ADMIN_A)]);
    expect(await db.org.count({ where: { id: A } })).toBe(0);
    signIn(ADMIN_A);
    const listed = await mine();
    expect(listed.body.deletions).toHaveLength(1);
    expect(listed.body.deletions[0]).toMatchObject({
      deletion: { id, status: "deleted", receipt: { org: { id: A } } },
      links: { export: null },
    });
  });

  // --- The lookup refuses everyone else alike.

  it("the lookup gives everyone it does not name the same empty list, and asks for a sign-in", async () => {
    await seedOrg(A, ADMIN_A);
    await seedOrg(B, ADMIN_B);
    await ownerRequest(A, ADMIN_A);
    signIn(ADMIN_B, B);
    const other = await mine();
    session.clerkId = "clerk_never_seen";
    const stranger = await mine();
    expect(other).toEqual({ status: 200, body: { deletions: [] } });
    expect(stranger).toEqual(other);
    signIn(null);
    expect((await mine()).status).toBe(401);
    // A member of A it does not name is refused too, though their org is being deleted,
    // and so is another admin of A: they can open it by id, but it does not name them.
    await seedMember(db, { orgId: A, userId: MEMBER_A, role: "member" });
    signIn(MEMBER_A, A);
    expect(await mine()).toEqual(other);
    await seedMember(db, { orgId: A, userId: ADMIN_A2, role: "admin" });
    signIn(ADMIN_A2, A);
    expect(await mine()).toEqual(other);
  });

  it("only the deletion's own recipients are listed, though another org's deletion names someone with the same prefix", async () => {
    await seedOrg(A, ADMIN_A);
    await seedOrg(B, ADMIN_B);
    const idA = await ownerRequest(A, ADMIN_A);
    await svc.startOrgDeletion({
      trigger: "owner",
      orgId: B,
      requestedBy: ADMIN_B,
      requesterClerkId: `${clerk(ADMIN_A)}x`,
    });
    signIn(ADMIN_A);
    expect((await mine()).body.deletions.map((d: { deletion: { id: string } }) => d.deletion.id)).toEqual([idA]);
  });
  // --- Day 7 deletes the Clerk organization.

  it("day 7 deletes the Clerk organization of an org deleted in the app, before the org row, once", async () => {
    await seedOrg(A, ADMIN_A);
    await seedOrg(B, ADMIN_B);
    const id = await ownerRequest(A, ADMIN_A);
    clerkOrgs.onDelete = async () => {
      // When Clerk deletes it, Willder's org row is still there to name it.
      expect(await db.org.count({ where: { id: A } })).toBe(1);
    };
    expect((await run.sweepOrgDeletions(new Date(Date.now() + 8 * DAY))).deleted).toEqual([id]);
    expect(clerkOrgs.deletes).toEqual([`clerk_org_${A}`]);
    expect([...clerkOrgs.existing]).toEqual([`clerk_org_${B}`]);
    expect(await db.org.count({ where: { id: A } })).toBe(0);
    await run.sweepOrgDeletions(new Date(Date.now() + 9 * DAY));
    expect(clerkOrgs.deletes).toEqual([`clerk_org_${A}`]);
  });

  it("a Clerk organization already gone counts as deleted", async () => {
    await seedOrg(A, ADMIN_A);
    const id = await ownerRequest(A, ADMIN_A);
    clerkOrgs.existing.clear();
    expect((await run.runOrgDeletion(id, new Date(Date.now() + 8 * DAY)))?.status).toBe("deleted");
    expect(clerkOrgs.deletes).toEqual([`clerk_org_${A}`]);
  });

  it("Clerk failing stops the run before the org row goes; the next run repeats it, also after Clerk did it and the answer was lost", async () => {
    await seedOrg(A, ADMIN_A);
    const id = await ownerRequest(A, ADMIN_A);
    const day8 = new Date(Date.now() + 8 * DAY);
    // A 5xx from Clerk, its organization untouched.
    clerkOrgs.onDelete = async (orgId) => {
      clerkOrgs.existing.add(orgId);
      throw new Error("Clerk 503");
    };
    await expect(run.runOrgDeletion(id, day8)).rejects.toThrow(/Clerk 503/);
    expect(await db.orgDeletion.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: "deleting",
      lastError: "Clerk 503",
    });
    expect(await db.org.count({ where: { id: A } })).toBe(1);
    // Clerk deletes it, and the connection drops before its answer arrives.
    clerkOrgs.onDelete = async () => {
      throw new Error("connection reset after Clerk deleted it");
    };
    await expect(run.runOrgDeletion(id, day8)).rejects.toThrow(/connection reset/);
    expect(await db.org.count({ where: { id: A } })).toBe(1);
    // The next run gets Clerk's 404 and finishes.
    clerkOrgs.onDelete = null;
    expect((await run.runOrgDeletion(id, day8))?.status).toBe("deleted");
    expect(clerkOrgs.deletes).toEqual([`clerk_org_${A}`, `clerk_org_${A}`, `clerk_org_${A}`]);
    expect(clerkOrgs.existing.has(`clerk_org_${A}`)).toBe(false);
  });

  it("a deletion Clerk started or joined makes no Clerk call; a cancelled one never deletes the Clerk organization", async () => {
    await seedOrg(A, ADMIN_A);
    await seedOrg(B, ADMIN_B);
    expect(await deliver("msg_del", orgDeleted(A, Date.now()))).toBe(200);
    const idB = await ownerRequest(B, ADMIN_B);
    signIn(ADMIN_B);
    expect((await cancelRoute.POST(new Request("http://localhost", { method: "POST" }), params(idB))).status).toBe(200);
    const result = await run.sweepOrgDeletions(new Date(Date.now() + 8 * DAY));
    expect(result.deleted).toHaveLength(1);
    expect(clerkOrgs.deletes).toEqual([]);
    expect(await db.org.count({ where: { id: B } })).toBe(1);
    expect(clerkOrgs.existing.has(`clerk_org_${B}`)).toBe(true);
  });

  it("the organization.deleted that day 7's own Clerk call causes changes nothing and starts nothing", async () => {
    await seedOrg(A, ADMIN_A);
    await seedMember(db, { orgId: A, userId: ADMIN_A2, role: "admin" });
    const id = await ownerRequest(A, ADMIN_A);
    clerkOrgs.onDelete = async () => {
      expect(await deliver("msg_own_echo", orgDeleted(A, Date.now()))).toBe(200);
      expect(await deliver("msg_own_rm", membership("deleted", A, ADMIN_A, Date.now()))).toBe(200);
    };
    const done = await run.runOrgDeletion(id, new Date(Date.now() + 8 * DAY));
    expect(done).toMatchObject({ status: "deleted", clerkEventId: null, recipientClerkIds: [clerk(ADMIN_A)] });
    expect(await db.orgDeletion.count({ where: { orgId: A } })).toBe(1);
    // Delivered again after the org row went: still nothing.
    expect(await deliver("msg_own_echo", orgDeleted(A, Date.now()))).toBe(200);
    expect(await db.orgDeletion.count({ where: { orgId: A } })).toBe(1);
  });
  // --- Races and repeats.

  // A cancel and Clerk's organization.deleted at the same moment.
  it("a cancel and organization.deleted at once: the cancel stands and Clerk's event starts a deletion of its own", async () => {
    await seedOrg(A, ADMIN_A);
    const cap = await db.capability.create({
      data: {
        orgId: A,
        agentId: "agent-1",
        tokenHash: `rt-${Date.now()}`,
        scopePath: `org_${A}`,
        permission: "read",
        expiresAt: new Date(Date.now() + 30 * DAY),
        createdBy: "system:test",
      },
    });
    const id = await ownerRequest(A, ADMIN_A);
    expect((await db.orgDeletion.findUniqueOrThrow({ where: { id } })).revokedCapabilityIds).toEqual([cap.id]);

    // Hold the token row so the cancel stops after it has claimed the deletion row.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const locked = new Promise<void>((r) => (held = r));
    const holder = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM capabilities WHERE id = ${cap.id} FOR UPDATE`;
        held();
        await gate;
      },
      { timeout: 20_000 },
    );
    await locked;
    const cancel = svc.cancelOrgDeletion(id, clerk(ADMIN_A));
    await new Promise((r) => setTimeout(r, 400));
    const join = deliver("msg_rt1", orgDeleted(A, Date.now()));
    await new Promise((r) => setTimeout(r, 800));
    release();
    await holder;
    const [cancelled, status] = await Promise.all([cancel, join]);
    expect(cancelled.status).toBe("cancelled");
    expect(status).toBe(200);

    const row = await db.orgDeletion.findUniqueOrThrow({ where: { id } });
    // Clerk's event did not touch the cancelled deletion and started one of its own.
    expect(row).toMatchObject({ status: "cancelled", clerkEventId: null });
    expect(await db.orgDeletion.findFirst({ where: { orgId: A, status: "pending" } })).toMatchObject({
      trigger: "clerk",
      clerkEventId: "msg_rt1",
    });
    // Svix redelivers; it finds that deletion.
    expect(await deliver("msg_rt1", orgDeleted(A, Date.now()))).toBe(200);
    const open = await db.orgDeletion.count({ where: { orgId: A, status: { in: ["pending", "deleting"] } } });
    expect({
      status: row.status,
      clerkEventId: row.clerkEventId,
      open,
      orgExists: await db.org.count({ where: { id: A } }),
    }).toEqual({
      status: "cancelled",
      clerkEventId: null,
      open: 1,
      orgExists: 1,
    });
  });

  // Class 7/11: a removal Clerk sent before the request, delivered during the window.
  it("a removal Clerk asserted before the request but delivered during the window: a cancel still deletes the row", async () => {
    await seedOrg(A, ADMIN_A);
    await seedMember(db, { orgId: A, userId: MEMBER_A, role: "member" });
    const id = await ownerRequest(A, ADMIN_A);
    expect(await deliver("msg_rt2", membership("deleted", A, MEMBER_A, Date.now() - 10 * MINUTE, "org:member"))).toBe(
      200,
    );
    expect(await db.user.count({ where: { id: MEMBER_A } })).toBe(1);
    signIn(ADMIN_A);
    expect((await cancelReq(id)).status).toBe(200);
    expect(await db.orgMembership.count({ where: { userId: MEMBER_A, removedAt: null } })).toBe(0);
    // DPA s10: "...or is cancelled, when it is deleted at once."
    expect(await db.user.count({ where: { id: MEMBER_A } })).toBe(0);
  });

  // Class 10 / claim 3 sibling: the users row's cascade reaching ANOTHER org's frozen account.
  async function homedInAOwnsAccountInB() {
    await seedOrg(A, ADMIN_A);
    await seedOrg(B, ADMIN_B);
    await seedMember(db, { orgId: A, userId: MEMBER_A, role: "member" });
    await seedMember(db, { orgId: B, userId: MEMBER_A, role: "member" });
    expect((await db.user.findUniqueOrThrow({ where: { id: MEMBER_A } })).orgId).toBe(A);
    await db.account.create({ data: { orgId: B, name: "B-Acme", ownerId: MEMBER_A } });
    expect(await deliver("msg_rt3_rmb", membership("deleted", B, MEMBER_A, Date.now() - MINUTE, "org:member"))).toBe(
      200,
    );
    await ownerRequest(B, ADMIN_B);
  }

  it("removing the last membership of a person who owns an account in another org being deleted answers 200", async () => {
    await homedInAOwnsAccountInB();
    const status = await deliver("msg_rt3a", membership("deleted", A, MEMBER_A, Date.now(), "org:member")).catch(
      (e: Error) => e.message,
    );
    expect(status).toBe(200);
  });

  it("cancelling A succeeds while a person who left it owns an account in B, which is being deleted", async () => {
    await homedInAOwnsAccountInB();
    const idA = await ownerRequest(A, ADMIN_A);
    expect(await deliver("msg_rt3b", membership("deleted", A, MEMBER_A, Date.now(), "org:member"))).toBe(200);
    signIn(ADMIN_A);
    const res = await cancelReq(idA).then(
      (r) => r.status,
      (e: Error) => e.message,
    );
    expect(res).toBe(200);
  });

  // Class 2/11: DPA s10 says the receipt is all that is kept.
  it("an org's cancelled deletions go with the org; only the receipt stays", async () => {
    await seedOrg(A, ADMIN_A);
    const first = await ownerRequest(A, ADMIN_A);
    signIn(ADMIN_A);
    expect((await cancelReq(first)).status).toBe(200);
    const second = await ownerRequest(A, ADMIN_A);
    expect((await run.runOrgDeletion(second, new Date(Date.now() + 8 * DAY)))?.status).toBe("deleted");
    expect(await db.org.count({ where: { id: A } })).toBe(0);
    const left = await db.orgDeletion.findMany({
      where: { orgId: A, status: { not: "deleted" } },
      select: { status: true, requestedBy: true, cancelledBy: true },
    });
    expect(left).toEqual([]);
  });

  // Class 2: "in whichever order the events arrive" / "owners and admins at the time of that request".
  it("a promotion delivered after Clerk deleted the org adds no recipient, whenever Clerk asserted it", async () => {
    await seedOrg(A, ADMIN_A);
    await seedMember(db, { orgId: A, userId: MEMBER_A, role: "member" });
    const deletedAt = Date.now();
    expect(await deliver("msg_rt6_del", orgDeleted(A, deletedAt))).toBe(200);
    expect(await deliver("msg_rt6_up", membership("updated", A, MEMBER_A, deletedAt - 10_000, "org:admin"))).toBe(200);
    // Never widened: fail closed rather than hand the export to a late arrival.
    expect(await recipients()).toEqual([clerk(ADMIN_A)]);
  });

  it("while an org is frozen, an account may lose its owner and nothing else", async () => {
    await seedOrg(A, ADMIN_A);
    await seedMember(db, { orgId: A, userId: MEMBER_A, role: "member" });
    const account = await db.account.create({ data: { orgId: A, name: "Acme", ownerId: MEMBER_A } });
    await ownerRequest(A, ADMIN_A);
    await expect(
      db.$executeRaw`UPDATE accounts SET "ownerId" = NULL, name = 'Renamed' WHERE id = ${account.id}`,
    ).rejects.toThrow(/being deleted/);
    await expect(db.$executeRaw`UPDATE accounts SET "ownerId" = ${ADMIN_A} WHERE id = ${account.id}`).rejects.toThrow(
      /being deleted/,
    );
    await expect(db.$executeRaw`UPDATE accounts SET name = 'Renamed' WHERE id = ${account.id}`).rejects.toThrow(
      /being deleted/,
    );
    await db.$executeRaw`UPDATE accounts SET "ownerId" = NULL WHERE id = ${account.id}`;
    expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).ownerId).toBeNull();
    await expect(db.$executeRaw`UPDATE accounts SET "ownerId" = ${ADMIN_A} WHERE id = ${account.id}`).rejects.toThrow(
      /being deleted/,
    );
  });

  // --- Every path that deletes a users row keeps the departures it takes, in any org
  // (deleteUsersWithoutMembership): a removal, a cancel, and day 7's move of people who
  // belong to no other org.

  /** ADMIN_A2: admin of A and of B, their row homed in A. */
  async function adminOfBothHomedInA() {
    await seedOrg(A, ADMIN_A);
    await seedOrg(B, ADMIN_B);
    await seedMember(db, { orgId: A, userId: ADMIN_A2, role: "admin" });
    await seedMember(db, { orgId: B, userId: ADMIN_A2, role: "admin" });
  }
  const departuresOf = async (userId: string) =>
    (await db.orgAdminDeparture.findMany({ where: { clerkUserId: clerk(userId) }, orderBy: { orgId: "asc" } })).map(
      (d) => ({
        orgId: d.orgId,
        removedAt: d.removedAt.getTime(),
      }),
    );

  it("a removal deleting the row keeps the departure of every admin membership it takes, in any org", async () => {
    await adminOfBothHomedInA();
    const t = Date.now();
    expect(await deliver("msg_any_rmb", membership("deleted", B, ADMIN_A2, t - 2_000))).toBe(200);
    // Still in A: the row and its ended membership of B stay.
    expect(await db.user.count({ where: { id: ADMIN_A2 } })).toBe(1);
    expect(await deliver("msg_any_rma", membership("deleted", A, ADMIN_A2, t - 1_000))).toBe(200);
    expect(await db.user.count({ where: { id: ADMIN_A2 } })).toBe(0);
    expect(await departuresOf(ADMIN_A2)).toEqual([
      { orgId: A, removedAt: t - 1_000 },
      { orgId: B, removedAt: t - 2_000 },
    ]);
    expect(await deliver("msg_any_delb", orgDeleted(B, t))).toBe(200);
    expect(await recipients(B)).toEqual([clerk(ADMIN_A2), clerk(ADMIN_B)].sort());
  });

  it("a removal deleting the row while another org it left is being deleted keeps that org's departure", async () => {
    await adminOfBothHomedInA();
    await ownerRequest(A, ADMIN_A);
    const t = Date.now();
    // Leaving A while A is frozen moves the row to B; leaving B then deletes it.
    expect(await deliver("msg_frz_rma", membership("deleted", A, ADMIN_A2, t - 2_000))).toBe(200);
    expect(await deliver("msg_frz_rmb", membership("deleted", B, ADMIN_A2, t - 1_000))).toBe(200);
    expect(await db.user.count({ where: { id: ADMIN_A2 } })).toBe(0);
    expect(await departuresOf(ADMIN_A2)).toEqual([
      { orgId: A, removedAt: t - 2_000 },
      { orgId: B, removedAt: t - 1_000 },
    ]);
    expect(await deliver("msg_frz_dela", orgDeleted(A, t))).toBe(200);
    expect(await recipients(A)).toEqual([clerk(ADMIN_A), clerk(ADMIN_A2)].sort());
  });

  it("a cancel deleting kept rows keeps the departures of their admin memberships in other orgs too", async () => {
    await adminOfBothHomedInA();
    const t = Date.now();
    expect(await deliver("msg_cx_rmb", membership("deleted", B, ADMIN_A2, t - 2_000))).toBe(200);
    const id = await ownerRequest(A, ADMIN_A);
    expect(await deliver("msg_cx_rma", membership("deleted", A, ADMIN_A2, t - 1_000))).toBe(200);
    expect(await db.user.count({ where: { id: ADMIN_A2 } })).toBe(1);
    signIn(ADMIN_A);
    expect((await cancelReq(id)).status).toBe(200);
    expect(await db.user.count({ where: { id: ADMIN_A2 } })).toBe(0);
    expect(await departuresOf(ADMIN_A2)).toEqual([
      { orgId: A, removedAt: t - 1_000 },
      { orgId: B, removedAt: t - 2_000 },
    ]);
    expect(await deliver("msg_cx_delb", orgDeleted(B, t))).toBe(200);
    expect(await recipients(B)).toEqual([clerk(ADMIN_A2), clerk(ADMIN_B)].sort());
  });

  it("a departure is kept for a membership that ended three days before, to the millisecond, and not one earlier", async () => {
    await adminOfBothHomedInA();
    await seedMember(db, { orgId: A, userId: MEMBER_A, role: "admin" });
    await seedMember(db, { orgId: B, userId: MEMBER_A, role: "admin" });
    const now = new Date();
    expect(await deliver("msg_edge3_in", membership("deleted", B, ADMIN_A2, now.getTime() - 3 * DAY))).toBe(200);
    expect(await deliver("msg_edge3_out", membership("deleted", B, MEMBER_A, now.getTime() - 3 * DAY - 1))).toBe(200);
    const id = await ownerRequest(A, ADMIN_A);
    expect(await deliver("msg_edge3_a2", membership("deleted", A, ADMIN_A2, now.getTime() - 1_000))).toBe(200);
    expect(await deliver("msg_edge3_m", membership("deleted", A, MEMBER_A, now.getTime() - 1_000))).toBe(200);
    await svc.cancelOrgDeletion(id, null, now);
    expect(await db.user.count({ where: { id: { in: [ADMIN_A2, MEMBER_A] } } })).toBe(0);
    expect((await departuresOf(ADMIN_A2)).map((d) => d.orgId)).toEqual([A, B]);
    expect((await departuresOf(MEMBER_A)).map((d) => d.orgId)).toEqual([A]);
  });

  it("a cancel keeps the row of a person who joined another org since leaving", async () => {
    await seedOrg(A, ADMIN_A);
    await seedOrg(B, ADMIN_B);
    await seedMember(db, { orgId: A, userId: MEMBER_A, role: "admin" });
    const id = await ownerRequest(A, ADMIN_A);
    expect(await deliver("msg_join_rma", membership("deleted", A, MEMBER_A, Date.now()))).toBe(200);
    await seedMember(db, { orgId: B, userId: MEMBER_A, role: "member" });
    expect((await db.user.findUniqueOrThrow({ where: { id: MEMBER_A } })).orgId).toBe(A);
    signIn(ADMIN_A);
    expect((await cancelReq(id)).status).toBe(200);
    expect(await db.orgMembership.count({ where: { orgId: B, userId: MEMBER_A, removedAt: null } })).toBe(1);
    expect(await db.orgAdminDeparture.count({ where: { clerkUserId: clerk(MEMBER_A) } })).toBe(0);
  });

  it("a departure is updated when the person rejoins and leaves the same org again", async () => {
    await seedOrg(B, ADMIN_B);
    await seedMember(db, { orgId: B, userId: MEMBER_A, role: "admin" });
    const t = Date.now();
    expect(await deliver("msg_again_1", membership("deleted", B, MEMBER_A, t - 10 * MINUTE))).toBe(200);
    await seedMember(db, { orgId: B, userId: MEMBER_A, role: "admin" });
    expect(await deliver("msg_again_2", membership("deleted", B, MEMBER_A, t - MINUTE))).toBe(200);
    expect(await departuresOf(MEMBER_A)).toEqual([{ orgId: B, removedAt: t - MINUTE }]);
  });

  it("day 7 deletes a person homed in the org who belongs to no other org, keeping their departure from the one they left", async () => {
    await adminOfBothHomedInA();
    const id = await ownerRequest(A, ADMIN_A);
    const runAt = Date.now() + 8 * DAY;
    // Left B the minute before day 7 runs, still a member of A: the row stays homed in A.
    expect(await deliver("msg_d7_rmb", membership("deleted", B, ADMIN_A2, runAt - MINUTE))).toBe(200);
    expect((await db.user.findUniqueOrThrow({ where: { id: ADMIN_A2 } })).orgId).toBe(A);
    expect((await run.runOrgDeletion(id, new Date(runAt)))?.status).toBe("deleted");
    // Not left behind in B with no membership.
    expect(await db.user.count({ where: { id: ADMIN_A2 } })).toBe(0);
    expect(await departuresOf(ADMIN_A2)).toEqual([{ orgId: B, removedAt: runAt - MINUTE }]);
    expect(await deliver("msg_d7_delb", orgDeleted(B, runAt))).toBe(200);
    expect(await recipients(B)).toEqual([clerk(ADMIN_A2), clerk(ADMIN_B)].sort());
  });

  it("day 7 deletes a person who owns an account in another org being deleted but belongs to none, and finishes", async () => {
    await seedOrg(A, ADMIN_A);
    await seedOrg(B, ADMIN_B);
    await seedMember(db, { orgId: A, userId: MEMBER_A, role: "member" });
    const account = await db.account.create({ data: { orgId: B, name: "B-Acme", ownerId: MEMBER_A } });
    await ownerRequest(B, ADMIN_B);
    const id = await ownerRequest(A, ADMIN_A);
    expect((await run.runOrgDeletion(id, new Date(Date.now() + 8 * DAY)))?.status).toBe("deleted");
    expect(await db.user.count({ where: { id: MEMBER_A } })).toBe(0);
    expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).ownerId).toBeNull();
  });
});
