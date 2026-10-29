import { beforeEach, describe, expect, it, vi } from "vitest";

// This route must be a real CALLER of the access layer (services/access's
// `can()`, which runs the same `evaluate()` every `memory.read` goes through),
// never a re-derivation of evaluate()'s grants-join logic in raw SQL (its own
// copy of the grantee-match and expiry conditions, its own `::ltree` join): that
// would be a live policy duplicate of the authorization decision itself, not
// just a row filter. This file pins it: only `@/lib/db` is mocked,
// `@/services/access` is left real, so the actual grant-resolution query
// (including its expiry/revocation clause) is what decides which candidate
// scopes come back. If `evaluate()`'s semantics ever change, this test (and the
// route) move with it automatically instead of silently drifting.
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    $queryRaw: vi.fn(),
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit_test_id" }) },
  },
}));

import { requireAccessContext } from "@/lib/access-context";
import { db } from "@/lib/db";
import { GET } from "./route";

const humanRc = (role: "member" | "admin" = "member") => ({
  org: { id: "org_1" },
  user: { id: "user_1" },
  ctx: { orgId: "org_1", actor: { type: "human" as const, id: "user_1", role } },
});

/** What readableScopePaths()'s grant query returns for a member holding read on `paths`. */
const granted = (...paths: string[]) =>
  paths.map((scopePath) => ({ userId: "user_1", role: "member", permission: "read", scopePath }));

/** The SQL text, and the bound values, of the `n`th $queryRaw call. */
const sqlOf = (n: number) => (vi.mocked(db.$queryRaw).mock.calls[n][0] as TemplateStringsArray).join("");
const valuesOf = (n: number) => vi.mocked(db.$queryRaw).mock.calls[n].slice(1);

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_test_id" } as never);
});

describe("GET /api/memory/scopes", () => {
  it("401 without an access context", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });

  it("returns [] for a non-human actor without touching the scope/grant tables", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue({
      org: { id: "org_1" },
      user: { id: "u" },
      ctx: { orgId: "org_1", actor: { type: "agent", id: "agent_1", capabilityToken: "wcap_x" } },
    } as never);

    const res = await GET();
    expect(await res.json()).toEqual({ scopes: [], truncated: false });
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it("is a real caller of the access layer, not a reimplementation: a scope with only an expired grant is excluded by evaluate()'s own query, not a route-local copy of the expiry rule", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(humanRc() as never);
    vi.mocked(db.$queryRaw)
      // readableScopePaths(): the caller holds a read grant on both departments.
      .mockResolvedValueOnce(granted("org_1.dept_sales", "org_1.dept_eng") as never)
      // The candidate scopes inside those grants.
      .mockResolvedValueOnce([
        { id: "s1", path: "org_1.dept_sales", name: "Sales" },
        { id: "s2", path: "org_1.dept_eng", name: "Eng" },
      ] as never)
      // Promise.all over a synchronous .map() dispatches can()'s underlying
      // db.$queryRaw calls, one per candidate scope, in candidate order, before
      // any of them resolve -- so mockResolvedValueOnce lines up 1:1 with
      // [s1, s2] regardless of resolution order.
      // s1: a live, unexpired grant -- evaluate()'s query returns a row.
      .mockResolvedValueOnce([{ permission: "read" }] as never)
      // s2: evaluate()'s own query already filters out an expired/revoked
      // grant in SQL (`expiresAt IS NULL OR expiresAt > now()`) -- empty rows,
      // indistinguishable here from "no grant at all", which is the point:
      // the route never sees or re-decides expiry itself.
      .mockResolvedValueOnce([] as never);

    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      scopes: [{ id: "s1", path: "org_1.dept_sales", name: "Sales" }],
      truncated: false,
    });

    // The grant query, the candidate query, then one real grant-resolution query
    // per candidate scope -- never a single route-local raw join over all scopes.
    expect(db.$queryRaw).toHaveBeenCalledTimes(4);

    // can(), NOT check(): a UI-facing capability listing must not write an
    // audit_log row per candidate scope. Swapping `can` for `check` would turn
    // one memory-page load into N probe rows in an append-only audit trail.
    // `db.auditLog.create` is mocked above precisely so check() WOULD succeed
    // here -- so only this assertion, not a crash, distinguishes the two.
    expect(db.auditLog.create).not.toHaveBeenCalled();
    // Inclusion is decided by evaluate()'s real query text -- its actual grants
    // join and expiry clause -- not a hand-rolled duplicate in this route.
    const decision = sqlOf(2);
    expect(decision).toContain('"grants"');
    expect(decision).toContain('"expiresAt"');
  });

  it("the candidate query only narrows to the caller's granted subtrees: it joins no grants and decides nothing", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(humanRc() as never);
    vi.mocked(db.$queryRaw)
      .mockResolvedValueOnce(granted("org_1.dept_sales") as never)
      .mockResolvedValueOnce([] as never);

    await GET();

    const candidates = sqlOf(1);
    expect(candidates).toContain('FROM "scopes"');
    expect(candidates).toContain("<@");
    expect(candidates).not.toContain('"grants"');
    expect(valuesOf(1)).toEqual(expect.arrayContaining(["org_1", "org_1.dept_sales", 51]));
  });

  it("a caller with no grant reads an empty list without a candidate query", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(humanRc() as never);
    vi.mocked(db.$queryRaw).mockResolvedValueOnce([] as never);

    expect(await (await GET()).json()).toEqual({ scopes: [], truncated: false });
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
  });
});

// The candidate query and the can() fan-out over it share the
// MAX_DESCENDANT_SCOPES bound check.ts already applies to its own per-scope
// fan-out, and hitting the bound is reported to the caller, never silent. The
// candidates are already limited to scopes the caller can read, so `truncated`
// says the caller's own list is cut, never how many scopes the org holds.
describe("GET /api/memory/scopes: candidate bound", () => {
  const candidates = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `s${i}`,
      path: `org_1.dept_${String(i).padStart(3, "0")}`,
      name: `Dept ${i}`,
    }));

  const withCandidates = (n: number) =>
    vi
      .mocked(db.$queryRaw)
      .mockResolvedValueOnce(granted("org_1") as never)
      .mockResolvedValueOnce(candidates(n) as never)
      .mockResolvedValue([{ permission: "read" }] as never);

  it("with 51 candidates, probes only the first 50 and reports truncated: true", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(humanRc() as never);
    withCandidates(51);

    const body = await (await GET()).json();

    expect(db.$queryRaw).toHaveBeenCalledTimes(2 + 50);
    expect(body.scopes).toHaveLength(50);
    expect(body.scopes.at(-1).path).toBe("org_1.dept_049");
    expect(body.truncated).toBe(true);
  });

  it("with exactly 50 candidates, probes all 50 and reports truncated: false", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(humanRc() as never);
    withCandidates(50);

    const body = await (await GET()).json();

    expect(db.$queryRaw).toHaveBeenCalledTimes(2 + 50);
    expect(body.scopes).toHaveLength(50);
    expect(body.truncated).toBe(false);
  });
});
