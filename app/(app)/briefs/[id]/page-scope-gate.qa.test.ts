// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Regression: the server-rendered /briefs/:id page must run the same scope gate
// the brief-read API routes run. The "denies" case below reproduces a real
// disclosure — an org member denied on the brief's scope still received the
// whole brief (title, summary, every section, the scope path it was drawn
// from) as server-rendered props while the API routes correctly 403'd them —
// and now asserts the fixed behavior instead.
//
// GET /api/briefs/:id and GET /api/briefs/:id/staleness are gated through
// check() on the brief's own scopePath; the server-rendered page is a third
// read surface, the one a grantee actually opens, and must be gated the same
// way.
//
// Guard removal must fail this file. Delete the check() call in page.tsx and
// the "denies" and "revoked" cases below both go red: without the gate the page
// returns brief props instead of calling notFound().
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never the sandbox's
// inherited DATABASE_URL, which points at live Neon. Skips cleanly without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-pagegate";
const OTHER_ORG = "org-qa-pagegate-other";
const BRIEF_SCOPE = "org_1.sales";
const SIBLING_SCOPE = "org_1.engineering";
const BRIEF_ID = "B-qa-pagegate";
const UNGRANTED_READER = "u-pagegate-ungranted";
const GRANTED_READER = "u-pagegate-granted";
const REVOKED_READER = "u-pagegate-revoked";
const OTHER_ORG_READER = "u-pagegate-other-org";

const SECRET_SUMMARY = "Acme is renegotiating at 40 percent off and may churn in Q4.";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
// next/navigation's notFound() throws a framework control-flow error; the real
// one is fine to let through, but a recognizable marker makes the assertions
// below say what they mean.
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

describe.skipIf(!QA_URL)("/briefs/:id page: scope gate", () => {
  let db: PrismaClient;
  let BriefPage: (typeof import("./page"))["default"];
  let check: (typeof import("@/services/access"))["check"];
  let requireAccessContext: ReturnType<typeof vi.fn>;
  let briefScopeId: string;

  const tenantTables = ["auditLog", "brief", "grant", "scope", "user"] as const;

  async function clearTenant(orgId: string) {
    for (const table of tenantTables) {
      await (db[table] as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where: { orgId } });
    }
    await db.org.deleteMany({ where: { id: orgId } });
  }

  /** Sign the given org member in, exactly as requireAccessContext() would. */
  function signIn(orgId: string, userId: string) {
    requireAccessContext.mockResolvedValue({
      org: { id: orgId },
      user: { id: userId },
      ctx: { orgId, actor: { type: "human", id: userId, role: "member" } },
    } as never);
  }

  const renderBrief = () => BriefPage({ params: Promise.resolve({ id: BRIEF_ID }) });

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ default: BriefPage } = await import("./page"));
    ({ check } = await import("@/services/access"));
    ({ requireAccessContext } = (await import("@/lib/access-context")) as never);

    await clearTenant(ORG);
    await clearTenant(OTHER_ORG);

    await db.org.create({ data: { id: ORG, name: "QA page gate" } });
    await db.org.create({ data: { id: OTHER_ORG, name: "QA page gate, other tenant" } });

    const briefScope = await db.scope.create({ data: { orgId: ORG, path: BRIEF_SCOPE, name: "sales" } });
    briefScopeId = briefScope.id;
    const siblingScope = await db.scope.create({ data: { orgId: ORG, path: SIBLING_SCOPE, name: "eng" } });

    await db.user.createMany({
      data: [
        { id: UNGRANTED_READER, orgId: ORG, email: "ungranted@qa.test", role: "member", clerkId: "clerk-pg-1" },
        { id: GRANTED_READER, orgId: ORG, email: "granted@qa.test", role: "member", clerkId: "clerk-pg-2" },
        { id: REVOKED_READER, orgId: ORG, email: "revoked@qa.test", role: "member", clerkId: "clerk-pg-3" },
        { id: OTHER_ORG_READER, orgId: OTHER_ORG, email: "other@qa.test", role: "member", clerkId: "clerk-pg-4" },
      ],
    });

    // A real member of the org, holding a real grant -- on a SIBLING scope only.
    // This is the revoked-grantee shape, not an anonymous visitor.
    await db.grant.create({
      data: {
        orgId: ORG,
        scopeId: siblingScope.id,
        granteeType: "user",
        granteeId: UNGRANTED_READER,
        permission: "read",
      },
    });
    // The allowed case: a member granted read on the brief's own scope.
    await db.grant.create({
      data: {
        orgId: ORG,
        scopeId: briefScopeId,
        granteeType: "user",
        granteeId: GRANTED_READER,
        permission: "read",
      },
    });

    await db.brief.create({
      data: {
        id: BRIEF_ID,
        orgId: ORG,
        type: "handoff",
        scopePath: BRIEF_SCOPE,
        title: "Acme handoff",
        summary: SECRET_SUMMARY,
        sections: [{ heading: "Open risks", content: SECRET_SUMMARY }],
        createdAt: new Date("2026-09-01T00:00:00Z"),
      },
    });
  });

  beforeEach(() => {
    requireAccessContext.mockReset();
  });

  afterAll(async () => {
    await clearTenant(ORG);
    await clearTenant(OTHER_ORG);
    await db.$disconnect();
  });

  it("the evaluator denies a reader holding no grant on the brief's scope", async () => {
    const decision = await check(
      { orgId: ORG, actor: { type: "human", id: UNGRANTED_READER, role: "member" } } as never,
      { action: "memory.read", scope: BRIEF_SCOPE },
    );
    expect(decision.allowed).toBe(false);
  });

  it("does not serve the brief to a reader the evaluator denies", async () => {
    signIn(ORG, UNGRANTED_READER);
    // notFound(), not a distinct denial: a denied reader must not be able to
    // tell a brief they may not read from one that does not exist.
    await expect(renderBrief()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("serves the brief to a reader granted read on its scope", async () => {
    signIn(ORG, GRANTED_READER);
    const rendered = (await renderBrief()) as {
      props: { brief: { summary: string; scopePath: string } };
    };
    expect(rendered.props.brief.summary).toBe(SECRET_SUMMARY);
    expect(rendered.props.brief.scopePath).toBe(BRIEF_SCOPE);
  });

  it("stops serving the brief once that reader's grant is revoked", async () => {
    signIn(ORG, REVOKED_READER);
    const grant = await db.grant.create({
      data: {
        orgId: ORG,
        scopeId: briefScopeId,
        granteeType: "user",
        granteeId: REVOKED_READER,
        permission: "read",
      },
    });

    const granted = (await renderBrief()) as { props: { brief: { summary: string } } };
    expect(granted.props.brief.summary).toBe(SECRET_SUMMARY);

    await db.grant.delete({ where: { id: grant.id } });

    await expect(renderBrief()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("does not serve the brief to a member of another tenant", async () => {
    signIn(OTHER_ORG, OTHER_ORG_READER);
    await expect(renderBrief()).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
