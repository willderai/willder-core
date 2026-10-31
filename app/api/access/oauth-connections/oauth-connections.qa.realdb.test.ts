// MCP OAuth connections and the capability mint, against real Postgres.
//
// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Moving the capability mint out of POST /api/access/capabilities into
// services/access/issue-capability.ts must leave that route's rules exactly as
// they were: default and maximum lifetime, who is recorded as the issuer, the
// refusals and their statuses, and an audit row for every decision. An OAuth
// connection must never fall back silently to the org root for a person who does
// not administer it, and an admin revoking a connected client's capability through
// the ordinary route must end that client's connection. Only the Clerk session is
// faked.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG_A = "oauthqa_a";
const ORG_B = "oauthqa_b";
// Each org's root scope is the path orgRootPath() derives from its id, so a mint
// that names no scope lands on a real scope row.
const ROOT_A = `org_${ORG_A}`;
const ROOT_B = `org_${ORG_B}`;
const SALES = `${ROOT_A}.sales`;

const ADMIN = "u-oauth-qa-admin";
const LEAD = "u-oauth-qa-lead";
const MEMBER = "u-oauth-qa-member";

const CLIENT = "https://claude.ai/oauth/mcp-client-metadata.json";
const HOUR_MS = 60 * 60 * 1000;

type Person = { id: string; orgId: string; role: "admin" | "member" };
const people: Record<string, Person> = {
  [ADMIN]: { id: ADMIN, orgId: ORG_A, role: "admin" },
  [LEAD]: { id: LEAD, orgId: ORG_A, role: "member" },
  [MEMBER]: { id: MEMBER, orgId: ORG_A, role: "member" },
};

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

describe.skipIf(!QA_URL)("capability mint and OAuth connections, real Postgres", () => {
  let db: PrismaClient;
  let mintPOST: (typeof import("../capabilities/route"))["POST"];
  let connectPOST: (typeof import("./route"))["POST"];
  let capabilityDELETE: (typeof import("../capabilities/[id]/route"))["DELETE"];
  let liveOAuthConnection: (typeof import("@/services/access"))["liveOAuthConnection"];
  let listGET: (typeof import("./route"))["GET"];
  let disconnectDELETE: (typeof import("./[id]/route"))["DELETE"];
  let requireAccessContext: ReturnType<typeof vi.fn>;

  function signInAs(userId: string) {
    const person = people[userId];
    requireAccessContext.mockResolvedValue({
      org: { id: person.orgId, name: person.orgId, clerkOrgId: `clerk_${person.orgId}` },
      user: { id: person.id },
      ctx: { orgId: person.orgId, actor: { type: "human", id: person.id, role: person.role }, origin: "app" },
    });
  }

  async function mint(body: Record<string, unknown>) {
    const res = await mintPOST(
      new Request("http://t/api/access/capabilities", { method: "POST", body: JSON.stringify(body) }),
    );
    return { status: res.status, body: await res.json() };
  }

  async function connect(body: Record<string, unknown>) {
    const res = await connectPOST(
      new Request("http://t/api/access/oauth-connections", { method: "POST", body: JSON.stringify(body) }),
    );
    return { status: res.status, body: await res.json() };
  }

  async function list() {
    const res = await listGET();
    return { status: res.status, body: await res.json() };
  }

  async function disconnect(id: string) {
    const res = await disconnectDELETE(new Request("http://t", { method: "DELETE" }), {
      params: Promise.resolve({ id }),
    });
    return res.status;
  }

  async function wipe() {
    for (const orgId of [ORG_A, ORG_B]) {
      await db.oAuthConnection.deleteMany({ where: { orgId } });
      await db.auditLog.deleteMany({ where: { orgId } });
      await db.capability.deleteMany({ where: { orgId } });
      await db.grant.deleteMany({ where: { orgId } });
      await db.scope.deleteMany({ where: { orgId } });
      await db.user.deleteMany({ where: { orgId } });
      await deleteOrgsWithRetry(db, { where: { id: orgId } });
    }
  }

  async function seed() {
    for (const [orgId, root] of [
      [ORG_A, ROOT_A],
      [ORG_B, ROOT_B],
    ]) {
      await db.org.create({ data: { id: orgId, name: orgId, clerkOrgId: `clerk_${orgId}` } });
      const scope = await db.scope.create({ data: { orgId, path: root, name: "Organization" } });
      await db.grant.create({
        data: { orgId, scopeId: scope.id, granteeType: "role", granteeId: "admin", permission: "admin" },
      });
    }
    const sales = await db.scope.create({ data: { orgId: ORG_A, path: SALES, name: "Sales" } });
    const rootA = await db.scope.findUniqueOrThrow({ where: { orgId_path: { orgId: ORG_A, path: ROOT_A } } });
    for (const person of Object.values(people)) {
      await db.user.create({
        data: {
          id: person.id,
          orgId: person.orgId,
          email: `${person.id}@oauth-qa.test`,
          role: person.role,
          clerkId: `clerk_${person.id}`,
        },
      });
    }
    await db.grant.createMany({
      data: [
        { orgId: ORG_A, scopeId: rootA.id, granteeType: "user", granteeId: LEAD, permission: "read" },
        { orgId: ORG_A, scopeId: sales.id, granteeType: "user", granteeId: LEAD, permission: "admin" },
        { orgId: ORG_A, scopeId: sales.id, granteeType: "user", granteeId: MEMBER, permission: "read" },
      ],
    });
  }

  beforeEach(async () => {
    process.env.DATABASE_URL = QA_URL;
    vi.stubEnv("MCP_OAUTH_ENABLED", "true");
    db ??= new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ POST: mintPOST } = await import("../capabilities/route"));
    ({ POST: connectPOST, GET: listGET } = await import("./route"));
    ({ DELETE: disconnectDELETE } = await import("./[id]/route"));
    ({ DELETE: capabilityDELETE } = await import("../capabilities/[id]/route"));
    ({ liveOAuthConnection } = await import("@/services/access"));
    ({ requireAccessContext } = (await import("@/lib/access-context")) as never as {
      requireAccessContext: ReturnType<typeof vi.fn>;
    });
    requireAccessContext.mockReset();
    await wipe();
    await seed();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  describe("POST /api/access/capabilities keeps its mint rules", () => {
    it("issues at the org root for an admin who names no scope, read by default, for seven days, recorded as theirs", async () => {
      signInAs(ADMIN);
      const before = Date.now();

      const { status, body } = await mint({ agentId: "support-bot" });

      expect(status).toBe(201);
      expect(body.token).toMatch(/^wcap_/);
      expect(body).toMatchObject({ scopePath: ROOT_A, permission: "read", agentId: "support-bot" });
      const row = await db.capability.findUniqueOrThrow({ where: { id: body.id } });
      expect(row.createdBy).toBe(ADMIN);
      const ttl = row.expiresAt.getTime() - before;
      expect(ttl).toBeGreaterThan(7 * 24 * HOUR_MS - 60_000);
      expect(ttl).toBeLessThanOrEqual(7 * 24 * HOUR_MS + 60_000);
    });

    it("caps a requested lifetime at ninety days and ignores a non-positive one", async () => {
      signInAs(ADMIN);
      const before = Date.now();

      const long = await mint({ agentId: "support-bot", ttlHours: 24 * 365 });
      const negative = await mint({ agentId: "support-bot", ttlHours: -5 });

      expect(new Date(long.body.expiresAt).getTime() - before).toBeLessThanOrEqual(90 * 24 * HOUR_MS + 60_000);
      expect(new Date(long.body.expiresAt).getTime() - before).toBeGreaterThan(90 * 24 * HOUR_MS - 60_000);
      expect(new Date(negative.body.expiresAt).getTime() - before).toBeLessThanOrEqual(7 * 24 * HOUR_MS + 60_000);
    });

    it("refuses a bad request with the same status and error as before, writing nothing", async () => {
      signInAs(ADMIN);

      expect(await mint({})).toEqual({ status: 400, body: { error: "agentId is required" } });
      expect(await mint({ agentId: "   " })).toEqual({ status: 400, body: { error: "agentId is required" } });
      expect(await mint({ agentId: "support-bot", permission: "owner" })).toEqual({
        status: 400,
        body: { error: "permission must be read|write|admin" },
      });
      expect((await mint({ agentId: "qa-agent" })).status).toBe(400);
      expect(await mint({ agentId: "support-bot", scopePath: `${ROOT_A}.nowhere` })).toEqual({
        status: 404,
        body: { error: "scope not found" },
      });
      expect(await mint({ agentId: "support-bot", scopePath: ROOT_B })).toEqual({
        status: 404,
        body: { error: "scope not found" },
      });
      expect(await db.capability.count({ where: { orgId: { in: [ORG_A, ORG_B] } } })).toBe(0);
    });

    it("refuses a member at a scope they only read with 403 and an audited deny, and lets a scope admin mint below the root", async () => {
      signInAs(MEMBER);
      const denied = await mint({ agentId: "support-bot", scopePath: SALES });
      expect(denied.status).toBe(403);
      expect(
        await db.auditLog.count({
          where: { orgId: ORG_A, actorId: MEMBER, action: "access.manage", decision: "deny" },
        }),
      ).toBe(1);

      signInAs(LEAD);
      expect((await mint({ agentId: "support-bot" })).status).toBe(403);
      const allowed = await mint({ agentId: "support-bot", scopePath: SALES, permission: "write" });
      expect(allowed.status).toBe(201);
      expect(allowed.body).toMatchObject({ scopePath: SALES, permission: "write" });
      expect(await db.capability.count({ where: { orgId: ORG_A } })).toBe(1);
    });
  });

  describe("an OAuth connection", () => {
    it("never falls back to the org root for a person who does not administer it", async () => {
      signInAs(LEAD);

      for (const scopePath of [undefined, "", "   "]) {
        const res = await connect({ clientId: CLIENT, agentId: "Claude", scopePath, permission: "read" });
        expect(res.status).toBe(400);
      }

      expect(await db.capability.count({ where: { orgId: ORG_A } })).toBe(0);
      expect(await db.oAuthConnection.count({ where: { orgId: ORG_A } })).toBe(0);
    });

    it("hands out no token, and its capability's hash matches no token anyone holds", async () => {
      signInAs(LEAD);

      const res = await connect({ clientId: CLIENT, agentId: "Claude", scopePath: SALES, permission: "read" });

      expect(res.status).toBe(201);
      expect(JSON.stringify(res.body)).not.toMatch(/wcap_|token/i);
      const row = await db.capability.findUniqueOrThrow({ where: { id: res.body.capabilityId } });
      expect(row).toMatchObject({ scopePath: SALES, permission: "read", createdBy: LEAD, revokedAt: null });
    });

    it("ends when an admin revokes its capability through DELETE /api/access/capabilities/:id", async () => {
      signInAs(LEAD);
      const connected = await connect({ clientId: CLIENT, agentId: "Claude", scopePath: SALES, permission: "read" });
      expect(await liveOAuthConnection(ORG_A, LEAD, CLIENT)).not.toBeNull();

      signInAs(ADMIN);
      const revoked = await capabilityDELETE(new Request("http://t", { method: "DELETE" }), {
        params: Promise.resolve({ id: connected.body.capabilityId }),
      });

      expect(revoked.status).toBe(200);
      expect(await liveOAuthConnection(ORG_A, LEAD, CLIENT)).toBeNull();
    });
  });

  describe("before MCP_OAUTH_ENABLED turns on", () => {
    it("refuses an omitted scope from an org admin and a member alike with 400, before any decision is audited", async () => {
      for (const who of [ADMIN, MEMBER]) {
        signInAs(who);
        for (const scopePath of [undefined, "", "  \t "]) {
          const res = await connect({ clientId: CLIENT, agentId: "Claude", scopePath, permission: "read" });
          expect(res).toEqual({ status: 400, body: { error: "scopePath is required: the scope the app may reach" } });
        }
      }

      expect(await db.capability.count({ where: { orgId: ORG_A } })).toBe(0);
      expect(await db.oAuthConnection.count({ where: { orgId: ORG_A } })).toBe(0);
      expect(await db.auditLog.count({ where: { orgId: ORG_A } })).toBe(0);
    });

    it("still connects an org admin who names the root on purpose", async () => {
      signInAs(ADMIN);
      const res = await connect({ clientId: CLIENT, agentId: "Claude", scopePath: ROOT_A, permission: "read" });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ scopePath: ROOT_A });
    });

    it("names the scope the app could reach when it was disconnected, not the one it first connected at", async () => {
      await db.scope.create({ data: { orgId: ORG_A, path: `${SALES}.emea`, name: "Sales EMEA" } });
      signInAs(LEAD);
      await connect({ clientId: CLIENT, agentId: "Claude", scopePath: SALES, permission: "read" });
      const narrowed = await connect({
        clientId: CLIENT,
        agentId: "Claude",
        scopePath: `${SALES}.emea`,
        permission: "read",
      });

      expect(await disconnect(narrowed.body.id)).toBe(200);

      const rows = await db.auditLog.findMany({ where: { action: "oauth.disconnected" } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        orgId: ORG_A,
        actorId: LEAD,
        target: `${SALES}.emea/oauth_connection:${narrowed.body.id}`,
        metadata: { capabilityId: narrowed.body.capabilityId, clientId: CLIENT },
      });
    });

    it("writes no disconnect row when an admin ends the connection by revoking its capability, and a later disconnect is a no-op", async () => {
      signInAs(LEAD);
      const connected = await connect({ clientId: CLIENT, agentId: "Claude", scopePath: SALES, permission: "read" });

      signInAs(ADMIN);
      const revoked = await capabilityDELETE(new Request("http://t", { method: "DELETE" }), {
        params: Promise.resolve({ id: connected.body.capabilityId }),
      });
      expect(revoked.status).toBe(200);

      signInAs(LEAD);
      expect((await list()).body.connections).toEqual([]);
      expect(await disconnect(connected.body.id)).toBe(200);
      const cap = await db.capability.findUniqueOrThrow({ where: { id: connected.body.capabilityId } });
      const rows = await db.auditLog.findMany({ where: { orgId: ORG_A, action: "oauth.disconnected" } });
      // The connection row was still unrevoked, so this first disconnect records itself;
      // the capability keeps the admin's earlier revoke time.
      expect(rows).toHaveLength(1);
      expect(cap.revokedAt!.getTime()).toBeLessThanOrEqual(rows[0].at.getTime());
    });

    it("lists a person's own connections only, never another person's in the same org, whatever the caller's role", async () => {
      signInAs(LEAD);
      const leads = await connect({ clientId: CLIENT, agentId: "Claude", scopePath: SALES, permission: "read" });

      signInAs(ADMIN);
      expect(await list()).toEqual({ status: 200, body: { connections: [] } });
      signInAs(MEMBER);
      expect(await list()).toEqual({ status: 200, body: { connections: [] } });

      signInAs(LEAD);
      const own = await list();
      expect(own.body.connections.map((c: { id: string }) => c.id)).toEqual([leads.body.id]);
      expect(own.body.connections[0].scopeName).toBe("Sales");
    });

    it("answers 404 on the list while the flag is off, before reading the session", async () => {
      vi.stubEnv("MCP_OAUTH_ENABLED", "false");
      const res = await listGET();
      expect(res.status).toBe(404);
      expect(requireAccessContext).not.toHaveBeenCalled();
    });
  });
});
