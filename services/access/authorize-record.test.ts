// authorizeRecord's outcomes, decided by stubbed check() and can(). That the routes
// built on it answer a missing and a forbidden record byte for byte alike, with one
// deny row, is proven against Postgres in app/api/existence-probes.realdb.qa.test.ts.
import { describe, expect, it, vi } from "vitest";
import { recordAuthorizer } from "./authorize-record";
import type { AccessContext, AccessDecision } from "./check";

const ctx = { orgId: "org1", actor: { type: "human", id: "u1", role: "member" }, origin: "app" } as AccessContext;
const record = { id: "r1", scopePath: "org_org1.legal" };
const request = { action: "memory.write" as const, scopeOf: (r: typeof record) => r.scopePath, target: "thing:r1" };

const decided = (allowed: boolean): AccessDecision => ({ allowed, reason: allowed ? "ok" : "no write grant" });

function deciders(writes: boolean, reads: boolean) {
  return {
    check: vi.fn(async () => decided(writes)),
    can: vi.fn(async () => decided(reads)),
  };
}

describe("authorizeRecord", () => {
  it("decides an id that matches nothing at the org root, and answers it absent even when allowed", async () => {
    const d = deciders(true, true);
    expect(await recordAuthorizer(d)(ctx, async () => null, request)).toEqual({ status: "absent" });
    expect(d.check).toHaveBeenCalledWith(ctx, { action: "memory.write", scope: "org_org1", target: "thing:r1" });
  });

  it("asks can() for an absent id the caller may not act on, as it does for a hidden record", async () => {
    const d = deciders(false, true);
    expect(await recordAuthorizer(d)(ctx, async () => null, request)).toEqual({ status: "absent" });
    expect(d.can).toHaveBeenCalledWith(ctx, { action: "memory.read", scope: "org_org1" });
  });

  it("records an absent id without a target when the target is built from the record", async () => {
    const d = deciders(false, false);
    await recordAuthorizer(d)(ctx, async () => null, { ...request, target: (r) => `thing:${r.scopePath}` });
    expect(d.check).toHaveBeenCalledWith(ctx, { action: "memory.write", scope: "org_org1", target: undefined });
  });

  it("decides on the record's own scope and returns it when allowed", async () => {
    const d = deciders(true, true);
    const access = await recordAuthorizer(d)(ctx, async () => record, request);
    expect(access).toMatchObject({ status: "allowed", record });
    expect(d.check).toHaveBeenCalledWith(ctx, { action: "memory.write", scope: "org_org1.legal", target: "thing:r1" });
  });

  it("answers a record the caller cannot read exactly like a missing one", async () => {
    const access = await recordAuthorizer(deciders(false, false))(ctx, async () => record, request);
    expect(access).toEqual({ status: "absent" });
  });

  it("tells a caller who can read the record, but not act on it, that they were denied", async () => {
    const access = await recordAuthorizer(deciders(false, true))(ctx, async () => record, request);
    expect(access).toMatchObject({ status: "denied", record, decision: { allowed: false } });
  });

  it("answers a refused read as absent without asking can()", async () => {
    const d = deciders(false, true);
    const access = await recordAuthorizer(d)(ctx, async () => record, { ...request, action: "memory.read" });
    expect(access).toEqual({ status: "absent" });
    expect(d.can).not.toHaveBeenCalled();
  });

  it("decides a stored scope that is not a valid path at the org root", async () => {
    const d = deciders(true, true);
    await recordAuthorizer(d)(ctx, async () => ({ ...record, scopePath: "not a path" }), request);
    expect(d.check).toHaveBeenCalledWith(ctx, expect.objectContaining({ scope: "org_org1" }));
  });

  it("builds the audit target from the record when given a function", async () => {
    const d = deciders(true, true);
    await recordAuthorizer(d)(ctx, async () => record, { ...request, target: (r) => `thing:${r.scopePath}` });
    expect(d.check).toHaveBeenCalledWith(ctx, expect.objectContaining({ target: "thing:org_org1.legal" }));
  });
});
