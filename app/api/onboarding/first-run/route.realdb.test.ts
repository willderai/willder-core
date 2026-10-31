// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// GET /api/onboarding/first-run against a real Postgres. The route runs with the
// shipping check() evaluator, the real audit query and real Prisma; only the Clerk
// session is stubbed. Step 2 is driven through the real Timeline detail route, so
// the audit target the checklist searches for is the one that route actually writes.
//
// What this proves that the unit tests cannot: each done state flips on exactly the
// row that proves it (a fact create in this org, not an update, another record type
// or another org; a live person-minted token below the root, not a root, revoked,
// expired, system-minted or other-org one; a denial after the mint, not before), and
// the access.manage gate's refusal is a visible audit row.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "fr1";
const OTHER_ORG = "fr2";
const ROOT = `org_${ORG}`;
const ENG = `${ROOT}.eng`;
const ADMIN = "u-admin-first-run";
const MEMBER = "u-member-first-run";
const OTHER_ADMIN = "u-other-admin-first-run";
const AGENT = "scoped-agent";
const DAY = 24 * 60 * 60 * 1000;

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

describe.skipIf(!QA_URL)("first-run checklist route, real Postgres", () => {
  let db: PrismaClient;
  let GET: (typeof import("./route"))["GET"];
  let GET_CHANGE: (typeof import("@/app/api/audit/timeline/[changeId]/route"))["GET"];
  let signIn: (who: "admin" | "member") => Promise<void>;
  let seq = 0;

  async function wipe() {
    const orgs = { in: [ORG, OTHER_ORG] };
    await db.auditLog.deleteMany({ where: { orgId: orgs } });
    await db.changeEvent.deleteMany({ where: { orgId: orgs } });
    await db.capability.deleteMany({ where: { orgId: orgs } });
    await db.grant.deleteMany({ where: { orgId: orgs } });
    await db.scope.deleteMany({ where: { orgId: orgs } });
    await db.user.deleteMany({ where: { id: { in: [ADMIN, MEMBER, OTHER_ADMIN] } } });
    await deleteOrgsWithRetry(db, { where: { id: orgs } });
  }

  async function status() {
    await signIn("admin");
    const res = await GET();
    expect(res.status).toBe(200);
    return res.json();
  }

  function change(orgId: string, opts: { op?: "create" | "update"; recordType?: string; scopePath?: string } = {}) {
    const id = randomUUID();
    return db.changeEvent.create({
      data: {
        id,
        orgId,
        seq: ++seq,
        scopePath: opts.scopePath ?? ENG,
        recordType: opts.recordType ?? "fact",
        recordId: `rec-${id}`,
        op: opts.op ?? "create",
        actorId: "claude-code",
        actorType: "agent",
        origin: "mcp",
        summary: `secret text ${id}`,
      },
    });
  }

  function token(
    orgId: string,
    scopePath: string,
    extra: { createdBy?: string | null; revokedAt?: Date; expiresAt?: Date; createdAt?: Date } = {},
  ) {
    return db.capability.create({
      data: {
        orgId,
        agentId: AGENT,
        tokenHash: randomUUID(),
        scopePath,
        createdBy: extra.createdBy === undefined ? ADMIN : extra.createdBy,
        revokedAt: extra.revokedAt,
        expiresAt: extra.expiresAt ?? new Date(Date.now() + DAY),
        createdAt: extra.createdAt,
      },
    });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ GET } = await import("./route"));
    ({ GET: GET_CHANGE } = await import("@/app/api/audit/timeline/[changeId]/route"));
    const { requireAccessContext } = (await import("@/lib/access-context")) as never as {
      requireAccessContext: ReturnType<typeof vi.fn>;
    };

    await wipe();
    seq = Number((await db.changeEvent.aggregate({ _max: { seq: true } }))._max.seq ?? 0);
    const org = await db.org.create({ data: { id: ORG, name: "First run QA" } });
    await db.org.create({ data: { id: OTHER_ORG, name: "First run QA other" } });
    const admin = await db.user.create({
      data: {
        id: ADMIN,
        orgId: ORG,
        email: "a@first-run.test",
        role: "admin",
        clerkId: "clerk-fr-admin",
        name: "Ada Admin",
      },
    });
    const member = await db.user.create({
      data: {
        id: MEMBER,
        orgId: ORG,
        email: "m@first-run.test",
        role: "member",
        clerkId: "clerk-fr-member",
        name: "Mo Member",
      },
    });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    const eng = await db.scope.create({ data: { orgId: ORG, path: ENG, name: "Engineering" } });
    await db.user.create({
      data: {
        id: OTHER_ADMIN,
        orgId: OTHER_ORG,
        email: "o@first-run.test",
        role: "admin",
        clerkId: "clerk-fr-other",
        name: "Oz Other",
      },
    });
    const otherRoot = await db.scope.create({
      data: { orgId: OTHER_ORG, path: `org_${OTHER_ORG}`, name: "other root" },
    });
    await db.scope.create({ data: { orgId: OTHER_ORG, path: `org_${OTHER_ORG}.eng`, name: "Other eng" } });
    await db.grant.create({
      data: {
        orgId: OTHER_ORG,
        scopeId: otherRoot.id,
        granteeType: "user",
        granteeId: OTHER_ADMIN,
        permission: "admin",
      },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: eng.id, granteeType: "user", granteeId: MEMBER, permission: "read" },
    });

    signIn = async (who) => {
      const user = who === "admin" ? admin : member;
      requireAccessContext.mockResolvedValue({
        org,
        user,
        ctx: { orgId: ORG, actor: { type: "human", id: user.id, role: user.role } },
      });
    };
  });

  afterAll(async () => {
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  it("shows nothing done in an empty workspace", async () => {
    expect(await status()).toEqual({ fact: null, openedFact: false, subScopeToken: null, denied: false });
  });

  it("ignores another org's fact, a non-fact record and an update", async () => {
    await change(OTHER_ORG, { scopePath: `org_${OTHER_ORG}.eng` });
    await change(ORG, { recordType: "brief" });
    await change(ORG, { op: "update" });
    expect((await status()).fact).toBeNull();
  });

  it("marks step 1 from a fact create, naming writer, scope and entry point, never the text", async () => {
    const fact = await change(ORG);
    const body = await status();
    expect(body.fact).toEqual({
      changeId: fact.id,
      writer: '"claude-code" (agent token)',
      writerType: "agent",
      source: "MCP",
      scopeName: "Engineering",
    });
    expect(JSON.stringify(body)).not.toContain("secret text");
    expect(body.openedFact).toBe(false);
  });

  it("marks step 2 only after the person opens a change in the real Timeline detail route", async () => {
    const { fact } = await status();
    const res = await GET_CHANGE(new Request(`http://t/api/audit/timeline/x?scope=${ENG}`), {
      params: Promise.resolve({ changeId: fact.changeId }),
    });
    expect(res.status).toBe(200);
    expect((await status()).openedFact).toBe(true);
  });

  it("counts only a live, person-minted token below the root", async () => {
    await token(ORG, ROOT); // the root is not "less"
    await token(ORG, ENG, { revokedAt: new Date() });
    await token(ORG, ENG, { expiresAt: new Date(Date.now() - 1000) });
    await token(ORG, ENG, { createdBy: "system:qa" });
    await token(OTHER_ORG, `org_${OTHER_ORG}.eng`, { createdBy: OTHER_ADMIN });
    expect((await status()).subScopeToken).toBeNull();

    await token(ORG, ENG, { createdAt: new Date(Date.now() - 60_000) });
    const body = await status();
    expect(body.subScopeToken).toEqual({ agent: `"${AGENT}" (agent token)`, scopeName: "Engineering" });
    expect(body.denied).toBe(false);
  });

  it("marks step 3 on a denial of that agent after the mint, not before", async () => {
    const deny = (at: Date, actorId = AGENT) =>
      db.auditLog.create({
        data: {
          orgId: ORG,
          actorType: "agent",
          actorId,
          action: "memory.read",
          target: `${ROOT}/query:x`,
          decision: "deny",
          at,
        },
      });
    await deny(new Date(Date.now() - 2 * 60_000));
    await deny(new Date(), "another-agent");
    expect((await status()).denied).toBe(false);
    await deny(new Date());
    expect((await status()).denied).toBe(true);
  });

  it("refuses a member without access.manage, and the refusal is a visible audit row", async () => {
    await signIn("member");
    const before = await db.auditLog.count({ where: { orgId: ORG, actorId: MEMBER, decision: "deny" } });
    const res = await GET();
    expect(res.status).toBe(403);
    const rows = await db.auditLog.findMany({ where: { orgId: ORG, actorId: MEMBER, decision: "deny" } });
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)).toMatchObject({ action: "access.manage", target: `${ROOT}/onboarding:first-run` });
  });
});
