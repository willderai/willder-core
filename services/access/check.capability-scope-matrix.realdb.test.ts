// An agent token is allowed only on a scope it covers, whatever shape the token has.
//
// check() loads the presented token's capability row even when its scope does not
// cover the target, so a refusal can name the person who provisioned it. That row
// must never reach a decision rule. This file drives every capability shape that
// could be mistaken for a covering one through the shipping check() and can()
// against real Postgres, where the ltree containment and expiry predicates run:
// self, descendant, ancestor, a sibling sharing a label prefix, another org's tree,
// expired, revoked, wider and narrower permission, a token issued to another agent,
// a second token of the same agent, and a grant-governed agent whose live grant is
// narrower than its token.
//
// Needs QA_DATABASE_URL naming an isolated, migrated test database; skipped without it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const ORG = `orgscopematrix${RUN}`;
const OTHER_ORG = `orgscopematrixother${RUN}`;
const ROOT = `org_${ORG}`;
const OTHER_ROOT = `org_${OTHER_ORG}`;
const SALES = `${ROOT}.sales`;
const SALES_Q1 = `${SALES}.q1`;
const SALES_EU = `${ROOT}.sales_eu`;
const SALES_EU_Q1 = `${SALES_EU}.q1`;
const ENG = `${ROOT}.eng`;
const OTHER_SALES = `${OTHER_ROOT}.sales`;

const AGENT = `agent-scope-matrix-${RUN}`;
const OTHER_AGENT = `agent-scope-matrix-other-${RUN}`;
const GOVERNED = `agent-scope-matrix-governed-${RUN}`;
const PERSON = `user-scope-matrix-${RUN}`;

type Action = "memory.read" | "memory.write";

describe.skipIf(!QA_URL)("an agent token is allowed only where it covers (real database)", () => {
  let db: PrismaClient;
  let access: typeof import("@/services/access");
  const tokens: Record<string, string> = {};

  async function mint(
    name: string,
    data: { orgId?: string; agentId?: string; scopePath: string; permission?: "read" | "write" | "admin" },
    state: { expired?: boolean; revoked?: boolean; grantGoverned?: boolean } = {},
  ) {
    tokens[name] = access.generateCapabilityToken();
    await db.capability.create({
      data: {
        orgId: data.orgId ?? ORG,
        agentId: data.agentId ?? AGENT,
        tokenHash: access.hashCapabilityToken(tokens[name]),
        scopePath: data.scopePath,
        permission: data.permission ?? "read",
        expiresAt: new Date(Date.now() + (state.expired ? -60_000 : 86_400_000)),
        revokedAt: state.revoked ? new Date() : null,
        grantGoverned: state.grantGoverned ?? false,
        // A token is never wider than its issuer: PERSON administers ORG, and a
        // token in the other org has no person behind it.
        createdBy: (data.orgId ?? ORG) === ORG ? PERSON : "system:scope-matrix",
      },
    });
  }

  /** check() and can() must agree; returns the shared answer. */
  async function allowed(token: string, scope: string, action: Action = "memory.read", agentId = AGENT) {
    const ctx = {
      orgId: ORG,
      actor: { type: "agent" as const, id: agentId, capabilityToken: token },
      origin: "mcp" as const,
    };
    const checked = (await access.check(ctx, { action, scope })).allowed;
    const probed = (await access.can(ctx, { action, scope })).allowed;
    expect(probed, `can() and check() disagree on ${scope}`).toBe(checked);
    return checked;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    access = await import("@/services/access");
    await db.org.createMany({
      data: [
        { id: ORG, name: "Scope matrix" },
        { id: OTHER_ORG, name: "Other" },
      ],
    });
    await db.user.create({
      data: { id: PERSON, orgId: ORG, email: `${RUN}@matrix.test`, role: "admin", clerkId: `clerk-${RUN}` },
    });
    const scopeIds: Record<string, string> = {};
    for (const path of [ROOT, SALES, SALES_Q1, SALES_EU, SALES_EU_Q1, ENG]) {
      scopeIds[path] = (await db.scope.create({ data: { orgId: ORG, path, name: path } })).id;
    }
    for (const path of [OTHER_ROOT, OTHER_SALES]) {
      await db.scope.create({ data: { orgId: OTHER_ORG, path, name: path } });
    }
    await db.grant.create({
      data: { orgId: ORG, scopeId: scopeIds[ROOT], granteeType: "user", granteeId: PERSON, permission: "admin" },
    });

    await mint("sales", { scopePath: SALES });
    await mint("salesWrite", { scopePath: SALES, permission: "write" });
    await mint("expired", { scopePath: SALES }, { expired: true });
    await mint("revoked", { scopePath: SALES }, { revoked: true });
    await mint("root", { scopePath: ROOT });
    await mint("eng", { scopePath: ENG });
    await mint("otherAgent", { scopePath: SALES, agentId: OTHER_AGENT });
    await mint("otherOrg", { scopePath: OTHER_SALES, orgId: OTHER_ORG });
    await mint("otherOrgRoot", { scopePath: OTHER_ROOT, orgId: OTHER_ORG });
    // A grant-governed agent whose token reaches SALES while its live grant reaches only SALES_Q1.
    await mint("governed", { scopePath: SALES, agentId: GOVERNED }, { grantGoverned: true });
    await db.grant.create({
      data: { orgId: ORG, scopeId: scopeIds[SALES_Q1], granteeType: "agent", granteeId: GOVERNED, permission: "read" },
    });
  });

  afterAll(async () => {
    await db.grant.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
    await db.capability.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
    await db.user.deleteMany({ where: { id: PERSON } });
    await deleteOrgsWithRetry(db, { where: { id: { in: [ORG, OTHER_ORG] } } });
    await db.$disconnect();
  });

  it("a live token is allowed on its own scope and below it", async () => {
    expect(await allowed(tokens.sales, SALES)).toBe(true);
    expect(await allowed(tokens.sales, SALES_Q1)).toBe(true);
  });

  it("refuses the ancestor, a sibling, and a sibling that shares the label prefix", async () => {
    expect(await allowed(tokens.sales, ROOT)).toBe(false);
    expect(await allowed(tokens.sales, ENG)).toBe(false);
    expect(await allowed(tokens.sales, SALES_EU)).toBe(false);
    expect(await allowed(tokens.sales, SALES_EU_Q1)).toBe(false);
  });

  it("refuses another org's tree, from a token of either org", async () => {
    expect(await allowed(tokens.sales, OTHER_SALES)).toBe(false);
    expect(await allowed(tokens.root, OTHER_ROOT)).toBe(false);
    // Another org's token, even one covering the asked-for path, matches nothing here.
    expect(await allowed(tokens.otherOrg, OTHER_SALES)).toBe(false);
    expect(await allowed(tokens.otherOrgRoot, SALES)).toBe(false);
  });

  it("refuses an expired or revoked token on the scope it would cover", async () => {
    expect(await allowed(tokens.expired, SALES)).toBe(false);
    expect(await allowed(tokens.revoked, SALES)).toBe(false);
  });

  it("a wider permission covers a narrower action; a narrower one never a wider", async () => {
    expect(await allowed(tokens.salesWrite, SALES, "memory.read")).toBe(true);
    expect(await allowed(tokens.salesWrite, SALES_EU, "memory.read")).toBe(false);
    expect(await allowed(tokens.sales, SALES, "memory.write")).toBe(false);
  });

  it("a token issued to another agent is refused, covering or not", async () => {
    expect(await allowed(tokens.otherAgent, SALES)).toBe(false);
    expect(await allowed(tokens.otherAgent, SALES_EU)).toBe(false);
  });

  it("an agent cannot borrow coverage from its own other token", async () => {
    // The agent holds `root`, which covers ENG; the token it presents does not.
    expect(await allowed(tokens.root, ENG)).toBe(true);
    expect(await allowed(tokens.sales, ENG)).toBe(false);
    expect(await allowed(tokens.eng, SALES)).toBe(false);
  });

  it("a grant-governed agent is held to its narrower live grant inside its token's scope", async () => {
    expect(await allowed(tokens.governed, SALES_Q1, "memory.read", GOVERNED)).toBe(true);
    expect(await allowed(tokens.governed, SALES, "memory.read", GOVERNED)).toBe(false);
    expect(await allowed(tokens.governed, SALES_EU, "memory.read", GOVERNED)).toBe(false);
  });

  it("a token hash names one capability: a second row for the same hash is refused by the database", async () => {
    await expect(
      db.capability.create({
        data: {
          orgId: ORG,
          agentId: AGENT,
          tokenHash: access.hashCapabilityToken(tokens.sales),
          scopePath: ROOT,
          permission: "admin",
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      }),
    ).rejects.toThrow();
    expect(await allowed(tokens.sales, ROOT)).toBe(false);
  });

  it("every refusal for a scope the token does not cover still names the provisioner", async () => {
    const decision = await access.check(
      { orgId: ORG, actor: { type: "agent", id: AGENT, capabilityToken: tokens.sales }, origin: "mcp" },
      { action: "memory.read", scope: SALES_EU },
    );
    expect(decision).toMatchObject({ allowed: false, triggeredBy: PERSON });
    expect(decision.capabilityId).toBeUndefined();
  });
});
