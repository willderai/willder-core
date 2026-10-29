import { beforeEach, describe, expect, it, vi } from "vitest";

// Real engine.ts runs against this in-memory fake `db` — the goal here is testing
// the actual integration (round-cap escalation, stop mid-run, refusing delivery
// without approval) end to end, not re-mocking every engine call away. Only the
// LLM-calling / billing edges are mocked.
interface FakeWorkflowRun {
  id: string;
  orgId: string;
  workflowKey: string;
  idempotencyKey: string;
  requestedBy: string;
  scopePath: string;
  status: string;
  round: number;
  roundCap: number;
  budgetCredits: number;
  reservedCredits: number;
  spentCredits: number;
  stopRequestedAt: Date | null;
  stoppedAt: Date | null;
  failureReason: string | null;
  heartbeatAt: Date;
  timeoutSeconds: number;
  briefId: string | null;
  deliveredAt: Date | null;
}
interface FakeStep {
  id: string;
  runId: string;
  role: string;
  round: number;
  idempotencyKey: string;
  verdict: string | null;
  reasons: unknown;
  output: unknown;
  evidence: unknown;
  costCredits: number;
  capabilityId: string | null;
  finishedAt: Date | null;
}

let runs: Map<string, FakeWorkflowRun>;
let steps: Map<string, FakeStep>;
let approvals: Map<string, { runId: string; approverId: string; decision: string; reason?: string }>;
let capabilities: Array<{ id: string; scopePath: string; agentId: string; revokedAt: Date | null }>;
let auditRows: Array<Record<string, unknown>>;
let briefs: Array<{ id: string } & Record<string, unknown>>;
let seq = 0;
const nextId = (prefix: string) => `${prefix}_${++seq}`;

// The brief's change event is create-brief.test.ts's subject; here it only has to succeed.
vi.mock("@/services/memory/change-events", () => ({ recordChangeEvent: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    // createBrief (services/memory/create-brief.ts) writes through a transaction; this
    // double runs it against the same mocked client.
    $transaction: vi.fn(function (this: unknown, fn: (tx: unknown) => unknown) {
      return fn(this);
    }),
    workflowRun: {
      create: vi.fn(async ({ data }: { data: Partial<FakeWorkflowRun> }) => {
        if ([...runs.values()].some((r) => r.idempotencyKey === data.idempotencyKey)) {
          const { Prisma } = await import("@/lib/generated/prisma/client");
          throw new Prisma.PrismaClientKnownRequestError("unique", {
            code: "P2002",
            clientVersion: "test",
            meta: { target: ["idempotencyKey"] },
          });
        }
        const run: FakeWorkflowRun = {
          id: nextId("run"),
          status: "queued",
          round: 0,
          roundCap: 3,
          reservedCredits: 0,
          spentCredits: 0,
          stopRequestedAt: null,
          stoppedAt: null,
          failureReason: null,
          heartbeatAt: new Date(),
          timeoutSeconds: 600,
          briefId: null,
          deliveredAt: null,
          ...data,
        } as FakeWorkflowRun;
        runs.set(run.id, run);
        return run;
      }),
      findUnique: vi.fn(async ({ where }: { where: { id?: string; idempotencyKey?: string } }) => {
        if (where.id) return runs.get(where.id) ?? null;
        return [...runs.values()].find((r) => r.idempotencyKey === where.idempotencyKey) ?? null;
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
        const run = runs.get(where.id);
        if (!run) throw new Error(`run ${where.id} not found`);
        return run;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const run = runs.get(where.id)!;
        const patch: Record<string, unknown> = { ...data };
        if (data.round && typeof data.round === "object" && "increment" in (data.round as object)) {
          patch.round = run.round + (data.round as { increment: number }).increment;
        }
        Object.assign(run, patch);
        return run;
      }),
      findMany: vi.fn(async () => [...runs.values()]),
    },
    workflowRunStep: {
      create: vi.fn(async ({ data }: { data: Partial<FakeStep> }) => {
        if ([...steps.values()].some((s) => s.idempotencyKey === data.idempotencyKey)) {
          const { Prisma } = await import("@/lib/generated/prisma/client");
          throw new Prisma.PrismaClientKnownRequestError("unique", {
            code: "P2002",
            clientVersion: "test",
            meta: { target: ["idempotencyKey"] },
          });
        }
        const step: FakeStep = {
          id: nextId("step"),
          verdict: null,
          reasons: [],
          output: null,
          evidence: [],
          costCredits: 0,
          capabilityId: null,
          finishedAt: null,
          ...data,
        } as FakeStep;
        steps.set(step.id, step);
        return step;
      }),
      findUnique: vi.fn(
        async ({ where }: { where: { idempotencyKey: string } }) =>
          [...steps.values()].find((s) => s.idempotencyKey === where.idempotencyKey) ?? null,
      ),
      findFirstOrThrow: vi.fn(async ({ where }: { where: { runId: string; role: string } }) => {
        const matches = [...steps.values()]
          .filter((s) => s.runId === where.runId && s.role === where.role)
          .sort((a, b) => b.round - a.round);
        if (matches.length === 0) throw new Error("no matching step");
        return matches[0];
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<FakeStep> }) => {
        const step = steps.get(where.id)!;
        Object.assign(step, data);
        return step;
      }),
      findMany: vi.fn(async ({ where }: { where: { runId: string; capabilityId?: unknown } }) =>
        [...steps.values()].filter((s) => s.runId === where.runId && s.capabilityId),
      ),
    },
    workflowApproval: {
      create: vi.fn(
        async ({ data }: { data: { runId: string; approverId: string; decision: string; reason?: string } }) => {
          approvals.set(data.runId, data);
          return { id: nextId("approval"), ...data };
        },
      ),
      findUnique: vi.fn(async ({ where }: { where: { runId: string } }) => approvals.get(where.runId) ?? null),
    },
    orgWorkflowControl: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(),
    },
    capability: {
      create: vi.fn(async ({ data }: { data: { scopePath: string; agentId: string } }) => {
        const cap = { id: nextId("cap"), scopePath: data.scopePath, agentId: data.agentId, revokedAt: null };
        capabilities.push(cap);
        return cap;
      }),
      updateMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
        let count = 0;
        for (const cap of capabilities) {
          if (where.id.in.includes(cap.id) && !cap.revokedAt) {
            cap.revokedAt = new Date();
            count++;
          }
        }
        return { count };
      }),
    },
    auditLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        auditRows.push(data);
        return { id: nextId("audit") };
      }),
    },
    brief: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const brief = { id: nextId("brief"), ...data };
        briefs.push(brief);
        return brief;
      }),
    },
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      // Mirror the real guarded UPDATE: only "succeed" (return 1) when the run's
      // current reserved+spent+estimate would stay within budgetCredits. Argument
      // order follows the real tagged-template interpolation order in
      // reserveWorkflowCredits (estimate, runId, estimate again) — NOT (runId,
      // estimate); a positional real-SQL param list doesn't care about this
      // (real Postgres just fills in $1/$2/$3 in the same order), but this fake
      // has to match it exactly to mean the same thing.
      const estimate = values[0] as number;
      const runId = values[1] as string;
      const run = runs.get(runId);
      if (!run) return 0;
      if (run.reservedCredits + run.spentCredits + estimate > run.budgetCredits) return 0;
      run.reservedCredits += estimate;
      return 1;
    }),
  },
}));

vi.mock("@/services/agents/runner", () => ({
  runHandoffAgent: vi.fn(),
  drawioLinkFromMermaid: vi.fn(() => null),
}));
vi.mock("@/services/agents/derive-artifacts", () => ({
  deriveHandoffCharts: vi.fn(() => ({})),
}));
vi.mock("@/services/billing", () => ({
  recordArtifactUsage: vi.fn(),
}));

import { runHandoffAgent } from "@/services/agents/runner";
import { recordArtifactUsage } from "@/services/billing";
import {
  startHandoffBriefRun,
  driveHandoffBriefRun,
  decideHandoffBriefRun,
  deliverHandoffBriefRun,
} from "./handoff-brief";
import { stopWorkflowRun } from "./engine";

const agentRow = {
  agentKey: "handoff-agent",
  name: "Handoff agent",
  role: "handoff",
  systemPrompt: null,
  tools: [],
  model: null,
};

const baseInput = {
  orgId: "org_1",
  requestedBy: "user_1",
  scopePath: "org_1.dept_sales",
  granteeName: "Jamie Contractor",
  agentRow,
};

beforeEach(() => {
  runs = new Map();
  steps = new Map();
  approvals = new Map();
  capabilities = [];
  auditRows = [];
  briefs = [];
  seq = 0;
  vi.clearAllMocks();
});

describe("driveHandoffBriefRun", () => {
  it("happy path: drafter produces a brief, checker passes, run reaches awaiting_approval", async () => {
    vi.mocked(runHandoffAgent).mockResolvedValue({ title: "Onboarding", summary: "s", sections: [] } as never);
    const { run } = await startHandoffBriefRun({ ...baseInput, requestFingerprint: "grant_1" });

    const final = await driveHandoffBriefRun(run.id, baseInput);

    expect(final.status).toBe("awaiting_approval");
    expect(runHandoffAgent).toHaveBeenCalledTimes(1);
    // A capability was minted scoped to exactly the run's scope, never wider.
    expect(capabilities[0]).toMatchObject({ scopePath: "org_1.dept_sales" });
    // Both drafter and checker steps were audited (guarantee 9).
    expect(auditRows.some((r) => r.actorId === "workflow:drafter" && r.decision === "allow")).toBe(true);
    expect(auditRows.some((r) => r.actorId === "workflow:checker" && r.decision === "allow")).toBe(true);
  });

  // NOT COVERED (named honestly rather than faked): the round-cap re-draft loop
  // itself. This workflow's drafter step always cites evidence that is exactly
  // its own run.scopePath (see driveHandoffBriefRun's comment on why that's the
  // honest interim measure), so checkEvidenceInScope can never return
  // "changes_requested" for it today — the checker can't fail, so the round-cap
  // branch is unreachable through this workflow's public API until the drafter
  // emits real per-claim evidence (this file's header gap). The round-cap logic
  // itself is exercised where it CAN fail: checkEvidenceInScope's own unit tests
  // in engine.test.ts cover a real out-of-scope citation and empty-evidence
  // rejection; what's untested is only this workflow's wiring of a failing
  // verdict into the round-increment/escalate branch. Do not report this
  // guarantee as fully covered end to end until that follow-up lands.

  it("stops mid-run and performs no further steps once stopWorkflowRun has been called", async () => {
    vi.mocked(runHandoffAgent).mockResolvedValue({ title: "t", summary: "s", sections: [] } as never);
    const { run } = await startHandoffBriefRun({ ...baseInput, requestFingerprint: "grant_3" });

    await stopWorkflowRun(run.id);
    const final = await driveHandoffBriefRun(run.id, baseInput);

    expect(final.status).toBe("stopped");
    expect(runHandoffAgent).not.toHaveBeenCalled();
  });

  it("does not start a drafter step once the run's budget is exhausted", async () => {
    vi.mocked(runHandoffAgent).mockResolvedValue({ title: "t", summary: "s", sections: [] } as never);
    const { run } = await startHandoffBriefRun({ ...baseInput, requestFingerprint: "grant_4" });
    runs.get(run.id)!.budgetCredits = 0; // even the first 1-credit reservation cannot land

    const final = await driveHandoffBriefRun(run.id, baseInput);

    expect(final.status).toBe("over_budget");
    expect(runHandoffAgent).not.toHaveBeenCalled();
  });

  it("resuming after a crash does not re-run an already-finished drafter step", async () => {
    vi.mocked(runHandoffAgent).mockResolvedValue({ title: "t", summary: "s", sections: [] } as never);
    const { run } = await startHandoffBriefRun({ ...baseInput, requestFingerprint: "grant_5" });

    await driveHandoffBriefRun(run.id, baseInput); // reaches awaiting_approval
    expect(runHandoffAgent).toHaveBeenCalledTimes(1);

    // Re-entering (e.g. a duplicate Inngest delivery) must not call the agent again.
    await driveHandoffBriefRun(run.id, baseInput);
    expect(runHandoffAgent).toHaveBeenCalledTimes(1);
  });
});

describe("decideHandoffBriefRun + deliverHandoffBriefRun", () => {
  async function runToApproval(fingerprint: string) {
    vi.mocked(runHandoffAgent).mockResolvedValue({ title: "Onboarding", summary: "s", sections: [] } as never);
    const { run } = await startHandoffBriefRun({ ...baseInput, requestFingerprint: fingerprint });
    return driveHandoffBriefRun(run.id, baseInput);
  }

  it("refuses to deliver a run with NO approval record at all", async () => {
    const run = await runToApproval("grant_10");
    await expect(deliverHandoffBriefRun(run.id, "org_1")).rejects.toThrow(/no real approval record/);
  });

  it("refuses to deliver a run whose only record is a REJECTED decision", async () => {
    const run = await runToApproval("grant_11");
    await decideHandoffBriefRun({ runId: run.id, approverId: "user_1", decision: "rejected", reason: "wrong scope" });
    await expect(deliverHandoffBriefRun(run.id, "org_1")).rejects.toThrow(/no real approval record/);
    expect(runs.get(run.id)!.status).toBe("failed");
  });

  it("delivers only after a real, approved WorkflowApproval row exists", async () => {
    const run = await runToApproval("grant_12");
    await decideHandoffBriefRun({ runId: run.id, approverId: "user_1", decision: "approved" });

    const { brief, run: delivered } = await deliverHandoffBriefRun(run.id, "org_1");

    expect(delivered.status).toBe("delivered");
    expect(delivered.briefId).toBe(brief.id);
    expect(recordArtifactUsage).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org_1", artifactType: "handoff", briefId: brief.id }),
    );
  });

  it("refuses a decision on a run that is not awaiting approval", async () => {
    vi.mocked(runHandoffAgent).mockResolvedValue({ title: "t", summary: "s", sections: [] } as never);
    const { run } = await startHandoffBriefRun({ ...baseInput, requestFingerprint: "grant_13" });
    // still "queued"/"drafting" — never driven to awaiting_approval
    await expect(decideHandoffBriefRun({ runId: run.id, approverId: "user_1", decision: "approved" })).rejects.toThrow(
      /not awaiting approval/,
    );
  });

  it("refuses delivery once the run has been stopped, even with a prior approval", async () => {
    const run = await runToApproval("grant_14");
    await decideHandoffBriefRun({ runId: run.id, approverId: "user_1", decision: "approved" });
    await stopWorkflowRun(run.id);

    await expect(deliverHandoffBriefRun(run.id, "org_1")).rejects.toThrow(/stopped/);
  });
});
