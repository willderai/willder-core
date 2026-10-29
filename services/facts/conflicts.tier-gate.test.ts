// The account-tier gate and raw-row authorship for the contradiction checks
// (services/facts/conflicts.ts).
//
// Brief correction runs findContradiction synchronously, before its own write. It used to
// take the contradicted fact's author from graph edges alone, so a row the graph has not
// absorbed yet (pending, declined, or on a tier that does not read the graph) read as "human"
// and opened a dispute instead of auto-merging. The author of a raw row is now read from the
// row itself in Postgres, whenever no graph edge matches the hit; a hit with a matching edge
// answers exactly as before. Shipped without a flag, as a bug fix.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreate, mockGraph, mockRetrieve, mockAuthorship } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockGraph: vi.fn(),
  mockRetrieve: vi.fn(),
  mockAuthorship: vi.fn(),
}));
vi.mock("@/lib/llm", () => ({
  createLLMClient: () => ({ chat: { completions: { create: mockCreate } } }),
  LLM_MODEL_ORCHESTRATOR: "test-orchestrator",
}));
vi.mock("@/services/memory", () => ({ guardedMemory: { graph: mockGraph, retrieve: mockRetrieve } }));
vi.mock("@/services/memory/raw-rows", () => ({ rawRowAuthorship: mockAuthorship }));

import { findContradiction, findScopeContradictionsChecked, findScopeContradictions } from "./conflicts";
import type { AccessContext } from "@/services/access";
import type { MemoryFact, StoreRead } from "@/types/memory";

const ctx = { orgId: "org_1", actor: { type: "human", id: "u1" } } as AccessContext;
const reply = (content: string) => ({ choices: [{ message: { content } }] });

/** A row stored in Postgres whose graph extraction has not run: no edge holds it yet. */
const PENDING: MemoryFact = {
  uuid: "chunk_pending",
  fact: "The deploy target is Vercel",
  validAt: null,
  actorType: "extraction",
  store: "semantic",
};

function readOf(facts: MemoryFact[], stores: StoreRead["store"][]) {
  return { facts, breakdown: { stores: stores.map((store) => ({ store, hits: 1 })), contextTokens: 10 } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreate.mockResolvedValue(reply(JSON.stringify({ index: 1, note: "incompatible targets" })));
  mockAuthorship.mockResolvedValue({ actorType: "extraction", actorName: "Google Drive" });
});

describe("a correction against a row the graph has not absorbed", () => {
  it("auto-merges on a tier that does not read the graph: the author is the raw row's own", async () => {
    mockRetrieve.mockResolvedValue(readOf([PENDING], ["semantic"]));
    mockGraph.mockResolvedValue({ nodes: [], edges: [], notRead: "account-tier" });
    const { contradiction } = await findContradiction(ctx, "org_1", "org_1.eng", "The deploy target is AWS");
    expect(contradiction).toMatchObject({ uuid: "chunk_pending", actorType: "extraction", actorName: "Google Drive" });
    // The route auto-merges any contradicted fact not written by a human.
    expect(contradiction!.actorType).not.toBe("human");
    expect(mockAuthorship).toHaveBeenCalledWith("org_1", "chunk_pending");
  });

  it("auto-merges on enterprise with the flag off: a pending row with no edge is read as its own author, not as human", async () => {
    mockRetrieve.mockResolvedValue(readOf([PENDING], ["graph", "semantic"]));
    mockGraph.mockResolvedValue({ nodes: [], edges: [] });
    const { contradiction } = await findContradiction(ctx, "org_1", "org_1.eng", "The deploy target is AWS");
    expect(contradiction).toEqual({
      fact: PENDING.fact,
      uuid: "chunk_pending",
      actorType: "extraction",
      actorName: "Google Drive",
      note: "incompatible targets",
    });
  });

  it("reads a pending agent row as agent, so the correction applies instead of opening a human dispute", async () => {
    mockAuthorship.mockResolvedValue({ actorType: "agent", actorName: null });
    mockRetrieve.mockResolvedValue(readOf([{ ...PENDING, actorType: "agent" }], ["graph", "semantic"]));
    mockGraph.mockResolvedValue({ nodes: [], edges: [] });
    const { contradiction } = await findContradiction(ctx, "org_1", "org_1.eng", "The deploy target is AWS");
    expect(contradiction).toMatchObject({ uuid: "chunk_pending", actorType: "agent", actorName: undefined });
  });

  it("is unchanged when an edge matches: the edge's author and uuid, and no row lookup", async () => {
    mockRetrieve.mockResolvedValue(
      readOf(
        [{ uuid: "chunk_absorbed", fact: "The deploy target is Vercel", validAt: null, store: "semantic" }],
        ["graph", "semantic"],
      ),
    );
    mockGraph.mockResolvedValue({
      nodes: [],
      edges: [
        {
          uuid: "edge_9",
          source: "a",
          target: "b",
          fact: "The deploy target is Vercel",
          actorType: "agent",
          actorName: "crew",
        },
      ],
    });
    const { contradiction } = await findContradiction(ctx, "org_1", "org_1.eng", "The deploy target is AWS");
    expect(contradiction).toEqual({
      fact: "The deploy target is Vercel",
      uuid: "edge_9",
      actorType: "agent",
      actorName: "crew",
      note: "incompatible targets",
    });
    expect(mockAuthorship).not.toHaveBeenCalled();
  });

  it("still defaults to human for a hit with no edge and no raw row", async () => {
    mockAuthorship.mockResolvedValue(null);
    mockRetrieve.mockResolvedValue(
      readOf(
        [{ uuid: "edge_gone", fact: "The deploy target is Vercel", validAt: null, store: "graph" }],
        ["graph", "semantic"],
      ),
    );
    mockGraph.mockResolvedValue({ nodes: [], edges: [] });
    const { contradiction } = await findContradiction(ctx, "org_1", "org_1.eng", "The deploy target is AWS");
    expect(contradiction).toMatchObject({ uuid: "edge_gone", actorType: "human" });
  });
});

describe("the scope contradiction scan on a tier that does not read the graph", () => {
  it("says the graph was not read and spends no model call", async () => {
    mockGraph.mockResolvedValue({ nodes: [], edges: [], notRead: "account-tier" });
    expect(await findScopeContradictionsChecked(ctx, "org_1", "org_1.eng")).toEqual({
      found: [],
      notRead: "account-tier",
    });
    expect(await findScopeContradictions(ctx, "org_1", "org_1.eng")).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("is unchanged on enterprise: the scan judges the graph's current edges and carries no label", async () => {
    mockGraph.mockResolvedValue({
      nodes: [],
      edges: [
        { uuid: "e1", source: "s", target: "t", fact: "the deploy target is Vercel" },
        { uuid: "e2", source: "s", target: "t", fact: "the deploy target is AWS" },
      ],
    });
    mockCreate.mockResolvedValue(reply(JSON.stringify({ contradictions: [{ a: 1, b: 2, note: "targets" }] })));
    expect(await findScopeContradictionsChecked(ctx, "org_1", "org_1.eng")).toEqual({
      found: [{ factA: "the deploy target is Vercel", factB: "the deploy target is AWS", note: "targets" }],
    });
  });
});
