// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// GET /api/memory/scopes against a real database: `truncated` and the listing are
// about the scopes the caller can read, never about how many scopes the org holds.
//
// The claim under test: a member granted one scope learns nothing from this route
// about scopes they cannot read. `truncated` is true only when the caller can read
// more than MAX_DESCENDANT_SCOPES scopes, so a narrow member in a large org reads
// `false`, and their own scope is listed wherever it sorts among the org's scopes.
// can() still decides each listed scope, at most MAX_DESCENDANT_SCOPES times.
//
// Only the caller's identity is stubbed. Membership, grants, expiry and the ltree
// containment all run against Postgres.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { seedMember } from "@/services/access/member.testsupport";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/services/access/check", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/services/access/check")>();
  return { ...real, can: vi.fn(real.can) };
});

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "k4mdscopesorg";
const OTHER_ORG = "k4mdscopesother";
const MEMBER = "k4md-scopes-member";
const ADMIN = "k4md-scopes-admin";
const ROOT = `org_${ORG}`;
const OTHER_ROOT = `org_${OTHER_ORG}`;

/** `<parent>.s_000`, `<parent>.s_001`, ...: zero-padded so path order is numeric order. */
const child = (parent: string, i: number) => `${parent}.s_${String(i).padStart(3, "0")}`;

describe.skipIf(!QA_URL)("GET /api/memory/scopes, what a narrow member learns", () => {
  let db: PrismaClient;
  let GET: (typeof import("./route"))["GET"];
  let MAX: number;
  let can: (typeof import("@/services/access/check"))["can"];
  let requireAccessContext: (typeof import("@/lib/access-context"))["requireAccessContext"];

  beforeAll(async () => {
    // Before the imports, so the `@/lib/db` singleton is built against the QA database.
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ GET } = await import("./route"));
    ({ MAX_DESCENDANT_SCOPES: MAX } = await import("@/services/access"));
    ({ can } = await import("@/services/access/check"));
    ({ requireAccessContext } = await import("@/lib/access-context"));
  });

  const cleanup = async () => {
    const orgs = { in: [ORG, OTHER_ORG] };
    await db.auditLog.deleteMany({ where: { orgId: orgs } });
    await db.grant.deleteMany({ where: { orgId: orgs } });
    await db.scope.deleteMany({ where: { orgId: orgs } });
    await db.orgMembership.deleteMany({ where: { orgId: orgs } });
    await db.user.deleteMany({ where: { id: { in: [MEMBER, ADMIN] } } });
    await db.org.deleteMany({ where: { id: orgs } });
  };

  afterAll(async () => {
    await cleanup();
    await db.$disconnect();
  });

  beforeEach(async () => {
    await cleanup();
    vi.mocked(can).mockClear();
    await db.org.create({ data: { id: ORG, name: "Scopes realdb" } });
    await db.org.create({ data: { id: OTHER_ORG, name: "Scopes realdb other" } });
    await seedMember(db, { orgId: ORG, userId: MEMBER, role: "member" });
    await seedMember(db, { orgId: ORG, userId: ADMIN, role: "admin" });
    await seedMember(db, { orgId: OTHER_ORG, userId: MEMBER, role: "member" });
  });

  /** Creates `paths` in `orgId`; returns their ids by path. */
  const seed = async (orgId: string, paths: string[]) => {
    const ids: Record<string, string> = {};
    for (const path of paths) ids[path] = (await db.scope.create({ data: { orgId, path, name: path } })).id;
    return ids;
  };
  const range = (parent: string, count: number) => Array.from({ length: count }, (_, i) => child(parent, i));

  const grant = (orgId: string, scopeId: string, userId = MEMBER, expiresAt?: Date) =>
    db.grant.create({
      data: { orgId, scopeId, granteeType: "user", granteeId: userId, permission: "read", expiresAt },
    });

  const callAs = async (userId: string, role: "member" | "admin") => {
    vi.mocked(requireAccessContext).mockResolvedValue({
      org: { id: ORG },
      user: { id: userId, role },
      ctx: { orgId: ORG, actor: { type: "human", id: userId, role } },
    } as never);
    const res = await GET();
    const body = (await res.json()) as { scopes: { path: string }[]; truncated: boolean };
    return {
      status: res.status,
      paths: body.scopes.map((s) => s.path),
      truncated: body.truncated,
      probes: vi.mocked(can).mock.calls.length,
    };
  };

  it("a member granted one scope in an org of more than MAX scopes reads truncated: false", async () => {
    const ids = await seed(ORG, [ROOT, ...range(ROOT, MAX + 10)]);
    await grant(ORG, ids[child(ROOT, 3)]);

    const r = await callAs(MEMBER, "member");

    expect(r.status).toBe(200);
    expect(r.paths).toEqual([child(ROOT, 3)]);
    expect(r.truncated).toBe(false);
  });

  it("a member's scope is listed even when MAX other scopes sort before it", async () => {
    const ids = await seed(ORG, [ROOT, ...range(ROOT, MAX + 10)]);
    await grant(ORG, ids[child(ROOT, MAX + 5)]);

    const r = await callAs(MEMBER, "member");

    expect(r.paths).toEqual([child(ROOT, MAX + 5)]);
    expect(r.truncated).toBe(false);
  });

  it("truncated is true when the member can read more than MAX scopes, and can() runs at most MAX times", async () => {
    const team = `${ROOT}.team`;
    const ids = await seed(ORG, [ROOT, team, ...range(team, MAX), ...range(`${ROOT}.other`, 5)]);
    await grant(ORG, ids[team]); // covers the team and its MAX children: MAX + 1 readable scopes

    const r = await callAs(MEMBER, "member");

    expect(r.truncated).toBe(true);
    expect(r.paths).toEqual([team, ...range(team, MAX - 1)]);
    expect(r.probes).toBe(MAX);
  });

  it("exactly MAX readable scopes in a larger org: every one listed, truncated false", async () => {
    const team = `${ROOT}.team`;
    const ids = await seed(ORG, [ROOT, team, ...range(team, MAX - 1), ...range(`${ROOT}.other`, 5)]);
    await grant(ORG, ids[team]);

    const r = await callAs(MEMBER, "member");

    expect(r.paths).toEqual([team, ...range(team, MAX - 1)]);
    expect(r.truncated).toBe(false);
    expect(r.probes).toBe(MAX);
  });

  it("an expired grant on a large subtree makes none of it readable, so it is not counted", async () => {
    const team = `${ROOT}.team`;
    const ids = await seed(ORG, [ROOT, team, ...range(team, MAX + 5), `${ROOT}.mine`]);
    await grant(ORG, ids[team], MEMBER, new Date(Date.now() - 60_000));
    await grant(ORG, ids[`${ROOT}.mine`]);

    const r = await callAs(MEMBER, "member");

    expect(r.paths).toEqual([`${ROOT}.mine`]);
    expect(r.truncated).toBe(false);
  });

  it("the same person's grants in another org never count", async () => {
    const ids = await seed(ORG, [ROOT, `${ROOT}.mine`]);
    const otherIds = await seed(OTHER_ORG, [OTHER_ROOT, ...range(OTHER_ROOT, MAX + 5)]);
    await grant(ORG, ids[`${ROOT}.mine`]);
    await grant(OTHER_ORG, otherIds[OTHER_ROOT]);

    const r = await callAs(MEMBER, "member");

    expect(r.paths).toEqual([`${ROOT}.mine`]);
    expect(r.truncated).toBe(false);
  });

  it("an admin, whose grant covers the org root, reads truncated: true for an org of more than MAX scopes", async () => {
    const ids = await seed(ORG, [ROOT, ...range(ROOT, MAX + 10)]);
    await db.grant.create({
      data: { orgId: ORG, scopeId: ids[ROOT], granteeType: "role", granteeId: "admin", permission: "admin" },
    });

    const r = await callAs(ADMIN, "admin");

    expect(r.truncated).toBe(true);
    expect(r.paths).toEqual([ROOT, ...range(ROOT, MAX - 1)]);
    expect(r.probes).toBe(MAX);
  });

  it("a member with no grant reads an empty list and truncated: false", async () => {
    await seed(ORG, [ROOT, ...range(ROOT, MAX + 10)]);

    const r = await callAs(MEMBER, "member");

    expect(r.paths).toEqual([]);
    expect(r.truncated).toBe(false);
  });
});
