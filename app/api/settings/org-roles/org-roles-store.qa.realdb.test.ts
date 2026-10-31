// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The two registries' write paths once each decides inside its
// store (services/resolver/org-roles.ts, services/memory/entity-aliases.ts):
//   - a save of an existing role racing a remove of it never answers 500 (a save that
//     reads its row back after the upsert throws P2025);
//   - the alias registry's refused save and remove answer the write-refusal text for
//     an admin with no org-root grant and an admin who may only read it, alike for an
//     existing and a missing id, with one deny row each and no row changed;
//   - an allowed admin's save naming a person id with a NUL is answered 400 or 404,
//     not 500 (Postgres refuses a NUL byte in text; this predates the store move);
//     a NUL in a key (an alias entity id, a role, a row id) is answered 400 naming
//     the field or 404 for the id, while a refused admin gets the write refusal.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never a live one.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Org, PrismaClient, User } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;
const IMPORT_TIMEOUT_MS = 60_000;

const ORG = "org-qa-orstore-a";
const ROOT = `org_${ORG}`;
const ADMIN = "u-qa-orstore-admin";
const NO_GRANT_ADMIN = "u-qa-orstore-nogrant";
const READ_ONLY_ADMIN = "u-qa-orstore-read-admin";
const MEMBER = "u-qa-orstore-member";
const USERS = { in: [ADMIN, NO_GRANT_ADMIN, READ_ONLY_ADMIN, MEMBER] };
const ALIAS_REFUSED = {
  status: 403,
  body: { error: "only an admin with write access to the organization can change aliases" },
};
const ROUNDS = 60;

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/services/memory", async (importActual) => ({
  ...(await importActual<typeof import("@/services/memory")>()),
  memory: { ingest: async () => undefined, transferEntity: async () => undefined },
}));

describe.skipIf(!QA_URL)("org role and alias registries: write paths after the store decides (real Postgres)", () => {
  let db: PrismaClient;
  let roles: typeof import("@/app/api/settings/org-roles/route");
  let roleById: typeof import("@/app/api/settings/org-roles/[id]/route");
  let aliases: typeof import("@/app/api/settings/aliases/route");
  let aliasById: typeof import("@/app/api/settings/aliases/[id]/route");
  let as: (userId: string) => void;
  const people = new Map<string, { org: Org; user: User }>();

  async function reset() {
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.entityAlias.deleteMany({ where: { orgId: ORG } });
    await db.orgRole.deleteMany({ where: { orgId: ORG } });
    await db.grant.deleteMany({ where: { orgId: ORG } });
    await db.scope.deleteMany({ where: { orgId: ORG } });
    await db.user.deleteMany({ where: { id: USERS } });
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
  }

  const post = (route: { POST: (req: Request) => Promise<Response> }, url: string, body: unknown) =>
    route.POST(
      new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    );
  const del = (
    route: { DELETE: (req: Request, p: { params: Promise<{ id: string }> }) => Promise<Response> },
    id: string,
  ) => route.DELETE(new Request("http://localhost", { method: "DELETE" }), { params: Promise.resolve({ id }) });
  const seen = async (res: Response) => ({ status: res.status, body: await res.json() });
  /** A route call's status, or "threw" when the handler rejected (a 500 in Next). */
  const status = (p: Promise<Response>) =>
    p.then(
      (r) => r.status,
      (e) => `threw ${(e as { code?: string }).code ?? e}`,
    );

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    ({ db } = await import("@/lib/db"));
    const { requireAccessContext } = (await import("@/lib/access-context")) as unknown as {
      requireAccessContext: ReturnType<typeof vi.fn>;
    };
    roles = await import("@/app/api/settings/org-roles/route");
    roleById = await import("@/app/api/settings/org-roles/[id]/route");
    aliases = await import("@/app/api/settings/aliases/route");
    aliasById = await import("@/app/api/settings/aliases/[id]/route");

    await reset();
    const org = await db.org.create({ data: { id: ORG, clerkOrgId: `clerk_${ORG}`, name: ORG } });
    for (const [id, role] of [
      [ADMIN, "admin"],
      [NO_GRANT_ADMIN, "admin"],
      [READ_ONLY_ADMIN, "admin"],
      [MEMBER, "member"],
    ] as const) {
      people.set(id, {
        org,
        user: await db.user.create({
          data: { id, orgId: ORG, clerkId: `clerk_${id}`, email: `${id}@example.test`, name: id, role },
        }),
      });
    }
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: READ_ONLY_ADMIN, permission: "read" },
    });

    as = (userId) => {
      const { org: o, user } = people.get(userId)!;
      requireAccessContext.mockResolvedValue({
        org: o,
        user,
        ctx: { orgId: o.id, actor: { type: "human" as const, id: userId, role: user.role }, origin: "app" as const },
      });
    };
  }, IMPORT_TIMEOUT_MS);

  beforeEach(async () => {
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.entityAlias.deleteMany({ where: { orgId: ORG } });
    await db.orgRole.deleteMany({ where: { orgId: ORG } });
  });

  afterAll(async () => {
    if (db) await reset();
  });

  it("never answers 500 when a save of a role races a remove of it", async () => {
    as(ADMIN);
    const outcomes = new Set<string>();
    // The remove starts 0-9 ms after the save, so some rounds land it between the
    // save's upsert and its read of the row back: the window a 500 lives in.
    for (let round = 0; round < ROUNDS; round++) {
      const { id } = await db.orgRole.create({ data: { orgId: ORG, role: "CEO", userId: ADMIN, aliases: [] } });
      const [saved, removed] = await Promise.all([
        status(post(roles, "http://localhost/api/settings/org-roles", { role: "CEO", userId: MEMBER })),
        new Promise<void>((r) => setTimeout(r, round % 10)).then(() => status(del(roleById, id))),
      ]);
      outcomes.add(`delay ${round % 10}: save ${saved}, remove ${removed}`);
      await db.orgRole.deleteMany({ where: { orgId: ORG } });
    }

    expect([...outcomes].filter((o) => o.includes("threw") || o.includes("500"))).toEqual([]);
  }, 120_000);

  it("answers an allowed admin's save naming a person id with a NUL as a bad or unknown person, not 500", async () => {
    as(ADMIN);
    const answer = await status(
      post(roles, "http://localhost/api/settings/org-roles", { role: "CFO", userId: "u\u0000x" }),
    );

    expect([400, 404]).toContain(answer);
    expect(await db.orgRole.count({ where: { orgId: ORG } })).toBe(0);
  });

  it.each([NO_GRANT_ADMIN, READ_ONLY_ADMIN])(
    "refuses %s's alias save and remove with the write-refusal text, alike for an existing and a missing id",
    async (who) => {
      const { id } = await db.entityAlias.create({
        data: { orgId: ORG, entityType: "user", entityId: MEMBER, canonicalName: MEMBER, aliases: ["m"] },
      });
      as(who);
      const save = async (entityId: string) =>
        seen(
          await post(aliases, "http://localhost/api/settings/aliases", {
            entityId,
            entityType: "user",
            canonicalName: "X",
            aliases: ["x"],
          }),
        );
      const answers = [
        await save(MEMBER),
        await save("u-qa-orstore-nobody"),
        await seen(await del(aliasById, id)),
        await seen(await del(aliasById, "alias-missing")),
      ];

      expect(answers).toEqual(Array(4).fill(ALIAS_REFUSED));
      expect(
        await db.entityAlias.findMany({
          where: { orgId: ORG },
          select: { id: true, canonicalName: true, aliases: true },
        }),
      ).toEqual([{ id, canonicalName: MEMBER, aliases: ["m"] }]);
      expect(
        await db.auditLog.findMany({
          where: { orgId: ORG, actorId: who },
          orderBy: [{ at: "asc" }, { id: "asc" }],
          select: { action: true, target: true, decision: true },
        }),
      ).toEqual([
        { action: "memory.write", target: `${ROOT}/entity_alias:${MEMBER}`, decision: "deny" },
        { action: "memory.write", target: `${ROOT}/entity_alias:u-qa-orstore-nobody`, decision: "deny" },
        { action: "memory.write", target: `${ROOT}/entity_alias:${id}`, decision: "deny" },
        { action: "memory.write", target: `${ROOT}/entity_alias:alias-missing`, decision: "deny" },
      ]);
    },
  );

  it("answers a member's alias save and remove with the same text, one role-gate row each", async () => {
    as(MEMBER);
    const answers = [
      await seen(
        await post(aliases, "http://localhost/api/settings/aliases", {
          entityId: MEMBER,
          entityType: "user",
          canonicalName: "X",
          aliases: [],
        }),
      ),
      await seen(await del(aliasById, "alias-missing")),
    ];
    expect(answers).toEqual([ALIAS_REFUSED, ALIAS_REFUSED]);
    expect(await db.auditLog.count({ where: { orgId: ORG, actorId: MEMBER } })).toBe(2);
  });

  it.each([
    ["canonicalName", { canonicalName: "Ac\u0000me" }],
    ["aliases", { aliases: ["ok", "bad\u0000alias"] }],
    ["aliases", { aliases: ["ok", "bad\ud800alias"] }],
    ["aliases", { aliases: ["bad\udc00alias", "ok"] }],
    ["entityId", { entityId: "界".repeat(1000) }],
    ["entityId", { entityId: "entity\u0000id" }],
  ] as const)("answers invalid alias %s with a field-naming 400 and stores nothing", async (field, patch) => {
    as(ADMIN);
    const res = await post(aliases, "http://localhost/api/settings/aliases", {
      entityId: "entity-input-test",
      entityType: "account",
      canonicalName: "Acme",
      aliases: ["ok"],
      ...patch,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(field);
    expect(await db.entityAlias.count({ where: { orgId: ORG } })).toBe(0);
  });

  it("answers an allowed admin's alias remove naming an id with a NUL as not found, and removes nothing", async () => {
    await db.entityAlias.create({
      data: { orgId: ORG, entityType: "user", entityId: MEMBER, canonicalName: MEMBER, aliases: [] },
    });
    as(ADMIN);
    expect(await seen(await del(aliasById, "alias\u0000x"))).toEqual({ status: 404, body: { error: "not found" } });
    expect(await db.entityAlias.count({ where: { orgId: ORG } })).toBe(1);
  });

  it("stores multibyte keys exactly at the byte cap in both registries", async () => {
    as(ADMIN);
    const key = "😀".repeat(250);
    expect(
      (
        await post(aliases, "http://localhost/api/settings/aliases", {
          entityId: key,
          entityType: "account",
          canonicalName: "Acme 😀",
          aliases: ["名", "😀"],
        })
      ).status,
    ).toBe(201);
    expect((await post(roles, "http://localhost/api/settings/org-roles", { role: key, userId: MEMBER })).status).toBe(
      201,
    );
    expect(await db.entityAlias.findUnique({ where: { orgId_entityId: { orgId: ORG, entityId: key } } })).toMatchObject(
      {
        canonicalName: "Acme 😀",
        aliases: ["名", "😀"],
      },
    );
    expect(await db.orgRole.findUnique({ where: { orgId_role: { orgId: ORG, role: key } } })).toMatchObject({
      userId: MEMBER,
    });
  });

  it("answers 400 for an oversized org-role key before the index rejects it", async () => {
    as(ADMIN);
    const res = await post(roles, "http://localhost/api/settings/org-roles", {
      role: "界".repeat(1000),
      userId: MEMBER,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("role");
    expect(await db.orgRole.count({ where: { orgId: ORG } })).toBe(0);
  });

  it("answers a missing person when that person's real row is deleted just before upsert", async () => {
    as(ADMIN);
    const user = await db.user.findUniqueOrThrow({ where: { id: MEMBER } });
    // Place the delete after the holder lookup, before the real INSERT; PostgreSQL
    // raises the actual foreign-key error rather than a mocked Prisma exception.
    const lookup = vi
      .spyOn(db.orgRole, "findUnique")
      .mockImplementationOnce(() => db.user.delete({ where: { id: MEMBER } }).then(() => null) as never);
    try {
      const res = await post(roles, "http://localhost/api/settings/org-roles", { role: "CFO", userId: MEMBER });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "user not found in org" });
      expect(await db.orgRole.count({ where: { orgId: ORG } })).toBe(0);
    } finally {
      lookup.mockRestore();
      await db.user.upsert({ where: { id: MEMBER }, create: user, update: {} });
    }
  });

  it.each([NO_GRANT_ADMIN, READ_ONLY_ADMIN])(
    "refuses %s before reporting malformed text or key limits",
    async (who) => {
      as(who);
      const patches = [
        { canonicalName: "bad\u0000name" },
        { aliases: ["bad\ud800alias"] },
        { entityId: "界".repeat(1000) },
        { entityId: "entity\u0000id" },
      ];
      for (const patch of patches) {
        const res = await post(aliases, "http://localhost/api/settings/aliases", {
          entityId: "entity-input-test",
          entityType: "account",
          canonicalName: "Acme",
          aliases: ["ok"],
          ...patch,
        });
        expect(await seen(res)).toEqual(ALIAS_REFUSED);
      }
      expect(await seen(await del(aliasById, "alias\u0000x"))).toEqual(ALIAS_REFUSED);
      const ROLES_REFUSED = {
        status: 403,
        body: { error: "only an admin with write access to the organization can change roles" },
      };
      for (const role of ["界".repeat(1000), "C\u0000FO"]) {
        expect(
          await seen(await post(roles, "http://localhost/api/settings/org-roles", { role, userId: MEMBER })),
        ).toEqual(ROLES_REFUSED);
      }
      expect(await seen(await del(roleById, "role\u0000x"))).toEqual(ROLES_REFUSED);
      expect(await db.entityAlias.count({ where: { orgId: ORG } })).toBe(0);
      expect(await db.orgRole.count({ where: { orgId: ORG } })).toBe(0);
    },
  );

  it("propagates the organization foreign-key error after organization deletion", async () => {
    const orgId = `${ORG}-deleted`;
    const personId = `${MEMBER}-deleted`;
    const org = await db.org.create({ data: { id: orgId, clerkOrgId: `clerk_${orgId}`, name: orgId } });
    const user = await db.user.create({
      data: { id: personId, orgId, clerkId: `clerk_${personId}`, email: `${personId}@example.test`, role: "admin" },
    });
    const scope = await db.scope.create({ data: { orgId, path: `org_${orgId}`, name: "root" } });
    await db.grant.create({
      data: { orgId, scopeId: scope.id, granteeType: "user", granteeId: personId, permission: "admin" },
    });
    people.set(personId, { org, user });
    as(personId);
    const lookup = vi
      .spyOn(db.orgRole, "findUnique")
      .mockImplementationOnce(() => db.org.delete({ where: { id: orgId } }).then(() => null) as never);
    try {
      await expect(
        post(roles, "http://localhost/api/settings/org-roles", { role: "CFO", userId: personId }),
      ).rejects.toMatchObject({
        code: "P2003",
        meta: { driverAdapterError: { cause: { constraint: { index: "org_roles_orgId_fkey" } } } },
      });
    } finally {
      lookup.mockRestore();
      people.delete(personId);
      await deleteOrgsWithRetry(db, { where: { id: orgId } });
    }
  });
});
