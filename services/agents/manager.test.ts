import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Unit tests for the QA MANAGER / SUPERVISOR engine (services/agents/manager.ts).
//
// Same isolation approach as run-loop.test.ts: everything the manager touches is mocked so
// we exercise the STATE MACHINE + guardrails with no live stack and no LLM.
//   - @/lib/db                 → a small stateful in-memory fake (AgentRun rows + AgentRunEvent
//                                rows) mirroring the Prisma semantics the engine relies on
//                                (update honors `{push}` + skips `undefined`; agentRunEvent
//                                enforces @@unique([runId,seq]) so the P2002 retry is real).
//   - @/services/agents/runner → buildMastraAgent returns a fake agent whose `generate` is a
//                                vi.fn we drive by prompt (plan / verify / replan); build-
//                                RuntimeContext returns a Map-backed get/set stub.
//   - @/services/agents/run-loop → `driveRun` is mocked; it "completes" a child by writing a
//                                plan whose PlanItem.result fragments the manager then reads.
//   - @/lib/qa-agent, @/services/agents/qa-tools, @/services/billing → stubbed.
//
// The manager takes the INLINE-DRIVE path (INNGEST_BYPASS=1) so children run deterministically
// in-process; one test unsets it to exercise the inngest.send + poll dispatch instead.

type Frag = Record<string, unknown>;

const h = vi.hoisted(() => {
  const runs = new Map<string, Record<string, unknown>>();
  const events: { runId: string; seq: number; type: string; payload: unknown }[] = [];
  const race = { armed: false, forType: "" as string };
  let idc = 0;
  const slots = {
    // Overridable generate behaviors, keyed by prompt.
    plan: () => ({ complexity: "low", decompose: false, rationale: "single", children: [] as Frag[] }),
    verify: (finding: string) => {
      if (/FAKE/i.test(finding)) return { verdict: "false", evidence: "could not reproduce", rationale: "x" };
      if (/MAYBE/i.test(finding)) return { verdict: "uncertain", evidence: "inconclusive", rationale: "x" };
      return { verdict: "confirmed", evidence: "reproduced independently", rationale: "x" };
    },
    replan: (_prompt: string) => ({ coverageComplete: true, reason: "done", children: [] as Frag[] }),
    // Overridable child driver: given the child runId, write its completed plan fragments.
    drive: null as null | ((childRunId: string) => void),
  };
  return { runs, events, race, slots, nextId: () => `run_${++idc}`, generate: vi.fn() };
});

// The brief's change event is create-brief.test.ts's subject; here it only has to succeed.
vi.mock("@/services/memory/change-events", () => ({ recordChangeEvent: vi.fn() }));
vi.mock("@/lib/db", () => {
  const isPush = (v: unknown): v is { push: unknown } =>
    !!v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) && "push" in v;
  const applyData = (row: Record<string, unknown>, data: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      if (isPush(v)) row[k] = [...((row[k] as unknown[]) ?? []), (v as { push: unknown }).push];
      else row[k] = v;
    }
  };
  const p2002 = () => {
    const e = new Error("Unique constraint failed") as Error & { code: string };
    e.code = "P2002";
    return e;
  };
  return {
    db: {
      // createBrief (services/memory/create-brief.ts) writes through a transaction; this
      // double runs it against the same mocked client.
      $transaction: vi.fn(function (this: unknown, fn: (tx: unknown) => unknown) {
        return fn(this);
      }),
      agentRun: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const id = h.nextId();
          const row: Record<string, unknown> = {
            id,
            plan: null,
            pendingInput: null,
            briefId: null,
            finishedAt: null,
            createdAt: new Date(),
            ...data,
          };
          h.runs.set(id, row);
          return { id };
        }),
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => h.runs.get(where.id) ?? null),
        findFirst: vi.fn(async ({ where }: { where: { id: string; orgId?: string } }) => {
          const r = h.runs.get(where.id);
          if (!r) return null;
          if (where.orgId && r.orgId !== where.orgId) return null;
          return r;
        }),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = h.runs.get(where.id);
          if (!row) throw new Error("run not found");
          applyData(row, data);
          return row;
        }),
      },
      agentRunEvent: {
        findFirst: vi.fn(async ({ where }: { where: { runId: string } }) => {
          const evs = h.events.filter((e) => e.runId === where.runId);
          if (evs.length === 0) return null;
          return { seq: evs.reduce((m, e) => Math.max(m, e.seq), 0) };
        }),
        create: vi.fn(async ({ data }: { data: { runId: string; seq: number; type: string; payload: unknown } }) => {
          if (h.race.armed && data.type === h.race.forType) {
            h.race.armed = false;
            h.events.push({ runId: data.runId, seq: data.seq, type: "__competitor__", payload: {} });
            throw p2002();
          }
          if (h.events.some((e) => e.runId === data.runId && e.seq === data.seq)) throw p2002();
          h.events.push({ runId: data.runId, seq: data.seq, type: data.type, payload: data.payload });
          return { id: `ev_${h.events.length}` };
        }),
      },
      agent: { findFirst: vi.fn() },
      brief: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: "brief_1",
          createdAt: new Date("2026-07-20T00:00:00.000Z"),
          ...data,
        })),
      },
    },
  };
});

vi.mock("@/services/agents/runner", () => ({
  buildMastraAgent: vi.fn(() => ({ generate: h.generate })),
  buildRuntimeContext: vi.fn(() => {
    const m = new Map<string, unknown>();
    return { get: (k: string) => m.get(k), set: (k: string, v: unknown) => void m.set(k, v) };
  }),
}));

vi.mock("@/lib/qa-agent", () => ({ QA_AGENT_ID: "qa_agent_id", QA_AGENT_NAME: "QA agent" }));
vi.mock("@/services/agents/qa-tools", () => ({ httpRequestTool: {} }));
vi.mock("@/services/billing", () => ({ recordArtifactUsage: vi.fn(async () => {}) }));

// driveRun (child driver) — writes the child's completed plan so childFragments() reads it.
vi.mock("@/services/agents/run-loop", () => ({
  driveRun: vi.fn(async (childRunId: string) => {
    if (h.slots.drive) return h.slots.drive(childRunId);
    // default: one bug whose finding is the child's focus (so the verify mock keys on it).
    const row = h.runs.get(childRunId) as { meta?: { focus?: string } } | undefined;
    const focus = row?.meta?.focus ?? "Full black-box sweep";
    writeChildPlan(childRunId, [bug(focus)]);
  }),
}));

// Inngest — dynamically imported ONLY on the non-bypass path. The send mock completes the
// child synchronously so waitForChild() returns immediately.
vi.mock("@/lib/inngest", () => ({
  QA_MANAGER_CHILD_EVENT: "qa/manager.child.requested",
  inngest: {
    send: vi.fn(async ({ data }: { data: { childRunId: string } }) => {
      const row = h.runs.get(data.childRunId) as { meta?: { focus?: string } } | undefined;
      writeChildPlan(data.childRunId, [bug(row?.meta?.focus ?? "sent")]);
    }),
  },
}));

import { db } from "@/lib/db";
import { recordArtifactUsage } from "@/services/billing";
import { driveRun } from "@/services/agents/run-loop";
import { inngest } from "@/lib/inngest";
import { orgRootPath } from "@/services/access";
import { qaManagerEnabled, createQaManagerRun, runQaManager, MANAGER_CONFIG, type StoppingMode } from "./manager";

// --- helpers ---------------------------------------------------------------

type Row = Record<string, unknown>;
const runRow = (id: string) => h.runs.get(id) as Row;
const eventsFor = (id: string) => h.events.filter((e) => e.runId === id);
const eventTypes = (id: string) => eventsFor(id).map((e) => e.type);
const childRows = () =>
  [...h.runs.values()].filter((r) => (r.meta as { type?: string } | undefined)?.type === "qa-interactive");

function bug(finding: string, severity: "blocker" | "major" | "minor" = "major"): Frag {
  return { as: "bug", severity, finding, repro: "r", observed: "o", expected: "e" };
}

function writeChildPlan(childRunId: string, fragments: Frag[]) {
  const row = h.runs.get(childRunId);
  if (!row) return;
  row.plan = {
    runId: childRunId,
    agentRole: "qa",
    items: fragments.map((f, i) => ({
      id: `it_${i}`,
      kind: "scenario",
      title: `item ${i}`,
      status: "done",
      origin: "agent",
      result: f,
    })),
    revision: 1,
  };
  row.status = "completed";
  row.phase = "done";
}

const target = { baseUrl: "https://api.acme.com", allowedHosts: ["api.acme.com"] };

// The manager's generate is one vi.fn shared by plan / verify / replan — dispatch by prompt.
function wireGenerate() {
  h.generate.mockImplementation(async (prompt: string) => {
    if (typeof prompt === "string" && prompt.includes("Plan (do NOT test yet)")) {
      return { object: h.slots.plan() };
    }
    if (typeof prompt === "string" && prompt.startsWith("A child tester reported")) {
      const m = /Finding: (.*)/.exec(prompt);
      return { object: h.slots.verify(m?.[1] ?? "") };
    }
    if (typeof prompt === "string" && prompt.includes("re-planning after round")) {
      return { object: h.slots.replan(prompt) };
    }
    return { object: {} };
  });
}

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  h.runs.clear();
  h.events.length = 0;
  h.race.armed = false;
  h.slots.plan = () => ({ complexity: "low", decompose: false, rationale: "single", children: [] });
  h.slots.verify = (finding: string) => {
    if (/FAKE/i.test(finding)) return { verdict: "false", evidence: "could not reproduce", rationale: "x" };
    if (/MAYBE/i.test(finding)) return { verdict: "uncertain", evidence: "inconclusive", rationale: "x" };
    return { verdict: "confirmed", evidence: "reproduced independently", rationale: "x" };
  };
  h.slots.replan = () => ({ coverageComplete: true, reason: "done", children: [] });
  h.slots.drive = null;
  process.env.INNGEST_BYPASS = "1";
  delete process.env.INNGEST_DEV;
  vi.mocked(db.agent.findFirst).mockResolvedValue({
    active: true,
    agentKey: "qa-agent",
    name: "QA agent",
    role: "qa",
    model: null,
    systemPrompt: null,
    tools: ["http_request", "memory_read"],
    settings: {},
  } as never);
  wireGenerate();
});

afterEach(() => {
  process.env = { ...ORIG_ENV };
});

async function start(over: Partial<Parameters<typeof createQaManagerRun>[0]> = {}) {
  return createQaManagerRun({
    orgId: "org_1",
    agentId: "agent_1",
    triggeredBy: "user_42",
    target,
    ...over,
  });
}

// ---------------------------------------------------------------------------
// 1. FLAG — mirrors paymentsEnabled()
// ---------------------------------------------------------------------------

describe("qaManagerEnabled", () => {
  const prev = process.env.QA_MANAGER;
  afterEach(() => {
    if (prev === undefined) delete process.env.QA_MANAGER;
    else process.env.QA_MANAGER = prev;
  });

  it("is OFF unless explicitly enabled, and true only for true/1/on/yes", () => {
    delete process.env.QA_MANAGER;
    expect(qaManagerEnabled()).toBe(false);
    for (const off of ["false", "0", "off", "no", "", "enabled"]) {
      process.env.QA_MANAGER = off;
      expect(qaManagerEnabled()).toBe(false);
    }
    for (const on of ["true", "1", "on", "yes", "TRUE", "On", "YES"]) {
      process.env.QA_MANAGER = on;
      expect(qaManagerEnabled()).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. PLANNING / DECOMPOSITION
// ---------------------------------------------------------------------------

describe("planning / decomposition", () => {
  it("single-child fallback when the plan step declines to decompose", async () => {
    const runId = await start();
    await runQaManager(runId);
    const kids = childRows();
    expect(kids).toHaveLength(1);
    expect((kids[0].meta as { focus: string }).focus).toBe("Full black-box sweep of the target");
  });

  it("single-child fallback when decompose:true but the child list is empty", async () => {
    h.slots.plan = () => ({ complexity: "high", decompose: true, rationale: "x", children: [] });
    const runId = await start();
    await runQaManager(runId);
    expect(childRows()).toHaveLength(1);
  });

  it("decomposes into the independent slices the plan step returns", async () => {
    h.slots.plan = () => ({
      complexity: "medium",
      decompose: true,
      rationale: "three independent endpoints",
      children: [
        { title: "Probe /login", focus: "auth" },
        { title: "Probe /checkout", focus: "checkout" },
        { title: "Probe /search", focus: "search" },
      ],
    });
    const runId = await start();
    await runQaManager(runId);
    const kids = childRows();
    expect(kids).toHaveLength(3);
    expect(kids.map((k) => (k.meta as { focus: string }).focus).sort()).toEqual(["auth", "checkout", "search"]);
  });

  it("enforces the hard per-round cap of MAX_CHILDREN (=5) even when the plan step over-produces", async () => {
    // Coverage-complete after round 0 so only the planned slices spawn.
    h.slots.plan = () => ({
      complexity: "high",
      decompose: true,
      rationale: "many",
      children: Array.from({ length: 8 }, (_, i) => ({ title: `slice ${i}`, focus: `f${i}` })),
    });
    const runId = await start();
    await runQaManager(runId);
    expect(MANAGER_CONFIG.MAX_CHILDREN).toBe(5);
    expect(childRows()).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// 4. CONVERGENCE + GUARDRAIL (the safety-critical one)
// ---------------------------------------------------------------------------

describe("convergence + guardrail", () => {
  it("loop-until-dry: stops after DRY_ROUNDS_TO_STOP consecutive rounds add no new verified finding", async () => {
    // Round 0: initial slice → a confirmed bug (new finding). Re-plan offers a FAKE slice.
    // Round 1: the FAKE slice's bug is rejected on verification → 0 new findings → dry → stop.
    h.slots.replan = () => ({
      coverageComplete: false,
      reason: "one more",
      children: [{ title: "FAKE follow-up", focus: "FAKE region" }],
    });
    const runId = await start({ stoppingMode: "loop-until-dry" });
    await runQaManager(runId);
    expect(MANAGER_CONFIG.DRY_ROUNDS_TO_STOP).toBe(1);
    // 2 rounds ran (round 0 productive, round 1 dry) → exactly 2 children.
    expect(childRows()).toHaveLength(2);
    expect(runRow(runId).phase).toBe("done");
  });

  it("GUARDRAIL overrides the stopping mode: MAX_ROUNDS halts a loop-until-dry run that would never go dry", async () => {
    // Every round finds a NEW confirmed bug (never dry) and the re-plan always wants more —
    // the ONLY thing that can stop this is the hard round guardrail.
    h.slots.replan = () => ({
      coverageComplete: false,
      reason: "keep going forever",
      children: [{ title: "another slice", focus: `slice-${Math.random()}` }],
    });
    const runId = await start({ stoppingMode: "loop-until-dry" });
    await runQaManager(runId);
    expect(MANAGER_CONFIG.MAX_ROUNDS).toBe(3);
    // Bounded at MAX_ROUNDS rounds (1 child/round here) despite the never-satisfied stopping mode.
    expect(childRows()).toHaveLength(MANAGER_CONFIG.MAX_ROUNDS);
    expect(runRow(runId).phase).toBe("done");
  });

  it("GUARDRAIL overrides the stopping mode: MAX_TOTAL_CHILDREN caps total fan-out across rounds", async () => {
    h.slots.plan = () => ({
      complexity: "high",
      decompose: true,
      rationale: "wide",
      children: Array.from({ length: 5 }, (_, i) => ({ title: `s${i}`, focus: `f${i}` })),
    });
    h.slots.replan = () => ({
      coverageComplete: false,
      reason: "more",
      children: Array.from({ length: 5 }, (_, i) => ({ title: `r${i}`, focus: `rf${i}-${Math.random()}` })),
    });
    const runId = await start({ stoppingMode: "loop-until-dry" });
    await runQaManager(runId);
    expect(MANAGER_CONFIG.MAX_TOTAL_CHILDREN).toBe(8);
    // 5 (round 0) + 3 (round 1, clamped by remaining budget) = 8, never exceeding the ceiling.
    expect(childRows()).toHaveLength(MANAGER_CONFIG.MAX_TOTAL_CHILDREN);
  });

  it("GUARDRAIL overrides: MAX_LLM_UNITS halts verification mid-flight on a bug-heavy child", async () => {
    // One child reports 40 candidate defects; the per-defect verify loop must stop at the
    // LLM-unit ceiling rather than verifying all 40.
    h.slots.drive = (childRunId: string) => {
      writeChildPlan(
        childRunId,
        Array.from({ length: 40 }, (_, i) => bug(`REAL defect ${i}`)),
      );
    };
    const runId = await start();
    await runQaManager(runId);
    expect(MANAGER_CONFIG.MAX_LLM_UNITS).toBe(30);
    // 1 llmUnit spent dispatching the child; verification then runs until the budget is hit.
    const verifyCalls = h.generate.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].startsWith("A child tester reported"),
    ).length;
    expect(verifyCalls).toBe(MANAGER_CONFIG.MAX_LLM_UNITS - 1); // 29
    expect(verifyCalls).toBeLessThan(40);
  });

  it("verdict-stabilizes: stops as soon as the round verdict is unchanged from the prior round", async () => {
    // Every round yields the same 'broken' verdict; the mode should stop after round 1.
    h.slots.replan = () => ({
      coverageComplete: false,
      reason: "more",
      children: [{ title: "next", focus: `next-${Math.random()}` }],
    });
    const runId = await start({ stoppingMode: "verdict-stabilizes" });
    await runQaManager(runId);
    // round 0 (verdict set) + round 1 (verdict equal → stop) = 2 children.
    expect(childRows()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 5. ADVERSARIAL VERIFICATION
// ---------------------------------------------------------------------------

describe("adversarial verification", () => {
  it("accepts only confirmed bugs to the verdict, rejects false ones (counted), and surfaces uncertain separately", async () => {
    h.slots.drive = (childRunId: string) => {
      writeChildPlan(childRunId, [
        bug("REAL blocker", "blocker"),
        bug("FAKE alarm"),
        bug("MAYBE flaky"),
        { as: "performance", endpoint: "/search", samples: 3, p50LatencyMs: 40, maxLatencyMs: 90, errorRate: 0 },
      ]);
    };
    const runId = await start();
    await runQaManager(runId);

    const created = vi.mocked(db.brief.create).mock.calls[0]![0]!.data as unknown as {
      summary: string;
      sections: { heading: string; content: string }[];
    };
    // 1 confirmed, 1 uncertain, 1 rejected recorded in the manager verification summary.
    const summarySection = created.sections.find((s) => s.heading === "Manager verification summary")!;
    expect(summarySection.content).toContain("1 confirmed, 1 uncertain, 1 rejected");
    // Confirmed and uncertain land in distinct sections; performance passthrough is folded in.
    expect(created.sections.map((s) => s.heading)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Verified defects (1)"),
        expect.stringContaining("Unconfirmed / uncertain findings (1)"),
        "Performance",
      ]),
    );
    // A confirmed blocker → broken verdict.
    expect(created.summary.startsWith("🛑 Broken")).toBe(true);
  });

  it("verifies each child-reported bug independently (one verify LLM call per candidate defect)", async () => {
    h.slots.drive = (childRunId: string) => {
      writeChildPlan(childRunId, [bug("REAL one"), bug("REAL two")]);
    };
    const runId = await start();
    await runQaManager(runId);
    const verifyCalls = h.generate.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].startsWith("A child tester reported"),
    );
    expect(verifyCalls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 6. CHILDREN + EVENTS + FINALIZE
// ---------------------------------------------------------------------------

describe("children + events", () => {
  it("creates each child run with meta.parentRunId pointing back to the parent", async () => {
    const runId = await start();
    await runQaManager(runId);
    const kids = childRows();
    expect(kids).toHaveLength(1);
    expect((kids[0].meta as { parentRunId: string; type: string }).parentRunId).toBe(runId);
    expect((kids[0].meta as { type: string }).type).toBe("qa-interactive");
    // The parent plan item id equals the child run id (itemId ↔ childRunId binding).
    const plan = runRow(runId).plan as { items: { id: string }[] };
    expect(plan.items[0].id).toBe(kids[0].id);
  });

  it("drives children inline on the bypass path (driveRun called, inngest.send not)", async () => {
    const runId = await start();
    await runQaManager(runId);
    expect(driveRun).toHaveBeenCalledTimes(1);
    expect(driveRun).toHaveBeenCalledWith(expect.any(String), "org_1");
    expect(inngest.send).not.toHaveBeenCalled();
  });

  it("dispatches via inngest.send(QA_MANAGER_CHILD_EVENT) + poll when NOT bypassing", async () => {
    delete process.env.INNGEST_BYPASS;
    delete process.env.INNGEST_DEV;
    const runId = await start();
    await runQaManager(runId);
    expect(inngest.send).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "qa/manager.child.requested",
        data: { childRunId: expect.any(String), orgId: "org_1" },
      }),
    );
    expect(runRow(runId).phase).toBe("done");
  });

  it("assigns a strictly increasing, gapless, unique seq on the parent event stream", async () => {
    const runId = await start();
    await runQaManager(runId);
    const seqs = eventsFor(runId)
      .filter((e) => e.type !== "__competitor__")
      .map((e) => e.seq);
    expect(seqs.length).toBeGreaterThan(0);
    expect(new Set(seqs).size).toBe(seqs.length);
    seqs.forEach((s, i) => expect(s).toBe(i + 1));
  });

  it("retries on the P2002 seq race and lands a unique seq above the racing writer", async () => {
    h.race.armed = true;
    h.race.forType = "phase"; // the manager's first emit is phase:planning
    const runId = await start();
    await runQaManager(runId);
    const evs = eventsFor(runId);
    const competitor = evs.find((e) => e.type === "__competitor__");
    const phase = evs.find((e) => e.type === "phase");
    expect(competitor).toBeDefined();
    expect(phase).toBeDefined();
    expect(phase!.seq).toBe(competitor!.seq + 1);
    const realSeqs = evs.filter((e) => e.type !== "__competitor__").map((e) => e.seq);
    expect(new Set(realSeqs).size).toBe(realSeqs.length);
  });

  it("emits the manager stream: phase, plan, step_started/step_completed per child, artifact, done", async () => {
    const runId = await start();
    await runQaManager(runId);
    const types = eventTypes(runId);
    expect(types).toContain("plan");
    expect(types).toContain("step_started");
    expect(types).toContain("step_completed");
    expect(types).toContain("artifact");
    expect(types).toContain("done");
    expect(types).toContain("phase");
  });
});

describe("finalize", () => {
  it("folds accepted findings into ONE qa_review Brief, meters it, and links briefId on the run", async () => {
    const runId = await start();
    await runQaManager(runId);
    const run = runRow(runId);
    expect(run.phase).toBe("done");
    expect(run.status).toBe("completed");
    expect(run.briefId).toBe("brief_1");

    expect(db.brief.create).toHaveBeenCalledTimes(1);
    expect(db.brief.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ orgId: "org_1", type: "qa_review" }) }),
    );
    expect(recordArtifactUsage).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org_1", artifactType: "qa_review", briefId: "brief_1" }),
    );

    const done = eventsFor(runId).find((e) => e.type === "done");
    expect(done).toBeDefined();
    const brief = (done!.payload as { brief: { id: string; type: string } }).brief;
    expect(brief).toMatchObject({ id: "brief_1", type: "qa_review" });
  });

  it("uses meta.scopePath for the Brief scope + metering when the run is scoped", async () => {
    const runId = await start({ scopePath: "org_1.engineering" });
    await runQaManager(runId);
    const data = vi.mocked(db.brief.create).mock.calls[0][0].data as {
      scopePath: string;
      scopeLabel: string | null;
    };
    expect(data.scopePath).toBe("org_1.engineering");
    expect(data.scopeLabel).toBeNull();
    expect(recordArtifactUsage).toHaveBeenCalledWith(expect.objectContaining({ scopePath: "org_1.engineering" }));
  });

  // scopePath is authorization-bearing (check() enforces against it, cast to
  // ::ltree). The manager's finalize() must not write '(target) <host>'
  // straight into scopePath for a scope-less run, same as qa-run.ts/run-loop.ts:
  // it falls back to the org root and keeps the host label in scopeLabel for
  // display.
  it("falls back to the org root for scopePath on a scope-less managed run, keeping the host label in scopeLabel", async () => {
    const runId = await start();
    await runQaManager(runId);
    const data = vi.mocked(db.brief.create).mock.calls[0][0].data as {
      scopePath: string;
      scopeLabel: string | null;
    };
    expect(data.scopePath).toBe(orgRootPath("org_1"));
    expect(data.scopeLabel).toBe("(target) api.acme.com");

    const done = eventsFor(runId).find((e) => e.type === "done");
    const brief = (done!.payload as { brief: { scopePath: string; scopeLabel: string | null } }).brief;
    expect(brief.scopePath).toBe(orgRootPath("org_1"));
    expect(brief.scopeLabel).toBe("(target) api.acme.com");
  });

  it("flips the run to failed + emits error when the QA agent row cannot be loaded", async () => {
    vi.mocked(db.agent.findFirst).mockResolvedValue(null as never);
    const runId = await start();
    await runQaManager(runId);
    const run = runRow(runId);
    expect(run.phase).toBe("failed");
    expect(run.status).toBe("failed");
    const err = eventsFor(runId).find((e) => e.type === "error");
    expect(err).toBeDefined();
    expect((err!.payload as { message: string }).message).toBe("agent not found for manager run");
  });
});

// A type-only touch so `StoppingMode` import is exercised by tsc without being unused.
const _mode: StoppingMode = "loop-until-dry";
void _mode;
