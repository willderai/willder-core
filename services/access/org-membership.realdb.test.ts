// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A person can belong to several orgs, and what they may do in one org depends
// only on their membership and role in that org.
//
// The writers are the real ones: ensureTenant() for a signed-in request (Clerk's
// session is mocked, the database is not) and the Clerk webhook route with a real
// svix signature. The reader is the real check() on a capability token, whose
// issuer bound (`access_person_holds`) is where a wrong membership answer shows.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never a live one.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { Webhook } from "svix";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const clerkSession = vi.hoisted(() => ({
  current: null as null | { userId: string; orgId: string; orgRole: string; sessionClaims: { iat: number } },
}));

/** Clerk's server-side view: the signed-in person's profile, and who belongs to
 * which org right now (Clerk org id -> member Clerk user id -> Clerk role). */
const clerkServer = vi.hoisted(() => ({
  currentUser: null as null | {
    id: string;
    firstName: string;
    lastName: null;
    emailAddresses: { emailAddress: string }[];
  },
  members: {} as Record<string, Record<string, string>>,
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => clerkSession.current ?? { userId: null, orgId: null, orgRole: null },
  currentUser: async () => clerkServer.currentUser,
  clerkClient: async () => ({
    organizations: {
      getOrganization: async () => null,
      getOrganizationMembershipList: async ({
        organizationId,
        userId,
      }: {
        organizationId: string;
        userId?: string[];
      }) => ({
        data: Object.entries(clerkServer.members[organizationId] ?? {})
          .filter(([id]) => !userId || userId.includes(id))
          .map(([id, role]) => ({ role, publicUserData: { userId: id } })),
      }),
    },
  }),
}));

/** A step to run between a request's tenant sync and the rest of the request,
 * to stage another request interleaving with it. */
const afterTenantSync = vi.hoisted(() => ({ run: null as null | (() => Promise<void>) }));

vi.mock("@/lib/tenant", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenant")>();
  return {
    ...actual,
    ensureTenant: async () => {
      const org = await actual.ensureTenant();
      const step = afterTenantSync.run;
      afterTenantSync.run = null;
      if (step) await step();
      return org;
    },
  };
});

vi.mock("@/lib/inngest", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  inngest: { send: async () => undefined },
}));

vi.mock("@/services/memory", () => ({
  memory: { ingest: async () => undefined },
}));

type Permission = "read" | "write" | "admin";

/** The tenant sync pulls in the agent runner; a cold import can take seconds. */
const IMPORT_TIMEOUT_MS = 60_000;

const ORG_A = "org-qa-om-a";
const ORG_B = "org-qa-om-b";
const ROOT_A = "org_qa_om_a";
const ROOT_B = "org_qa_om_b";
const CLERK_ORG = { [ORG_A]: "clerk_org_qa_om_a", [ORG_B]: "clerk_org_qa_om_b" } as const;
const ORGS = { in: [ORG_A, ORG_B] };

const SECRET = `whsec_${Buffer.from("willder-org-membership-test-key-01234").toString("base64")}`;

type Person = { id: string; clerkId: string };
const person = (name: string): Person => ({ id: `u-qa-om-${name}`, clerkId: `clerk_user_qa_om_${name}` });

describe.skipIf(!QA_URL)("per-org membership decides access in each org, real Postgres", () => {
  let db: PrismaClient;
  let check: (typeof import("./check"))["check"];
  let hashCapabilityToken: (typeof import("./capabilities"))["hashCapabilityToken"];
  let ensureTenant: (typeof import("@/lib/tenant"))["ensureTenant"];
  let requireAccessContext: (typeof import("@/lib/access-context"))["requireAccessContext"];
  let clerkWebhook: (typeof import("@/app/api/webhooks/clerk/route"))["POST"];
  let seq = 0;

  /** Sign `p` in with `org` as their active Clerk org, as the browser would, and
   * run the tenant sync every signed-in request runs. `issuedAt` is the session
   * token's issue time (default: now). */
  async function signIn(p: Person, orgId: keyof typeof CLERK_ORG, orgRole = "org:admin", issuedAt = new Date()) {
    clerkSession.current = {
      userId: p.clerkId,
      orgId: CLERK_ORG[orgId],
      orgRole,
      sessionClaims: { iat: Math.floor(issuedAt.getTime() / 1000) },
    };
    return ensureTenant();
  }

  /** Deliver a signed Clerk membership event for `p` in `orgId`. */
  async function webhook(
    type: "created" | "updated" | "deleted",
    p: Person,
    orgId: keyof typeof CLERK_ORG,
    opts: { role?: string; at?: Date } = {},
  ) {
    const body = JSON.stringify({
      type: `organizationMembership.${type}`,
      object: "event",
      timestamp: (opts.at ?? new Date()).getTime(),
      data: {
        id: `orgmem_qa_${++seq}`,
        role: opts.role ?? "org:member",
        organization: { id: CLERK_ORG[orgId], name: orgId },
        public_user_data: { user_id: p.clerkId, identifier: `${p.id}@example.test` },
      },
    });
    const id = `msg_qa_om_${seq}`;
    const now = new Date();
    const res = await clerkWebhook(
      new Request("http://localhost/api/webhooks/clerk", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "svix-id": id,
          "svix-timestamp": String(Math.floor(now.getTime() / 1000)),
          "svix-signature": new Webhook(SECRET).sign(id, now, body),
        },
        body,
      }),
    );
    expect(res.status).toBe(200);
  }

  async function createPerson(p: Person, orgId: string, role: "admin" | "member" = "admin") {
    await db.user.create({ data: { id: p.id, orgId, clerkId: p.clerkId, email: `${p.id}@example.test`, role } });
  }

  /** Mint a capability token the way every mint path does: one insert. */
  async function mint(orgId: string, scopePath: string, permission: Permission, createdBy: string) {
    const token = `qa-om-token-${++seq}`;
    const agentId = `agent-qa-om-${seq}`;
    try {
      await db.capability.create({
        data: {
          orgId,
          agentId,
          scopePath,
          permission,
          createdBy,
          tokenHash: hashCapabilityToken(token),
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
      return { ok: true as const, token, agentId };
    } catch (error) {
      return { ok: false as const, error };
    }
  }

  async function mintOrThrow(orgId: string, scopePath: string, permission: Permission, createdBy: string) {
    const result = await mint(orgId, scopePath, permission, createdBy);
    if (!result.ok) throw new Error(`setup: ${createdBy}'s ${permission} mint on ${scopePath} was refused`);
    return result;
  }

  async function tokenReads(orgId: string, t: { token: string; agentId: string }, scope: string) {
    const decision = await check(
      { orgId, actor: { type: "agent", id: t.agentId, capabilityToken: t.token }, origin: "mcp" },
      { action: "memory.read", scope },
    );
    return decision.allowed;
  }

  async function holds(orgId: string, userId: string, needed: Permission, path: string) {
    const rows = await db.$queryRaw<{ holds: boolean }[]>`
      SELECT "access_person_holds"(${orgId}, ${userId}, ${needed}::"Permission", ${path}) AS holds`;
    return rows[0].holds;
  }

  async function reset() {
    await db.auditLog.deleteMany({ where: { orgId: ORGS } });
    await db.capability.deleteMany({ where: { orgId: ORGS } });
    await db.grant.deleteMany({ where: { orgId: ORGS } });
    await db.scope.deleteMany({ where: { orgId: ORGS } });
    await db.user.deleteMany({ where: { OR: [{ orgId: ORGS }, { clerkId: { startsWith: "clerk_user_qa_om_" } }] } });
    await db.agent.deleteMany({ where: { orgId: ORGS } });
    await deleteOrgsWithRetry(db, { where: { id: ORGS } });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    vi.stubEnv("CLERK_WEBHOOK_SECRET", SECRET);
    ({ db } = await import("@/lib/db"));
    ({ check } = await import("./check"));
    ({ hashCapabilityToken } = await import("./capabilities"));
    ({ ensureTenant } = await import("@/lib/tenant"));
    ({ requireAccessContext } = await import("@/lib/access-context"));
    ({ POST: clerkWebhook } = await import("@/app/api/webhooks/clerk/route"));
  }, IMPORT_TIMEOUT_MS);

  beforeEach(async () => {
    await reset();
    clerkServer.currentUser = null;
    clerkServer.members = {};
    // Both orgs as the tenant sync seeds them: an org-root scope where the owner
    // and admin roles hold admin.
    for (const [orgId, root] of [
      [ORG_A, ROOT_A],
      [ORG_B, ROOT_B],
    ] as const) {
      await db.org.create({ data: { id: orgId, clerkOrgId: CLERK_ORG[orgId], name: orgId } });
      const scope = await db.scope.create({ data: { orgId, path: root, name: "Organization" } });
      await db.scope.create({ data: { orgId, path: `${root}.eng`, name: "eng" } });
      for (const role of ["owner", "admin"]) {
        await db.grant.create({
          data: { orgId, scopeId: scope.id, granteeType: "role", granteeId: role, permission: "admin" },
        });
      }
    }
  });

  afterAll(async () => {
    await reset();
    clerkSession.current = null;
    vi.unstubAllEnvs();
  });

  it("a token minted in one org keeps working after its issuer opens another org", async () => {
    const p = person("flip");
    await createPerson(p, ORG_A);
    expect(await signIn(p, ORG_A)).toMatchObject({ id: ORG_A });
    const inA = await mintOrThrow(ORG_A, ROOT_A, "read", p.id);

    expect(await signIn(p, ORG_B)).toMatchObject({ id: ORG_B });
    const inB = await mintOrThrow(ORG_B, ROOT_B, "read", p.id);

    // `users.orgId` still names the org last used...
    expect((await db.user.findUniqueOrThrow({ where: { id: p.id } })).orgId).toBe(ORG_B);
    // ...and neither org's token depends on it.
    expect(await tokenReads(ORG_A, inA, ROOT_A)).toBe(true);
    expect(await tokenReads(ORG_B, inB, ROOT_B)).toBe(true);
    expect((await mint(ORG_A, `${ROOT_A}.eng`, "read", p.id)).ok).toBe(true);

    await signIn(p, ORG_A);
    expect(await tokenReads(ORG_A, inA, ROOT_A)).toBe(true);
    expect(await tokenReads(ORG_B, inB, ROOT_B)).toBe(true);
  });

  it("removing a membership refuses that org's tokens on the next call, and not another org's", async () => {
    const p = person("leaver");
    await createPerson(p, ORG_A);
    await signIn(p, ORG_A);
    const inA = await mintOrThrow(ORG_A, ROOT_A, "read", p.id);
    await signIn(p, ORG_B);
    const inB = await mintOrThrow(ORG_B, ROOT_B, "read", p.id);

    // Removed from A while B is the org they last used.
    await webhook("deleted", p, ORG_A);

    expect(await tokenReads(ORG_A, inA, ROOT_A)).toBe(false);
    expect(await tokenReads(ORG_B, inB, ROOT_B)).toBe(true);
    expect((await mint(ORG_A, ROOT_A, "read", p.id)).ok).toBe(false);
    expect((await db.user.findUniqueOrThrow({ where: { id: p.id } })).orgId).toBe(ORG_B);
  });

  it("removing a person from the org they last used keeps them, and their tokens, in their other org", async () => {
    const p = person("leaver-active");
    await createPerson(p, ORG_B);
    await signIn(p, ORG_B);
    const inB = await mintOrThrow(ORG_B, ROOT_B, "read", p.id);
    await signIn(p, ORG_A);
    const inA = await mintOrThrow(ORG_A, ROOT_A, "read", p.id);

    await webhook("deleted", p, ORG_A);

    expect(await tokenReads(ORG_A, inA, ROOT_A)).toBe(false);
    expect(await tokenReads(ORG_B, inB, ROOT_B)).toBe(true);
    const user = await db.user.findUniqueOrThrow({ where: { id: p.id } });
    expect([user.orgId, user.role]).toEqual([ORG_B, "admin"]);
  });

  it("removing a person from their only org deletes their user row, as before", async () => {
    const p = person("only-org");
    await createPerson(p, ORG_A);
    await signIn(p, ORG_A);
    const inA = await mintOrThrow(ORG_A, ROOT_A, "read", p.id);

    await webhook("deleted", p, ORG_A);

    expect(await db.user.findUnique({ where: { id: p.id } })).toBeNull();
    expect(await tokenReads(ORG_A, inA, ROOT_A)).toBe(false);
  });

  it("a removal delivered after a newer re-add changes nothing, not even the org last used", async () => {
    const p = person("late-removal");
    await createPerson(p, ORG_B);
    await signIn(p, ORG_A, "org:admin", new Date(Date.now() - 120_000));
    const removedAt = new Date(Date.now() - 60_000);
    const readdedAt = new Date(Date.now() - 30_000);
    await webhook("created", p, ORG_A, { role: "org:admin", at: readdedAt });
    await signIn(p, ORG_B); // B's membership is now the most recently updated...
    // ...and A, through a token no newer than the re-add, is the org last used.
    expect(await signIn(p, ORG_A, "org:admin", readdedAt)).toMatchObject({ id: ORG_A });

    await webhook("deleted", p, ORG_A, { at: removedAt }); // retried late by the sender

    expect(await holds(ORG_A, p.id, "read", ROOT_A)).toBe(true);
    expect((await db.user.findUniqueOrThrow({ where: { id: p.id } })).orgId).toBe(ORG_A);
  });

  it("a role demotion recorded for one org narrows that org's tokens only", async () => {
    const p = person("demoted");
    await createPerson(p, ORG_A);
    await signIn(p, ORG_A, "org:admin");
    const inA = await mintOrThrow(ORG_A, ROOT_A, "read", p.id);
    await signIn(p, ORG_B, "org:admin");
    const inB = await mintOrThrow(ORG_B, ROOT_B, "read", p.id);

    // Demoted in A by an admin, while the person has B open: only the webhook
    // carries the change; no signed-in request in A runs.
    await webhook("updated", p, ORG_A, { role: "org:member" });

    expect(await tokenReads(ORG_A, inA, ROOT_A)).toBe(false);
    expect(await tokenReads(ORG_B, inB, ROOT_B)).toBe(true);
    const memberships = await db.orgMembership.findMany({ where: { userId: p.id }, orderBy: { orgId: "asc" } });
    expect(memberships.map((m) => [m.orgId, m.role, m.removedAt])).toEqual([
      [ORG_A, "member", null],
      [ORG_B, "admin", null],
    ]);
  });

  it("a signed-in request's role in its org comes from that org's membership", async () => {
    const p = person("two-roles");
    await createPerson(p, ORG_A);
    await signIn(p, ORG_A, "org:member");
    await signIn(p, ORG_B, "org:admin");
    clerkSession.current = { ...clerkSession.current!, orgId: CLERK_ORG[ORG_A], orgRole: "org:member" };
    const rc = await requireAccessContext();
    expect(rc?.org.id).toBe(ORG_A);
    expect(rc?.ctx.actor).toMatchObject({ type: "human", id: p.id, role: "member" });
    expect(rc?.user.role).toBe("member");
  });

  it("a request's role is its own org's, even when a request in another org rewrites the user row mid-request", async () => {
    // Member in A, admin in B. A request in A syncs its tenant (the user row now
    // says A/member); before it reads the row, a concurrent request in B syncs
    // (the row now says B/admin). The A request must still act as a member.
    const p = person("interleaved");
    await createPerson(p, ORG_A, "member");
    await signIn(p, ORG_A, "org:member");
    await signIn(p, ORG_B, "org:admin");

    const sessionInA = { ...clerkSession.current!, orgId: CLERK_ORG[ORG_A], orgRole: "org:member" };
    clerkSession.current = sessionInA;
    afterTenantSync.run = async () => {
      expect(await signIn(p, ORG_B, "org:admin")).toMatchObject({ id: ORG_B });
      clerkSession.current = sessionInA;
    };
    const rc = await requireAccessContext();

    const row = await db.user.findUniqueOrThrow({ where: { id: p.id } });
    expect([row.orgId, row.role]).toEqual([ORG_B, "admin"]); // the interleaving happened
    expect(rc?.org.id).toBe(ORG_A);
    expect(rc?.ctx.actor).toMatchObject({ type: "human", id: p.id, role: "member" });
    expect(rc?.user.role).toBe("member");
  });

  it("a removal recorded while a request is past its tenant sync refuses that request", async () => {
    // The tenant sync saw a live membership; before the request builds its
    // context, the removal webhook lands. The request must not act in the org.
    const p = person("removed-mid-request");
    await createPerson(p, ORG_B);
    await signIn(p, ORG_B);
    await signIn(p, ORG_A);

    afterTenantSync.run = async () => {
      await webhook("deleted", p, ORG_A);
    };
    const rc = await requireAccessContext();

    expect(await holds(ORG_A, p.id, "read", ROOT_A)).toBe(false); // the removal happened
    expect(rc).toBeNull();
  });

  it("a session token issued before a removal cannot restore the membership; a newer one can", async () => {
    const p = person("stale-session");
    await createPerson(p, ORG_B);
    await signIn(p, ORG_B);
    await signIn(p, ORG_A);
    const inA = await mintOrThrow(ORG_A, ROOT_A, "read", p.id);

    const removedAt = new Date();
    await webhook("deleted", p, ORG_A, { at: removedAt });

    // A request still carrying a session token from before the removal.
    expect(await signIn(p, ORG_A, "org:admin", new Date(removedAt.getTime() - 60_000))).toBeNull();
    expect(await requireAccessContext()).toBeNull();
    expect(await holds(ORG_A, p.id, "read", ROOT_A)).toBe(false);
    // A `created` event older than the removal, delivered late, does not restore it.
    await webhook("created", p, ORG_A, { role: "org:admin", at: new Date(removedAt.getTime() - 20_000) });
    expect(await holds(ORG_A, p.id, "read", ROOT_A)).toBe(false);
    expect(await tokenReads(ORG_A, inA, ROOT_A)).toBe(false);
    // A stale request does not move the person's last-used org either.
    expect((await db.user.findUniqueOrThrow({ where: { id: p.id } })).orgId).toBe(ORG_B);

    // A session token Clerk issued after the removal asserts membership again.
    expect(await signIn(p, ORG_A, "org:admin", new Date(removedAt.getTime() + 2_000))).toMatchObject({ id: ORG_A });
    expect(await holds(ORG_A, p.id, "read", ROOT_A)).toBe(true);
  });

  it("a session token issued before removal from a person's only org cannot recreate them", async () => {
    // Removal from the only org deletes the user row, and the membership's
    // record of the removal with it. A request still carrying a session token
    // from before the removal then looks like a first visit.
    const p = person("only-org-stale");
    clerkServer.currentUser = {
      id: p.clerkId,
      firstName: "Stale",
      lastName: null,
      emailAddresses: [{ emailAddress: `${p.id}@example.test` }],
    };
    clerkServer.members = { [CLERK_ORG[ORG_A]]: { [p.clerkId]: "org:admin" } };
    expect(await signIn(p, ORG_A)).toMatchObject({ id: ORG_A });
    const firstId = (await db.user.findUniqueOrThrow({ where: { clerkId: p.clerkId } })).id;
    expect(await holds(ORG_A, firstId, "read", ROOT_A)).toBe(true);

    const removedAt = new Date();
    clerkServer.members = {};
    await webhook("deleted", { id: firstId, clerkId: p.clerkId }, ORG_A, { at: removedAt });
    expect(await db.user.findUnique({ where: { clerkId: p.clerkId } })).toBeNull();

    expect(await signIn(p, ORG_A, "org:admin", new Date(removedAt.getTime() - 30_000))).toBeNull();
    expect(await db.user.findUnique({ where: { clerkId: p.clerkId } })).toBeNull();
    expect(await requireAccessContext()).toBeNull();

    // Invited back: Clerk lists them again, so the first visit recreates them,
    // with the role Clerk holds now rather than the one on the session token.
    clerkServer.members = { [CLERK_ORG[ORG_A]]: { [p.clerkId]: "org:member" } };
    expect(await signIn(p, ORG_A, "org:admin")).toMatchObject({ id: ORG_A });
    const back = await db.user.findUniqueOrThrow({ where: { clerkId: p.clerkId } });
    expect(
      (await db.orgMembership.findUniqueOrThrow({ where: { orgId_userId: { orgId: ORG_A, userId: back.id } } })).role,
    ).toBe("member");
  });

  it("an everyone grant gives a person outside the org nothing, and a removed member nothing", async () => {
    const outsider = person("outsider");
    const member = person("everyone-member");
    await createPerson(outsider, ORG_B, "member");
    await createPerson(member, ORG_A, "member");
    await signIn(member, ORG_A, "org:member");
    await signIn(member, ORG_B, "org:member");
    const rootA = await db.scope.findUniqueOrThrow({ where: { orgId_path: { orgId: ORG_A, path: ROOT_A } } });
    await db.grant.create({
      data: { orgId: ORG_A, scopeId: rootA.id, granteeType: "everyone", granteeId: "*", permission: "read" },
    });

    expect(await holds(ORG_A, outsider.id, "read", ROOT_A)).toBe(false);
    expect((await mint(ORG_A, ROOT_A, "read", outsider.id)).ok).toBe(false);

    const inA = await mintOrThrow(ORG_A, ROOT_A, "read", member.id);
    expect(await tokenReads(ORG_A, inA, ROOT_A)).toBe(true);
    await webhook("deleted", member, ORG_A);
    expect(await holds(ORG_A, member.id, "read", ROOT_A)).toBe(false);
    expect(await tokenReads(ORG_A, inA, ROOT_A)).toBe(false);
  });

  it("an issuer whose membership row is missing altogether holds nothing, and their tokens stop", async () => {
    const p = person("no-membership-row");
    await createPerson(p, ORG_A);
    await signIn(p, ORG_A);
    const inA = await mintOrThrow(ORG_A, ROOT_A, "read", p.id);
    expect(await tokenReads(ORG_A, inA, ROOT_A)).toBe(true);

    // Not a removal (that keeps the row with removedAt set): the row is gone.
    await db.$executeRaw`DELETE FROM "org_memberships" WHERE "orgId" = ${ORG_A} AND "userId" = ${p.id}`;
    expect(await holds(ORG_A, p.id, "read", ROOT_A)).toBe(false);
    expect(await tokenReads(ORG_A, inA, ROOT_A)).toBe(false);
  });

  it("an expired grant is not honoured on a database session whose time zone is not UTC", async () => {
    // Prisma stores DateTime as UTC in `timestamp without time zone`. Compared
    // against a bare now(), such a value is read in the session's zone, so west
    // of UTC a grant that expired an hour ago would still look live.
    const p = person("tz");
    await createPerson(p, ORG_A, "member");
    const eng = await db.scope.findUniqueOrThrow({ where: { orgId_path: { orgId: ORG_A, path: `${ROOT_A}.eng` } } });
    const rootA = await db.scope.findUniqueOrThrow({ where: { orgId_path: { orgId: ORG_A, path: ROOT_A } } });
    await db.grant.create({
      data: {
        orgId: ORG_A,
        scopeId: rootA.id,
        granteeType: "user",
        granteeId: p.id,
        permission: "read",
        expiresAt: new Date(Date.now() - 3_600_000),
      },
    });
    await db.grant.create({
      data: {
        orgId: ORG_A,
        scopeId: eng.id,
        granteeType: "user",
        granteeId: p.id,
        permission: "read",
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });

    const pg = new Client({ connectionString: QA_URL, options: "-c TimeZone=America/Los_Angeles" });
    await pg.connect();
    try {
      const zone = await pg.query("SHOW TimeZone");
      expect(zone.rows[0].TimeZone).toBe("America/Los_Angeles");
      const holdsOn = async (path: string) =>
        (await pg.query(`SELECT "access_person_holds"($1, $2, 'read'::"Permission", $3) AS h`, [ORG_A, p.id, path]))
          .rows[0].h;
      expect(await holdsOn(ROOT_A)).toBe(false); // expired an hour ago
      expect(await holdsOn(`${ROOT_A}.eng`)).toBe(true); // expires in an hour
      // The mint trigger asks the same function, so the expired grant cannot back a token.
      await expect(
        pg.query(
          `INSERT INTO "capabilities" ("id", "orgId", "agentId", "tokenHash", "scopePath", "permission", "expiresAt", "createdBy", "createdAt")
           VALUES ($1, $2, 'agent-qa-om-tz', $3, $4, 'read', now() + interval '1 day', $5, now())`,
          [`cap-qa-om-tz-${++seq}`, ORG_A, `hash-qa-om-tz-${seq}`, ROOT_A, p.id],
        ),
      ).rejects.toThrow(/capability wider than its issuer/);
    } finally {
      await pg.end();
    }
  });

  it("the migration's backfill gives every existing person exactly one membership, in their row's org and role", async () => {
    const migration = readFileSync(
      fileURLToPath(new URL("../../prisma/migrations/20261010020000_org_memberships/migration.sql", import.meta.url)),
      "utf8",
    );
    const backfill = migration.split("-- backfill:start")[1]?.split("-- backfill:end")[0];
    if (!backfill) throw new Error("setup: backfill markers not found in the migration");

    // Rows as they existed before the migration: written with the join trigger
    // off, so no membership exists until the backfill runs. One transaction,
    // rolled back, so nothing here outlives the test.
    const pg = new Client({ connectionString: QA_URL });
    await pg.connect();
    try {
      await pg.query("BEGIN");
      await pg.query(`ALTER TABLE "users" DISABLE TRIGGER "users_join_org"`);
      const rows = [
        [person("bf-1").id, ORG_A, "admin"],
        [person("bf-2").id, ORG_A, "member"],
        [person("bf-3").id, ORG_B, "owner"],
      ];
      for (const [id, orgId, role] of rows) {
        await pg.query(
          `INSERT INTO "users" ("id", "orgId", "clerkId", "email", "role", "updatedAt") VALUES ($1, $2, $3, $4, $5, now())`,
          [id, orgId, `clerk_${id}`, `${id}@example.test`, role],
        );
      }
      const before = await pg.query(`SELECT count(*)::int AS n FROM "org_memberships" WHERE "userId" = ANY($1)`, [
        rows.map((r) => r[0]),
      ]);
      expect(before.rows[0].n).toBe(0);

      await pg.query(backfill);
      await pg.query(backfill); // idempotent

      const after = await pg.query(
        `SELECT "userId", "orgId", "role"::text AS role, "removedAt" FROM "org_memberships" WHERE "userId" = ANY($1) ORDER BY "userId"`,
        [rows.map((r) => r[0])],
      );
      expect(after.rows.map((r) => [r.userId, r.orgId, r.role, r.removedAt])).toEqual(rows.map((r) => [...r, null]));
      // Every person in the database, not only these three, has a membership in
      // their row's org after the backfill.
      const orphans = await pg.query(`
        SELECT count(*)::int AS n FROM "users" u
        WHERE NOT EXISTS (SELECT 1 FROM "org_memberships" m WHERE m."userId" = u."id" AND m."orgId" = u."orgId")`);
      expect(orphans.rows[0].n).toBe(0);
    } finally {
      await pg.query("ROLLBACK");
      await pg.end();
    }
  });
});
