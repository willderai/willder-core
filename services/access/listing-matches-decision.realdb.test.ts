// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The scope readers listing (GET /api/access/scopes/:id/readers) names exactly
// the people check() lets read the scope, for a person in two orgs, after a role
// change and after a removal. Each test asks three times, in this order: the
// listing, the decision, the listing again. All three must agree.
//
// The writers are the real ones: ensureTenant() for a signed-in request (Clerk's
// session is mocked, the database is not) and the Clerk webhook route with a real
// svix signature. The listing is the real route; the decision is the real
// check(), reached through requireAccessContext() as a request reaches it, or
// given a context built earlier, as a request in flight holds one.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never a live one.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Webhook } from "svix";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "./check";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const clerkSession = vi.hoisted(() => ({
  current: null as null | { userId: string; orgId: string; orgRole: string; sessionClaims: { iat: number } },
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => clerkSession.current ?? { userId: null, orgId: null, orgRole: null },
  currentUser: async () => null,
  clerkClient: async () => ({
    organizations: {
      getOrganization: async () => null,
      getOrganizationMembershipList: async () => ({ data: [] }),
    },
  }),
}));

vi.mock("@/lib/inngest", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  inngest: { send: async () => undefined },
}));

vi.mock("@/services/memory", () => ({
  memory: { ingest: async () => undefined },
}));

/** The tenant sync pulls in the agent runner; a cold import can take seconds. */
const IMPORT_TIMEOUT_MS = 60_000;

const ORG_A = "org-qa-lmd-a";
const ORG_B = "org-qa-lmd-b";
const ROOT_A = "org_qa_lmd_a";
const ROOT_B = "org_qa_lmd_b";
const ENG_A = `${ROOT_A}.eng`;
const CLERK_ORG = { [ORG_A]: "clerk_org_qa_lmd_a", [ORG_B]: "clerk_org_qa_lmd_b" } as const;
const ORGS = { in: [ORG_A, ORG_B] };

const SECRET = `whsec_${Buffer.from("willder-listing-decision-test-key-0123").toString("base64")}`;

type OrgId = keyof typeof CLERK_ORG;
type Person = { id: string; clerkId: string };
const person = (name: string): Person => ({ id: `u-qa-lmd-${name}`, clerkId: `clerk_user_qa_lmd_${name}` });

/** The admin who asks for the listing. Only ever signed in to org A. */
const LISTER = person("lister");

describe.skipIf(!QA_URL)("the readers listing names exactly the people check() lets read, real Postgres", () => {
  let db: PrismaClient;
  let check: (typeof import("./check"))["check"];
  let ensureTenant: (typeof import("@/lib/tenant"))["ensureTenant"];
  let requireAccessContext: (typeof import("@/lib/access-context"))["requireAccessContext"];
  let clerkWebhook: (typeof import("@/app/api/webhooks/clerk/route"))["POST"];
  let readersRoute: (typeof import("@/app/api/access/scopes/[id]/readers/route"))["GET"];
  let seq = 0;

  /** Sign `p` in with `org` active, as the browser would, and run the tenant
   * sync every signed-in request runs. `issuedAt` is the session token's issue
   * time (default: now). */
  async function signIn(p: Person, org: OrgId, orgRole: string, issuedAt = new Date()) {
    clerkSession.current = {
      userId: p.clerkId,
      orgId: CLERK_ORG[org],
      orgRole,
      sessionClaims: { iat: Math.floor(issuedAt.getTime() / 1000) },
    };
    return ensureTenant();
  }

  /** Deliver a signed Clerk membership event for `p` in `org`. */
  async function webhook(type: "created" | "updated" | "deleted", p: Person, org: OrgId, role = "org:member") {
    const body = JSON.stringify({
      type: `organizationMembership.${type}`,
      object: "event",
      timestamp: Date.now(),
      data: {
        id: `orgmem_qa_lmd_${++seq}`,
        role,
        organization: { id: CLERK_ORG[org], name: org },
        public_user_data: { user_id: p.clerkId, identifier: `${p.id}@example.test` },
      },
    });
    const id = `msg_qa_lmd_${seq}`;
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

  async function createPerson(p: Person, orgId: string, role: "admin" | "member") {
    await db.user.create({ data: { id: p.id, orgId, clerkId: p.clerkId, email: `${p.id}@example.test`, role } });
  }

  async function grant(granteeType: "user" | "role" | "everyone", granteeId: string, path = ENG_A) {
    const scope = await db.scope.findUniqueOrThrow({ where: { orgId_path: { orgId: ORG_A, path } } });
    await db.grant.create({ data: { orgId: ORG_A, scopeId: scope.id, granteeType, granteeId, permission: "read" } });
  }

  /** The readers listing for `path` in org A, as its admin asks for it: each
   * person by id, with the role the listing reports. */
  async function listing(path = ENG_A): Promise<Map<string, string>> {
    const scope = await db.scope.findUniqueOrThrow({ where: { orgId_path: { orgId: ORG_A, path } } });
    await signIn(LISTER, ORG_A, "org:admin");
    const res = await readersRoute(new Request(`http://localhost/api/access/scopes/${scope.id}/readers`), {
      params: Promise.resolve({ id: scope.id }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { people: { id: string; role: string }[] };
    const ids = body.people.map((p) => p.id);
    expect(ids, "each person is listed once").toEqual([...new Set(ids)]);
    return new Map(body.people.map((p) => [p.id, p.role]));
  }

  /** check() on reading `path` in org A, for a context already in hand. */
  async function decides(ctx: AccessContext, path = ENG_A): Promise<boolean> {
    return (await check(ctx, { action: "memory.read", scope: path })).allowed;
  }

  /** `p`'s next signed-in request in org A: the tenant sync, then check(). */
  async function nextRequestReads(p: Person, orgRole: string, issuedAt = new Date(), path = ENG_A): Promise<boolean> {
    await signIn(p, ORG_A, orgRole, issuedAt);
    const rc = await requireAccessContext();
    return rc ? decides(rc.ctx, path) : false;
  }

  /** The context `p` holds in org A, as a request built it just now. */
  async function contextNow(p: Person, orgRole: string): Promise<AccessContext> {
    await signIn(p, ORG_A, orgRole);
    const rc = await requireAccessContext();
    if (!rc) throw new Error(`setup: ${p.id} has no request context in org A`);
    return rc.ctx;
  }

  /** Ask the listing, then the decision, then the listing again. All three
   * agree. Returns the role each listing named the person with. */
  async function expectAgreement(p: Person, decision: () => Promise<boolean>, expected: boolean, path = ENG_A) {
    const before = await listing(path);
    const allowed = await decision();
    const after = await listing(path);
    expect({ listedBefore: before.has(p.id), allowed, listedAfter: after.has(p.id) }).toEqual({
      listedBefore: expected,
      allowed: expected,
      listedAfter: expected,
    });
    return { before: before.get(p.id), after: after.get(p.id) };
  }

  async function reset() {
    await db.auditLog.deleteMany({ where: { orgId: ORGS } });
    await db.capability.deleteMany({ where: { orgId: ORGS } });
    await db.grant.deleteMany({ where: { orgId: ORGS } });
    await db.scope.deleteMany({ where: { orgId: ORGS } });
    await db.user.deleteMany({ where: { OR: [{ orgId: ORGS }, { clerkId: { startsWith: "clerk_user_qa_lmd_" } }] } });
    await db.agent.deleteMany({ where: { orgId: ORGS } });
    await deleteOrgsWithRetry(db, { where: { id: ORGS } });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    vi.stubEnv("CLERK_WEBHOOK_SECRET", SECRET);
    ({ db } = await import("@/lib/db"));
    ({ check } = await import("./check"));
    ({ ensureTenant } = await import("@/lib/tenant"));
    ({ requireAccessContext } = await import("@/lib/access-context"));
    ({ POST: clerkWebhook } = await import("@/app/api/webhooks/clerk/route"));
    ({ GET: readersRoute } = await import("@/app/api/access/scopes/[id]/readers/route"));
  }, IMPORT_TIMEOUT_MS);

  beforeEach(async () => {
    await reset();
    // Both orgs as the tenant sync seeds them: an org-root scope where the owner
    // and admin roles hold admin, and an `eng` scope under it with no grant.
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
    await createPerson(LISTER, ORG_A, "admin");
  });

  afterAll(async () => {
    await reset();
    clerkSession.current = null;
    vi.unstubAllEnvs();
  });

  it.each([
    ["a grant to them", "user"],
    ["a grant to their role", "role"],
    ["a grant to everyone", "everyone"],
  ] as const)(
    "a member who reads through %s and last signed in to another org is listed, and reads",
    async (_name, kind) => {
      const p = person(`away-${kind}`);
      await createPerson(p, ORG_A, "member");
      await signIn(p, ORG_A, "org:member");
      await grant(kind, kind === "user" ? p.id : kind === "role" ? "member" : "*");
      await signIn(p, ORG_B, "org:admin");
      expect((await db.user.findUniqueOrThrow({ where: { id: p.id } })).orgId).toBe(ORG_B);

      expect(await expectAgreement(p, () => nextRequestReads(p, "org:member"), true)).toEqual({
        before: "member",
        after: "member",
      });
    },
  );

  it("an admin who last signed in to another org, as a member there, is listed as an admin, and reads", async () => {
    const p = person("moved-admin");
    await createPerson(p, ORG_A, "admin");
    await signIn(p, ORG_A, "org:admin");
    await grant("user", p.id); // A second grant reaching them; they are still one person.
    await signIn(p, ORG_B, "org:member");
    // The user row now names B, with B's role.
    const row = await db.user.findUniqueOrThrow({ where: { id: p.id } });
    expect([row.orgId, row.role]).toEqual([ORG_B, "member"]);

    expect(await expectAgreement(p, () => nextRequestReads(p, "org:admin"), true)).toEqual({
      before: "admin",
      after: "admin",
    });
  });

  it("an admin demoted in Clerk drops off the listing, and is refused, even holding a context built while an admin", async () => {
    const p = person("demoted");
    await createPerson(p, ORG_A, "admin");
    const asAdmin = await contextNow(p, "org:admin");
    expect(await decides(asAdmin)).toBe(true);

    // Demoted in A by another admin: only the webhook carries the change.
    await webhook("updated", p, ORG_A, "org:member");

    await expectAgreement(p, () => decides(asAdmin), false);
    // A session token issued before the demotion still says admin; it is older
    // than the demotion, so it changes nothing.
    await expectAgreement(p, () => nextRequestReads(p, "org:admin", new Date(Date.now() - 60_000)), false);
    await expectAgreement(p, () => nextRequestReads(p, "org:member"), false);
  });

  it("a removed member drops off the listing, and is refused, even holding a context built before the removal", async () => {
    const p = person("removed");
    await createPerson(p, ORG_B, "member");
    const inA = await contextNow(p, "org:member");
    await grant("user", p.id);
    expect(await decides(inA)).toBe(true);

    await webhook("deleted", p, ORG_A);

    await expectAgreement(p, () => decides(inA), false);
    await expectAgreement(p, () => nextRequestReads(p, "org:member", new Date(Date.now() - 60_000)), false);
    // They keep their other org.
    expect((await db.user.findUniqueOrThrow({ where: { id: p.id } })).orgId).toBe(ORG_B);
  });

  it("before the app knows of a membership, neither the listing nor check() admits the person; once known, both do", async () => {
    // A member of B whom Clerk has added to A. Neither the webhook nor a
    // signed-in request in A has reached the app yet.
    const p = person("lagging");
    await createPerson(p, ORG_B, "member");
    await grant("everyone", "*");
    const claimed: AccessContext = { orgId: ORG_A, actor: { type: "human", id: p.id, role: "admin" }, origin: "app" };

    await expectAgreement(p, () => decides(claimed), false);
    await expectAgreement(p, () => decides(claimed, ROOT_A), false, ROOT_A);

    // The webhook arrives: the membership is known, and both name them.
    await webhook("created", p, ORG_A, "org:member");
    await expectAgreement(p, () => decides(claimed), true);
    // The role is the membership's, never the one a context claims.
    await expectAgreement(p, () => decides(claimed, ROOT_A), false, ROOT_A);
  });

  it("a person's own first request in an org records their membership before check() runs, so the listing names them from then on", async () => {
    const p = person("first-request");
    await createPerson(p, ORG_B, "member");
    await grant("everyone", "*");
    expect((await listing()).has(p.id)).toBe(false);

    expect(await nextRequestReads(p, "org:member")).toBe(true);
    expect((await listing()).has(p.id)).toBe(true);
  });
});
