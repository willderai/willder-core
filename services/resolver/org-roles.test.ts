// The org role registry decides inside its own functions. Every function that serves
// a person takes that person's AccessContext and asks check() at the org root before
// it reads a role, a person or a row id, so a new caller cannot reach a row without a
// decision (a safety helper that every route must remember to call will be missed).
//
// Two halves. The `@ts-expect-error` lines are a compile-time test: `tsc --noEmit`
// fails with "Unused '@ts-expect-error' directive" the moment a store function
// accepts a bare org id again, so a green vitest run alone does not execute them.
// The runtime half pins the decision itself: what check() is asked, and that a
// refusal touches no row. The real-Postgres half, with real grants and audit rows,
// is app/api/settings/org-roles/org-roles-access.realdb.test.ts.
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

vi.mock("@/services/access", async (importActual) => ({
  ...(await importActual<typeof import("@/services/access")>()),
  check: vi.fn(),
  liveMembership: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    orgRole: { findMany: vi.fn(), findUnique: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
    user: { findUnique: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));

import { db } from "@/lib/db";
import { check, liveMembership, orgRootPath, type AccessContext } from "@/services/access";
import * as registry from "./org-roles";
import { readOrgRolePage, removeOrgRole, saveOrgRole } from "./org-roles";

const ctx: AccessContext = { orgId: "org_1", actor: { type: "human", id: "u_admin", role: "admin" }, origin: "app" };
const query = new URLSearchParams("page=1");
const input = { role: "CEO", userId: "u_ceo", aliases: [] };
const row = { id: "role_1", role: "CEO", aliases: [], user: { id: "u_ceo", name: "Ada", email: "ada@acme.test" } };

/** Whether any registry row, person or membership was read or written. */
const touchedAnything = () =>
  [...Object.values(db.orgRole), db.user.findUnique, db.$queryRaw, liveMembership].some(
    (fn) => vi.mocked(fn as () => unknown).mock.calls.length > 0,
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(check).mockResolvedValue({ allowed: false, reason: "no grant" } as never);
  vi.mocked(liveMembership).mockResolvedValue({ role: "member" } as never);
  vi.mocked(db.user.findUnique).mockResolvedValue(row.user as never);
  vi.mocked(db.orgRole.findUnique).mockResolvedValue(null);
  vi.mocked(db.orgRole.upsert).mockResolvedValue({ id: row.id, role: row.role, aliases: row.aliases } as never);
  vi.mocked(db.orgRole.deleteMany).mockResolvedValue({ count: 1 } as never);
});

describe("org role registry store: no caller without an access context", () => {
  it("does not compile a call that passes anything but an access context first", () => {
    expectTypeOf(readOrgRolePage).parameter(0).toEqualTypeOf<AccessContext>();
    expectTypeOf(saveOrgRole).parameter(0).toEqualTypeOf<AccessContext>();
    expectTypeOf(removeOrgRole).parameter(0).toEqualTypeOf<AccessContext>();

    // Never called: tsc checks these lines, and each must stay an error.
    const ctxFreeCallers = () => [
      // @ts-expect-error a bare org id is not an AccessContext
      readOrgRolePage("org_1", query),
      // @ts-expect-error a bare org id is not an AccessContext
      saveOrgRole("org_1", input),
      // @ts-expect-error a bare org id is not an AccessContext
      removeOrgRole("org_1", "role_1"),
      // @ts-expect-error the access context is required
      removeOrgRole(undefined, "role_1"),
    ];
    expect(ctxFreeCallers).toBeTypeOf("function");
  });

  it("throws, before any read, when an untyped caller passes no access context", async () => {
    vi.mocked(check).mockResolvedValue({ allowed: true, reason: "grant" } as never);
    const untyped = removeOrgRole as (ctx: unknown, id: string) => Promise<unknown>;

    await expect(untyped(undefined, "role_1")).rejects.toThrow(TypeError);
    expect(touchedAnything()).toBe(false);
  });

  it("exports no read or write of the registry besides the decided ones and the ingest job's loader", () => {
    expect(Object.keys(registry).sort()).toEqual([
      "loadOrgRoleEntities",
      "readOrgRolePage",
      "removeOrgRole",
      "saveOrgRole",
    ]);
  });
});

describe("org role registry store: the decision at the org root", () => {
  it.each([
    ["listing", () => readOrgRolePage(ctx, query), "memory.read", "org_roles", null],
    ["saving", () => saveOrgRole(ctx, input), "memory.write", "org_role:CEO", { outcome: "denied" }],
    ["removing", () => removeOrgRole(ctx, "role_1"), "memory.write", "org_role:role_1", "denied"],
  ] as const)(
    "asks check() once before %s, and on a refusal reads and writes nothing",
    async (_what, call, action, target, refused) => {
      expect(await call()).toEqual(refused);

      expect(vi.mocked(check).mock.calls).toEqual([[ctx, { action, scope: orgRootPath("org_1"), target }]]);
      expect(touchedAnything()).toBe(false);
    },
  );

  it("reads a refused caller's query not at all, and an allowed caller's malformed one before any row", async () => {
    expect(await readOrgRolePage(ctx, new URLSearchParams("sort=nope"))).toBeNull();

    vi.mocked(check).mockResolvedValue({ allowed: true, reason: "grant" } as never);
    expect(await readOrgRolePage(ctx, new URLSearchParams(""))).toEqual({ error: "page is required" });
    expect(await readOrgRolePage(ctx, new URLSearchParams("page=1&sort=name"))).toEqual({
      error: "sort must be one of role, person",
    });
    expect(touchedAnything()).toBe(false);
  });

  it("looks up the person only after an allowed save, inside the caller's org", async () => {
    vi.mocked(check).mockResolvedValue({ allowed: true, reason: "grant" } as never);
    vi.mocked(liveMembership).mockResolvedValue(null);

    expect(await saveOrgRole(ctx, input)).toEqual({ outcome: "not-a-member" });
    expect(liveMembership).toHaveBeenCalledWith("org_1", "u_ceo");
    expect(db.orgRole.upsert).not.toHaveBeenCalled();
  });

  it("saves inside the caller's org and names who the graph knew the role by", async () => {
    vi.mocked(check).mockResolvedValue({ allowed: true, reason: "grant" } as never);

    // New role: the graph may know the holder by the title itself.
    expect(await saveOrgRole(ctx, input)).toEqual({ outcome: "saved", row, previousName: "CEO" });
    expect(vi.mocked(db.orgRole.upsert).mock.calls[0][0]).toMatchObject({
      where: { orgId_role: { orgId: "org_1", role: "CEO" } },
      create: { orgId: "org_1", role: "CEO", userId: "u_ceo", aliases: [] },
    });

    // Same holder again: nothing to move.
    vi.mocked(db.orgRole.findUnique).mockResolvedValue({ userId: "u_ceo", user: { name: "Ada" } } as never);
    expect(await saveOrgRole(ctx, input)).toMatchObject({ previousName: null });

    // Role changed hands: the previous holder's name.
    vi.mocked(db.orgRole.findUnique).mockResolvedValue({ userId: "u_bob", user: { name: "Bob" } } as never);
    expect(await saveOrgRole(ctx, input)).toMatchObject({ previousName: "Bob" });
  });

  it("builds the saved row from the upsert's own columns and the person it looked up, with no read after the write", async () => {
    vi.mocked(check).mockResolvedValue({ allowed: true, reason: "grant" } as never);
    vi.mocked(db.orgRole.upsert).mockResolvedValue({ id: "role_9", role: "CEO", aliases: ["chief"] } as never);

    const saved = await saveOrgRole(ctx, { ...input, aliases: ["chief"] });
    expect(saved).toEqual({
      outcome: "saved",
      row: { id: "role_9", role: "CEO", aliases: ["chief"], user: row.user },
      previousName: "CEO",
    });
    // Scalars only: a relation in the upsert's select turns it into a read-then-write
    // that two concurrent first saves race on (the realdb sixteen-saves test).
    expect(vi.mocked(db.orgRole.upsert).mock.calls[0][0].select).toEqual({ id: true, role: true, aliases: true });
    expect(db.user.findUnique).toHaveBeenCalledWith({
      where: { id: "u_ceo" },
      select: { id: true, name: true, email: true },
    });
  });

  it.each([
    ["person id", { ...input, userId: "u\u0000x" }, "userId"],
    ["alias", { ...input, aliases: ["chief", "b\u0000ss"] }, "aliases"],
  ])(
    "refuses an allowed save whose %s holds a NUL, after the decision and before any query",
    async (_what, nul, field) => {
      vi.mocked(check).mockResolvedValue({ allowed: true, reason: "grant" } as never);

      expect(await saveOrgRole(ctx, nul)).toEqual({
        outcome: "unstorable",
        error: `${field} contains a NUL (\\u0000) character, which cannot be stored. Remove it and retry.`,
      });
      expect(check).toHaveBeenCalledTimes(1);
      expect(touchedAnything()).toBe(false);
    },
  );

  it.each([
    ["a lone high half", "b\ud83dss"],
    ["a lone low half", "x\udc00"],
  ])(
    "refuses an allowed save whose alias holds %s of a surrogate pair, before any query, and keeps a whole pair",
    async (_what, alias) => {
      vi.mocked(check).mockResolvedValue({ allowed: true, reason: "grant" } as never);

      expect(await saveOrgRole(ctx, { ...input, aliases: ["chief", alias] })).toEqual({
        outcome: "unstorable",
        error: "aliases contains half of a surrogate pair, which cannot be stored. Remove it and retry.",
      });
      expect(touchedAnything()).toBe(false);
      expect(await saveOrgRole(ctx, { ...input, aliases: ["boss \ud83d\ude00"] })).toMatchObject({ outcome: "saved" });
    },
  );

  it("answers a refused caller's NUL person id as any refusal, without saying it holds a NUL", async () => {
    expect(await saveOrgRole(ctx, { ...input, userId: "u\u0000x" })).toEqual({ outcome: "denied" });
    expect(touchedAnything()).toBe(false);
  });

  it("refuses a save for a person with a membership but no user row", async () => {
    vi.mocked(check).mockResolvedValue({ allowed: true, reason: "grant" } as never);
    vi.mocked(db.user.findUnique).mockResolvedValue(null);

    expect(await saveOrgRole(ctx, input)).toEqual({ outcome: "not-a-member" });
    expect(db.orgRole.upsert).not.toHaveBeenCalled();
  });

  it("removes only inside the caller's org, and answers missing when nothing was deleted", async () => {
    vi.mocked(check).mockResolvedValue({ allowed: true, reason: "grant" } as never);

    expect(await removeOrgRole(ctx, "role_1")).toBe("deleted");
    vi.mocked(db.orgRole.deleteMany).mockResolvedValue({ count: 0 } as never);
    expect(await removeOrgRole(ctx, "role_1")).toBe("missing");
    expect(db.orgRole.deleteMany).toHaveBeenCalledWith({ where: { id: "role_1", orgId: "org_1" } });
  });
});
