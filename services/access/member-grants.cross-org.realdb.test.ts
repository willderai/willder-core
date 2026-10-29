// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A person's membership of one org never reaches another org's grants or
// scopes, through check(), readableScopePaths() or scopeReaders(), the three
// readers of services/access/member-grants.ts.
//
// Two orgs share scope labels and role names. One person is a member of A and
// an admin of B; one is a member of B only; one is a member of A who was
// removed from B. Every context claims `admin`, which check() must ignore.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never a live one.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "./check";
import { seedMember } from "./member.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const A = "org-qa-xorg-a";
const B = "org-qa-xorg-b";
const ROOT_A = "org_qa_xorg_a";
const ROOT_B = "org_qa_xorg_b";
const ENG_A = `${ROOT_A}.eng`;
const ENG_B = `${ROOT_B}.eng`;

/** A member in A, an admin in B. */
const BOTH = "u-qa-xorg-both";
/** A member of B only. */
const ONLY_B = "u-qa-xorg-only-b";
/** A member of A, removed from B. */
const LEFT_B = "u-qa-xorg-left-b";

describe.skipIf(!QA_URL)("a membership of one org reaches nothing in another, real Postgres", () => {
  let db: PrismaClient;
  let check: (typeof import("./check"))["check"];
  let readableScopePaths: (typeof import("./check"))["readableScopePaths"];
  let scopeReaders: (typeof import("./source-widening"))["scopeReaders"];

  /** A context in `orgId` claiming `admin`: check() reads the membership instead. */
  const ctx = (orgId: string, id: string): AccessContext => ({
    orgId,
    actor: { type: "human", id, role: "admin" },
    origin: "app",
  });
  const reads = async (orgId: string, id: string, scope: string) =>
    (await check(ctx(orgId, id), { action: "memory.read", scope })).allowed;
  const listed = async (orgId: string, scope: string) =>
    (await scopeReaders(orgId, scope)).map((p) => [p.id, p.role]).sort();

  async function reset() {
    await db.auditLog.deleteMany({ where: { orgId: { in: [A, B] } } });
    await db.grant.deleteMany({ where: { orgId: { in: [A, B] } } });
    await db.user.deleteMany({ where: { id: { in: [BOTH, ONLY_B, LEFT_B] } } });
    await db.org.deleteMany({ where: { id: { in: [A, B] } } });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ check, readableScopePaths } = await import("./check"));
    ({ scopeReaders } = await import("./source-widening"));
    await reset();

    // Both orgs as the tenant sync seeds them, with the same labels and role
    // grants: the admin role holds admin on the root.
    for (const [org, root] of [
      [A, ROOT_A],
      [B, ROOT_B],
    ] as const) {
      await db.org.create({ data: { id: org, name: org } });
      const rootScope = await db.scope.create({ data: { id: `sc-${org}-root`, orgId: org, path: root, name: "root" } });
      await db.scope.create({ data: { id: `sc-${org}-eng`, orgId: org, path: `${root}.eng`, name: "eng" } });
      await db.grant.create({
        data: { orgId: org, scopeId: rootScope.id, granteeType: "role", granteeId: "admin", permission: "admin" },
      });
    }
    await seedMember(db, { orgId: A, userId: BOTH, role: "member" });
    await seedMember(db, { orgId: B, userId: BOTH, role: "admin" });
    await seedMember(db, { orgId: B, userId: ONLY_B, role: "member" });
    await seedMember(db, { orgId: A, userId: LEFT_B, role: "member" });
    await seedMember(db, { orgId: B, userId: LEFT_B, role: "member" });
    await db.orgMembership.update({
      where: { orgId_userId: { orgId: B, userId: LEFT_B } },
      data: { removedAt: new Date() },
    });
    // In B, everyone may read eng, and the person who left B holds a grant there.
    await db.grant.create({
      data: { orgId: B, scopeId: `sc-${B}-eng`, granteeType: "everyone", granteeId: "*", permission: "read" },
    });
    await db.grant.create({
      data: { orgId: B, scopeId: `sc-${B}-eng`, granteeType: "user", granteeId: LEFT_B, permission: "read" },
    });
  });

  afterAll(async () => {
    if (!db) return;
    await reset();
    await db.$disconnect();
  });

  it("an admin role in B does not reach A, where the person is only a member", async () => {
    expect(await reads(B, BOTH, ENG_B)).toBe(true);
    expect(await reads(A, BOTH, ENG_A)).toBe(false);
    expect(await reads(A, BOTH, ROOT_A)).toBe(false);
    expect(await listed(A, ENG_A)).toEqual([]);
  });

  it("a context in one org never reaches the other org's scopes", async () => {
    expect(await reads(A, BOTH, ENG_B)).toBe(false);
    expect(await reads(B, BOTH, ENG_A)).toBe(false);
    expect(await reads(A, ONLY_B, ENG_B)).toBe(false);
    expect(await listed(A, ENG_B)).toEqual([]);
  });

  it("an everyone grant in B reaches B's live members only, and a removal from B holds while the A membership lives", async () => {
    expect(await reads(B, ONLY_B, ENG_B)).toBe(true);
    expect(await reads(B, LEFT_B, ENG_B)).toBe(false);
    expect(await reads(A, LEFT_B, ENG_B)).toBe(false);
    expect(await listed(B, ENG_B)).toEqual(
      [
        [BOTH, "admin"],
        [ONLY_B, "member"],
      ].sort(),
    );
  });

  it("readableScopePaths stays inside the context's org", async () => {
    expect(await readableScopePaths(ctx(A, BOTH))).toEqual([]);
    expect((await readableScopePaths(ctx(B, BOTH))).sort()).toEqual([ROOT_B, ENG_B]);
    expect(await readableScopePaths(ctx(A, LEFT_B))).toEqual([]);
  });

  // The app writes a grant only on a scope of its own org, but the database does
  // not enforce it: no composite key ties grants(orgId, scopeId) to scopes(orgId, id).
  describe("a grant row whose scope belongs to another org", () => {
    /** Org A's grant on B's root scope, and org B's grant on A's eng scope. */
    const MISMATCHED = ["g-qa-xorg-a-on-b", "g-qa-xorg-b-on-a"];
    beforeAll(async () => {
      await db.grant.create({
        data: {
          id: MISMATCHED[0],
          orgId: A,
          scopeId: `sc-${B}-root`,
          granteeType: "everyone",
          granteeId: "*",
          permission: "read",
        },
      });
      await db.grant.create({
        data: {
          id: MISMATCHED[1],
          orgId: B,
          scopeId: `sc-${A}-eng`,
          granteeType: "everyone",
          granteeId: "*",
          permission: "read",
        },
      });
    });
    afterAll(async () => {
      await db.grant.deleteMany({ where: { id: { in: MISMATCHED } } });
    });

    it("an A grant on a B scope lets no member of A read B, list it as readable, or be listed by it", async () => {
      expect(await reads(A, LEFT_B, ENG_B)).toBe(false);
      expect(await reads(A, BOTH, ENG_B)).toBe(false);
      expect(await readableScopePaths(ctx(A, LEFT_B))).toEqual([]);
      expect(await listed(A, ENG_B)).toEqual([]);
    });

    it("a B grant on an A scope lets no member of A read that scope, list it as readable, or be listed by it", async () => {
      expect(await reads(A, BOTH, ENG_A)).toBe(false);
      expect(await reads(A, LEFT_B, ENG_A)).toBe(false);
      expect(await readableScopePaths(ctx(A, BOTH))).toEqual([]);
      expect(await listed(A, ENG_A)).toEqual([]);
    });
  });
});
