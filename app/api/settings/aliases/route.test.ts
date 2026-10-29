import { beforeEach, describe, expect, it, vi } from "vitest";

// The alias registry routes. A merge copies an entity's old name from whatever
// scope it lived in into this org-wide registry, so listing or editing it is a
// read or write of memory: an org admin role is necessary but not sufficient,
// and check() must allow the action at the org root. The database and check()
// are mocked; the real services/memory/entity-aliases module runs in between.
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/services/access", async () => {
  const actual = await vi.importActual<typeof import("@/services/access")>("@/services/access");
  return {
    check: vi.fn(),
    recordRefusal: vi.fn(),
    orgRootPath: actual.orgRootPath,
    orgRoleRequired: actual.orgRoleRequired,
  };
});
vi.mock("@/lib/db", () => ({
  db: {
    entityAlias: { findMany: vi.fn(), findUnique: vi.fn(), upsert: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));

import { requireAccessContext } from "@/lib/access-context";
import { check, orgRootPath, recordRefusal } from "@/services/access";
import { db } from "@/lib/db";
import { GET, POST } from "./route";
import { DELETE } from "./[id]/route";

const admin = {
  org: { id: "org_1" },
  user: { id: "u_admin", role: "admin" },
  ctx: { orgId: "org_1", actor: { type: "human", id: "u_admin", role: "admin" } },
};
const row = {
  id: "alias_1",
  orgId: "org_1",
  entityId: "merge:Project Falcon",
  canonicalName: "Falcon",
  aliases: ["Project Falcon"],
};
const body = { entityId: "acct_1", entityType: "account", canonicalName: "Acme", aliases: ["ACME Inc"] };
const post = (input: object = body) =>
  new Request("http://t/api/settings/aliases", { method: "POST", body: JSON.stringify(input) });
const del = () => DELETE(new Request("http://t", { method: "DELETE" }), { params: Promise.resolve({ id: "alias_1" }) });

const list = (query = "page=1") => GET(new Request(`http://t/api/settings/aliases?${query}`));

const touchedRegistry = () =>
  [...Object.values(db.entityAlias), db.$queryRaw].some((fn) => vi.mocked(fn as () => unknown).mock.calls.length > 0);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(admin as never);
  vi.mocked(check).mockResolvedValue({ allowed: true, reason: "grant" } as never);
  // One page: the rows, then the matching and org counts.
  vi.mocked(db.$queryRaw)
    .mockResolvedValueOnce([{ ...row, entityType: "account", createdAt: new Date("2026-10-01T00:00:00Z") }] as never)
    .mockResolvedValueOnce([{ total: 1, count: 1 }] as never);
  vi.mocked(db.entityAlias.upsert).mockResolvedValue({ ...row, ...body } as never);
  vi.mocked(db.entityAlias.deleteMany).mockResolvedValue({ count: 1 } as never);
});

describe("alias registry: an admin role and an org-root decision", () => {
  it("refuses a list request with no page, or with a value the list does not offer, before reading", async () => {
    for (const [query, error] of [
      ["", "page is required"],
      ["page=1&type=robot", "type must be one of user, account, contact, org"],
      ["page=1&sort=createdBy", "sort must be one of name, type, created"],
    ]) {
      const res = await list(query);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error });
    }
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it("lists a page of the registry after check() allows reading the org root", async () => {
    const res = await list();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      aliases: [{ ...row, entityType: "account", createdAt: "2026-10-01T00:00:00.000Z" }],
      total: 1,
      count: 1,
      page: 1,
      pageSize: 25,
    });
    expect(check).toHaveBeenCalledWith(
      admin.ctx,
      expect.objectContaining({ action: "memory.read", scope: orgRootPath("org_1") }),
    );
  });

  /** What the list, a save and a remove answer, as [status, body]. */
  const answers = async () => {
    const out: unknown[] = [];
    for (const call of [() => list(), () => POST(post()), del]) {
      const res = await call();
      out.push([res.status, await res.json()]);
    }
    return out;
  };
  // A list refusal says only that the list is for admins; a refused change says what
  // the change needs, which the panel shows after "Could not remove …".
  const REFUSED = [
    [403, { error: "admin required" }],
    [403, { error: "only an admin with write access to the organization can change aliases" }],
    [403, { error: "only an admin with write access to the organization can change aliases" }],
  ];

  it("refuses an admin whose org-root grant is gone, without reading a row", async () => {
    vi.mocked(check).mockResolvedValue({ allowed: false, reason: "no grant" } as never);
    expect(await answers()).toEqual(REFUSED);
    expect(touchedRegistry()).toBe(false);
  });

  it("refuses a member's list, save and remove with the answers a refused admin gets", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue({
      org: admin.org,
      user: { id: "u_m", role: "member" },
      ctx: { orgId: "org_1", actor: { type: "human", id: "u_m", role: "member" } },
    } as never);
    expect(await answers()).toEqual(REFUSED);
    expect(check).not.toHaveBeenCalled();
    expect(touchedRegistry()).toBe(false);
  });

  it("writes and deletes after check() allows writing at the org root", async () => {
    const created = await POST(post());
    expect(created.status).toBe(201);
    expect((await created.json()).alias).toMatchObject(body);
    expect((await del()).status).toBe(200);
    expect(vi.mocked(check).mock.calls.map(([, r]) => [r.action, r.scope])).toEqual([
      ["memory.write", orgRootPath("org_1")],
      ["memory.write", orgRootPath("org_1")],
    ]);
    expect(db.entityAlias.deleteMany).toHaveBeenCalledWith({ where: { id: "alias_1", orgId: "org_1" } });
  });

  it("answers 404 for an alias id outside the org", async () => {
    vi.mocked(db.entityAlias.deleteMany).mockResolvedValue({ count: 0 } as never);
    expect((await del()).status).toBe(404);
  });

  it("still refuses a member before any decision", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue({
      org: admin.org,
      user: { id: "u_m", role: "member" },
      ctx: { orgId: "org_1", actor: { type: "human", id: "u_m", role: "member" } },
    } as never);
    expect((await list()).status).toBe(403);
    expect(check).not.toHaveBeenCalled();
    expect(recordRefusal).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordRefusal).mock.calls[0]).toEqual([
      expect.objectContaining({ actor: expect.objectContaining({ id: "u_m" }) }),
      {
        action: "access.refused",
        target: "org_org_1/settings:aliases:list",
        auditReason: "role member on org_org_1; this operation requires owner or admin",
      },
    ]);
  });
});

describe("alias registry input storage", () => {
  const invalid = [
    ["canonicalName", { canonicalName: "Ac\u0000me" }],
    ["canonicalName", { canonicalName: "Ac\ud800me" }],
    ["aliases", { aliases: ["ok", "bad\u0000alias"] }],
    ["aliases", { aliases: ["ok", "bad\ud800alias"] }],
    ["aliases", { aliases: ["bad\udc00alias", "ok"] }],
    ["entityId", { entityId: "bad\ud800id" }],
    ["entityId", { entityId: "bad\udc00id" }],
    ["entityId", { entityId: "x".repeat(1001) }],
    ["entityId", { entityId: "界".repeat(334) }],
    ["entityId", { entityId: "😀".repeat(251) }],
  ] as const;

  it.each(invalid)("refuses unstorable %s with a field-naming 400 before writing", async (field, patch) => {
    const res = await POST(post({ ...body, ...patch }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(field);
    expect(check).toHaveBeenCalledTimes(1);
    expect(touchedRegistry()).toBe(false);
  });

  it.each(invalid)("refuses access before reporting invalid %s", async (_field, patch) => {
    vi.mocked(check).mockResolvedValue({ allowed: false, reason: "no grant" } as never);
    const res = await POST(post({ ...body, ...patch }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "only an admin with write access to the organization can change aliases",
    });
    expect(touchedRegistry()).toBe(false);
  });

  it.each(["x".repeat(1000), "界".repeat(333) + "x", "😀".repeat(250)])(
    "accepts an entity key at the 1000-byte boundary",
    async (entityId) => {
      const res = await POST(
        post({ ...body, entityId, canonicalName: "Name 😀", aliases: ["界", "😀", "literal\\u0000"] }),
      );
      expect(res.status).toBe(201);
      expect(db.entityAlias.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            entityId,
            canonicalName: "Name 😀",
            aliases: ["界", "😀", "literal\\u0000"],
          }),
        }),
      );
    },
  );
});

it.each(["\ud800x\udc00", "\udc00\ud800", "\ud800\ud800", "\udc00\udc00", "\ud800\udc00\ud800"])(
  "rejects malformed surrogate arrangements in each field",
  async (malformed) => {
    for (const patch of [{ canonicalName: malformed }, { entityId: malformed }, { aliases: [malformed] }]) {
      const res = await POST(post({ ...body, ...patch }));
      expect(res.status).toBe(400);
    }
    expect(touchedRegistry()).toBe(false);
  },
);

it.each(["é".repeat(500), "e\u0301".repeat(333) + "x", "\ud800\udc00".repeat(250)])(
  "preserves an alias key's exact Unicode bytes",
  async (entityId) => {
    expect(Buffer.byteLength(entityId)).toBe(1000);
    expect((await POST(post({ ...body, entityId }))).status).toBe(201);
    expect(db.entityAlias.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ entityId }) }),
    );
  },
);
