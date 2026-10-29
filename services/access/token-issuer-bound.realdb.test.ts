// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A capability token is never wider than the person who minted it.
//
// Two halves, both asserted over every scope of a seeded tree rather than a
// hand-picked pair, against an independent oracle computed in this file from
// the grants the test itself wrote:
//
//   1. Minting. Inserting a `capabilities` row whose issuer (`createdBy`) is a
//      person succeeds exactly when that person currently holds the token's
//      permission on the token's scope, in the token's org. Every mint path
//      (the API route, the agent provisioners, the workflow engine) ends in that
//      insert, so the insert is what this exercises.
//   2. Use. check() allows an agent's token on a target exactly when the token
//      covers it AND its issuer can do the same thing there right now. Narrowing
//      or removing the issuer's access after the mint narrows the token with it.
//
// Tokens with no person behind them (`createdBy` null, or `system:<label>` for
// a scheduled job) are bounded by their own scope only, and stay that way.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never a live one.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;

type Permission = "read" | "write" | "admin";
type Role = "owner" | "admin" | "member";

const ORG = "org-qa-issuer-bound";
const OTHER_ORG = "org-qa-issuer-bound-other";
const ROOT = "org_qa_issuer_bound";
const OTHER_ROOT = "org_qa_issuer_bound_other";

/** Every scope in both orgs. `sales_x` is a sibling of `sales` whose name
 * differs only past the shared prefix, so a LIKE-style prefix match would leak. */
const TREE: { orgId: string; path: string }[] = [
  ROOT,
  `${ROOT}.eng`,
  `${ROOT}.eng.api`,
  `${ROOT}.eng.web`,
  `${ROOT}.sales`,
  `${ROOT}.sales.emea`,
  `${ROOT}.sales_x`,
  `${ROOT}.hr`,
]
  .map((path) => ({ orgId: ORG, path }))
  .concat([OTHER_ROOT, `${OTHER_ROOT}.eng`].map((path) => ({ orgId: OTHER_ORG, path })));

/** The two enumerating tests make several hundred round trips each. */
const ENUMERATION_TIMEOUT_MS = 60_000;

const PERMISSIONS: Permission[] = ["read", "write", "admin"];
const RANK: Record<Permission, number> = { read: 1, write: 2, admin: 3 };

type SeedGrant = {
  orgId: string;
  path: string;
  granteeType: "user" | "role" | "everyone";
  granteeId: string;
  permission: Permission;
  expiresAt?: Date;
};

type Person = { id: string; orgId: string; role: Role };

const PEOPLE: Person[] = [
  { id: "u-qa-ib-admin", orgId: ORG, role: "admin" },
  { id: "u-qa-ib-alice", orgId: ORG, role: "member" },
  { id: "u-qa-ib-bob", orgId: ORG, role: "member" },
  { id: "u-qa-ib-carol", orgId: ORG, role: "member" },
  { id: "u-qa-ib-outsider", orgId: OTHER_ORG, role: "admin" },
];

const BEFORE: SeedGrant[] = [
  { orgId: ORG, path: ROOT, granteeType: "role", granteeId: "admin", permission: "admin" },
  { orgId: ORG, path: `${ROOT}.eng`, granteeType: "user", granteeId: "u-qa-ib-alice", permission: "admin" },
  { orgId: ORG, path: `${ROOT}.sales.emea`, granteeType: "user", granteeId: "u-qa-ib-alice", permission: "read" },
  { orgId: ORG, path: `${ROOT}.sales`, granteeType: "user", granteeId: "u-qa-ib-bob", permission: "write" },
  { orgId: ORG, path: `${ROOT}.hr`, granteeType: "everyone", granteeId: "*", permission: "read" },
  // Expired: never counts, at mint or at use.
  {
    orgId: ORG,
    path: ROOT,
    granteeType: "user",
    granteeId: "u-qa-ib-carol",
    permission: "admin",
    expiresAt: new Date(Date.now() - 60_000),
  },
  { orgId: OTHER_ORG, path: OTHER_ROOT, granteeType: "role", granteeId: "admin", permission: "admin" },
];

/** True when `covering` is `target` or one of its ltree ancestors. */
function pathCovers(covering: string, target: string): boolean {
  return target === covering || target.startsWith(`${covering}.`);
}

/** The oracle: does `person` hold `permission` on `path` in `orgId` under `grants`? */
function holds(
  grants: SeedGrant[],
  people: Person[],
  personId: string,
  orgId: string,
  path: string,
  permission: Permission,
): boolean {
  const person = people.find((p) => p.id === personId);
  if (!person || person.orgId !== orgId) return false;
  return grants.some(
    (g) =>
      g.orgId === orgId &&
      (!g.expiresAt || g.expiresAt > new Date()) &&
      ((g.granteeType === "user" && g.granteeId === person.id) ||
        (g.granteeType === "role" && g.granteeId === person.role) ||
        g.granteeType === "everyone") &&
      RANK[g.permission] >= RANK[permission] &&
      pathCovers(g.path, path),
  );
}

describe.skipIf(!QA_URL)("a capability token is never wider than its issuer, real Postgres", () => {
  let db: PrismaClient;
  let check: (typeof import("./check"))["check"];
  let hashCapabilityToken: (typeof import("./capabilities"))["hashCapabilityToken"];
  let tokenSeq = 0;
  const inADay = () => new Date(Date.now() + 86_400_000);

  async function seedGrants(grants: SeedGrant[]) {
    await db.grant.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
    for (const g of grants) {
      const scope = await db.scope.findUniqueOrThrow({ where: { orgId_path: { orgId: g.orgId, path: g.path } } });
      await db.grant.create({
        data: {
          orgId: g.orgId,
          scopeId: scope.id,
          granteeType: g.granteeType,
          granteeId: g.granteeId,
          permission: g.permission,
          expiresAt: g.expiresAt,
        },
      });
    }
  }

  /** Insert a capability row the way every mint path does. Resolves to the raw
   * token on success, or to the database's refusal. */
  async function mint(input: { orgId: string; scopePath: string; permission: Permission; createdBy: string | null }) {
    const token = `qa-issuer-bound-token-${++tokenSeq}`;
    const agentId = `agent-qa-ib-${tokenSeq}`;
    try {
      await db.capability.create({
        data: { ...input, agentId, tokenHash: hashCapabilityToken(token), expiresAt: inADay() },
      });
      return { ok: true as const, token, agentId };
    } catch (error) {
      return { ok: false as const, error };
    }
  }

  async function allowed(
    orgId: string,
    agentId: string,
    token: string,
    action: "memory.read" | "memory.write",
    scope: string,
  ) {
    const decision = await check(
      { orgId, actor: { type: "agent", id: agentId, capabilityToken: token }, origin: "mcp" },
      { action, scope },
    );
    return decision.allowed;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ check } = await import("./check"));
    ({ hashCapabilityToken } = await import("./capabilities"));

    const orgs = { in: [ORG, OTHER_ORG] };
    await db.auditLog.deleteMany({ where: { orgId: orgs } });
    await db.capability.deleteMany({ where: { orgId: orgs } });
    await db.grant.deleteMany({ where: { orgId: orgs } });
    await db.scope.deleteMany({ where: { orgId: orgs } });
    await db.user.deleteMany({ where: { orgId: orgs } });
    await db.org.deleteMany({ where: { id: orgs } });

    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.org.create({ data: { id: OTHER_ORG, name: OTHER_ORG } });
    for (const s of TREE) await db.scope.create({ data: { orgId: s.orgId, path: s.path, name: s.path } });
    for (const p of PEOPLE) {
      await db.user.create({
        data: { id: p.id, orgId: p.orgId, clerkId: `clerk-${p.id}`, email: `${p.id}@example.test`, role: p.role },
      });
    }
    await seedGrants(BEFORE);
  });

  afterAll(async () => {
    const orgs = { in: [ORG, OTHER_ORG] };
    await db?.auditLog.deleteMany({ where: { orgId: orgs } });
    await db?.capability.deleteMany({ where: { orgId: orgs } });
    await db?.grant.deleteMany({ where: { orgId: orgs } });
    await db?.scope.deleteMany({ where: { orgId: orgs } });
    await db?.user.deleteMany({ where: { orgId: orgs } });
    await db?.org.deleteMany({ where: { id: orgs } });
    await db?.$disconnect();
  });

  it(
    "minting succeeds exactly when the issuer holds the permission on the scope, for every person, scope, permission and org",
    async () => {
      const mismatches: string[] = [];
      let refusals = 0;
      for (const person of PEOPLE) {
        for (const mintOrg of [ORG, OTHER_ORG]) {
          for (const scope of TREE) {
            for (const permission of PERMISSIONS) {
              // A token's scope must name a scope of its own org; asking for one in
              // the other org is the cross-tenant case, and must be refused too.
              const expected =
                scope.orgId === mintOrg && holds(BEFORE, PEOPLE, person.id, mintOrg, scope.path, permission);
              const result = await mint({ orgId: mintOrg, scopePath: scope.path, permission, createdBy: person.id });
              if (!result.ok) refusals++;
              if (result.ok !== expected) {
                mismatches.push(
                  `${person.id} minting ${permission} on ${scope.path} in ${mintOrg}: expected ${expected ? "allowed" : "refused"}`,
                );
              }
            }
          }
        }
      }
      expect(mismatches).toEqual([]);
      // The enumeration is only meaningful if both outcomes occurred.
      expect(refusals).toBeGreaterThan(0);
    },
    ENUMERATION_TIMEOUT_MS,
  );

  it("an issuer id that names no person in the org is refused, never treated as a system token", async () => {
    const result = await mint({ orgId: ORG, scopePath: ROOT, permission: "read", createdBy: "u-qa-ib-nobody" });
    expect(result.ok).toBe(false);
  });

  it("a mint refusal is a permission error the caller can tell apart from a crash", async () => {
    const result = await mint({ orgId: ORG, scopePath: ROOT, permission: "admin", createdBy: "u-qa-ib-alice" });
    expect(result.ok).toBe(false);
    const { isIssuerBoundRefusal } = await import("./capabilities");
    expect(isIssuerBoundRefusal(result.ok ? null : result.error)).toBe(true);
  });

  it(
    "a token is refused on every scope its issuer can no longer read or write, after the issuer is narrowed or removed",
    async () => {
      await seedGrants(BEFORE);
      // Every token each person could legitimately mint before the change.
      const tokens: { personId: string; scopePath: string; permission: Permission; token: string; agentId: string }[] =
        [];
      for (const person of PEOPLE.filter((p) => p.orgId === ORG)) {
        for (const scope of TREE.filter((s) => s.orgId === ORG)) {
          for (const permission of ["read", "write"] as Permission[]) {
            if (!holds(BEFORE, PEOPLE, person.id, ORG, scope.path, permission)) continue;
            const result = await mint({ orgId: ORG, scopePath: scope.path, permission, createdBy: person.id });
            if (!result.ok) throw new Error(`setup: legitimate mint refused for ${person.id} on ${scope.path}`);
            tokens.push({
              personId: person.id,
              scopePath: scope.path,
              permission,
              token: result.token,
              agentId: result.agentId,
            });
          }
        }
      }
      expect(tokens.length).toBeGreaterThan(10);

      // After: alice is demoted from admin on eng to read on eng.api only; bob
      // leaves the org (the membership-deleted webhook deletes his user row); the
      // admin role is demoted to read at the root; the hr everyone-grant is gone.
      const AFTER: SeedGrant[] = [
        { orgId: ORG, path: ROOT, granteeType: "role", granteeId: "admin", permission: "read" },
        { orgId: ORG, path: `${ROOT}.eng.api`, granteeType: "user", granteeId: "u-qa-ib-alice", permission: "read" },
        { orgId: ORG, path: `${ROOT}.sales.emea`, granteeType: "user", granteeId: "u-qa-ib-alice", permission: "read" },
        { orgId: ORG, path: `${ROOT}.sales`, granteeType: "user", granteeId: "u-qa-ib-bob", permission: "write" },
        { orgId: OTHER_ORG, path: OTHER_ROOT, granteeType: "role", granteeId: "admin", permission: "admin" },
      ];
      await seedGrants(AFTER);
      await db.user.delete({ where: { id: "u-qa-ib-bob" } });
      const peopleAfter = PEOPLE.filter((p) => p.id !== "u-qa-ib-bob");

      const mismatches: string[] = [];
      let narrowed = 0;
      for (const t of tokens) {
        for (const target of TREE) {
          for (const action of ["memory.read", "memory.write"] as const) {
            const needed: Permission = action === "memory.read" ? "read" : "write";
            const tokenCovers =
              target.orgId === ORG && pathCovers(t.scopePath, target.path) && RANK[t.permission] >= RANK[needed];
            const expected = tokenCovers && holds(AFTER, peopleAfter, t.personId, ORG, target.path, needed);
            if (tokenCovers && !expected) narrowed++;
            const actual = await allowed(target.orgId, t.agentId, t.token, action, target.path);
            if (actual !== expected) {
              mismatches.push(
                `${t.personId}'s ${t.permission} token on ${t.scopePath}, ${action} ${target.path}: expected ${expected ? "allow" : "deny"}`,
              );
            }
          }
        }
      }
      expect(mismatches).toEqual([]);
      expect(narrowed).toBeGreaterThan(0);
    },
    ENUMERATION_TIMEOUT_MS,
  );

  it("a token with no person behind it is bounded by its own scope only", async () => {
    await seedGrants([]);
    const system = await mint({ orgId: ORG, scopePath: `${ROOT}.eng`, permission: "read", createdBy: "system:cron" });
    const unattributed = await mint({ orgId: ORG, scopePath: `${ROOT}.eng`, permission: "read", createdBy: null });
    for (const result of [system, unattributed]) {
      if (!result.ok) throw new Error("setup: a token with no person behind it was refused at mint");
      expect(await allowed(ORG, result.agentId, result.token, "memory.read", `${ROOT}.eng.api`)).toBe(true);
      expect(await allowed(ORG, result.agentId, result.token, "memory.read", `${ROOT}.sales`)).toBe(false);
      expect(await allowed(ORG, result.agentId, result.token, "memory.write", `${ROOT}.eng`)).toBe(false);
    }
  });

  it("a person-issued token cannot be widened past its issuer by updating its scope, permission or org", async () => {
    await seedGrants(BEFORE);
    const result = await mint({
      orgId: ORG,
      scopePath: `${ROOT}.eng.api`,
      permission: "read",
      createdBy: "u-qa-ib-alice",
    });
    if (!result.ok) throw new Error("setup: alice's read mint on eng.api was refused");
    const where = { tokenHash: hashCapabilityToken(result.token) };

    // alice holds admin on eng and read on sales.emea, nothing else of her own.
    const widenings = [
      { scopePath: ROOT },
      { scopePath: `${ROOT}.sales` },
      { scopePath: `${ROOT}.sales.emea`, permission: "write" as const },
      { orgId: OTHER_ORG, scopePath: OTHER_ROOT },
    ];
    for (const data of widenings) {
      await expect(db.capability.update({ where, data }), JSON.stringify(data)).rejects.toThrow();
    }
    // A change that stays inside what she holds is still allowed.
    await db.capability.update({ where, data: { scopePath: `${ROOT}.eng`, permission: "write" } });
    const row = await db.capability.findUniqueOrThrow({ where });
    expect([row.scopePath, row.permission, row.issuedByPerson]).toEqual([`${ROOT}.eng`, "write", true]);
  });

  /**
   * Runs `body` while `access_person_holds` answers NULL for this file's org and
   * behaves normally everywhere else, then puts the original definition back.
   * The real function cannot return NULL today (its body is one EXISTS); this
   * proves that if a future body ever does, both gates read the unknown as a
   * refusal instead of as "the issuer still holds access".
   */
  async function whileIssuerCheckIsUnknown(body: () => Promise<void>) {
    const signature = `public.access_person_holds(text, text, "Permission", text)`;
    const [{ def }] = await db.$queryRawUnsafe<{ def: string }[]>(
      `SELECT pg_get_functiondef('${signature}'::regprocedure) AS def`,
    );
    const original = "public.access_person_holds(";
    if (!def.includes(original)) throw new Error("setup: unexpected access_person_holds definition");
    await db.$executeRawUnsafe(def.replace(original, "public.access_person_holds_qa_original("));
    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION public.access_person_holds(org_id text, user_id text, needed "Permission", target_path text)
      RETURNS boolean LANGUAGE sql STABLE SET search_path = public, pg_temp
      AS $$ SELECT CASE WHEN org_id = '${ORG}' THEN NULL
                        ELSE public.access_person_holds_qa_original(org_id, user_id, needed, target_path) END $$`);
    try {
      await body();
    } finally {
      await db.$executeRawUnsafe(def);
      await db.$executeRawUnsafe(
        `DROP FUNCTION public.access_person_holds_qa_original(text, text, "Permission", text)`,
      );
    }
  }

  it("access_person_holds answers false, never NULL, for every issuer it cannot place", async () => {
    await seedGrants(BEFORE);
    const cases: [string, string | null, string | null, Permission | null, string | null][] = [
      ["an issuer id that names nobody", ORG, "u-qa-ib-nobody", "read", `${ROOT}.hr`],
      ["an issuer from another org", ORG, "u-qa-ib-outsider", "read", `${ROOT}.hr`],
      ["a NULL issuer", ORG, null, "read", `${ROOT}.hr`],
      ["a NULL org", null, "u-qa-ib-alice", "read", `${ROOT}.eng`],
      ["a NULL permission", ORG, "u-qa-ib-alice", null, `${ROOT}.eng`],
      ["a NULL target", ORG, "u-qa-ib-alice", "read", null],
      ["every input NULL", null, null, null, null],
    ];
    const answers: Record<string, boolean | null> = {};
    for (const [label, orgId, userId, needed, target] of cases) {
      const [{ holds: answer }] = await db.$queryRaw<{ holds: boolean | null }[]>`
        SELECT "access_person_holds"(${orgId}::text, ${userId}::text, ${needed}::"Permission", ${target}::text) AS holds`;
      answers[label] = answer;
    }
    expect(answers).toEqual(Object.fromEntries(cases.map(([label]) => [label, false])));
  });

  it("check() refuses a person-issued token when the issuer check cannot answer", async () => {
    await seedGrants(BEFORE);
    const person = await mint({ orgId: ORG, scopePath: `${ROOT}.eng`, permission: "read", createdBy: "u-qa-ib-alice" });
    const system = await mint({ orgId: ORG, scopePath: `${ROOT}.eng`, permission: "read", createdBy: "system:cron" });
    if (!person.ok || !system.ok) throw new Error("setup: a legitimate mint was refused");
    expect(await allowed(ORG, person.agentId, person.token, "memory.read", `${ROOT}.eng.api`)).toBe(true);

    await whileIssuerCheckIsUnknown(async () => {
      expect(await allowed(ORG, person.agentId, person.token, "memory.read", `${ROOT}.eng.api`)).toBe(false);
      // No person behind it: the issuer check does not apply, so an unknown cannot narrow it.
      expect(await allowed(ORG, system.agentId, system.token, "memory.read", `${ROOT}.eng.api`)).toBe(true);
    });
    expect(await allowed(ORG, person.agentId, person.token, "memory.read", `${ROOT}.eng.api`)).toBe(true);
  });

  it("the mint trigger refuses a person-issued token when the issuer check cannot answer", async () => {
    await seedGrants(BEFORE);
    await whileIssuerCheckIsUnknown(async () => {
      const person = await mint({
        orgId: ORG,
        scopePath: `${ROOT}.eng`,
        permission: "read",
        createdBy: "u-qa-ib-alice",
      });
      expect(person.ok).toBe(false);
      const system = await mint({ orgId: ORG, scopePath: `${ROOT}.eng`, permission: "read", createdBy: "system:cron" });
      expect(system.ok).toBe(true);
    });
  });

  it("the stamp that marks a token as person-issued cannot be cleared by the writer", async () => {
    await seedGrants(BEFORE);
    const result = await mint({ orgId: ORG, scopePath: `${ROOT}.eng`, permission: "read", createdBy: "u-qa-ib-alice" });
    if (!result.ok) throw new Error("setup: alice's read mint on eng was refused");
    const row = await db.capability.findUniqueOrThrow({ where: { tokenHash: hashCapabilityToken(result.token) } });
    await db.capability.update({ where: { id: row.id }, data: { issuedByPerson: false } });
    await seedGrants([]);
    expect(await allowed(ORG, result.agentId, result.token, "memory.read", `${ROOT}.eng`)).toBe(false);
  });
});
