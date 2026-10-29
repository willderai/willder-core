// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// GET /api/memory/scopes against a real database: the candidate bound, and that
// the real access layer still decides which candidates come back.
//
// The claim under test: the route asks Postgres for at most
// MAX_DESCENDANT_SCOPES + 1 of the org's scopes inside the caller's grants, runs
// can() on at most MAX_DESCENDANT_SCOPES of them, and says `truncated: true` only
// when the caller can read more than that, never because the org holds more scopes.
// Inclusion is still can()'s decision (grant, expiry, tenant), and can() writes no
// audit row, so listing scopes never records a read.
//
// `probes` counts every $queryRaw: one for the caller's grants, one for the
// candidates, then one can() per candidate.
//
// Only the caller's identity is stubbed. The Prisma queries, the ltree grant join
// and the expiry clause in evaluate() all run against Postgres.
//
// Set QA_DATABASE_URL to an ISOLATED test database, never an inherited
// DATABASE_URL that may point at a live database. Skips cleanly without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-scopes-bound";
const OTHER_ORG = "org-qa-scopes-bound-other";
const USER = "user-qa-scopes-bound";
const ORG_ROOT = "org_qa_scopes_bound";
const OTHER_ROOT = "org_qa_scopes_other";

/** `dept_000`, `dept_001`, ...: zero-padded so path order is numeric order. */
const dept = (root: string, i: number) => `${root}.dept_${String(i).padStart(3, "0")}`;

describe.skipIf(!QA_URL)("GET /api/memory/scopes, real database", () => {
  let db: PrismaClient;
  let appDb: (typeof import("@/lib/db"))["db"];
  let GET: (typeof import("./route"))["GET"];
  let MAX: number;

  beforeAll(async () => {
    // Before the imports, so the `@/lib/db` singleton is built against the QA database.
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ GET } = await import("./route"));
    ({ db: appDb } = await import("@/lib/db"));
    ({ MAX_DESCENDANT_SCOPES: MAX } = await import("@/services/access"));
    const { requireAccessContext } = await import("@/lib/access-context");
    vi.mocked(requireAccessContext).mockResolvedValue({
      org: { id: ORG },
      user: { id: USER },
      ctx: { orgId: ORG, actor: { type: "human", id: USER, role: "member" } },
    } as never);
  });

  const cleanup = async () => {
    const orgs = { in: [ORG, OTHER_ORG] };
    await db.auditLog.deleteMany({ where: { orgId: orgs } });
    await db.grant.deleteMany({ where: { orgId: orgs } });
    await db.scope.deleteMany({ where: { orgId: orgs } });
    await db.user.deleteMany({ where: { id: USER } });
    await db.org.deleteMany({ where: { id: orgs } });
  };

  afterAll(async () => {
    await cleanup();
    await db.$disconnect();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanup();
    await db.org.create({ data: { id: ORG, name: "Scopes bound QA" } });
    await db.org.create({ data: { id: OTHER_ORG, name: "Scopes bound QA other" } });
    await db.user.create({
      data: { id: USER, orgId: ORG, email: "m@scopes.test", role: "member", clerkId: "clerk-scopes-bound" },
    });
  });

  /** Creates `count` sibling scopes under `root` in `orgId`; returns their ids by index. */
  const seedScopes = async (orgId: string, root: string, count: number) => {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const s = await db.scope.create({ data: { orgId, path: dept(root, i), name: `Dept ${i}` } });
      ids.push(s.id);
    }
    return ids;
  };

  const grantRead = (orgId: string, scopeId: string, expiresAt?: Date) =>
    db.grant.create({
      data: { orgId, scopeId, granteeType: "user", granteeId: USER, permission: "read", expiresAt },
    });

  const call = async () => {
    const probes = vi.spyOn(appDb, "$queryRaw");
    const res = await GET();
    const body = (await res.json()) as { scopes: { path: string }[]; truncated: boolean };
    return {
      status: res.status,
      paths: body.scopes.map((s) => s.path),
      truncated: body.truncated,
      probes: probes.mock.calls.length,
    };
  };

  it("a narrow member past the bound: their grant is found wherever it sorts, an expired one is not, and truncated is false", async () => {
    const ids = await seedScopes(ORG, ORG_ROOT, MAX + 10);
    await grantRead(ORG, ids[10]);
    await grantRead(ORG, ids[20], new Date(Date.now() - 60_000)); // expired: not readable
    await grantRead(ORG, ids[MAX + 5]); // sorts after MAX other scopes: still listed
    const otherIds = await seedScopes(OTHER_ORG, OTHER_ROOT, 3);
    await grantRead(OTHER_ORG, otherIds[0]); // same user id, other tenant

    const auditBefore = await db.auditLog.count({ where: { orgId: ORG } });
    const r = await call();

    expect(r.status).toBe(200);
    expect(r.paths).toEqual([dept(ORG_ROOT, 10), dept(ORG_ROOT, MAX + 5)]);
    // The org holds MAX + 10 scopes, but this member reads two of them.
    expect(r.truncated).toBe(false);
    expect(r.probes).toBe(2 + 2);
    // can(), not check(): a capability listing records no reads.
    expect(await db.auditLog.count({ where: { orgId: ORG } })).toBe(auditBefore);
  });

  it("past the bound for a caller who reads more than MAX scopes: probes MAX and says truncated", async () => {
    const root = await db.scope.create({ data: { orgId: ORG, path: ORG_ROOT, name: "Org" } });
    await seedScopes(ORG, ORG_ROOT, MAX + 10);
    await grantRead(ORG, root.id); // covers the root and every scope under it

    const r = await call();

    expect(r.paths).toEqual([ORG_ROOT, ...Array.from({ length: MAX - 1 }, (_, i) => dept(ORG_ROOT, i))]);
    expect(r.truncated).toBe(true);
    expect(r.probes).toBe(2 + MAX);
  });

  it("exactly at the bound: every readable scope probed, truncated false", async () => {
    const root = await db.scope.create({ data: { orgId: ORG, path: ORG_ROOT, name: "Org" } });
    await seedScopes(ORG, ORG_ROOT, MAX - 1);
    await grantRead(ORG, root.id);

    const r = await call();

    expect(r.paths).toHaveLength(MAX);
    expect(r.paths.at(-1)).toBe(dept(ORG_ROOT, MAX - 2));
    expect(r.truncated).toBe(false);
    expect(r.probes).toBe(2 + MAX);
  });

  it("another org's scopes never count toward the bound or the result", async () => {
    const ids = await seedScopes(ORG, ORG_ROOT, 30);
    await grantRead(ORG, ids[29]);
    const otherRoot = await db.scope.create({ data: { orgId: OTHER_ORG, path: OTHER_ROOT, name: "Other" } });
    await seedScopes(OTHER_ORG, OTHER_ROOT, MAX + 5);
    await grantRead(OTHER_ORG, otherRoot.id);

    const r = await call();

    expect(r.paths).toEqual([dept(ORG_ROOT, 29)]);
    expect(r.truncated).toBe(false);
    expect(r.probes).toBe(2 + 1);
  });
});
