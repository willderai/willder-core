// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// GET /api/briefs/:id/staleness must not serialize a scope's changes to a
// reader without a covering read grant. Passing the brief scope directly to
// auditChangesUnderScope() while readableScopePaths() filters only the
// separate source counts would leak the audit targets and timestamps; the
// route's check() on the brief's own scope is what closes that, and this file
// proves it against a real database.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "org-scope-leak-f1";
const BRIEF_SCOPE = "org_1.sales"; // the brief's scope
const READER_SCOPE = "org_1.engineering"; // the only scope the reader is granted
const READER = "u-f1";
const BRIEF_ID = "B-f1";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

describe.skipIf(!QA_URL)("staleness changes do not leak without a covering grant", () => {
  let db: PrismaClient;
  let getStaleness: (typeof import("./[id]/staleness/route"))["GET"];
  let check: (typeof import("@/services/access"))["check"];
  let requireAccessContext: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ GET: getStaleness } = await import("./[id]/staleness/route"));
    ({ check } = await import("@/services/access"));
    ({ requireAccessContext } = (await import("@/lib/access-context")) as never);

    for (const m of ["auditLog", "brief", "grant", "scope", "user"] as const) {
      await (db[m] as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where: { orgId: ORG } });
    }
    await db.org.deleteMany({ where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: "QA f1" } });
    await db.user.create({
      data: { id: READER, orgId: ORG, email: "f1@qa.test", role: "member", clerkId: "clerk-f1" },
    });
    const briefScope = await db.scope.create({ data: { orgId: ORG, path: BRIEF_SCOPE, name: "sales" } });
    const readerScope = await db.scope.create({ data: { orgId: ORG, path: READER_SCOPE, name: "eng" } });
    void briefScope;
    // The reader holds a real grant, but on a SIBLING scope only.
    await db.grant.create({
      data: { orgId: ORG, scopeId: readerScope.id, granteeType: "user", granteeId: READER, permission: "read" },
    });
    await db.brief.create({
      data: {
        id: BRIEF_ID,
        orgId: ORG,
        type: "handoff",
        scopePath: BRIEF_SCOPE,
        title: "t",
        summary: "s",
        sections: {},
        createdAt: new Date("2026-09-01T00:00:00Z"),
      },
    });
    // A write under the BRIEF's scope, after generation.
    await db.auditLog.create({
      data: {
        id: "f1-secret-write",
        orgId: ORG,
        actorType: "human",
        actorId: "other",
        action: "memory.write",
        target: `${BRIEF_SCOPE}.dealX/entity:AcmeContract`,
        decision: "allow",
        at: new Date("2026-09-02T00:00:00Z"),
      },
    });
    requireAccessContext.mockResolvedValue({
      org: { id: ORG },
      ctx: { orgId: ORG, actor: { type: "human", id: READER, role: "member" } },
    } as never);
  });

  afterAll(async () => {
    for (const m of ["auditLog", "brief", "grant", "scope", "user"] as const) {
      await (db[m] as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where: { orgId: ORG } });
    }
    await db.org.deleteMany({ where: { id: ORG } });
    await db.$disconnect();
  });

  it("the evaluator denies this reader on the brief's scope", async () => {
    const d = await check({ orgId: ORG, actor: { type: "human", id: READER, role: "member" } } as never, {
      action: "memory.read",
      scope: BRIEF_SCOPE,
    });
    expect(d.allowed).toBe(false);
  });

  it("and the route answers 404, withholding the restricted scope's audit targets and timestamps", async () => {
    const res = await getStaleness(new Request("http://t"), { params: Promise.resolve({ id: BRIEF_ID }) } as never);
    const body = await res.json();
    console.log("staleness status:", res.status, "body:", JSON.stringify(body));
    expect(res.status).toBe(404);
  });
});
