import { beforeEach, describe, expect, it, vi } from "vitest";

// Unit tests for the interactive agent-loop engine (services/agents/run-loop.ts).
//
// Everything the loop touches is mocked so we exercise the STATE MACHINE + pure logic
// in isolation, with no live stack and no LLM:
//   - @/lib/db          → a small stateful in-memory fake (AgentRun rows + AgentRunEvent
//                         rows) that mirrors the Prisma semantics the loop relies on
//                         (findUnique/findFirst return the live row; update applies a
//                         data patch, honoring `{ push }` on arrays and skipping
//                         `undefined` keys the way Prisma does; agentRunEvent enforces
//                         @@unique([runId, seq]) so the retry path is real).
//   - @/services/agents/runner   → buildMastraAgent returns a fake agent whose
//                         `generate` is a vi.fn we drive; buildRuntimeContext returns a
//                         Map-backed get/set stub.
//   - @/lib/qa-agent, @/services/agents/qa-tools, @/services/billing → stubbed.
//
// We assert on the persisted AgentRun row + the emitted AgentRunEvent stream — never the LLM.

const h = vi.hoisted(() => {
  const runs = new Map<string, Record<string, unknown>>();
  const events: { runId: string; seq: number; type: string; payload: unknown }[] = [];
  const race = { armed: false, forType: "" as string };
  let idc = 0;
  return {
    runs,
    events,
    race,
    nextId: () => `run_${++idc}`,
    generate: vi.fn(),
  };
});

// The brief's change event is create-brief.test.ts's subject; here it only has to succeed.
vi.mock("@/services/memory/change-events", () => ({ recordChangeEvent: vi.fn() }));
vi.mock("@/lib/db", () => {
  const isPush = (v: unknown): v is { push: unknown } =>
    !!v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) && "push" in v;
  const applyData = (row: Record<string, unknown>, data: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue; // Prisma: an `undefined` field is a no-op, NOT a clear.
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
            appliedEditIds: [],
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
        updateMany: vi.fn(
          async ({ where, data }: { where: { id: string; orgId?: string }; data: Record<string, unknown> }) => {
            // Like Prisma, an omitted orgId filter matches any org.
            const row = h.runs.get(where.id);
            if (!row) return { count: 0 };
            if (where.orgId && row.orgId !== where.orgId) return { count: 0 };
            applyData(row, data);
            return { count: 1 };
          },
        ),
      },
      agentRunEvent: {
        findFirst: vi.fn(async ({ where }: { where: { runId: string } }) => {
          const evs = h.events.filter((e) => e.runId === where.runId);
          if (evs.length === 0) return null;
          return { seq: evs.reduce((m, e) => Math.max(m, e.seq), 0) };
        }),
        create: vi.fn(async ({ data }: { data: { runId: string; seq: number; type: string; payload: unknown } }) => {
          if (h.race.armed && data.type === h.race.forType) {
            // Simulate a racing writer that grabbed this seq first.
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

vi.mock("@/lib/qa-agent", () => ({
  QA_AGENT_ID: "qa_agent_id",
  QA_AGENT_NAME: "QA agent",
  provisionQaAgentCapability: vi.fn(async () => "wcap_scoped"),
}));
vi.mock("@/services/agents/qa-tools", () => ({ httpRequestTool: {} }));
vi.mock("@/services/billing", () => ({ recordArtifactUsage: vi.fn(async () => {}) }));

import { db } from "@/lib/db";
import { provisionQaAgentCapability } from "@/lib/qa-agent";
import { recordArtifactUsage } from "@/services/billing";
import { orgRootPath } from "@/services/access";
import { createQaInteractiveRun, driveRun, resumeRun, applyPlanEdit, isTerminalPhase } from "./run-loop";
import type { ClarificationRequest } from "@/types/agent-run";

type Row = Record<string, unknown>;
const runRow = (id: string) => h.runs.get(id) as Row;
const eventsFor = (id: string) => h.events.filter((e) => e.runId === id);
const eventTypes = (id: string) => eventsFor(id).map((e) => e.type);

const target = { baseUrl: "https://api.acme.com" };

// A generate impl that plans a 2-item checklist and returns a plain section per item.
function defaultGenerate() {
  h.generate.mockImplementation(async (prompt: string) => {
    if (typeof prompt === "string" && prompt.startsWith("Plan (do NOT execute")) {
      return {
        object: {
          items: [
            { kind: "endpoint-probe", title: "Probe /health", detail: "check base" },
            { kind: "perf-measure", title: "Measure /search", detail: "latency" },
          ],
        },
      };
    }
    return { object: { narration: "observed something", section: { heading: "Notes", content: "looks ok" } } };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.runs.clear();
  h.events.length = 0;
  h.race.armed = false;
  vi.mocked(db.agent.findFirst).mockResolvedValue({
    active: true,
    id: "agent_1",
    agentKey: "qa-agent",
    name: "QA agent",
    role: "qa",
    model: null,
    systemPrompt: null,
    tools: ["http_request", "memory_read"],
    settings: {},
  } as never);
  defaultGenerate();
});

async function startRun(over: Partial<Parameters<typeof createQaInteractiveRun>[0]> = {}) {
  return createQaInteractiveRun({
    orgId: "org_1",
    agentId: "agent_1",
    triggeredBy: "user_42",
    target,
    ...over,
  });
}

// ---------------------------------------------------------------------------
// isTerminalPhase
// ---------------------------------------------------------------------------

describe("isTerminalPhase", () => {
  it("is true only for done + failed", () => {
    expect(isTerminalPhase("done")).toBe(true);
    expect(isTerminalPhase("failed")).toBe(true);
    for (const p of ["planning", "consulting", "executing", "paused", "finalizing", null, undefined]) {
      expect(isTerminalPhase(p)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Tenant binding — driveRun only advances or fails a run in the org it was given
// ---------------------------------------------------------------------------

describe("driveRun tenant binding", () => {
  it("does not advance a run that belongs to another org", async () => {
    const runId = await startRun();
    await driveRun(runId, "org_OTHER");
    const run = runRow(runId);
    expect(run.phase).toBe("planning");
    expect(run.plan).toBeNull();
    expect(h.generate).not.toHaveBeenCalled();
    expect(eventsFor(runId)).toHaveLength(0);
  });

  it("refuses to drive without an orgId instead of reading the run unbound", async () => {
    const runId = await startRun();
    await expect(driveRun(runId, undefined as unknown as string)).rejects.toThrow(TypeError);
    await expect(driveRun(runId, "")).rejects.toThrow(TypeError);
    expect(runRow(runId).phase).toBe("planning");
    expect(h.generate).not.toHaveBeenCalled();
  });

  it("does not mark another org's run failed when the driver errors", async () => {
    const runId = await startRun();
    vi.mocked(db.agentRun.findFirst).mockRejectedValueOnce(new Error("db unavailable"));
    await driveRun(runId, "org_OTHER");
    const run = runRow(runId);
    expect(run.phase).toBe("planning");
    expect(run.status).not.toBe("failed");
    expect(eventsFor(runId)).toHaveLength(0);
  });

  it("marks its own org's run failed when the driver errors", async () => {
    const runId = await startRun();
    vi.mocked(db.agentRun.findFirst).mockRejectedValueOnce(new Error("db unavailable"));
    await driveRun(runId, "org_1");
    expect(runRow(runId).phase).toBe("failed");
    expect(eventTypes(runId)).toEqual(expect.arrayContaining(["error", "phase"]));
  });
});

// ---------------------------------------------------------------------------
// PLANNING
// ---------------------------------------------------------------------------

describe("planning", () => {
  it("turns the LLM's items into a PlanItem[] (id + status:pending + origin:agent) and advances to consulting", async () => {
    const runId = await startRun(); // non-autopilot → stops at the consulting pause
    await driveRun(runId, "org_1");
    const run = runRow(runId);
    const plan = run.plan as {
      items: { id: string; title: string; status: string; origin: string; kind: string }[];
      revision: number;
    };
    expect(plan.items).toHaveLength(2);
    expect(plan.items[0]).toMatchObject({
      title: "Probe /health",
      status: "pending",
      origin: "agent",
      kind: "endpoint-probe",
    });
    expect(typeof plan.items[0].id).toBe("string");
    expect(plan.items[0].id.length).toBeGreaterThan(0);
    expect(plan.revision).toBe(0);
    // plan is emitted before the loop advances the phase past consulting.
    expect(eventTypes(runId)).toContain("plan");
  });

  it("falls back to the deterministic default plan when the LLM returns no items", async () => {
    h.generate.mockImplementation(async () => ({ object: { items: [] } }));
    const runId = await startRun();
    await driveRun(runId, "org_1");
    const plan = runRow(runId).plan as { items: { title: string; kind: string }[] };
    // defaultQaPlanItems: 3 items with no scopePath (no spec-check).
    expect(plan.items).toHaveLength(3);
    expect(plan.items.map((i) => i.kind)).toEqual(["endpoint-probe", "endpoint-probe", "perf-measure"]);
  });

  it("adds a spec-check to the default plan when a scopePath is set", async () => {
    h.generate.mockImplementation(async () => ({ object: { items: [] } }));
    const runId = await startRun({ scopePath: "org_1.engineering", autopilot: true });
    await driveRun(runId, "org_1");
    const plan = runRow(runId).plan as { items: { kind: string }[] };
    expect(plan.items.map((i) => i.kind)).toContain("spec-check");
  });

  it("falls back to the default plan when the LLM generate throws", async () => {
    h.generate.mockImplementation(async () => {
      throw new Error("model timeout");
    });
    const runId = await startRun();
    await driveRun(runId, "org_1");
    const plan = runRow(runId).plan as { items: unknown[] };
    expect(plan.items.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// CONSULTING — clarification + pause
// ---------------------------------------------------------------------------

describe("consulting (non-autopilot)", () => {
  it("builds a ClarificationRequest whose questions each carry a recommended default with source 'recommendation', pauses, and STOPS the driver", async () => {
    const runId = await startRun();
    await driveRun(runId, "org_1");
    const run = runRow(runId);
    expect(run.phase).toBe("paused");

    const pending = run.pendingInput as ClarificationRequest;
    expect(pending.checkpointId).toBe(`consult-${runId}`);
    expect(pending.blocking).toBe(true);
    expect(pending.questions.map((q) => q.id)).toEqual(["peak-traffic", "p95-latency-budget", "release-criticality"]);
    for (const q of pending.questions) {
      expect(q.recommended).toBeDefined();
      expect((q.recommended as { source: string }).source).toBe("recommendation");
    }

    // needs_input + phase:paused were emitted and NO execution started.
    expect(eventTypes(runId)).toEqual(expect.arrayContaining(["needs_input"]));
    expect(eventTypes(runId)).not.toContain("step_started");
  });

  it("emits needs_input carrying the checkpoint on the stream", async () => {
    const runId = await startRun();
    await driveRun(runId, "org_1");
    const needs = eventsFor(runId).find((e) => e.type === "needs_input");
    expect(needs).toBeDefined();
    const payload = needs!.payload as { checkpoint: ClarificationRequest };
    expect(payload.checkpoint.questions).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// AUTOPILOT — fold defaults, never pause
// ---------------------------------------------------------------------------

describe("consulting (autopilot)", () => {
  it("folds every recommended default as an assumption and proceeds without pausing", async () => {
    const runId = await startRun({ autopilot: true });
    await driveRun(runId, "org_1");
    const run = runRow(runId);
    const meta = run.meta as { clarifyAnswers: { questionId: string; answer: string; source: string }[] };
    expect(meta.clarifyAnswers).toHaveLength(3);
    expect(meta.clarifyAnswers.every((a) => a.source === "recommendation")).toBe(true);
    // The recommended values fold to their string form.
    const byId = Object.fromEntries(meta.clarifyAnswers.map((a) => [a.questionId, a.answer]));
    expect(byId).toEqual({ "peak-traffic": "50", "p95-latency-budget": "500", "release-criticality": "standard" });
    // Never paused; ran to a terminal phase.
    expect(eventTypes(runId)).not.toContain("needs_input");
    expect(run.phase).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// RESUME — answer folding
// ---------------------------------------------------------------------------

describe("resumeRun (answer folding)", () => {
  async function toPaused() {
    const runId = await startRun();
    await driveRun(runId, "org_1");
    return runId;
  }

  it("records a human answer as source 'human' and folds untouched questions to their recommended default", async () => {
    const runId = await toPaused();
    const res = await resumeRun(runId, "org_1", {
      checkpointId: `consult-${runId}`,
      answers: [{ questionId: "peak-traffic", answer: { kind: "number", value: 99 } }],
    });
    expect(res).toEqual({ status: "resumed" });

    const meta = runRow(runId).meta as { clarifyAnswers: { questionId: string; answer: string; source: string }[] };
    const byId = Object.fromEntries(meta.clarifyAnswers.map((a) => [a.questionId, a]));
    expect(byId["peak-traffic"]).toMatchObject({ answer: "99", source: "human" });
    expect(byId["p95-latency-budget"]).toMatchObject({ answer: "500", source: "recommendation" });
    expect(byId["release-criticality"]).toMatchObject({ answer: "standard", source: "recommendation" });
    // resume flips the phase to executing and emits resumed.
    expect(runRow(runId).phase).toBe("executing");
    expect(eventTypes(runId)).toContain("resumed");
  });

  it("treats acceptedDefault:true as taking the recommendation even if an answer is present", async () => {
    const runId = await toPaused();
    await resumeRun(runId, "org_1", {
      checkpointId: `consult-${runId}`,
      answers: [{ questionId: "peak-traffic", acceptedDefault: true, answer: { kind: "number", value: 12345 } }],
    });
    const meta = runRow(runId).meta as { clarifyAnswers: { questionId: string; answer: string; source: string }[] };
    const pt = meta.clarifyAnswers.find((a) => a.questionId === "peak-traffic");
    expect(pt).toMatchObject({ answer: "50", source: "recommendation" });
  });

  it("folds a single-choice human answer to its optionId", async () => {
    const runId = await toPaused();
    await resumeRun(runId, "org_1", {
      checkpointId: `consult-${runId}`,
      answers: [{ questionId: "release-criticality", answer: { kind: "single", optionId: "critical" } }],
    });
    const meta = runRow(runId).meta as { clarifyAnswers: { questionId: string; answer: string; source: string }[] };
    const rc = meta.clarifyAnswers.find((a) => a.questionId === "release-criticality");
    expect(rc).toMatchObject({ answer: "critical", source: "human" });
  });

  it("is a no-op on a duplicate resume once the checkpoint is cleared / already resumed", async () => {
    const runId = await toPaused();
    await resumeRun(runId, "org_1", { checkpointId: `consult-${runId}`, answers: [] });
    const dup = await resumeRun(runId, "org_1", { checkpointId: `consult-${runId}`, answers: [] });
    expect(dup).toEqual({ status: "noop" });
  });

  it("returns invalid for an unknown run and for a mismatched checkpointId", async () => {
    expect(await resumeRun("nope", "org_1", { checkpointId: "x", answers: [] })).toEqual({
      status: "invalid",
      error: "run not found",
    });
    const runId = await toPaused();
    const bad = await resumeRun(runId, "org_1", { checkpointId: "wrong", answers: [] });
    expect(bad).toEqual({ status: "invalid", error: "checkpointId does not match the open checkpoint" });
  });

  it("enforces tenant scoping — a resume from another org cannot see the run", async () => {
    const runId = await toPaused();
    const res = await resumeRun(runId, "org_OTHER", { checkpointId: `consult-${runId}`, answers: [] });
    expect(res).toEqual({ status: "invalid", error: "run not found" });
  });
});

// ---------------------------------------------------------------------------
// EXECUTING — walk from cursor, re-read plan each iteration, tolerate failures
// ---------------------------------------------------------------------------

describe("executing", () => {
  it("walks the whole plan from the cursor and marks each item done with a fragment", async () => {
    const runId = await startRun({ autopilot: true });
    await driveRun(runId, "org_1");
    const plan = runRow(runId).plan as { items: { status: string; result?: unknown }[] };
    expect(plan.items.every((i) => i.status === "done")).toBe(true);
    expect(plan.items.every((i) => i.result)).toBe(true);
    const types = eventTypes(runId);
    expect(types.filter((t) => t === "step_started")).toHaveLength(2);
    expect(types.filter((t) => t === "step_completed")).toHaveLength(2);
    expect(types).toContain("artifact");
  });

  it("re-reads the plan each iteration so a live edit at the boundary is executed (adds a 3rd item mid-run)", async () => {
    const runId = await startRun({ autopilot: true });
    let itemCalls = 0;
    h.generate.mockImplementation(async (prompt: string) => {
      if (prompt.startsWith("Plan (do NOT execute")) {
        return {
          object: {
            items: [
              { kind: "endpoint-probe", title: "A" },
              { kind: "perf-measure", title: "B" },
            ],
          },
        };
      }
      itemCalls++;
      if (itemCalls === 1) {
        // While the first item is running, append a third item at the next boundary.
        const plan = runRow(runId).plan as { revision: number };
        await applyPlanEdit(runId, "org_1", {
          editId: "edit-1",
          baseRevision: plan.revision,
          ops: [{ op: "add", item: { kind: "scenario", title: "C-added" } }],
        });
      }
      return { object: { section: { heading: "H", content: "c" } } };
    });
    await driveRun(runId, "org_1");
    const plan = runRow(runId).plan as { items: { title: string; status: string; origin: string }[] };
    expect(plan.items.map((i) => i.title)).toEqual(["A", "B", "C-added"]);
    expect(plan.items.every((i) => i.status === "done")).toBe(true);
    // The appended item was executed. Each item now makes TWO generate calls
    // (act→observe with tools, then structure with the schema), so 3 items = 6 calls.
    expect(itemCalls).toBe(6);
  });

  it("emits step_failed and continues when a single item's generate throws", async () => {
    let n = 0;
    h.generate.mockImplementation(async (prompt: string) => {
      if (prompt.startsWith("Plan (do NOT execute")) {
        return {
          object: {
            items: [
              { kind: "endpoint-probe", title: "A" },
              { kind: "perf-measure", title: "B" },
            ],
          },
        };
      }
      n++;
      if (n === 1) throw new Error("probe blew up");
      return { object: { section: { heading: "H", content: "c" } } };
    });
    const runId = await startRun({ autopilot: true });
    await driveRun(runId, "org_1");
    const plan = runRow(runId).plan as { items: { status: string }[] };
    expect(plan.items[0].status).toBe("failed");
    expect(plan.items[1].status).toBe("done");
    const failed = eventsFor(runId).find((e) => e.type === "step_failed");
    expect(failed).toBeDefined();
    expect((failed!.payload as { error: string }).error).toBe("probe blew up");
    // The run still reaches a terminal phase despite the failure.
    expect(runRow(runId).phase).toBe("done");
  });

  it("mints a scoped capability when scopePath is set", async () => {
    const runId = await startRun({ autopilot: true, scopePath: "org_1.engineering" });
    await driveRun(runId, "org_1");
    expect(provisionQaAgentCapability).toHaveBeenCalledWith("org_1", "org_1.engineering", "user_42");
  });

  it("does NOT mint a capability for a pure black-box run (no scopePath)", async () => {
    const runId = await startRun({ autopilot: true });
    await driveRun(runId, "org_1");
    expect(provisionQaAgentCapability).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// EVENT SEQ — monotonic per run + the @@unique([runId,seq]) retry
// ---------------------------------------------------------------------------

describe("event seq", () => {
  it("assigns a strictly increasing, gapless, unique seq per run", async () => {
    const runId = await startRun({ autopilot: true });
    await driveRun(runId, "org_1");
    const seqs = eventsFor(runId).map((e) => e.seq);
    expect(seqs.length).toBeGreaterThan(0);
    expect(new Set(seqs).size).toBe(seqs.length); // unique
    seqs.forEach((s, i) => expect(s).toBe(i + 1)); // 1..N gapless + monotonic
  });

  it("retries on the P2002 race and still lands a unique seq above the racing writer", async () => {
    h.race.armed = true;
    h.race.forType = "plan"; // the first emit of the run races once
    const runId = await startRun(); // non-autopilot → a short, deterministic stream
    await driveRun(runId, "org_1");

    const evs = eventsFor(runId);
    const competitor = evs.find((e) => e.type === "__competitor__");
    const plan = evs.find((e) => e.type === "plan");
    expect(competitor).toBeDefined();
    expect(plan).toBeDefined();
    // The retried write got a seq strictly above the racing write's seq.
    expect(plan!.seq).toBe(competitor!.seq + 1);
    // All real (non-racing) seqs remain unique.
    const realSeqs = evs.filter((e) => e.type !== "__competitor__").map((e) => e.seq);
    expect(new Set(realSeqs).size).toBe(realSeqs.length);
  });
});

// ---------------------------------------------------------------------------
// FINALIZING — build + link a qa_review Brief; error path fails the run
// ---------------------------------------------------------------------------

describe("finalizing", () => {
  it("builds a qa_review Brief, meters it, and links briefId on the run", async () => {
    const runId = await startRun({ autopilot: true });
    await driveRun(runId, "org_1");
    const run = runRow(runId);
    expect(run.phase).toBe("done");
    expect(run.status).toBe("completed");
    expect(run.briefId).toBe("brief_1");

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

  it("prefixes a verdict label into the Brief summary", async () => {
    const runId = await startRun({ autopilot: true });
    await driveRun(runId, "org_1");
    const data = vi.mocked(db.brief.create).mock.calls[0][0].data as { summary: string };
    // All items returned a plain section (no bugs) → healthy verdict label.
    expect(data.summary.startsWith("✅ Healthy")).toBe(true);
  });

  // scopePath is authorization-bearing (check() enforces against it, cast to
  // ::ltree). A scope-less run (this test's default, startRun with no
  // scopePath) must not write '(target) <host>', not a valid ltree value,
  // into it: it falls back to the org root, and the tested host is preserved
  // in scopeLabel for display.
  it("falls back to the org root for scopePath on a scope-less run, keeping the host label in scopeLabel", async () => {
    const runId = await startRun({ autopilot: true });
    await driveRun(runId, "org_1");
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

  it("keeps the real memory scope in scopePath and leaves scopeLabel null when a scope was given", async () => {
    h.generate.mockImplementation(async () => ({ object: { items: [] } }));
    const runId = await startRun({ scopePath: "org_1.engineering", autopilot: true });
    await driveRun(runId, "org_1");
    const data = vi.mocked(db.brief.create).mock.calls[0][0].data as {
      scopePath: string;
      scopeLabel: string | null;
    };
    expect(data.scopePath).toBe("org_1.engineering");
    expect(data.scopeLabel).toBeNull();
  });
});

describe("error path", () => {
  it("flips the run to failed and emits error + phase:failed when a phase throws unrecoverably", async () => {
    // No matching agent row → doPlanning's loadAgentRow throws.
    vi.mocked(db.agent.findFirst).mockResolvedValue(null as never);
    const runId = await startRun({ autopilot: true });
    await driveRun(runId, "org_1");
    const run = runRow(runId);
    expect(run.phase).toBe("failed");
    expect(run.status).toBe("failed");
    const err = eventsFor(runId).find((e) => e.type === "error");
    expect(err).toBeDefined();
    expect((err!.payload as { message: string }).message).toBe("agent not found for run");
    expect(eventTypes(runId)).toContain("phase");
  });
});
