import { beforeEach, describe, expect, it, vi } from "vitest";

// Handler-logic tests for the fact-governance routes (UC9 — activates the
// conflict-resolution design in docs/willder_conflict_resolution.md):
//   • GET  /api/facts/disputes                 — pending (status=disputed) disputes the
//                                                 caller is scope-admin over; 401.
//   • POST /api/facts/disputes/:id/resolve     — { resolution, value? } → transitions
//                                                 status + stamps resolver/resolvedAt;
//                                                 404 unknown id; cross-org isolation.
//   • POST /api/briefs/:id/correct             — { sectionHeading?, correction } →
//                                                 { ok, autoMerged, disputeId? }. The
//                                                 correction is written back as a
//                                                 HUMAN-authored episode (the provenance
//                                                 claim that makes human>agent auto-merge
//                                                 work); 401; 404 (brief not found/wrong org).
//
// Mocks match the real route deps: the correction route ingests via ingestMemory
// (@/lib/inngest), auto-merges via guardedMemory.removeFact, and decides auto-merge vs
// dispute via findContradiction / openFactDispute. db is fully mocked.
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/services/access", async () => ({
  check: vi.fn(),
  can: vi.fn(),
  isValidLtreePath: (await vi.importActual<typeof import("@/services/access/check")>("@/services/access/check"))
    .isValidLtreePath,
  orgRootPath: (orgId: string) => `org_${orgId}`,
  AccessDeniedError: class AccessDeniedError extends Error {
    decision: { reason: string };
    constructor(decision: { reason: string }) {
      super(decision.reason);
      this.decision = decision;
    }
  },
}));
vi.mock("@/services/memory", () => ({
  guardedMemory: { removeFact: vi.fn() },
  MemoryServiceError: class MemoryServiceError extends Error {},
}));
vi.mock("@/lib/inngest", () => ({ ingestMemory: vi.fn() }));
vi.mock("@/services/facts/conflicts", () => ({ findContradiction: vi.fn() }));
// Only the write the correct route makes is stubbed; the dispute routes' own reads
// run for real against the mocked db.
vi.mock("@/services/memory/fact-disputes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory/fact-disputes")>()),
  openFactDispute: vi.fn(),
}));
vi.mock("@/services/signals", () => ({ recordFeedback: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    factDispute: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    brief: { findFirst: vi.fn() },
    // The episode cap checked before a correction: no org row here, so nothing is capped.
    org: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));
// These cases are about scope-admin filtering on enterprise, every org's tier today, where
// no dispute is held back by tier; the tier gate has its own suite
// (services/memory/graph-anchored-rows.tier-gate.test.ts).
vi.mock("@/services/memory/raw-rows", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory/raw-rows")>()),
  keepServedAnchors: async <T>(_orgId: string, rows: readonly T[]) => [...rows],
}));

import { requireAccessContext } from "@/lib/access-context";
import { can, check } from "@/services/access";
import { guardedMemory } from "@/services/memory";
import { ingestMemory } from "@/lib/inngest";
import { findContradiction } from "@/services/facts/conflicts";
import { openFactDispute } from "@/services/memory/fact-disputes";
import { db } from "@/lib/db";

import { GET as disputesGET } from "./facts/disputes/route";
import { POST as resolvePOST } from "./facts/disputes/[id]/resolve/route";
import { POST as correctPOST } from "./briefs/[id]/correct/route";

const admin = {
  org: { id: "org_1" },
  user: { id: "user_admin", name: "Priya", role: "admin" },
  ctx: { orgId: "org_1", actor: { type: "human", id: "user_admin", role: "admin" } },
};

const req = (url: string, body?: unknown, method = "POST") =>
  new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

// A disputed fact in org_1's engineering scope.
const disputeRow = {
  id: "disp_1",
  orgId: "org_1",
  scopePath: "org_1.engineering",
  graphitiFactUuid: "fact-uuid-abc",
  proposerActorType: "human",
  proposerActorId: "user_kenji",
  existingActorType: "human",
  existingActorId: "user_priya",
  status: "disputed",
  resolvedValue: null,
  resolverId: null,
  resolvedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(admin as never);
  vi.mocked(check).mockResolvedValue({ allowed: true, reason: "ok" });
  // The caller can read every scope here, so a denial is a 403 rather than a 404.
  vi.mocked(can).mockResolvedValue({ allowed: true, reason: "ok" });
  vi.mocked(db.factDispute.findMany).mockResolvedValue([disputeRow] as never);
  vi.mocked(db.factDispute.findFirst).mockResolvedValue(disputeRow as never);
  vi.mocked(db.factDispute.update).mockImplementation((async (arg: { data: Record<string, unknown> }) => ({
    ...disputeRow,
    ...arg.data,
  })) as never);
});

describe("GET /api/facts/disputes", () => {
  it("returns only disputed-status rows the caller is scope-admin over", async () => {
    const res = await disputesGET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.disputes).toHaveLength(1);
    expect(data.disputes[0]).toMatchObject({ id: "disp_1", status: "disputed" });

    // Query is pending-only (status=disputed), scoped to this org.
    const call = vi.mocked(db.factDispute.findMany).mock.calls[0][0] as { where: Record<string, unknown> };
    expect(call.where).toMatchObject({ orgId: "org_1", status: "disputed" });
    // Authority is evaluated per scope via access.manage (the scope-admin rule).
    expect(check).toHaveBeenCalledWith(
      admin.ctx,
      expect.objectContaining({ action: "access.manage", scope: "org_1.engineering" }),
    );
  });

  it("filters out disputes in scopes the caller is not admin over", async () => {
    vi.mocked(check).mockResolvedValue({ allowed: false, reason: "not scope admin" });
    const res = await disputesGET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.disputes).toHaveLength(0);
  });

  it("401 without a session", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(null);
    const res = await disputesGET();
    expect(res.status).toBe(401);
  });
});

describe("POST /api/facts/disputes/:id/resolve", () => {
  const cases: { resolution: string; status: string; value?: string }[] = [
    { resolution: "proposer", status: "resolved_proposer" },
    { resolution: "existing", status: "resolved_existing" },
    {
      resolution: "reconciled",
      status: "resolved_reconciled",
      value: "We use Postgres ltree, closure table removed by Q3.",
    },
  ];

  for (const c of cases) {
    it(`resolution "${c.resolution}" → status ${c.status}, stamps resolver + resolvedAt`, async () => {
      const res = await resolvePOST(
        req(`http://t/api/facts/disputes/disp_1/resolve`, { resolution: c.resolution, value: c.value }),
        params({ id: "disp_1" }),
      );
      expect(res.status).toBe(200);

      const updateArg = vi.mocked(db.factDispute.update).mock.calls[0][0] as {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      };
      expect(updateArg.where).toMatchObject({ id: "disp_1" });
      expect(updateArg.data.status).toBe(c.status);
      expect(updateArg.data.resolverId).toBe("user_admin");
      expect(updateArg.data.resolvedAt).toBeInstanceOf(Date);
      if (c.value !== undefined) expect(updateArg.data.resolvedValue).toBe(c.value);
    });
  }

  it("403 when the caller is not admin on the dispute's scope", async () => {
    vi.mocked(check).mockResolvedValue({ allowed: false, reason: "not scope admin" });
    const res = await resolvePOST(
      req(`http://t/api/facts/disputes/disp_1/resolve`, { resolution: "proposer" }),
      params({ id: "disp_1" }),
    );
    expect(res.status).toBe(403);
    expect(db.factDispute.update).not.toHaveBeenCalled();
  });

  it("400 for an unknown resolution value", async () => {
    const res = await resolvePOST(
      req(`http://t/api/facts/disputes/disp_1/resolve`, { resolution: "whatever" }),
      params({ id: "disp_1" }),
    );
    expect(res.status).toBe(400);
    expect(db.factDispute.update).not.toHaveBeenCalled();
  });

  it("404 for an unknown dispute id", async () => {
    vi.mocked(db.factDispute.findFirst).mockResolvedValue(null);
    const res = await resolvePOST(
      req(`http://t/api/facts/disputes/nope/resolve`, { resolution: "proposer" }),
      params({ id: "nope" }),
    );
    expect(res.status).toBe(404);
    expect(db.factDispute.update).not.toHaveBeenCalled();
  });

  it("cross-org isolation: a dispute in another org is not resolvable", async () => {
    // The route scopes the lookup to the caller's org, so a foreign dispute won't be
    // found → 404, and nothing is ever updated.
    vi.mocked(db.factDispute.findFirst).mockResolvedValue(null);
    const res = await resolvePOST(
      req(`http://t/api/facts/disputes/disp_from_org_2/resolve`, { resolution: "existing" }),
      params({ id: "disp_from_org_2" }),
    );
    expect(res.status).toBe(404);
    const lookupArg = vi.mocked(db.factDispute.findFirst).mock.calls[0][0] as { where: Record<string, unknown> };
    expect(lookupArg.where).toMatchObject({ id: "disp_from_org_2", orgId: "org_1" });
    expect(db.factDispute.update).not.toHaveBeenCalled();
  });
});

describe("POST /api/briefs/:id/correct", () => {
  const stubBrief = { id: "brief_1", orgId: "org_1", scopePath: "org_1.engineering" };

  beforeEach(() => {
    vi.mocked(db.brief.findFirst).mockResolvedValue(stubBrief as never);
    vi.mocked(findContradiction).mockResolvedValue({ contradiction: null, complete: true });
    vi.mocked(openFactDispute).mockResolvedValue({ id: "disp_new" } as never);
  });

  it("happy path (no contradiction): writes back a HUMAN episode, returns { ok, autoMerged:false }", async () => {
    const res = await correctPOST(
      req(`http://t/api/briefs/brief_1/correct`, {
        sectionHeading: "System design",
        correction: "We moved off the closure table entirely — ltree only.",
      }),
      params({ id: "brief_1" }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ ok: true, autoMerged: false });

    // The provenance claim: the correction is ingested as a HUMAN-authored episode.
    expect(ingestMemory).toHaveBeenCalledWith(
      expect.objectContaining({ actorType: "human", scopePath: "org_1.engineering", groupId: "org_1" }),
    );
    // Tagged the same way
    // check()'s own gating call above tagged this write (`brief:${id}`), so
    // its confirmed-applied audit row still matches staleness's self-write
    // exclusion after the switch off authorization-time rows.
    expect(ingestMemory).toHaveBeenCalledWith(expect.objectContaining({ auditTag: "brief:brief_1" }));
  });

  it("says the contradiction check was incomplete when its read did not search everything", async () => {
    vi.mocked(findContradiction).mockResolvedValue({ contradiction: null, complete: false });
    const res = await correctPOST(
      req(`http://t/api/briefs/brief_1/correct`, { correction: "The queue runs on Postgres now." }),
      params({ id: "brief_1" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, autoMerged: false, contradictionCheckIncomplete: true });
  });

  it("does not flag a complete contradiction check", async () => {
    const res = await correctPOST(
      req(`http://t/api/briefs/brief_1/correct`, { correction: "The queue runs on Postgres now." }),
      params({ id: "brief_1" }),
    );
    expect(await res.json()).not.toHaveProperty("contradictionCheckIncomplete");
  });

  it("auto-merges when the correction contradicts an AGENT fact (human outranks)", async () => {
    vi.mocked(findContradiction).mockResolvedValue({
      contradiction: {
        fact: "The queue runs on SQS.",
        uuid: "edge-1",
        actorType: "agent",
        actorName: "Architecture agent",
        note: "",
      },
      complete: true,
    });
    vi.mocked(guardedMemory.removeFact).mockResolvedValue({
      removed: true,
      removedVersion: { changeId: "change-supersede-1", scopePath: "org_1.engineering" },
    });
    const res = await correctPOST(
      req(`http://t/api/briefs/brief_1/correct`, { correction: "The queue runs on Postgres now." }),
      params({ id: "brief_1" }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.autoMerged).toBe(true);
    // Auto-merge invalidates the stale agent fact.
    expect(guardedMemory.removeFact).toHaveBeenCalledWith(
      admin.ctx,
      expect.objectContaining({ factId: "edge-1" }),
      "org_1.engineering",
      "The queue runs on Postgres now.",
    );
    // Still recorded as a human episode, naming the removal it replaces.
    expect(ingestMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: "human",
        correctionOf: { factId: "edge-1", removalId: "change-supersede-1", scopePath: "org_1.engineering" },
      }),
    );
  });

  it("opens a dispute when the correction contradicts a same-tier HUMAN fact", async () => {
    vi.mocked(findContradiction).mockResolvedValue({
      contradiction: {
        fact: "The queue runs on SQS.",
        uuid: "edge-2",
        actorType: "human",
        actorName: "Priya",
        note: "",
      },
      complete: true,
    });
    const res = await correctPOST(
      req(`http://t/api/briefs/brief_1/correct`, { correction: "The queue runs on Postgres now." }),
      params({ id: "brief_1" }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ autoMerged: false, disputeId: "disp_new" });
    expect(openFactDispute).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org_1", graphitiFactUuid: "edge-2", proposerActorType: "human" }),
    );
    expect(guardedMemory.removeFact).not.toHaveBeenCalled();
  });

  // ingestMemory refuses a NUL by throwing, which this route did not map: a 500 naming nothing,
  // after the contradiction search had already run.
  it.each([
    ["correction", { correction: "The queue runs on\u0000 Postgres now." }],
    ["sectionHeading", { sectionHeading: "System\u0000 design", correction: "The queue runs on Postgres now." }],
  ])("400 naming the fix when %s holds a NUL, before any search or write", async (field, body) => {
    const res = await correctPOST(req(`http://t/api/briefs/brief_1/correct`, body), params({ id: "brief_1" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      `${field} contains a NUL (\\u0000) character, which cannot be stored. Remove it and retry.`,
    );
    expect(findContradiction).not.toHaveBeenCalled();
    expect(ingestMemory).not.toHaveBeenCalled();
  });

  it("401 without a session", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(null);
    const res = await correctPOST(
      req(`http://t/api/briefs/brief_1/correct`, { correction: "x" }),
      params({ id: "brief_1" }),
    );
    expect(res.status).toBe(401);
  });

  it("404 when the brief does not exist / belongs to another org", async () => {
    vi.mocked(db.brief.findFirst).mockResolvedValue(null);
    const res = await correctPOST(
      req(`http://t/api/briefs/brief_from_org_2/correct`, { correction: "x" }),
      params({ id: "brief_from_org_2" }),
    );
    expect(res.status).toBe(404);
    const lookupArg = vi.mocked(db.brief.findFirst).mock.calls[0][0] as { where: Record<string, unknown> };
    expect(lookupArg.where).toMatchObject({ id: "brief_from_org_2", orgId: "org_1" });
  });
});
