import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the db the same way services/access/check.test.ts does: check() (called
// from inside checkFactStaleness) uses db.$queryRaw (grant lookup) +
// db.auditLog.create; the provenance rows themselves live on db.factProvenance.
vi.mock("@/lib/db", () => ({
  db: {
    orgDeletion: { findFirst: async () => null },
    $queryRaw: vi.fn(),
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit_test_id" }), update: vi.fn() },
    factProvenance: {
      create: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

import { db } from "@/lib/db";
import { recordFactProvenance, checkFactStaleness, type CheckFactStalenessInput } from "./fact-provenance";
import type { AccessContext } from "@/services/access";

const human = (): AccessContext => ({
  orgId: "org_1",
  actor: { type: "human", id: "user_1", role: "member" },
  origin: "app",
});

/** A grant covering `permission` on exactly the given scope (matches
 * check.test.ts's `rows()` shape, one $queryRaw result set per call). */
const grantRow = (permission: "read" | "write" | "admin") => [{ permission }];
const noGrant = () => [];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_test_id" } as never);
});

// The fact-resolution half of recordFactProvenance has its own file,
// provenance-fact-resolution.test.ts, which drives the real guard over a
// partitioned store. Here the fact always resolves, so these cases stay about
// the row that gets written.
vi.mock("@/services/memory", () => ({
  guardedMemory: { findFact: vi.fn().mockResolvedValue({ uuid: "fact_1", fact: "a fact" }) },
}));

describe("recordFactProvenance", () => {
  it("creates a fresh row with the given fields", async () => {
    vi.mocked(db.factProvenance.create).mockResolvedValue({ id: "prov_1" } as never);

    await recordFactProvenance(human(), {
      orgId: "org_1",
      scopePath: "org_1.deal_a",
      graphitiFactUuid: "fact_1",
      sourceType: "pr",
      sourceRef: "github.com/acme/app/pull/42",
      recordedRevision: "sha_old",
      ownerId: "user_1",
    });

    expect(db.factProvenance.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orgId: "org_1",
        scopePath: "org_1.deal_a",
        graphitiFactUuid: "fact_1",
        sourceRef: "github.com/acme/app/pull/42",
        recordedRevision: "sha_old",
        status: "fresh",
      }),
    });
  });
});

describe("checkFactStaleness", () => {
  const baseRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
    id: "prov_default",
    orgId: "org_1",
    scopePath: "org_1.scope",
    graphitiFactUuid: "fact_default",
    sourceType: "pr" as const,
    sourceRef: "github.com/acme/app/pull/42",
    recordedRevision: "sha_old",
    ownerId: "user_1",
    status: "fresh" as const,
    flaggedAt: null,
    flaggedReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

  const input = (overrides: Partial<CheckFactStalenessInput> = {}): CheckFactStalenessInput => ({
    orgId: "org_1",
    sourceType: "pr",
    sourceRef: "github.com/acme/app/pull/42",
    currentRevision: "sha_new",
    ...overrides,
  });

  // The leak scenario every access-control boundary needs a real test for:
  // two rows recorded against the SAME sourceRef in two DIFFERENT scopes, a
  // caller whose grant covers only one of them. The row outside the caller's
  // scope must never be flagged (or otherwise mutated) even though it matched
  // on sourceRef — matching a query is not the same as being visible to this
  // caller.
  it("flags only the row the caller's grant covers; the out-of-scope row is never touched", async () => {
    const inScope = baseRow({ id: "prov_in_scope", scopePath: "org_1.scope_a", graphitiFactUuid: "fact_a" });
    const outOfScope = baseRow({ id: "prov_out_of_scope", scopePath: "org_1.scope_b", graphitiFactUuid: "fact_b" });
    vi.mocked(db.factProvenance.findMany).mockResolvedValue([inScope, outOfScope] as never);
    // checkFactStaleness processes candidates in findMany's return order, so the
    // first check() call is for inScope (grant present) and the second is for
    // outOfScope (no matching grant) — same call-order convention
    // services/access/check.test.ts's own `rows()` helper relies on.
    vi.mocked(db.$queryRaw)
      .mockResolvedValueOnce(grantRow("write") as never)
      .mockResolvedValueOnce(noGrant() as never);
    vi.mocked(db.factProvenance.updateMany).mockResolvedValue({ count: 1 } as never);

    const result = await checkFactStaleness(human(), input());

    expect(result.flagged).toEqual([
      { id: "prov_in_scope", graphitiFactUuid: "fact_a", ownerId: "user_1", scopePath: "org_1.scope_a" },
    ]);
    expect(result.skippedOutOfScope).toEqual(["prov_out_of_scope"]);

    expect(db.factProvenance.updateMany).toHaveBeenCalledTimes(1);
    expect(db.factProvenance.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "prov_in_scope", status: "fresh" },
        data: expect.objectContaining({ status: "potentially_stale" }),
      }),
    );
    // The actual leak assertion: no update call ever names the out-of-scope row.
    for (const call of vi.mocked(db.factProvenance.updateMany).mock.calls) {
      expect((call[0] as { where: { id: string } }).where.id).not.toBe("prov_out_of_scope");
    }
  });

  it("never flags, and never calls check(), for a row whose revision hasn't moved", async () => {
    const stillFresh = baseRow({ id: "prov_still_fresh", recordedRevision: "sha_new" });
    vi.mocked(db.factProvenance.findMany).mockResolvedValue([stillFresh] as never);

    const result = await checkFactStaleness(human(), input({ currentRevision: "sha_new" }));

    expect(result.flagged).toEqual([]);
    expect(result.skippedOutOfScope).toEqual([]);
    expect(result.skippedNoRevision).toEqual([]);
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(db.factProvenance.updateMany).not.toHaveBeenCalled();
  });

  it("skips (never deletes or flags) an in-scope row with no recordedRevision yet, after checking scope", async () => {
    const noRevision = baseRow({ id: "prov_no_revision", recordedRevision: null });
    vi.mocked(db.factProvenance.findMany).mockResolvedValue([noRevision] as never);
    vi.mocked(db.$queryRaw).mockResolvedValueOnce(grantRow("write") as never);

    const result = await checkFactStaleness(human(), input());

    expect(result.skippedNoRevision).toEqual(["prov_no_revision"]);
    expect(result.skippedOutOfScope).toEqual([]);
    expect(result.flagged).toEqual([]);
    // Scope is enforced before the no-revision bucket is assigned, not skipped.
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    expect(db.factProvenance.updateMany).not.toHaveBeenCalled();
  });

  // A candidate row with no recordedRevision must not skip the scope check and
  // land in skippedNoRevision when it is out of the caller's scope: the
  // skippedNoRevisionCount in the route response would leak the existence of
  // an out-of-scope provenance row for a sourceRef the caller has no access to.
  it("buckets an out-of-scope row with no recordedRevision as skippedOutOfScope, never skippedNoRevision", async () => {
    const outOfScopeNoRevision = baseRow({
      id: "prov_out_of_scope_no_rev",
      scopePath: "org_1.scope_b",
      recordedRevision: null,
    });
    vi.mocked(db.factProvenance.findMany).mockResolvedValue([outOfScopeNoRevision] as never);
    vi.mocked(db.$queryRaw).mockResolvedValueOnce(noGrant() as never);

    const result = await checkFactStaleness(human(), input());

    expect(result.skippedOutOfScope).toEqual(["prov_out_of_scope_no_rev"]);
    expect(result.skippedNoRevision).toEqual([]);
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    expect(db.factProvenance.updateMany).not.toHaveBeenCalled();
  });

  it("only ever updates status/flaggedAt/flaggedReason — never removes the row (flag, not delete)", async () => {
    const row = baseRow({ id: "prov_1" });
    vi.mocked(db.factProvenance.findMany).mockResolvedValue([row] as never);
    vi.mocked(db.$queryRaw).mockResolvedValueOnce(grantRow("write") as never);
    vi.mocked(db.factProvenance.updateMany).mockResolvedValue({ count: 1 } as never);

    await checkFactStaleness(human(), input({ reason: "#42 got 3 new commits" }));

    expect(db.factProvenance).not.toHaveProperty("delete");
    const call = vi.mocked(db.factProvenance.updateMany).mock.calls[0][0];
    expect(Object.keys(call.data).sort()).toEqual(["flaggedAt", "flaggedReason", "status"]);
    expect(call.data.flaggedReason).toBe("#42 got 3 new commits");
  });

  // Two concurrent revision reports both reading this
  // row as `fresh` must not both "win" — only the write that actually flips
  // status:fresh -> potentially_stale (count === 1) counts the row as flagged.
  it("does not flag a row a concurrent report already transitioned out of fresh (updateMany count 0)", async () => {
    const row = baseRow({ id: "prov_racing" });
    vi.mocked(db.factProvenance.findMany).mockResolvedValue([row] as never);
    vi.mocked(db.$queryRaw).mockResolvedValueOnce(grantRow("write") as never);
    vi.mocked(db.factProvenance.updateMany).mockResolvedValue({ count: 0 } as never);

    const result = await checkFactStaleness(human(), input());

    expect(result.flagged).toEqual([]);
    expect(db.factProvenance.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "prov_racing", status: "fresh" } }),
    );
  });

  it("matches candidates on sourceType + sourceRef together, not sourceRef alone", async () => {
    vi.mocked(db.factProvenance.findMany).mockResolvedValue([] as never);

    await checkFactStaleness(human(), input({ sourceType: "commit" }));

    expect(db.factProvenance.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ sourceType: "commit", sourceRef: "github.com/acme/app/pull/42" }),
      }),
    );
  });
});
