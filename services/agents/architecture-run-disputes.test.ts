// fileContradictionDisputes records BOTH edges of a contradiction on the dispute row.
// The scope scan de-duplicates open disputes on the (existing, proposer) edge pair
// (services/memory/scope-dispute-scan.ts); a row filed here without the proposer uuid
// falls back to matching either edge alone and absorbs unrelated conflicts on that
// edge, so the proposer uuid must reach openFactDispute whenever the graph has one.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/facts/conflicts", () => ({ resolveContradictions: vi.fn() }));
vi.mock("@/services/memory/fact-disputes", () => ({ openFactDispute: vi.fn() }));
vi.mock("@/lib/architecture-agent", () => ({ architectureAgentContext: vi.fn(() => ({})) }));
vi.mock("@/services/memory/create-brief", () => ({ createBrief: vi.fn() }));
vi.mock("@/services/agents/runner", () => ({
  runArchitectureAgent: vi.fn(),
  drawioLinkFromMermaid: vi.fn(),
}));
vi.mock("@/services/agents/derive-artifacts", () => ({ deriveArchitectureCharts: vi.fn() }));
vi.mock("@/services/billing", () => ({ recordArtifactUsage: vi.fn() }));

const { resolveContradictions } = await import("@/services/facts/conflicts");
const { openFactDispute } = await import("@/services/memory/fact-disputes");
const { fileContradictionDisputes } = await import("./architecture-run");

const FLAGGED = [{ factA: "edge_a", factB: "edge_b", note: "incompatible" }];

describe("fileContradictionDisputes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(openFactDispute).mockResolvedValue({ id: "d1" } as never);
  });

  it("stores the proposer's edge uuid when the proposing side is a real edge", async () => {
    vi.mocked(resolveContradictions).mockResolvedValue([
      {
        ...FLAGGED[0],
        existing: { uuid: "edge_a", actorType: "agent", actorId: "a1" },
        proposer: { uuid: "edge_b", actorType: "agent", actorId: "a2" },
      },
    ] as never);

    await fileContradictionDisputes("org_1", "org_1.eng", "tok", FLAGGED);

    expect(openFactDispute).toHaveBeenCalledWith(
      expect.objectContaining({ graphitiFactUuid: "edge_a", proposerFactUuid: "edge_b" }),
    );
  });

  it("leaves the proposer uuid unset when the proposing side has no edge", async () => {
    vi.mocked(resolveContradictions).mockResolvedValue([
      {
        ...FLAGGED[0],
        existing: { uuid: "edge_a", actorType: "agent", actorId: "a1" },
        proposer: null,
      },
    ] as never);

    await fileContradictionDisputes("org_1", "org_1.eng", "tok", FLAGGED);

    const [input] = vi.mocked(openFactDispute).mock.calls[0];
    expect(input.graphitiFactUuid).toBe("edge_a");
    expect(input.proposerFactUuid).toBeUndefined();
  });
});
