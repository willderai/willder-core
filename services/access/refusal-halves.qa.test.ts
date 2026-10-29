// The client-safe/operator split of an access decision.
//
// Three seams carry a decision outward without going through toolError() or
// /api/changes, which have their own tests: AccessDeniedError.message (what a
// generic catch-all would print), the erasure route's 403 body, and the audit
// timeline's per-change 403 body. Each must hand out `reason` and never
// `auditReason`.
import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAccessContext = vi.fn();
const check = vi.fn();

vi.mock("@/lib/access-context", () => ({ requireAccessContext: () => requireAccessContext() }));
vi.mock("@/services/access", async (actual) => ({
  ...(await actual<typeof import("@/services/access")>()),
  check: (...args: unknown[]) => check(...args),
}));
vi.mock("@/services/memory/change-history", () => ({ readChangeInScope: vi.fn() }));
vi.mock("@/services/memory/versions", () => ({ readVersionLineage: vi.fn() }));

const { AccessDeniedError } = await import("@/services/access");
const { POST: ERASE } = await import("@/app/api/access/erasure/route");
const { GET: GET_CHANGE } = await import("@/app/api/audit/timeline/[changeId]/route");

const SUBJECT_LABEL = "Northwind_Holdings";
const DENIED = {
  allowed: false,
  reason: "no read grant for user u1 (role member) on the target scope — ask an org admin",
  auditReason: `no read grant for user u1 (role member) on org_c1.${SUBJECT_LABEL}`,
};

describe("a refusal's operator half never leaves through these seams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAccessContext.mockResolvedValue({
      org: { id: "c1" },
      user: { id: "u1" },
      ctx: { orgId: "c1", actor: { type: "human", id: "u1", role: "member" } },
    });
  });

  it("AccessDeniedError.message is the caller's half", () => {
    const e = new AccessDeniedError(DENIED);
    expect(e.message).toBe(DENIED.reason);
    expect(e.message).not.toContain(SUBJECT_LABEL);
    expect(String(e)).not.toContain(SUBJECT_LABEL);
  });

  it("POST /api/access/erasure answers 403 with the caller's half only", async () => {
    // The route's own check() refuses, before anything is recorded or queued.
    check.mockResolvedValueOnce(DENIED);
    const res = await ERASE(
      new Request("http://t/api/access/erasure", { method: "POST", body: JSON.stringify({ email: "a@b.example" }) }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: DENIED.reason });
  });

  it("GET /api/audit/timeline/:changeId answers 403 with the caller's half only", async () => {
    // The first check() is the access.manage gate on the audit page, the second the read.
    check.mockResolvedValueOnce({ allowed: true, reason: "ok" }).mockResolvedValueOnce(DENIED);
    const res = await GET_CHANGE(new Request("http://t/api/audit/timeline/ch1?scope=org_c1"), {
      params: Promise.resolve({ changeId: "ch1" }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: DENIED.reason });
  });
});
