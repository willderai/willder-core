// Hidden-row existence oracle in the provenance scope check of
// POST /api/memory/facts/staleness-check: a source probe must not reveal hidden
// row counts.
//
// Why this file exists alongside the other two: the service test
// (services/memory/fact-provenance.test.ts) exercises the real enforcement ordering but
// stops at checkFactStaleness()'s return value, and the route test
// (route.test.ts) pins the JSON shape with checkFactStaleness ENTIRELY MOCKED.
// Neither drives a real out-of-scope provenance row through the real service and
// out through the real route — exactly the path an attacker probes. Both could
// keep passing while the composed path leaks.
//
// The core assertion here is a DIFFERENTIAL ORACLE, which is the actual security
// property and is stronger than "the field is absent": the caller's response must
// be byte-for-byte IDENTICAL whether or not a hidden out-of-scope provenance row
// exists for the probed sourceRef. Any observable difference — a count, an array
// length, a changed field — is the existence leak, whatever it is named.
import { beforeEach, describe, expect, it, vi } from "vitest";

// Only the access context and the db are mocked. services/memory/fact-provenance and
// services/access/check both run for real, so the enforcement ORDER under test is
// the shipped code path, not a fake.
vi.mock("@/lib/db", () => ({
  db: {
    orgDeletion: { findFirst: async () => null },
    $queryRaw: vi.fn(),
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit_test_id" }), update: vi.fn() },
    // updateMany, not update: the write-in-loop is a conditional
    // updateMany({ where: { id, status: "fresh" } }), not a bare update-by-id,
    // so a concurrent transition can't be silently overwritten.
    factProvenance: { create: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
  },
}));
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

import { db } from "@/lib/db";
import { requireAccessContext } from "@/lib/access-context";
import { POST } from "./route";

const VISIBLE_SCOPE = "org_1.scope_visible";
const HIDDEN_SCOPE = "org_1.scope_hidden";
const SOURCE_REF = "github.com/acme/app/pull/42";

const rc = {
  org: { id: "org_1" },
  user: { id: "user_1" },
  ctx: {
    orgId: "org_1",
    actor: { type: "human" as const, id: "user_1", role: "member" as const },
  },
};

const row = (overrides: Record<string, unknown> = {}) => ({
  id: "prov_default",
  orgId: "org_1",
  scopePath: VISIBLE_SCOPE,
  graphitiFactUuid: "fact_default",
  sourceType: "pr" as const,
  sourceRef: SOURCE_REF,
  recordedRevision: "sha_old",
  ownerId: "user_1",
  status: "fresh" as const,
  flaggedAt: null,
  flaggedReason: null,
  createdAt: new Date("2026-09-10T00:00:00Z"),
  ...overrides,
});

/** Grant every scope EXCEPT the hidden one. Keyed on the target scope path that
 * check() passes into its grant query, so the allow/deny verdict follows the row
 * being checked rather than call order — a test that depended on ordering would
 * quietly stop testing the boundary the moment the loop was reordered, which is
 * the very class of bug under test. */
const grantAllBut = (deniedScope: string) => {
  vi.mocked(db.$queryRaw).mockImplementation(((...args: unknown[]) =>
    Promise.resolve(JSON.stringify(args).includes(deniedScope) ? [] : [{ permission: "write" }])) as never);
};

// sourceType is a required body field. Every row in this file is sourceType
// "pr", matching SOURCE_REF's shape, so the probe always reports that same type.
const probe = (currentRevision = "sha_new") =>
  POST(
    new Request("http://t/api/memory/facts/staleness-check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceType: "pr", sourceRef: SOURCE_REF, currentRevision }),
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(rc as never);
  vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_test_id" } as never);
  vi.mocked(db.factProvenance.updateMany).mockResolvedValue({ count: 1 } as never);
  grantAllBut(HIDDEN_SCOPE);
});

describe("POST /api/memory/facts/staleness-check — hidden-row existence oracle", () => {
  it("returns an IDENTICAL response whether or not a hidden out-of-scope row with NO recordedRevision exists", async () => {
    // Probe A: only the caller's own visible row exists.
    vi.mocked(db.factProvenance.findMany).mockResolvedValue([
      row({ id: "prov_visible", scopePath: VISIBLE_SCOPE, recordedRevision: null }),
    ] as never);
    const withoutHidden = await (await probe()).json();

    // Probe B: same, plus a row in a scope this caller cannot see, which ALSO has
    // no recordedRevision. If the no-revision branch ran before the scope check,
    // this row would skip the scope check and land in skippedNoRevision, bumping
    // skippedNoRevisionCount from 1 to 2.
    vi.clearAllMocks();
    vi.mocked(requireAccessContext).mockResolvedValue(rc as never);
    vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_test_id" } as never);
    grantAllBut(HIDDEN_SCOPE);
    vi.mocked(db.factProvenance.findMany).mockResolvedValue([
      row({ id: "prov_visible", scopePath: VISIBLE_SCOPE, recordedRevision: null }),
      row({ id: "prov_hidden", scopePath: HIDDEN_SCOPE, recordedRevision: null }),
    ] as never);
    const withHidden = await (await probe()).json();

    expect(withHidden).toEqual(withoutHidden);
    expect(JSON.stringify(withHidden)).not.toContain("prov_hidden");
    expect(JSON.stringify(withHidden)).not.toContain("scope_hidden");
    // And the hidden row is never counted into the one count that does ship.
    expect(withHidden.skippedNoRevisionCount).toBe(1);
  });

  it("returns an IDENTICAL response whether or not a hidden out-of-scope row WITH a stale recordedRevision exists", async () => {
    vi.mocked(db.factProvenance.findMany).mockResolvedValue([
      row({ id: "prov_visible", scopePath: VISIBLE_SCOPE, recordedRevision: "sha_old" }),
    ] as never);
    const withoutHidden = await (await probe()).json();

    vi.clearAllMocks();
    vi.mocked(requireAccessContext).mockResolvedValue(rc as never);
    vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_test_id" } as never);
    vi.mocked(db.factProvenance.updateMany).mockResolvedValue({ count: 1 } as never);
    grantAllBut(HIDDEN_SCOPE);
    vi.mocked(db.factProvenance.findMany).mockResolvedValue([
      row({ id: "prov_visible", scopePath: VISIBLE_SCOPE, recordedRevision: "sha_old" }),
      row({ id: "prov_hidden", scopePath: HIDDEN_SCOPE, recordedRevision: "sha_old" }),
    ] as never);
    const withHidden = await (await probe()).json();

    expect(withHidden).toEqual(withoutHidden);
    // The hidden row must also never be WRITTEN to, not merely hidden from output.
    const updatedIds = vi
      .mocked(db.factProvenance.updateMany)
      .mock.calls.map((c) => (c[0] as { where: { id: string } }).where.id);
    expect(updatedIds).toEqual(["prov_visible"]);
  });

  it("counts ONLY in-scope rows in skippedNoRevisionCount when the batch mixes both", async () => {
    vi.mocked(db.factProvenance.findMany).mockResolvedValue([
      row({ id: "prov_in_1", scopePath: VISIBLE_SCOPE, recordedRevision: null }),
      row({ id: "prov_hidden_1", scopePath: HIDDEN_SCOPE, recordedRevision: null }),
      row({ id: "prov_hidden_2", scopePath: HIDDEN_SCOPE, recordedRevision: null }),
      row({ id: "prov_in_2", scopePath: VISIBLE_SCOPE, recordedRevision: null }),
    ] as never);

    const json = await (await probe()).json();

    expect(json).toEqual({ flagged: [], flaggedCount: 0, skippedNoRevisionCount: 2 });
  });

  it("a caller with NO grant anywhere cannot distinguish 'no rows' from 'rows exist that you cannot see'", async () => {
    // Nothing granted at all: every check() denies.
    vi.mocked(db.$queryRaw).mockResolvedValue([] as never);

    vi.mocked(db.factProvenance.findMany).mockResolvedValue([] as never);
    const noRows = await (await probe()).json();

    vi.mocked(db.factProvenance.findMany).mockResolvedValue([
      row({ id: "prov_hidden_a", scopePath: HIDDEN_SCOPE, recordedRevision: null }),
      row({ id: "prov_hidden_b", scopePath: HIDDEN_SCOPE, recordedRevision: "sha_old" }),
    ] as never);
    const hiddenRows = await (await probe()).json();

    expect(hiddenRows).toEqual(noRows);
    expect(hiddenRows).toEqual({ flagged: [], flaggedCount: 0, skippedNoRevisionCount: 0 });
    expect(db.factProvenance.updateMany).not.toHaveBeenCalled();
  });

  it("an out-of-scope row whose revision already MATCHES is skipped without a write and without a count", async () => {
    // The one branch that still short-circuits before check(): a row already at
    // currentRevision. Verified here as genuinely unobservable — it is neither
    // written nor counted — so skipping the scope check on it is safe.
    vi.mocked(db.factProvenance.findMany).mockResolvedValue([
      row({ id: "prov_hidden_fresh", scopePath: HIDDEN_SCOPE, recordedRevision: "sha_new" }),
    ] as never);

    const json = await (await probe("sha_new")).json();

    expect(json).toEqual({ flagged: [], flaggedCount: 0, skippedNoRevisionCount: 0 });
    expect(db.factProvenance.updateMany).not.toHaveBeenCalled();
  });
});
