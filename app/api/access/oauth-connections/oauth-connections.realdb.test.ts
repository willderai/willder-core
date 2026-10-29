// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Connecting an OAuth client gives it a capability no wider than the person who
// connected it, bound to that person, org and client, and revoking either the
// connection or the capability ends it.
//
// Two orgs, each with the role grant a new workspace gets (admins administer the
// root). In org A a team lead reads the whole org and administers Sales; a member
// only reads Sales. Every case drives the real route handlers against Postgres, where
// scope containment and the audit log are decided; only the Clerk session is faked.
// The authorize page, the token exchange and the token on /api/mcp are covered end to
// end in app/api/oauth/oauth-flow.realdb.test.ts.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG_A = "org-oauth-connect-a";
const ORG_B = "org-oauth-connect-b";
const ROOT_A = "org_oauth_connect_a";
const SALES = `${ROOT_A}.sales`;
const ENG = `${ROOT_A}.eng`;
const ROOT_B = "org_oauth_connect_b";

const ADMIN = "u-oauth-connect-admin";
const LEAD = "u-oauth-connect-lead";
const MEMBER = "u-oauth-connect-member";
const ADMIN_B = "u-oauth-connect-admin-b";

const CLAUDE = "https://claude.ai/oauth/mcp-client-metadata.json";
const CHATGPT = "client_2Xq9mVb7chatgpt";

const DAY_MS = 24 * 60 * 60 * 1000;

type Person = { id: string; orgId: string; role: "admin" | "member" };
const people: Record<string, Person> = {
  [ADMIN]: { id: ADMIN, orgId: ORG_A, role: "admin" },
  [LEAD]: { id: LEAD, orgId: ORG_A, role: "member" },
  [MEMBER]: { id: MEMBER, orgId: ORG_A, role: "member" },
  [ADMIN_B]: { id: ADMIN_B, orgId: ORG_B, role: "admin" },
};

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

describe.skipIf(!QA_URL)("OAuth connections, real Postgres", () => {
  let db: PrismaClient;
  let connectPOST: (typeof import("./route"))["POST"];
  let listGET: (typeof import("./route"))["GET"];
  let disconnectDELETE: (typeof import("./[id]/route"))["DELETE"];
  let capabilityDELETE: (typeof import("../capabilities/[id]/route"))["DELETE"];
  let requireAccessContext: ReturnType<typeof vi.fn>;

  function signInAs(userId: string) {
    const person = people[userId];
    requireAccessContext.mockResolvedValue({
      org: { id: person.orgId, name: person.orgId, clerkOrgId: `clerk_${person.orgId}` },
      user: { id: person.id },
      ctx: { orgId: person.orgId, actor: { type: "human", id: person.id, role: person.role }, origin: "app" },
    });
  }

  function connect(body: Record<string, unknown>) {
    return connectPOST(
      new Request("http://t/api/access/oauth-connections", { method: "POST", body: JSON.stringify(body) }),
    );
  }

  async function listConnections() {
    const res = await listGET();
    return { status: res.status, body: res.status === 200 ? await res.json() : null };
  }

  function disconnect(id: string) {
    return disconnectDELETE(new Request("http://t", { method: "DELETE" }), { params: Promise.resolve({ id }) });
  }

  function revokeCapability(id: string) {
    return capabilityDELETE(new Request("http://t", { method: "DELETE" }), { params: Promise.resolve({ id }) });
  }

  async function wipe() {
    for (const orgId of [ORG_A, ORG_B]) {
      await db.oAuthConnection.deleteMany({ where: { orgId } });
      await db.auditLog.deleteMany({ where: { orgId } });
      await db.capability.deleteMany({ where: { orgId } });
      await db.grant.deleteMany({ where: { orgId } });
      await db.scope.deleteMany({ where: { orgId } });
      await db.user.deleteMany({ where: { orgId } });
      await db.org.deleteMany({ where: { id: orgId } });
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
    await db.scope.create({ data: { orgId: ORG_A, path: ENG, name: "Engineering" } });
    const rootA = await db.scope.findUniqueOrThrow({ where: { orgId_path: { orgId: ORG_A, path: ROOT_A } } });

    for (const person of Object.values(people)) {
      await db.user.create({
        data: {
          id: person.id,
          orgId: person.orgId,
          email: `${person.id}@oauth-connect.test`,
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
    ({ POST: connectPOST, GET: listGET } = await import("./route"));
    ({ DELETE: disconnectDELETE } = await import("./[id]/route"));
    ({ DELETE: capabilityDELETE } = await import("../capabilities/[id]/route"));
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

  it("binds a scope admin's client to a capability at the chosen scope, issued by them, with no token handed out", async () => {
    signInAs(LEAD);
    const res = await connect({ clientId: CLAUDE, agentId: "Claude", scopePath: SALES, permission: "write" });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("wcap_");
    expect(body).not.toHaveProperty("token");

    const connection = await db.oAuthConnection.findUniqueOrThrow({
      where: { orgId_userId_clientId: { orgId: ORG_A, userId: LEAD, clientId: CLAUDE } },
      include: { capability: true },
    });
    expect(connection.id).toBe(body.id);
    expect(connection.revokedAt).toBeNull();
    expect(connection.capability).toMatchObject({
      orgId: ORG_A,
      agentId: "Claude",
      scopePath: SALES,
      permission: "write",
      createdBy: LEAD,
      revokedAt: null,
    });
    const lifetime = connection.capability.expiresAt.getTime() - Date.now();
    expect(lifetime).toBeGreaterThan(89 * DAY_MS);
    expect(lifetime).toBeLessThanOrEqual(90 * DAY_MS);

    const allow = await db.auditLog.findFirst({
      where: {
        orgId: ORG_A,
        actorId: LEAD,
        action: "access.manage",
        target: { contains: `capabilities:issue:${SALES}` },
      },
    });
    expect(allow?.decision).toBe("allow");
  });

  it("refuses a member who only reads the scope, records the deny, and writes no capability or connection", async () => {
    signInAs(MEMBER);
    const res = await connect({ clientId: CLAUDE, agentId: "Claude", scopePath: SALES, permission: "read" });

    expect(res.status).toBe(403);
    const deny = await db.auditLog.findFirst({ where: { orgId: ORG_A, actorId: MEMBER, action: "access.manage" } });
    expect(deny?.decision).toBe("deny");
    expect(await db.capability.count({ where: { orgId: ORG_A } })).toBe(0);
    expect(await db.oAuthConnection.count({ where: { orgId: ORG_A } })).toBe(0);
  });

  it("refuses a scope wider than the one the person administers, even one they can read", async () => {
    signInAs(LEAD);
    const wider = await connect({ clientId: CLAUDE, agentId: "Claude", scopePath: ROOT_A, permission: "read" });
    expect(wider.status).toBe(403);

    // Engineering is under the root the lead reads but outside Sales, which they administer.
    const sibling = await connect({ clientId: CLAUDE, agentId: "Claude", scopePath: ENG, permission: "read" });
    expect(sibling.status).toBe(403);

    const denies = await db.auditLog.count({
      where: { orgId: ORG_A, actorId: LEAD, action: "access.manage", decision: "deny" },
    });
    expect(denies).toBe(2);
    expect(await db.capability.count({ where: { orgId: ORG_A } })).toBe(0);
    expect(await db.oAuthConnection.count({ where: { orgId: ORG_A } })).toBe(0);
  });

  it("refuses another org's scope as if it did not exist", async () => {
    signInAs(ADMIN);
    const res = await connect({ clientId: CLAUDE, agentId: "Claude", scopePath: ROOT_B, permission: "read" });

    expect(res.status).toBe(404);
    expect(await db.capability.count({ where: { orgId: { in: [ORG_A, ORG_B] } } })).toBe(0);
    expect(await db.oAuthConnection.count({ where: { orgId: { in: [ORG_A, ORG_B] } } })).toBe(0);
  });

  it("refuses a connection without a client id", async () => {
    signInAs(ADMIN);
    const res = await connect({ clientId: "  ", agentId: "Claude", scopePath: SALES, permission: "read" });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("client_id");
    expect(await db.capability.count({ where: { orgId: ORG_A } })).toBe(0);
  });

  it("replaces the connection when the same client connects again and revokes the capability it replaced", async () => {
    signInAs(LEAD);
    const first = await (
      await connect({ clientId: CLAUDE, agentId: "Claude", scopePath: SALES, permission: "write" })
    ).json();
    const second = await connect({ clientId: CLAUDE, agentId: "Claude", scopePath: SALES, permission: "read" });
    expect(second.status).toBe(201);
    const replacement = await second.json();

    const connections = await db.oAuthConnection.findMany({ where: { orgId: ORG_A, userId: LEAD, clientId: CLAUDE } });
    expect(connections).toHaveLength(1);
    expect(connections[0].capabilityId).toBe(replacement.capabilityId);

    const old = await db.capability.findUniqueOrThrow({ where: { id: first.capabilityId } });
    expect(old.revokedAt).not.toBeNull();
    const current = await db.capability.findUniqueOrThrow({ where: { id: replacement.capabilityId } });
    expect(current).toMatchObject({ permission: "read", revokedAt: null });
  });

  it("keeps two connects racing from one client to one live capability", async () => {
    signInAs(LEAD);
    const results = await Promise.all([
      connect({ clientId: CLAUDE, agentId: "Claude", scopePath: SALES, permission: "read" }),
      connect({ clientId: CLAUDE, agentId: "Claude", scopePath: SALES, permission: "read" }),
    ]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);

    const connection = await db.oAuthConnection.findUniqueOrThrow({
      where: { orgId_userId_clientId: { orgId: ORG_A, userId: LEAD, clientId: CLAUDE } },
    });
    const live = await db.capability.findMany({ where: { orgId: ORG_A, createdBy: LEAD, revokedAt: null } });
    expect(live.map((c) => c.id)).toEqual([connection.capabilityId]);
  });

  it("keeps each client's connection separate for one person", async () => {
    signInAs(LEAD);
    await connect({ clientId: CLAUDE, agentId: "Claude", scopePath: SALES, permission: "read" });
    await connect({ clientId: CHATGPT, agentId: "ChatGPT", scopePath: SALES, permission: "read" });

    expect(await db.oAuthConnection.count({ where: { orgId: ORG_A, userId: LEAD } })).toBe(2);
    expect(await db.capability.count({ where: { orgId: ORG_A, createdBy: LEAD, revokedAt: null } })).toBe(2);
  });

  it("ends the connection and its capability when the person disconnects, and keeps the first timestamp", async () => {
    signInAs(LEAD);
    const connected = await (
      await connect({ clientId: CLAUDE, agentId: "Claude", scopePath: SALES, permission: "read" })
    ).json();

    const res = await disconnect(connected.id);
    expect(res.status).toBe(200);
    const connection = await db.oAuthConnection.findUniqueOrThrow({ where: { id: connected.id } });
    const capability = await db.capability.findUniqueOrThrow({ where: { id: connected.capabilityId } });
    expect(connection.revokedAt).not.toBeNull();
    expect(capability.revokedAt).toEqual(connection.revokedAt);

    const again = await (await disconnect(connected.id)).json();
    expect(again.alreadyRevoked).toBe(true);
    expect(new Date(again.revokedAt)).toEqual(connection.revokedAt);
  });

  it("answers another person's connection, in the same org or another, as not found and leaves it live", async () => {
    signInAs(LEAD);
    const connected = await (
      await connect({ clientId: CLAUDE, agentId: "Claude", scopePath: SALES, permission: "read" })
    ).json();

    signInAs(ADMIN);
    expect((await disconnect(connected.id)).status).toBe(404);
    signInAs(ADMIN_B);
    expect((await disconnect(connected.id)).status).toBe(404);

    const connection = await db.oAuthConnection.findUniqueOrThrow({
      where: { id: connected.id },
      include: { capability: true },
    });
    expect(connection.revokedAt).toBeNull();
    expect(connection.capability.revokedAt).toBeNull();
  });

  it("shows no live connection once an admin revokes its capability, and a reconnect binds a new one", async () => {
    signInAs(LEAD);
    const connected = await (
      await connect({ clientId: CLAUDE, agentId: "Claude", scopePath: SALES, permission: "read" })
    ).json();
    const { liveOAuthConnection } = await import("@/services/access");
    expect((await liveOAuthConnection(ORG_A, LEAD, CLAUDE))?.capabilityId).toBe(connected.capabilityId);

    signInAs(ADMIN);
    expect((await revokeCapability(connected.capabilityId)).status).toBe(200);
    expect(await liveOAuthConnection(ORG_A, LEAD, CLAUDE)).toBeNull();

    signInAs(LEAD);
    const reconnected = await (
      await connect({ clientId: CLAUDE, agentId: "Claude", scopePath: SALES, permission: "read" })
    ).json();
    expect((await liveOAuthConnection(ORG_A, LEAD, CLAUDE))?.capabilityId).toBe(reconnected.capabilityId);
  });

  it("shows no live connection once it expires", async () => {
    signInAs(LEAD);
    const connected = await (
      await connect({ clientId: CLAUDE, agentId: "Claude", scopePath: SALES, permission: "read" })
    ).json();
    await db.capability.update({
      where: { id: connected.capabilityId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const { liveOAuthConnection } = await import("@/services/access");
    expect(await liveOAuthConnection(ORG_A, LEAD, CLAUDE)).toBeNull();
  });

  it("refuses a connection that names no scope, even from an org admin, and writes nothing", async () => {
    signInAs(ADMIN);
    for (const scopePath of [undefined, "", "   "]) {
      const res = await connect({ clientId: CLAUDE, agentId: "Claude", scopePath, permission: "read" });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("scopePath");
    }

    expect(await db.capability.count({ where: { orgId: ORG_A } })).toBe(0);
    expect(await db.oAuthConnection.count({ where: { orgId: ORG_A } })).toBe(0);
  });

  it("records one audit row naming the app and its scope when the person disconnects, and none for a refused or repeated one", async () => {
    signInAs(LEAD);
    const connected = await (
      await connect({ clientId: CLAUDE, agentId: "Claude", scopePath: SALES, permission: "read" })
    ).json();

    signInAs(ADMIN);
    expect((await disconnect(connected.id)).status).toBe(404);
    signInAs(LEAD);
    expect((await disconnect(connected.id)).status).toBe(200);
    expect((await disconnect(connected.id)).status).toBe(200);

    const rows = await db.auditLog.findMany({ where: { orgId: ORG_A, action: "oauth.disconnected" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: "human",
      actorId: LEAD,
      decision: "allow",
      target: `${SALES}/oauth_connection:${connected.id}`,
      metadata: { connectionId: connected.id, clientId: CLAUDE, capabilityId: connected.capabilityId, origin: "app" },
    });
    const connection = await db.oAuthConnection.findUniqueOrThrow({ where: { id: connected.id } });
    expect(rows[0].at.getTime()).toBeGreaterThanOrEqual(connection.revokedAt!.getTime() - 1000);

    const { isVisibleAuditRow } = await import("@/services/audit/visibility");
    expect(isVisibleAuditRow(rows[0].action, rows[0].target, "allow")).toBe(true);
  });

  it("lists only the person's own live connections, newest first, with the scope's name and no token", async () => {
    signInAs(LEAD);
    const claude = await (
      await connect({ clientId: CLAUDE, agentId: "Claude", scopePath: SALES, permission: "write" })
    ).json();
    const chatgpt = await (
      await connect({ clientId: CHATGPT, agentId: "ChatGPT", scopePath: SALES, permission: "read" })
    ).json();
    signInAs(ADMIN);
    const admins = await (
      await connect({ clientId: CLAUDE, agentId: "Claude", scopePath: ENG, permission: "read" })
    ).json();

    signInAs(LEAD);
    const listed = await listConnections();
    expect(listed.status).toBe(200);
    expect(listed.body.connections.map((c: { id: string }) => c.id)).toEqual([chatgpt.id, claude.id]);
    expect(listed.body.connections[1]).toMatchObject({
      clientId: CLAUDE,
      agentId: "Claude",
      capabilityId: claude.capabilityId,
      scopePath: SALES,
      scopeName: "Sales",
      permission: "write",
    });
    expect(JSON.stringify(listed.body)).not.toMatch(/wcap_|token/i);

    // Disconnected, revoked by an admin, and expired connections all drop out.
    await disconnect(chatgpt.id);
    expect((await listConnections()).body.connections.map((c: { id: string }) => c.id)).toEqual([claude.id]);
    await db.capability.update({
      where: { id: claude.capabilityId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await listConnections()).body.connections).toEqual([]);

    signInAs(ADMIN);
    expect((await listConnections()).body.connections.map((c: { id: string }) => c.id)).toEqual([admins.id]);
    // A revoked connection drops out on its own, even with its capability still live.
    await db.oAuthConnection.update({ where: { id: admins.id }, data: { revokedAt: new Date() } });
    expect((await listConnections()).body.connections).toEqual([]);
    await db.oAuthConnection.update({ where: { id: admins.id }, data: { revokedAt: null } });
    expect((await revokeCapability(admins.capabilityId)).status).toBe(200);
    expect((await listConnections()).body.connections).toEqual([]);

    signInAs(ADMIN_B);
    expect((await listConnections()).body.connections).toEqual([]);
  });

  it("answers an unsigned-in list request with 401", async () => {
    requireAccessContext.mockResolvedValue(null);
    expect((await listConnections()).status).toBe(401);
  });

  it("answers 404 on every connection route while MCP_OAUTH_ENABLED is off, and writes nothing", async () => {
    signInAs(LEAD);
    const connected = await (
      await connect({ clientId: CLAUDE, agentId: "Claude", scopePath: SALES, permission: "read" })
    ).json();
    requireAccessContext.mockClear();

    for (const value of [undefined, "false", "1", "TRUE"]) {
      vi.stubEnv("MCP_OAUTH_ENABLED", value);

      expect(
        (await connect({ clientId: CHATGPT, agentId: "ChatGPT", scopePath: SALES, permission: "read" })).status,
      ).toBe(404);
      expect((await disconnect(connected.id)).status).toBe(404);
      expect((await listConnections()).status).toBe(404);
    }

    expect(requireAccessContext).not.toHaveBeenCalled();
    expect(await db.oAuthConnection.count({ where: { orgId: ORG_A, revokedAt: null } })).toBe(1);
    expect(await db.capability.count({ where: { orgId: ORG_A, revokedAt: null } })).toBe(1);
  });
});
