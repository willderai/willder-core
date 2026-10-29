// GET /api/access/scopes/:id/readers lists every person and every live token
// that can read one scope, and check() agrees with it for every principal: each
// one listed is allowed to read the scope, each one left out is refused.
//
// The fixture puts one principal on each side of every rule check() applies:
// a grant to the user, their role, or everyone; a grant on an ancestor, the
// scope itself, a sibling, or a child; expired grants; tokens live, expired,
// revoked, outside the scope, belonging to a deactivated agent, or outliving
// the grant behind them; and a second org holding the same names.
//
// Drives the real route and check() against Postgres. Only the signed-in
// caller is stubbed. Set QA_DATABASE_URL to an isolated test database; the
// suite skips without it.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { Actor } from "@/services/access";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "whocanread";
const OTHER_ORG = "whocanreadother";
const ROOT = `org_${ORG}`;
const SALES = `${ROOT}.sales`;
const SALES_EMEA = `${SALES}.emea`;
const OPS = `${ROOT}.ops`;
const HOUR = 60 * 60 * 1000;

type Principal = { label: string; actor: Actor };

describe.skipIf(!QA_URL)("who can read a scope, and check() agrees, real Postgres", () => {
  let db: PrismaClient;
  let readersGET: (typeof import("./route"))["GET"];
  let check: (typeof import("@/services/access"))["check"];
  let hashCapabilityToken: (typeof import("@/services/access"))["hashCapabilityToken"];
  let requireAccessContext: ReturnType<typeof vi.fn>;
  let salesId: string;
  let otherOrgSalesId: string;
  const people: Principal[] = [];
  const tokens: Principal[] = [];

  async function wipe() {
    const orgs = { in: [ORG, OTHER_ORG] };
    for (const model of [db.auditLog, db.capability, db.agent, db.grant, db.scope, db.user] as unknown as {
      deleteMany(args: unknown): Promise<unknown>;
    }[]) {
      await model.deleteMany({ where: { orgId: orgs } });
    }
    await db.org.deleteMany({ where: { id: orgs } });
  }

  async function person(id: string, role: "owner" | "admin" | "member", orgId = ORG) {
    await db.user.create({ data: { id, orgId, clerkId: `clerk-${id}`, email: `${id}@whocanread.test`, role } });
    if (orgId === ORG) people.push({ label: id, actor: { type: "human", id, role } });
  }

  async function grant(
    scopeId: string,
    granteeType: "user" | "role" | "agent" | "everyone",
    granteeId: string,
    permission: "read" | "write" | "admin",
    extra: { expiresAt?: Date; orgId?: string } = {},
  ) {
    await db.grant.create({
      data: { orgId: extra.orgId ?? ORG, scopeId, granteeType, granteeId, permission, expiresAt: extra.expiresAt },
    });
  }

  /** A capability token for `agentId`; the raw value is kept so check() can be asked as that agent. */
  async function token(
    label: string,
    agentId: string,
    scopePath: string,
    extra: {
      permission?: "read" | "write" | "admin";
      expiresAt?: Date;
      revokedAt?: Date;
      grantGoverned?: boolean;
      orgId?: string;
    } = {},
  ) {
    const raw = `wcap_test_${label}_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: extra.orgId ?? ORG,
        agentId,
        tokenHash: hashCapabilityToken(raw),
        scopePath,
        permission: extra.permission ?? "read",
        expiresAt: extra.expiresAt ?? new Date(Date.now() + HOUR),
        revokedAt: extra.revokedAt,
        grantGoverned: extra.grantGoverned ?? false,
      },
    });
    if ((extra.orgId ?? ORG) === ORG)
      tokens.push({ label, actor: { type: "agent", id: agentId, capabilityToken: raw } });
  }

  beforeEach(async () => {
    process.env.DATABASE_URL = QA_URL;
    db ??= new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ GET: readersGET } = await import("./route"));
    ({ check, hashCapabilityToken } = await import("@/services/access"));
    ({ requireAccessContext } = (await import("@/lib/access-context")) as never as {
      requireAccessContext: ReturnType<typeof vi.fn>;
    });

    await wipe();
    people.length = 0;
    tokens.length = 0;
    await db.org.create({ data: { id: ORG, name: "who can read" } });
    await db.org.create({ data: { id: OTHER_ORG, name: "who can read, other org" } });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    const sales = await db.scope.create({ data: { orgId: ORG, path: SALES, name: "sales" } });
    const emea = await db.scope.create({ data: { orgId: ORG, path: SALES_EMEA, name: "emea" } });
    const ops = await db.scope.create({ data: { orgId: ORG, path: OPS, name: "ops" } });
    salesId = sales.id;
    const otherSales = await db.scope.create({ data: { orgId: OTHER_ORG, path: SALES, name: "sales" } });
    otherOrgSalesId = otherSales.id;
    const past = new Date(Date.now() - HOUR);

    // People.
    await person("owner-by-role", "owner");
    await grant(root.id, "role", "owner", "admin");
    await person("reader-on-scope", "member");
    await grant(sales.id, "user", "reader-on-scope", "read");
    await person("writer-on-root", "member");
    await grant(root.id, "user", "writer-on-root", "write");
    await person("grant-expired", "member");
    await grant(sales.id, "user", "grant-expired", "read", { expiresAt: past });
    await person("grant-on-sibling", "member");
    await grant(ops.id, "user", "grant-on-sibling", "read");
    await person("grant-on-child", "member");
    await grant(emea.id, "user", "grant-on-child", "read");
    await person("no-grant", "admin");
    await person("other-org-reader", "member", OTHER_ORG);
    await grant(otherSales.id, "user", "other-org-reader", "admin", { orgId: OTHER_ORG });
    await grant(otherSales.id, "everyone", "*", "read", { orgId: OTHER_ORG });
    // A role grant that has expired names nobody.
    await grant(sales.id, "role", "admin", "read", { expiresAt: past });

    // Tokens.
    await token("live-on-scope", "agent-reader", SALES);
    await token("live-on-root-write", "agent-writer", ROOT, { permission: "write" });
    await token("second-token-same-agent", "agent-reader", ROOT);
    await token("no-agent-row", "external-mcp-client", SALES);
    await token("expired", "agent-expired", SALES, { expiresAt: past });
    await token("revoked", "agent-revoked", SALES, { revokedAt: past });
    await token("on-sibling", "agent-sibling", OPS);
    await token("on-child", "agent-child", SALES_EMEA);
    await db.agent.create({ data: { orgId: ORG, agentKey: "agent-off", name: "off", role: "custom", active: false } });
    await token("agent-deactivated", "agent-off", SALES);
    await db.agent.create({ data: { orgId: ORG, agentKey: "agent-on", name: "on", role: "custom", active: true } });
    await token("agent-active", "agent-on", SALES);
    await token("grant-governed-backed", "agent-governed", SALES, { grantGoverned: true });
    await grant(root.id, "agent", "agent-governed", "read");
    await token("grant-governed-outlived", "agent-outlived", SALES, { grantGoverned: true });
    await grant(ops.id, "agent", "agent-outlived", "read");
    await token("grant-governed-grant-expired", "agent-grant-expired", SALES, { grantGoverned: true });
    await grant(root.id, "agent", "agent-grant-expired", "read", { expiresAt: past });
    await token("other-org", "agent-reader", SALES, { orgId: OTHER_ORG });

    requireAccessContext.mockResolvedValue({
      org: { id: ORG },
      user: { id: "owner-by-role" },
      ctx: { orgId: ORG, actor: { type: "human", id: "owner-by-role", role: "owner" }, origin: "api" },
    });
  });

  afterAll(async () => {
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  function getReaders(id = salesId) {
    return readersGET(new Request("http://t"), { params: Promise.resolve({ id }) });
  }

  async function allowedToRead(principal: Principal): Promise<boolean> {
    const decision = await check(
      { orgId: ORG, actor: principal.actor, origin: "api" },
      {
        action: "memory.read",
        scope: SALES,
        target: "who-can-read-agreement",
      },
    );
    return decision.allowed;
  }

  it("lists exactly the people and live tokens that can read the scope", async () => {
    const res = await getReaders();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.scope).toEqual({ id: salesId, path: SALES });
    expect(body.people.map((p: { id: string }) => p.id).sort()).toEqual(
      ["owner-by-role", "reader-on-scope", "writer-on-root"].sort(),
    );
    expect(body.people.find((p: { id: string }) => p.id === "owner-by-role")).toEqual({
      id: "owner-by-role",
      name: null,
      email: "owner-by-role@whocanread.test",
      role: "owner",
    });
    const tokenRows = body.tokens as { agentId: string; capabilityId: string; permission: string; expiresAt: string }[];
    expect(tokenRows.map((t) => `${t.agentId}:${t.permission}`).sort()).toEqual(
      [
        "agent-reader:read",
        "agent-reader:read",
        "agent-writer:write",
        "external-mcp-client:read",
        "agent-on:read",
        "agent-governed:read",
      ].sort(),
    );
    for (const row of tokenRows) {
      expect(row.capabilityId).toEqual(expect.any(String));
      expect(new Date(row.expiresAt).getTime()).toBeGreaterThan(Date.now());
    }
    // Never the token itself, nor its hash.
    expect(JSON.stringify(body)).not.toMatch(/wcap_|tokenHash/);
  });

  it("agrees with check() for every principal: listed means allowed, left out means refused", async () => {
    const body = await (await getReaders()).json();
    const listedPeople = new Set(body.people.map((p: { id: string }) => p.id));
    const listedCapabilityIds = new Set(body.tokens.map((t: { capabilityId: string }) => t.capabilityId));
    const capabilityIdOf = async (principal: Principal) => {
      if (principal.actor.type !== "agent") return "";
      if (!("capabilityToken" in principal.actor)) return principal.actor.capabilityId;
      return (await db.capability.findUnique({
        where: { tokenHash: hashCapabilityToken(principal.actor.capabilityToken) },
        select: { id: true },
      }))!.id;
    };

    const disagreements: string[] = [];
    for (const principal of people) {
      const listed = listedPeople.has(principal.actor.id);
      if (listed !== (await allowedToRead(principal))) disagreements.push(`person ${principal.label}`);
    }
    for (const principal of tokens) {
      const listed = listedCapabilityIds.has(await capabilityIdOf(principal));
      if (listed !== (await allowedToRead(principal))) disagreements.push(`token ${principal.label}`);
    }
    expect(disagreements).toEqual([]);
    // The fixture really has principals on both sides.
    expect(people.length - listedPeople.size).toBeGreaterThanOrEqual(4);
    expect(tokens.length - listedCapabilityIds.size).toBeGreaterThanOrEqual(6);
  });

  it("applies check()'s org and grantee-type edges: an agent switched off by id, look-alike rows in another org", async () => {
    const before = await (await getReaders()).json();
    const root = await db.scope.findFirstOrThrow({ where: { orgId: ORG, path: ROOT } });

    // An agent switched off whose token names it by database id, not by key.
    const offById = await db.agent.create({
      data: { orgId: ORG, agentKey: "agent-off-by-id", name: "off by id", role: "custom", active: false },
    });
    await token("agent-deactivated-by-id", offById.id, SALES);
    // Another org switches off an agent with the same key as a live agent here.
    await db.agent.create({
      data: { orgId: OTHER_ORG, agentKey: "agent-on", name: "on elsewhere", role: "custom", active: false },
    });
    // A grant-governed agent backed only by a grant in another org, or by a
    // grant to a user who happens to carry its id: neither backs the token.
    await token("grant-governed-other-org-grant", "agent-elsewhere", SALES, { grantGoverned: true });
    await grant(otherOrgSalesId, "agent", "agent-elsewhere", "read", { orgId: OTHER_ORG });
    await token("grant-governed-user-grant", "agent-as-user", SALES, { grantGoverned: true });
    await grant(root.id, "user", "agent-as-user", "read");
    // An owner in another org, where the owner role grant here does not reach.
    await person("other-org-owner", "owner", OTHER_ORG);

    const body = await (await getReaders()).json();
    expect(body.people).toEqual(before.people);
    expect(body.tokens).toEqual(before.tokens);
    for (const label of [
      "agent-deactivated-by-id",
      "agent-active",
      "grant-governed-other-org-grant",
      "grant-governed-user-grant",
    ]) {
      const principal = tokens.find((t) => t.label === label)!;
      const listed = body.tokens.some((t: { agentId: string }) => t.agentId === principal.actor.id);
      expect({ label, allowed: await allowedToRead(principal) }).toEqual({ label, allowed: listed });
    }
  });

  it("lists every person in the org, and no one outside it, once everyone may read the scope", async () => {
    await grant(salesId, "everyone", "*", "read");

    const body = await (await getReaders()).json();

    expect(body.people.map((p: { id: string }) => p.id).sort()).toEqual(people.map((p) => p.actor.id).sort());
    for (const principal of people) expect(await allowedToRead(principal)).toBe(true);
  });

  it("answers a scope in another org as not found", async () => {
    const res = await getReaders(otherOrgSalesId);
    expect(res.status).toBe(404);
  });

  it("refuses a caller who does not administer the scope", async () => {
    requireAccessContext.mockResolvedValue({
      org: { id: ORG },
      user: { id: "reader-on-scope" },
      ctx: { orgId: ORG, actor: { type: "human", id: "reader-on-scope", role: "member" }, origin: "api" },
    });
    const deniesBefore = await db.auditLog.count({ where: { orgId: ORG, decision: "deny" } });
    const res = await getReaders();
    expect(res.status).toBe(403);
    expect(await res.json()).not.toHaveProperty("people");
    // The refusal leaves exactly one deny row, naming the caller and the scope.
    const denies = await db.auditLog.findMany({
      where: { orgId: ORG, decision: "deny" },
      orderBy: { chainSeq: "asc" },
    });
    expect(denies.slice(deniesBefore)).toEqual([
      expect.objectContaining({
        actorType: "human",
        actorId: "reader-on-scope",
        target: `${SALES}/scopes:readers:${SALES}`,
      }),
    ]);
  });

  it("refuses an unauthenticated caller", async () => {
    requireAccessContext.mockResolvedValue(null);
    expect((await getReaders()).status).toBe(401);
  });
});
