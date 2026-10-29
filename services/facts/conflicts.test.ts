import { beforeEach, describe, expect, it, vi } from "vitest";

// findScopeContradictions is the bounded, read-time contradiction scan GET
// /api/briefs/:id/staleness calls when its own `changed` flag is true. Mock the
// LLM client the same way draft.test.ts does — no network, tests prompt/parse
// behavior only.
const { mockCreate, mockGraph, mockRetrieve } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockGraph: vi.fn(),
  mockRetrieve: vi.fn(),
}));
vi.mock("@/lib/llm", () => ({
  createLLMClient: () => ({ chat: { completions: { create: mockCreate } } }),
  LLM_MODEL_ORCHESTRATOR: "test-orchestrator",
}));
vi.mock("@/services/memory", () => ({ guardedMemory: { graph: mockGraph, retrieve: mockRetrieve } }));

import { findContradiction, findScopeContradictions } from "./conflicts";
import type { AccessContext } from "@/services/access";

const ctx = { orgId: "org_1", actor: { type: "human", id: "u1" } } as AccessContext;
const reply = (content: string) => ({ choices: [{ message: { content } }] });
const edge = (uuid: string, fact: string) => ({ uuid, source: "s", target: "t", fact });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("findScopeContradictions", () => {
  it("returns [] without calling the LLM when fewer than 2 facts exist in scope", async () => {
    mockGraph.mockResolvedValue({ edges: [edge("e1", "only one fact")], nodes: [] });
    const result = await findScopeContradictions(ctx, "org_1", "org_1.eng");
    expect(result).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns [] when the graph read throws (best-effort, never breaks the caller)", async () => {
    mockGraph.mockRejectedValue(new Error("graph unavailable"));
    const result = await findScopeContradictions(ctx, "org_1", "org_1.eng");
    expect(result).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("maps a genuine LLM-flagged pair back to the real fact text", async () => {
    mockGraph.mockResolvedValue({
      edges: [
        edge("e1", "the deploy target is Vercel. Confirmed by the platform team."),
        edge("e2", "the deploy target is AWS ECS. Confirmed by the platform team."),
      ],
      nodes: [],
    });
    mockCreate.mockResolvedValue(
      reply(JSON.stringify({ contradictions: [{ a: 1, b: 2, note: "same decision, incompatible targets" }] })),
    );
    const result = await findScopeContradictions(ctx, "org_1", "org_1.eng");
    expect(result).toEqual([
      {
        factA: "the deploy target is Vercel. Confirmed by the platform team.",
        factB: "the deploy target is AWS ECS. Confirmed by the platform team.",
        note: "same decision, incompatible targets",
      },
    ]);
  });

  it("scans current facts only: a version a write race superseded is not judged against its winner", async () => {
    // The graph view marks the loser of a race with invalidAt (services/memory/guarded-store.ts);
    // judging it against the winner would report a conflict the product already decided as a
    // live contradiction between two current facts.
    mockGraph.mockResolvedValue({
      edges: [
        edge("e1", "the release train leaves on Monday"),
        { ...edge("e2", "the release train leaves on Tuesday"), invalidAt: "2026-10-06T10:00:00.000Z" },
        edge("e3", "the freeze window starts Friday"),
      ],
      nodes: [],
    });
    mockCreate.mockResolvedValue(reply(JSON.stringify({ contradictions: [] })));

    await findScopeContradictions(ctx, "org_1", "org_1.eng");

    const prompt = String(mockCreate.mock.calls[0]![0].messages[1].content);
    expect(prompt).toContain("Monday");
    expect(prompt).not.toContain("Tuesday");
  });

  it("bounds the graph read to SCOPE_SCAN_LIMIT (20), same order as MAX_CHANGES", async () => {
    mockGraph.mockResolvedValue({ edges: [], nodes: [] });
    await findScopeContradictions(ctx, "org_1", "org_1.eng");
    expect(mockGraph).toHaveBeenCalledWith(ctx, { groupId: "org_1", limit: 20 }, "org_1.eng");
  });

  it("drops an out-of-range or malformed index instead of throwing", async () => {
    mockGraph.mockResolvedValue({
      edges: [edge("e1", "fact one"), edge("e2", "fact two")],
      nodes: [],
    });
    mockCreate.mockResolvedValue(
      reply(
        JSON.stringify({
          contradictions: [
            { a: 1, b: 9, note: "bad index" },
            { a: 1, b: 1, note: "self" },
          ],
        }),
      ),
    );
    const result = await findScopeContradictions(ctx, "org_1", "org_1.eng");
    expect(result).toEqual([]);
  });

  it("returns [] when the model call itself fails", async () => {
    mockGraph.mockResolvedValue({
      edges: [edge("e1", "fact one"), edge("e2", "fact two")],
      nodes: [],
    });
    mockCreate.mockRejectedValue(new Error("llm down"));
    const result = await findScopeContradictions(ctx, "org_1", "org_1.eng");
    expect(result).toEqual([]);
  });

  it("returns [] when the model finds no genuine contradiction", async () => {
    mockGraph.mockResolvedValue({
      edges: [edge("e1", "fact one"), edge("e2", "fact two")],
      nodes: [],
    });
    mockCreate.mockResolvedValue(reply(JSON.stringify({ contradictions: [] })));
    const result = await findScopeContradictions(ctx, "org_1", "org_1.eng");
    expect(result).toEqual([]);
  });
});

describe("findContradiction", () => {
  it("marks a fact served as an excerpt in the list the model judges", async () => {
    mockRetrieve.mockResolvedValue({
      facts: [
        { uuid: "f1", fact: "The queue runs on Redis.", validAt: null },
        { uuid: "f2", fact: "… The queue moved in May. …", validAt: null, excerptOfChars: 67716 },
      ],
    });
    mockCreate.mockResolvedValue(reply(JSON.stringify({ index: 0, note: "" })));

    await findContradiction(ctx, "org_1", undefined, "The queue runs on Postgres.");

    const prompt = String(mockCreate.mock.calls[0]![0].messages[1].content);
    expect(prompt).toContain("1. The queue runs on Redis.\n2. … The queue moved in May. … [excerpt of 67716 chars]");
  });

  it("finds none, and says the check was complete, when a complete read returns nothing", async () => {
    mockRetrieve.mockResolvedValue({ facts: [] });

    await expect(findContradiction(ctx, "org_1", undefined, "The queue runs on Postgres.")).resolves.toEqual({
      contradiction: null,
      complete: true,
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["some scopes below were not searched", { partialScopeCoverage: true }],
    ["a store did not answer", { degraded: ["graph"] }],
  ])("does not read as 'no contradiction' when %s", async (_why, incomplete) => {
    mockRetrieve.mockResolvedValue({ facts: [], ...incomplete });

    await expect(findContradiction(ctx, "org_1", undefined, "The queue runs on Postgres.")).resolves.toEqual({
      contradiction: null,
      complete: false,
    });
  });
});
