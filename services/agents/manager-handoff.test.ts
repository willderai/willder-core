import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Unit tests for the HANDOFF (BRIEFING) MANAGER engine (services/agents/manager-handoff.ts).
//
// Handoff is ONE-SHOT (no AgentRun / run-loop / db), so this is far lighter than manager.test.ts:
// we mock only the runner (buildMastraAgent → a fake agent whose `generate` we drive by prompt;
// buildRuntimeContext → a Map-backed stub) and the handoff-agent id constants. Each child does a
// two-call retrieve→structure; the fake agent returns text on call 1 (no `output`) and a
// per-bucket HandoffBrief `object` on call 2 (with `output`). Slots let a test make one bucket's
// structure call throw, exercising per-child failure tolerance.

type Brief = {
  title: string;
  summary: string;
  sections: { heading: string; content: string }[];
  diagram?: string;
  focusAreas?: { label: string; weight: number }[];
  rampPlan?: { milestone: string; week?: string }[];
};

const h = vi.hoisted(() => {
  const slots = {
    // Keyed by bucket title → the HandoffBrief that bucket's structure call returns.
    briefFor: null as null | ((bucketTitle: string) => Brief),
    // Bucket titles whose structure call should throw (per-child failure).
    throwFor: new Set<string>(),
  };
  return { slots, generate: vi.fn() };
});

vi.mock("@/services/agents/runner", () => ({
  buildMastraAgent: vi.fn(() => ({ generate: h.generate })),
  buildRuntimeContext: vi.fn(() => {
    const m = new Map<string, unknown>();
    return { get: (k: string) => m.get(k), set: (k: string, v: unknown) => void m.set(k, v) };
  }),
  HANDOFF_OUTPUT_SCHEMA: {},
}));

vi.mock("@/lib/handoff-agent", () => ({
  HANDOFF_AGENT_ID: "handoff_agent_id",
  HANDOFF_AGENT_NAME: "Handoff agent",
}));

import {
  handoffManagerEnabled,
  runHandoffManager,
  foldHandoffFragments,
  HANDOFF_BUCKETS,
  HANDOFF_MANAGER_CONFIG,
  type HandoffBucket,
} from "./manager-handoff";

// --- helpers ---------------------------------------------------------------

/** Extract the bucket title from a prompt (each child prompt embeds `"<title>" portion`). */
function bucketOf(prompt: string): string {
  const m = /"([^"]+)" portion/.exec(prompt);
  return m?.[1] ?? "";
}

function defaultBrief(title: string): Brief {
  return {
    title: `Child: ${title}`,
    summary: `Summary for ${title}.`,
    sections: [{ heading: title, content: `Content for ${title}.` }],
  };
}

// Drive the fake agent: call 1 (retrieve, no `output`) → text; call 2 (structure, `output`) → object.
function wireGenerate() {
  h.generate.mockImplementation(async (prompt: string, options?: { output?: unknown }) => {
    const title = bucketOf(prompt);
    if (!options?.output) return { text: `observations for ${title}` };
    if (h.slots.throwFor.has(title)) throw new Error(`structure failed for ${title}`);
    const brief = h.slots.briefFor ? h.slots.briefFor(title) : defaultBrief(title);
    return { object: brief };
  });
}

const ORIG_ENV = { ...process.env };

const agentRow = {
  agentKey: "handoff-agent",
  name: "Handoff agent",
  role: "handoff",
  model: null,
  systemPrompt: null,
  tools: ["memory_read"],
  settings: {},
};

function opts(over: Record<string, unknown> = {}) {
  return {
    agentRow,
    granteeName: "Jordan Rivera",
    granteeRole: "Contractor",
    orgId: "org_1",
    capabilityToken: "wcap_test",
    memoryScope: "org_1.engineering",
    ...over,
  } as Parameters<typeof runHandoffManager>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  h.slots.briefFor = null;
  h.slots.throwFor = new Set();
  wireGenerate();
});

afterEach(() => {
  process.env = { ...ORIG_ENV };
});

// ---------------------------------------------------------------------------
// 1. FLAG — mirrors archManagerEnabled()
// ---------------------------------------------------------------------------

describe("handoffManagerEnabled", () => {
  const prev = process.env.HANDOFF_MANAGER;
  afterEach(() => {
    if (prev === undefined) delete process.env.HANDOFF_MANAGER;
    else process.env.HANDOFF_MANAGER = prev;
  });

  it("is OFF unless explicitly enabled, and true only for true/1/on/yes", () => {
    delete process.env.HANDOFF_MANAGER;
    expect(handoffManagerEnabled()).toBe(false);
    for (const off of ["false", "0", "off", "no", "", "enabled"]) {
      process.env.HANDOFF_MANAGER = off;
      expect(handoffManagerEnabled()).toBe(false);
    }
    for (const on of ["true", "1", "on", "yes", "TRUE", "On", "YES"]) {
      process.env.HANDOFF_MANAGER = on;
      expect(handoffManagerEnabled()).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. DECOMPOSITION — fixed ≤5 domain buckets, depth-1
// ---------------------------------------------------------------------------

describe("decomposition", () => {
  it("caps at MAX_CHILDREN (=5) buckets", () => {
    expect(HANDOFF_MANAGER_CONFIG.MAX_CHILDREN).toBe(5);
    expect(HANDOFF_BUCKETS.length).toBeLessThanOrEqual(5);
  });

  it("runs one two-call child per bucket (retrieve + structure), in parallel", async () => {
    await runHandoffManager(opts());
    // 2 generate calls per bucket.
    expect(h.generate).toHaveBeenCalledTimes(HANDOFF_BUCKETS.length * 2);
    // Every bucket got a retrieve (no output) and a structure (output) call.
    const structureTitles = h.generate.mock.calls
      .filter((c) => (c[1] as { output?: unknown } | undefined)?.output)
      .map((c) => bucketOf(c[0] as string))
      .sort();
    expect(structureTitles).toEqual(HANDOFF_BUCKETS.map((b) => b.title).sort());
  });

  it("gives every child's runtime context the caller's sourcesRead set, so no child's reads go unrecorded", async () => {
    const { buildRuntimeContext } = await import("@/services/agents/runner");
    const sourcesRead = new Set<string>();

    await runHandoffManager(opts({ sourcesRead }));

    const passed = vi.mocked(buildRuntimeContext).mock.calls.map(([values]) => values.sourcesRead);
    expect(passed).toHaveLength(HANDOFF_BUCKETS.length);
    for (const set of passed) expect(set).toBe(sourcesRead);
  });

  it("never spawns more than MAX_CHILDREN children even if the bucket list grew", async () => {
    await runHandoffManager(opts());
    const structureCalls = h.generate.mock.calls.filter((c) => (c[1] as { output?: unknown } | undefined)?.output);
    expect(structureCalls.length).toBeLessThanOrEqual(HANDOFF_MANAGER_CONFIG.MAX_CHILDREN);
  });
});

// ---------------------------------------------------------------------------
// 3. FOLD — merge sections (bucket order, dedupe), synthesize title/summary, union extras
// ---------------------------------------------------------------------------

describe("fold", () => {
  it("folds every child's sections into ONE brief in bucket order", async () => {
    const brief = await runHandoffManager(opts());
    expect(brief.title).toBe("Onboarding briefing for Jordan Rivera (Contractor)");
    // One section per bucket, in bucket order.
    expect(brief.sections.map((s) => s.heading)).toEqual(HANDOFF_BUCKETS.map((b) => b.title));
    expect(brief.summary).toContain("Jordan Rivera");
  });

  it("dedupes sections by heading (first writer wins) and drops empty content", () => {
    const buckets: HandoffBucket[] = [
      { title: "A", focus: "a" },
      { title: "B", focus: "b" },
      { title: "C", focus: "c" },
    ];
    const brief = foldHandoffFragments({ granteeName: "Sam" }, [
      {
        bucket: buckets[0],
        brief: { title: "t", summary: "s1", sections: [{ heading: "Systems", content: "first" }] },
      },
      { bucket: buckets[1], brief: { title: "t", summary: "s2", sections: [{ heading: "systems", content: "dup" }] } },
      { bucket: buckets[2], brief: { title: "t", summary: "s3", sections: [{ heading: "Empty", content: "  " }] } },
    ]);
    expect(brief.sections).toHaveLength(1);
    expect(brief.sections[0]).toEqual({ heading: "Systems", content: "first" });
    expect(brief.title).toBe("Onboarding briefing for Sam");
  });

  it("unions focusAreas (dedupe by label, keep highest weight) and rampPlan (dedupe by milestone), picks first diagram", () => {
    const b: HandoffBucket[] = [
      { title: "A", focus: "a" },
      { title: "B", focus: "b" },
    ];
    const brief = foldHandoffFragments({ granteeName: "Sam" }, [
      {
        bucket: b[0],
        brief: {
          title: "t",
          summary: "s",
          sections: [{ heading: "A", content: "x" }],
          focusAreas: [{ label: "Auth", weight: 3 }],
          rampPlan: [{ milestone: "Read the docs", week: "Week 1" }],
          diagram: "graph TD; A-->B",
        },
      },
      {
        bucket: b[1],
        brief: {
          title: "t",
          summary: "s",
          sections: [{ heading: "B", content: "y" }],
          focusAreas: [
            { label: "auth", weight: 7 },
            { label: "Billing", weight: 2 },
          ],
          rampPlan: [{ milestone: "read the docs" }, { milestone: "Ship a change" }],
          diagram: "graph TD; C-->D",
        },
      },
    ]);
    expect(brief.focusAreas).toEqual(
      expect.arrayContaining([
        { label: "auth", weight: 7 },
        { label: "Billing", weight: 2 },
      ]),
    );
    expect(brief.focusAreas).toHaveLength(2); // Auth/auth deduped, highest weight kept
    expect(brief.rampPlan?.map((m) => m.milestone)).toEqual(["Read the docs", "Ship a change"]);
    expect(brief.diagram).toBe("graph TD; A-->B"); // first non-empty
  });

  it("yields a valid honest brief when NO child produced anything", () => {
    const brief = foldHandoffFragments({ granteeName: "Sam" }, []);
    expect(brief.sections).toEqual([]);
    expect(brief.summary).toContain("No relevant memory");
    expect(brief.focusAreas).toBeUndefined();
    expect(brief.rampPlan).toBeUndefined();
    expect(brief.diagram).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. PER-CHILD FAILURE TOLERANCE — a failing child is skipped, the run still folds the rest
// ---------------------------------------------------------------------------

describe("per-child failure tolerance", () => {
  it("skips a child whose structure call throws and folds the survivors", async () => {
    const failing = HANDOFF_BUCKETS[2].title;
    h.slots.throwFor = new Set([failing]);
    const brief = await runHandoffManager(opts());
    const headings = brief.sections.map((s) => s.heading);
    expect(headings).not.toContain(failing);
    // Every other bucket still contributed its section.
    expect(headings).toHaveLength(HANDOFF_BUCKETS.length - 1);
  });

  it("still returns a valid brief when EVERY child fails", async () => {
    h.slots.throwFor = new Set(HANDOFF_BUCKETS.map((b) => b.title));
    const brief = await runHandoffManager(opts());
    expect(brief.sections).toEqual([]);
    expect(brief.summary).toContain("No relevant memory");
    expect(brief.title).toBe("Onboarding briefing for Jordan Rivera (Contractor)");
  });
});
