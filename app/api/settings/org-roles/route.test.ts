import { beforeEach, describe, expect, it, vi } from "vitest";

// The org role registry routes. A role names a person for all of the org's
// memory, so listing or editing the registry needs an org admin role and check()
// allowing the action at the org root, decided before any row, person or id is
// looked up. The database and check() are mocked; the real
// services/resolver/org-roles module runs in between. The real-Postgres half,
// with real grants and audit rows, is org-roles-access.realdb.test.ts.
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/services/access", async () => {
  const actual = await vi.importActual<typeof import("@/services/access")>("@/services/access");
  return {
    check: vi.fn(),
    recordRefusal: vi.fn(),
    liveMembership: vi.fn(),
    orgRootPath: actual.orgRootPath,
    orgRoleRequired: actual.orgRoleRequired,
  };
});
vi.mock("@/services/memory", () => ({
  memory: { ingest: vi.fn(async () => undefined), transferEntity: vi.fn(async () => undefined) },
}));
vi.mock("@/lib/db", () => ({
  db: {
    orgRole: { findMany: vi.fn(), findUnique: vi.fn(), upsert: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
    user: { findUnique: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));

import { requireAccessContext } from "@/lib/access-context";
import { check, liveMembership, orgRootPath, recordRefusal } from "@/services/access";
import { db } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { memory } from "@/services/memory";
import { GET, POST } from "./route";
import { DELETE } from "./[id]/route";

const admin = {
  org: { id: "org_1", name: "Acme" },
  user: { id: "u_admin", role: "admin" },
  ctx: { orgId: "org_1", actor: { type: "human", id: "u_admin", role: "admin" }, origin: "app" },
};
const row = {
  id: "role_1",
  orgId: "org_1",
  role: "CEO",
  userId: "u_ceo",
  aliases: [],
  user: { id: "u_ceo", name: "Ada", email: "ada@acme.test" },
};
const listRequest = () => new Request("http://t/api/settings/org-roles?page=1");
const post = (body: object = { role: " CEO ", userId: "u_ceo" }) =>
  POST(new Request("http://t/api/settings/org-roles", { method: "POST", body: JSON.stringify(body) }));
const del = () => DELETE(new Request("http://t", { method: "DELETE" }), { params: Promise.resolve({ id: "role_1" }) });

/** Whether the route read or wrote any registry row or person. */
const touchedAnything = () =>
  [...Object.values(db.orgRole), db.user.findUnique, db.$queryRaw, liveMembership].some(
    (fn) => vi.mocked(fn as () => unknown).mock.calls.length > 0,
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(admin as never);
  vi.mocked(check).mockResolvedValue({ allowed: true, reason: "grant" } as never);
  vi.mocked(liveMembership).mockResolvedValue({ role: "member" } as never);
  vi.mocked(db.orgRole.findMany).mockResolvedValue([row] as never);
  vi.mocked(db.orgRole.findUnique).mockResolvedValue(row as never);
  vi.mocked(db.orgRole.upsert).mockResolvedValue({ id: row.id, role: row.role, aliases: row.aliases } as never);
  vi.mocked(db.user.findUnique).mockResolvedValue(row.user as never);
  vi.mocked(db.orgRole.deleteMany).mockResolvedValue({ count: 1 } as never);
});

describe("org role registry: an admin role and an org-root decision", () => {
  it("lists the registry after check() allows reading the org root", async () => {
    vi.mocked(db.$queryRaw)
      .mockResolvedValueOnce([row] as never)
      .mockResolvedValueOnce([{ total: 1, count: 1 }] as never);
    const res = await GET(listRequest());
    expect(res.status).toBe(200);
    expect((await res.json()).roles.map((r: { id: string }) => r.id)).toEqual([row.id]);
    expect(vi.mocked(check).mock.calls).toEqual([
      [admin.ctx, { action: "memory.read", scope: orgRootPath("org_1"), target: "org_roles" }],
    ]);
  });

  it("saves and deletes after check() allows writing at the org root", async () => {
    expect((await post()).status).toBe(201);
    expect((await del()).status).toBe(200);
    expect(vi.mocked(check).mock.calls.map(([, r]) => r)).toEqual([
      { action: "memory.write", scope: orgRootPath("org_1"), target: "org_role:CEO" },
      { action: "memory.write", scope: orgRootPath("org_1"), target: "org_role:role_1" },
    ]);
  });

  it.each([
    ["a new role", null, { oldName: "CEO", newName: "Ada" }],
    ["a role that changed hands", { userId: "u_bob", user: { name: "Bob" } }, { oldName: "Bob", newName: "Ada" }],
    ["a role saved again for the same person", { userId: "u_ceo", user: { name: "Ada" } }, null],
  ] as const)(
    "on %s, moves the graph's facts from the old name and records the role",
    async (_case, existing, moved) => {
      vi.mocked(db.orgRole.findUnique).mockResolvedValue(existing as never);
      expect((await post()).status).toBe(201);

      expect(vi.mocked(memory.transferEntity).mock.calls).toEqual(moved ? [[{ groupId: "org_1", ...moved }]] : []);
      expect(vi.mocked(memory.ingest).mock.calls.map(([input]) => input.content)).toEqual(["Ada is the CEO of Acme."]);
    },
  );

  it("answers a save with the row this request wrote and the person it named, read nowhere else", async () => {
    const res = await post();

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      role: { id: "role_1", role: "CEO", aliases: [], user: { id: "u_ceo", name: "Ada", email: "ada@acme.test" } },
    });
  });

  it.each([
    ["person id", { role: "CEO", userId: "u\u0000x" }, "userId"],
    ["alias", { role: "CEO", userId: "u_ceo", aliases: ["chief", "b\u0000ss"] }, "aliases"],
  ])(
    "answers an allowed admin's save whose %s holds a NUL with 400 naming it, before any lookup",
    async (_what, body, field) => {
      const res = await post(body);

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: `${field} contains a NUL (\\u0000) character, which cannot be stored. Remove it and retry.`,
      });
      expect(check).toHaveBeenCalledTimes(1);
      expect(touchedAnything()).toBe(false);
      expect(memory.ingest).not.toHaveBeenCalled();
    },
  );

  it("deletes only inside the org, and answers 404 when nothing was deleted, such as a second delete", async () => {
    vi.mocked(db.orgRole.deleteMany).mockResolvedValue({ count: 0 } as never);
    const res = await del();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
    expect(db.orgRole.deleteMany).toHaveBeenCalledWith({ where: { id: "role_1", orgId: "org_1" } });
  });

  /** What each method answers, as [status, body]. */
  const answers = async () => {
    const out: unknown[] = [];
    for (const call of [() => GET(listRequest()), post, del]) {
      const res = await call();
      out.push([res.status, await res.json()]);
    }
    return out;
  };
  // A list refusal says only that the list is for admins; a refused change says what
  // the change needs, so an admin who may only read the root learns why Remove failed.
  const REFUSED = [
    [403, { error: "admin required" }],
    [403, { error: "only an admin with write access to the organization can change roles" }],
    [403, { error: "only an admin with write access to the organization can change roles" }],
  ];

  it("refuses an admin whose org-root grant is gone, without reading a row, a person or an id", async () => {
    vi.mocked(check).mockResolvedValue({ allowed: false, reason: "no grant" } as never);
    expect(await answers()).toEqual(REFUSED);
    expect(touchedAnything()).toBe(false);
  });

  it("still refuses a member before any decision, with the same answers", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue({
      org: admin.org,
      user: { id: "u_m", role: "member" },
      ctx: { orgId: "org_1", actor: { type: "human", id: "u_m", role: "member" } },
    } as never);
    expect(await answers()).toEqual(REFUSED);
    expect(check).not.toHaveBeenCalled();
    expect(recordRefusal).toHaveBeenCalledTimes(3);
    expect(touchedAnything()).toBe(false);
  });
});

describe("org role storage limits and disappearing person", () => {
  it.each(["x".repeat(1001), "界".repeat(334), "😀".repeat(251)])(
    "refuses a role key over 1000 UTF-8 bytes before lookup",
    async (role) => {
      const res = await post({ role, userId: "u_ceo" });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("role");
      expect(touchedAnything()).toBe(false);
      expect(memory.ingest).not.toHaveBeenCalled();
    },
  );

  it("refuses access before reporting an oversized role", async () => {
    vi.mocked(check).mockResolvedValue({ allowed: false, reason: "no grant" } as never);
    const res = await post({ role: "界".repeat(1000), userId: "u_ceo" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "only an admin with write access to the organization can change roles" });
    expect(touchedAnything()).toBe(false);
  });

  it.each(["x".repeat(1000), "界".repeat(333) + "x", "😀".repeat(250)])(
    "accepts a role key at the 1000-byte boundary",
    async (role) => {
      expect((await post({ role, userId: "u_ceo", aliases: ["😀"] })).status).toBe(201);
      expect(db.orgRole.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: expect.objectContaining({ role }) }),
      );
    },
  );

  const malformed = [
    ["role", { role: "bad\ud800role" }],
    ["role", { role: "bad\udc00role" }],
    ["userId", { userId: "bad\ud800id" }],
    ["userId", { userId: "bad\udc00id" }],
    ["aliases", { aliases: ["ok", "\ud800"] }],
    ["aliases", { aliases: ["\udc00", "ok"] }],
  ] as const;
  it.each(malformed)("rejects malformed Unicode in %s before lookup", async (field, patch) => {
    const res = await post({ role: "CEO", userId: "u_ceo", ...patch });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(field);
    expect(touchedAnything()).toBe(false);
  });

  it.each(malformed)("refuses access before reporting malformed Unicode in %s", async (_field, patch) => {
    vi.mocked(check).mockResolvedValue({ allowed: false, reason: "no grant" } as never);
    const res = await post({ role: "CEO", userId: "u_ceo", ...patch });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "only an admin with write access to the organization can change roles" });
    expect(touchedAnything()).toBe(false);
  });

  it("answers the missing-person response when deletion races the upsert", async () => {
    vi.mocked(db.user.findUnique).mockResolvedValueOnce(null);
    const missing = await post();
    const missingBody = await missing.json();
    vi.mocked(db.orgRole.upsert).mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Foreign key constraint", {
        code: "P2003",
        clientVersion: "test",
        meta: {
          modelName: "OrgRole",
          driverAdapterError: { cause: { constraint: { index: "org_roles_userId_fkey" } } },
        },
      }),
    );
    const raced = await post();
    expect(raced.status).toBe(missing.status);
    expect(await raced.json()).toEqual(missingBody);
    expect(memory.ingest).not.toHaveBeenCalled();
    expect(memory.transferEntity).not.toHaveBeenCalled();
  });

  it("does not disguise unrelated database failures as a missing person", async () => {
    const error = new Prisma.PrismaClientKnownRequestError("Connection unavailable", {
      code: "P1001",
      clientVersion: "test",
    });
    vi.mocked(db.orgRole.upsert).mockRejectedValueOnce(error);
    await expect(post()).rejects.toBe(error);
  });
});

describe("org-role foreign-key error identity", () => {
  it.each([
    ["organization constraint", { modelName: "OrgRole", constraint: "org_roles_orgId_fkey" }],
    [
      "adapter organization constraint",
      { modelName: "OrgRole", driverAdapterError: { cause: { constraint: { index: "org_roles_orgId_fkey" } } } },
    ],
    [
      "adapter unknown constraint",
      { modelName: "OrgRole", driverAdapterError: { cause: { constraint: { index: "unknown_fkey" } } } },
    ],
    ["unrecognized metadata shape", { modelName: "OrgRole", constraint: "org_roles_userId_fkey" }],
    ["missing constraint", { modelName: "OrgRole", driverAdapterError: { cause: { constraint: null } } }],
    ["missing metadata", undefined],
  ] as const)("preserves P2003 for %s rather than reporting a missing person", async (_case, meta) => {
    const error = new Prisma.PrismaClientKnownRequestError("Foreign key constraint", {
      code: "P2003",
      clientVersion: "test",
      meta,
    });
    vi.mocked(db.orgRole.upsert).mockRejectedValueOnce(error);
    await expect(post()).rejects.toBe(error);
    expect(memory.ingest).not.toHaveBeenCalled();
    expect(memory.transferEntity).not.toHaveBeenCalled();
  });
});

it.each(["é".repeat(500), "e\u0301".repeat(333) + "x", "\ud800\udc00".repeat(250)])(
  "stores exact 1000-byte Unicode spelling",
  async (role) => {
    expect(Buffer.byteLength(role)).toBe(1000);
    expect((await post({ role, userId: "u_ceo" })).status).toBe(201);
    expect(db.orgRole.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ role }) }),
    );
  },
);

it("canonical equivalence does not bypass the actual UTF-8 limit", async () => {
  const role = "e\u0301".repeat(500);
  expect(Buffer.byteLength(role.normalize("NFC"))).toBe(1000);
  expect((await post({ role, userId: "u_ceo" })).status).toBe(400);
  expect(touchedAnything()).toBe(false);
});

it.each(["P2002", "P2025", "P2010"])("preserves %s errors", async (code) => {
  const error = new Prisma.PrismaClientKnownRequestError("failure", { code, clientVersion: "test" });
  vi.mocked(db.orgRole.upsert).mockRejectedValueOnce(error);
  await expect(post()).rejects.toBe(error);
});
