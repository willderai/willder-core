import { beforeEach, describe, expect, it, vi } from "vitest";

// Tests for the QA run→persist pipeline (services/agents/qa-run.ts). It runs the QA agent
// (mocked here) and flattens the structured QaReport into the generic Brief `sections`
// array BriefView already renders, prefixing the verdict into the summary and storing the
// Brief as type "qa_review". We mock both the runner (canned report) and db.brief.create,
// and assert on the shape persisted — not the LLM.
vi.mock("@/services/agents/runner", () => ({ runQaAgent: vi.fn() }));
vi.mock("@/lib/db", () => {
  const db = { brief: { create: vi.fn() }, $transaction: vi.fn((fn: (tx: unknown) => unknown) => fn(db)) };
  return { db };
});
// The brief's change event is create-brief.test.ts's subject; here it only has to succeed.
vi.mock("@/services/memory/change-events", () => ({ recordChangeEvent: vi.fn() }));

import { runQaAgent } from "@/services/agents/runner";
import { db } from "@/lib/db";
import { orgRootPath } from "@/services/access";
import { runAndPersistQaReview } from "./qa-run";

/** Same ltree-label contract check()'s `::ltree` cast enforces (services/access/check.ts). */
const isValidLtree = (path: string): boolean =>
  path.length > 0 && path.split(".").every((label) => /^[A-Za-z0-9_]+$/.test(label));

const agentRow = {
  id: "agent_qa",
  agentKey: "qa-agent",
  name: "QA agent",
  role: "qa",
  model: "qwen/qwen3-32b",
  systemPrompt: "test it",
  tools: [],
  settings: {},
} as never;

const baseInput = {
  agentRow,
  agentId: "agent_qa",
  orgId: "org_1",
  scopePath: "org_1.engineering",
  capabilityToken: "wcap_qa",
  target: { baseUrl: "https://api.acme.com" },
};

const fullReport = {
  title: "API smoke + edge probe: acme.com",
  summary: "Core endpoints respond, but signup 500s on empty email.",
  verdict: "issues_found" as const,
  bugs: [
    {
      severity: "major" as const,
      finding: "POST /signup 500s on empty email",
      repro: 'POST /signup {"email":""}',
      observed: "500 Internal Server Error",
      expected: "400 Bad Request with a validation message",
    },
  ],
  performance: [{ endpoint: "GET /search", samples: 10, p50LatencyMs: 120, maxLatencyMs: 900, errorRate: 0.1 }],
  suggestions: ["Add input validation on /signup", "Add a rate limit to /search"],
  unmeasurable: ["Server CPU/memory (no metrics endpoint exposed)"],
};

beforeEach(() => {
  vi.clearAllMocks();
  // db.brief.create echoes back an id + its input data so we can assert on what's persisted.
  vi.mocked(db.brief.create).mockImplementation((async (args: { data: Record<string, unknown> }) => ({
    id: "brief_qa",
    ...args.data,
  })) as never);
});

describe("runAndPersistQaReview", () => {
  it("runs the QA agent with the run inputs threaded through (scope→memoryScope, mode)", async () => {
    vi.mocked(runQaAgent).mockResolvedValue(fullReport as never);
    await runAndPersistQaReview({ ...baseInput, focus: "signup flow", mode: "api" });
    expect(runQaAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentRow,
        orgId: "org_1",
        capabilityToken: "wcap_qa",
        memoryScope: "org_1.engineering",
        target: { baseUrl: "https://api.acme.com" },
        focus: "signup flow",
        mode: "api",
      }),
    );
  });

  it("persists a Brief of type 'qa_review' scoped to the run", async () => {
    vi.mocked(runQaAgent).mockResolvedValue(fullReport as never);
    const { brief } = await runAndPersistQaReview(baseInput);
    expect(db.brief.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orgId: "org_1",
          type: "qa_review",
          scopePath: "org_1.engineering",
          title: fullReport.title,
        }),
      }),
    );
    expect(brief).toMatchObject({ id: "brief_qa", type: "qa_review" });
  });

  it("prefixes the verdict label into the summary", async () => {
    vi.mocked(runQaAgent).mockResolvedValue(fullReport as never);
    await runAndPersistQaReview(baseInput);
    const data = vi.mocked(db.brief.create).mock.calls[0]![0]!.data as unknown as { summary: string };
    expect(data.summary).toContain("⚠️ Issues found");
    expect(data.summary).toContain(fullReport.summary);
  });

  it("uses the matching verdict label for each verdict", async () => {
    const labels: [string, string][] = [
      ["healthy", "✅ Healthy"],
      ["issues_found", "⚠️ Issues found"],
      ["broken", "🛑 Broken"],
      ["could_not_test", "❓ Could not test"],
    ];
    for (const [verdict, label] of labels) {
      vi.mocked(runQaAgent).mockResolvedValue({ ...fullReport, verdict } as never);
      await runAndPersistQaReview(baseInput);
      const data = vi.mocked(db.brief.create).mock.lastCall![0].data as { summary: string };
      expect(data.summary.startsWith(label)).toBe(true);
    }
  });

  it("flattens bugs, performance, suggestions and unmeasurable into sections", async () => {
    vi.mocked(runQaAgent).mockResolvedValue(fullReport as never);
    await runAndPersistQaReview(baseInput);
    const data = vi.mocked(db.brief.create).mock.calls[0]![0]!.data as unknown as {
      sections: { heading: string; content: string }[];
    };
    const byHeading = Object.fromEntries(data.sections.map((s) => [s.heading, s.content]));

    // Bugs section: count in heading + severity/repro/observed/expected in body.
    expect(byHeading["Bugs (1)"]).toContain("[MAJOR] POST /signup 500s on empty email");
    expect(byHeading["Bugs (1)"]).toContain('Repro: POST /signup {"email":""}');
    expect(byHeading["Bugs (1)"]).toContain("Observed: 500 Internal Server Error");
    expect(byHeading["Bugs (1)"]).toContain("Expected: 400 Bad Request");

    // Performance section: endpoint + latency + error rate percentage.
    expect(byHeading["Performance"]).toContain("GET /search");
    expect(byHeading["Performance"]).toContain("p50 120ms");
    expect(byHeading["Performance"]).toContain("max 900ms");
    expect(byHeading["Performance"]).toContain("error rate 10.0%");

    // Suggestions + Not-measurable sections.
    expect(byHeading["Suggestions"]).toContain("• Add input validation on /signup");
    expect(byHeading["Not measurable black-box"]).toContain("Server CPU/memory");
  });

  it("produces no empty sections when the report's arrays are empty", async () => {
    const emptyReport = {
      title: "Clean run",
      summary: "Everything works.",
      verdict: "healthy" as const,
      bugs: [],
      performance: [],
      suggestions: [],
      unmeasurable: [],
    };
    vi.mocked(runQaAgent).mockResolvedValue(emptyReport as never);
    await runAndPersistQaReview(baseInput);
    const data = vi.mocked(db.brief.create).mock.calls[0]![0]!.data as unknown as {
      sections: { heading: string; content: string }[];
    };
    expect(data.sections).toEqual([]);
  });

  it("omits the 'Not measurable' section when unmeasurable is undefined", async () => {
    const noUnmeasurable = {
      title: "Partial",
      summary: "Some bugs.",
      verdict: "issues_found" as const,
      bugs: fullReport.bugs,
      performance: [],
      suggestions: [],
      // unmeasurable intentionally omitted
    };
    vi.mocked(runQaAgent).mockResolvedValue(noUnmeasurable as never);
    await runAndPersistQaReview(baseInput);
    const data = vi.mocked(db.brief.create).mock.calls[0]![0]!.data as unknown as {
      sections: { heading: string; content: string }[];
    };
    const headings = data.sections.map((s) => s.heading);
    expect(headings).toContain("Bugs (1)");
    expect(headings).not.toContain("Not measurable black-box");
  });

  it("returns both the persisted brief and the raw report", async () => {
    vi.mocked(runQaAgent).mockResolvedValue(fullReport as never);
    const result = await runAndPersistQaReview(baseInput);
    expect(result.report).toBe(fullReport);
    expect(result.brief).toMatchObject({ id: "brief_qa" });
  });

  // Brief.scopePath is authorization-bearing (check() enforces against it,
  // cast to ::ltree). A human-readable label ('(target) <host>') is not a
  // valid ltree value and would crash check()'s cast, so the real write path
  // always produces a valid, authorizable scopePath, with the label preserved
  // separately for display.
  describe("scope-less run's scopePath", () => {
    it("falls back to the org root, a valid ltree value, instead of the raw host label", async () => {
      vi.mocked(runQaAgent).mockResolvedValue(fullReport as never);
      await runAndPersistQaReview({ ...baseInput, scopePath: undefined });
      const data = vi.mocked(db.brief.create).mock.calls[0]![0]!.data as unknown as {
        scopePath: string;
        scopeLabel: string | null;
      };
      expect(data.scopePath).toBe(orgRootPath("org_1"));
      expect(isValidLtree(data.scopePath)).toBe(true);
      expect(data.scopeLabel).toBe("(target) api.acme.com");
    });

    it("keeps the real memory scope in scopePath and leaves scopeLabel null when a scope was given", async () => {
      vi.mocked(runQaAgent).mockResolvedValue(fullReport as never);
      await runAndPersistQaReview(baseInput);
      const data = vi.mocked(db.brief.create).mock.calls[0]![0]!.data as unknown as {
        scopePath: string;
        scopeLabel: string | null;
      };
      expect(data.scopePath).toBe("org_1.engineering");
      expect(data.scopeLabel).toBeNull();
    });
  });
});
