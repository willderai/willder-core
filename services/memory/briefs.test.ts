import { beforeEach, describe, expect, it, vi } from "vitest";

// authorizeBrief (services/memory/briefs.ts): the brief lookup and the check()
// decision on the brief's own scope, as one call. The database and check() are
// mocked; what is pinned is which scope gets decided, how often, and what a
// refusal hands back to the route that has to answer it.
vi.mock("@/lib/db", () => ({ db: { brief: { findFirst: vi.fn(), update: vi.fn() } } }));
vi.mock("@/services/access", async () => {
  const actual = await vi.importActual<typeof import("@/services/access/check")>("@/services/access/check");
  return { check: vi.fn(), isValidLtreePath: actual.isValidLtreePath, orgRootPath: actual.orgRootPath };
});

import { db } from "@/lib/db";
import { check, orgRootPath } from "@/services/access";
import { authorizeBrief, latestBriefAtScope } from "./briefs";

const ctx = { orgId: "org_1", actor: { type: "human", id: "u1", role: "member" }, origin: "app" } as const;
const stored = (scopePath: string) => ({ id: "brief_1", orgId: "org_1", scopePath, title: "t" });
const allow = { allowed: true, reason: "grant" };
const deny = { allowed: false, reason: "no grant" };
const decidedScopes = () => vi.mocked(check).mock.calls.map(([, request]) => request.scope);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(check).mockResolvedValue(allow as never);
});

describe("authorizeBrief", () => {
  it("finds nothing for an id not in the caller's org, and still decides at the org root", async () => {
    vi.mocked(db.brief.findFirst).mockResolvedValue(null);
    expect(await authorizeBrief(ctx, "brief_x", { action: "memory.read" })).toEqual({
      status: "missing",
      scopePath: orgRootPath("org_1"),
      decision: allow,
    });
    expect(vi.mocked(db.brief.findFirst).mock.calls[0][0]?.where).toMatchObject({ id: "brief_x", orgId: "org_1" });
    // The same audited decision a hidden brief costs, so the refusal takes as long
    // (app/api/briefs/[id]/existence-timing.realdb.test.ts), naming the probed id.
    expect(check).toHaveBeenCalledWith(ctx, {
      action: "memory.read",
      scope: orgRootPath("org_1"),
      target: "brief:brief_x",
    });
  });

  it("decides an absent id at the caller's own scope when it names one", async () => {
    vi.mocked(db.brief.findFirst).mockResolvedValue(null);
    vi.mocked(check).mockResolvedValue(deny as never);
    const access = await authorizeBrief(ctx, "brief_x", { action: "memory.read", absentScope: "org_1.eng" });
    expect(access).toEqual({ status: "missing", scopePath: "org_1.eng", decision: deny });
    expect(decidedScopes()).toEqual(["org_1.eng"]);
  });

  it("hides withdrawn briefs unless asked for them", async () => {
    vi.mocked(db.brief.findFirst).mockResolvedValue(stored("org_1.eng") as never);
    await authorizeBrief(ctx, "brief_1", { action: "memory.read" });
    await authorizeBrief(ctx, "brief_1", { action: "access.manage", includeWithdrawn: true });
    const [hidden, shown] = vi.mocked(db.brief.findFirst).mock.calls.map(([args]) => args?.where);
    expect(hidden).toHaveProperty("retirements");
    expect(shown).not.toHaveProperty("retirements");
  });

  it("decides the requested action on the brief's own scope, with the caller's audit target", async () => {
    vi.mocked(db.brief.findFirst).mockResolvedValue(stored("org_1.eng.team") as never);
    const access = await authorizeBrief(ctx, "brief_1", { action: "memory.write", target: "brief:brief_1" });
    expect(access.status).toBe("allowed");
    expect(check).toHaveBeenCalledWith(ctx, {
      action: "memory.write",
      scope: "org_1.eng.team",
      target: "brief:brief_1",
    });
  });

  it("refuses with the scope it decided on, for the route's 403-or-404 choice", async () => {
    vi.mocked(db.brief.findFirst).mockResolvedValue(stored("org_1.eng.team") as never);
    vi.mocked(check).mockResolvedValue(deny as never);
    const access = await authorizeBrief(ctx, "brief_1", { action: "memory.read" });
    expect(access).toEqual({ status: "denied", scopePath: "org_1.eng.team", decision: deny });
  });

  it("decides a stored scope that is not a scope path at the org root, and refuses with the org root", async () => {
    // A scope-less QA run's brief can carry a display label here. Handing that
    // label on would put it in front of an ltree cast (crash) and, worse, into a
    // response; the decision and the refusal both name the org root instead.
    vi.mocked(db.brief.findFirst).mockResolvedValue(stored("(target) api.acme.com") as never);
    vi.mocked(check).mockResolvedValue(deny as never);
    const access = await authorizeBrief(ctx, "brief_1", { action: "memory.write" });
    expect(decidedScopes()).toEqual([orgRootPath("org_1")]);
    expect(access).toEqual({ status: "denied", scopePath: orgRootPath("org_1"), decision: deny });
  });

  it("reuses a decision already made at the brief's scope instead of auditing the same read twice", async () => {
    vi.mocked(db.brief.findFirst).mockResolvedValue(stored("org_1.eng") as never);
    const earlier = { ...allow, auditLogId: "audit_1" };
    const access = await authorizeBrief(ctx, "brief_1", {
      action: "memory.read",
      decidedAt: { scope: "org_1.eng", decision: earlier as never },
    });
    expect(check).not.toHaveBeenCalled();
    expect(access).toMatchObject({ status: "allowed", decision: earlier });
  });

  it("still decides when the earlier decision was made at a different scope", async () => {
    vi.mocked(db.brief.findFirst).mockResolvedValue(stored("org_1.eng.team") as never);
    await authorizeBrief(ctx, "brief_1", {
      action: "memory.read",
      decidedAt: { scope: "org_1.eng", decision: allow as never },
    });
    expect(decidedScopes()).toEqual(["org_1.eng.team"]);
  });
});

describe("latestBriefAtScope", () => {
  it("does not query briefs when check() refuses the scope", async () => {
    vi.mocked(check).mockResolvedValue(deny as never);
    expect(await latestBriefAtScope(ctx, "org_1.eng")).toEqual({ decision: deny, brief: null });
    expect(db.brief.findFirst).not.toHaveBeenCalled();
  });
});
