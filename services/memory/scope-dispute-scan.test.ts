import { beforeEach, describe, expect, it, vi } from "vitest";

// The tier
// check and de-dup this module adds on top of resolveContradictions/
// openFactDispute (both exercised elsewhere — resolveContradictions by
// architecture-run.ts's own pipeline, openFactDispute by the /correct route) —
// mock both so this file only tests what fileSameTierScopeDisputes itself
// decides: same-tier files, cross-tier skips, an already-open dispute on the
// same edge pair is reused rather than duplicated.
vi.mock("@/services/facts/conflicts", () => ({ resolveContradictions: vi.fn() }));
vi.mock("@/services/memory/fact-disputes", () => ({ openFactDispute: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: { factDispute: { findFirst: vi.fn() } },
}));

import { db } from "@/lib/db";
import { resolveContradictions } from "@/services/facts/conflicts";
import { openFactDispute } from "@/services/memory/fact-disputes";
import { fileSameTierScopeDisputes } from "./scope-dispute-scan";
import type { AccessContext } from "@/services/access";

const ctx = { orgId: "org_1", actor: { type: "human", id: "u1" } } as AccessContext;
const CONTRADICTIONS = [{ factA: "a", factB: "b", note: "n" }];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.factDispute.findFirst).mockResolvedValue(null as never);
});

describe("fileSameTierScopeDisputes", () => {
  it("returns [] immediately for no contradictions, without calling resolveContradictions", async () => {
    const result = await fileSameTierScopeDisputes(ctx, "org_1", "org_1.eng", []);
    expect(result).toEqual([]);
    expect(resolveContradictions).not.toHaveBeenCalled();
  });

  it("files a dispute for a genuine same-tier pair", async () => {
    vi.mocked(resolveContradictions).mockResolvedValue([
      {
        factA: "a",
        factB: "b",
        note: "n",
        existing: { uuid: "edge_a", actorType: "human", actorId: "u1" },
        proposer: { uuid: "edge_b", actorType: "human", actorId: "u2" },
      },
    ]);
    vi.mocked(openFactDispute).mockResolvedValue({ id: "dispute_1" } as never);

    const result = await fileSameTierScopeDisputes(ctx, "org_1", "org_1.eng", CONTRADICTIONS);
    expect(result).toEqual(["dispute_1"]);
    expect(openFactDispute).toHaveBeenCalledWith({
      orgId: "org_1",
      scopePath: "org_1.eng",
      graphitiFactUuid: "edge_a",
      proposerFactUuid: "edge_b",
      proposerActorType: "human",
      proposerActorId: "u2",
      existingActorType: "human",
      existingActorId: "u1",
    });
  });

  it("skips a cross-tier pair — that has a ranked outcome, not a dispute", async () => {
    vi.mocked(resolveContradictions).mockResolvedValue([
      {
        factA: "a",
        factB: "b",
        note: "n",
        existing: { uuid: "edge_a", actorType: "extraction", actorId: "u1" },
        proposer: { uuid: "edge_b", actorType: "human", actorId: "u2" },
      },
    ]);
    const result = await fileSameTierScopeDisputes(ctx, "org_1", "org_1.eng", CONTRADICTIONS);
    expect(result).toEqual([]);
    expect(openFactDispute).not.toHaveBeenCalled();
  });

  it("skips a pair that didn't resolve to real graph edges on both sides", async () => {
    vi.mocked(resolveContradictions).mockResolvedValue([
      { factA: "a", factB: "b", note: "n", existing: null, proposer: null },
    ]);
    const result = await fileSameTierScopeDisputes(ctx, "org_1", "org_1.eng", CONTRADICTIONS);
    expect(result).toEqual([]);
    expect(openFactDispute).not.toHaveBeenCalled();
  });

  it("reuses an already-open dispute on the same edge instead of filing a duplicate", async () => {
    vi.mocked(resolveContradictions).mockResolvedValue([
      {
        factA: "a",
        factB: "b",
        note: "n",
        existing: { uuid: "edge_a", actorType: "human", actorId: "u1" },
        proposer: { uuid: "edge_b", actorType: "human", actorId: "u2" },
      },
    ]);
    vi.mocked(db.factDispute.findFirst).mockResolvedValue({ id: "already_open" } as never);

    const result = await fileSameTierScopeDisputes(ctx, "org_1", "org_1.eng", CONTRADICTIONS);
    expect(result).toEqual(["already_open"]);
    expect(openFactDispute).not.toHaveBeenCalled();
    // Pair key, both orientations: a later view reporting this pair with
    // existing/proposer swapped finds the same row, and a pre-migration row with
    // no proposer uuid still matches on either edge.
    expect(db.factDispute.findFirst).toHaveBeenCalledWith({
      where: {
        orgId: "org_1",
        scopePath: "org_1.eng",
        status: "disputed",
        OR: [
          { graphitiFactUuid: "edge_a", proposerFactUuid: "edge_b" },
          { graphitiFactUuid: "edge_b", proposerFactUuid: "edge_a" },
          { graphitiFactUuid: { in: ["edge_a", "edge_b"] }, proposerFactUuid: null },
        ],
      },
      select: { id: true },
    });
  });
});
