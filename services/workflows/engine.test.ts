import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the db + capability helpers the same way services/access/check.test.ts does:
// drive the JS reliability logic against a controlled fake, real Postgres behavior
// (the unique-constraint race, the atomic budget UPDATE) is exercised by the
// guard-removal differentials below, not by a live connection.
vi.mock("@/lib/db", () => ({
  db: {
    workflowRun: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
    },
    workflowRunStep: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findFirstOrThrow: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
    },
    workflowApproval: {
      create: vi.fn(),
      findUnique: vi.fn(),
    },
    orgWorkflowControl: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    capability: {
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    auditLog: { create: vi.fn() },
    $executeRaw: vi.fn(),
  },
}));

import { db } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import {
  startWorkflowRun,
  deriveWorkflowIdempotencyKey,
  runWorkflowStep,
  checkEvidenceInScope,
  reserveWorkflowCredits,
  settleWorkflowCredits,
  isWorkflowRunStopped,
  stopWorkflowRun,
  mintWorkflowRoleCapability,
  recordWorkflowApproval,
  recordWorkflowAudit,
  releaseStuckWorkflowRuns,
} from "./engine";

const uniqueViolation = (target: string) =>
  new Prisma.PrismaClientKnownRequestError("unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
    meta: { target: [target] },
  });

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Guarantee 1: one reservation per job -----------------------------------

describe("startWorkflowRun", () => {
  const input = {
    orgId: "org_1",
    workflowKey: "handoff-brief",
    requestedBy: "user_1",
    scopePath: "org_1.dept_sales",
    requestFingerprint: "grant_42",
    budgetCredits: 3,
  };

  it("creates a new run on the first call", async () => {
    vi.mocked(db.workflowRun.create).mockResolvedValue({ id: "run_1" } as never);
    const { run, isNew } = await startWorkflowRun(input);
    expect(isNew).toBe(true);
    expect(run).toEqual({ id: "run_1" });
    expect(db.workflowRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        idempotencyKey: deriveWorkflowIdempotencyKey(input),
        orgId: "org_1",
        workflowKey: "handoff-brief",
      }),
    });
  });

  it("returns the EXISTING run on a duplicate trigger instead of creating a second one", async () => {
    vi.mocked(db.workflowRun.create).mockRejectedValue(uniqueViolation("idempotencyKey"));
    vi.mocked(db.workflowRun.findUnique).mockResolvedValue({ id: "run_1", status: "queued" } as never);

    const { run, isNew } = await startWorkflowRun(input);

    expect(isNew).toBe(false);
    expect(run).toEqual({ id: "run_1", status: "queued" });
    expect(db.workflowRun.findUnique).toHaveBeenCalledWith({
      where: { idempotencyKey: deriveWorkflowIdempotencyKey(input) },
    });
  });

  it("does not swallow an unrelated unique violation", async () => {
    vi.mocked(db.workflowRun.create).mockRejectedValue(uniqueViolation("someOtherField"));
    await expect(startWorkflowRun(input)).rejects.toThrow();
  });

  it("re-throws a non-unique-constraint error", async () => {
    vi.mocked(db.workflowRun.create).mockRejectedValue(new Error("connection reset"));
    await expect(startWorkflowRun(input)).rejects.toThrow("connection reset");
  });

  it("derives the same key for the same (org, workflow, requester, fingerprint), a different key otherwise", () => {
    const a = deriveWorkflowIdempotencyKey(input);
    const b = deriveWorkflowIdempotencyKey(input);
    const differentRequester = deriveWorkflowIdempotencyKey({ ...input, requestedBy: "user_2" });
    expect(a).toBe(b);
    expect(a).not.toBe(differentRequester);
  });
});

// --- Guarantee 2: safe retries (idempotent per run/step/round) -------------

describe("runWorkflowStep", () => {
  const run = { id: "run_1" };

  it("executes and persists a step that has never run", async () => {
    vi.mocked(db.workflowRunStep.findUnique).mockResolvedValue(null);
    vi.mocked(db.workflowRun.update).mockResolvedValue({} as never);
    vi.mocked(db.workflowRunStep.create).mockResolvedValue({ id: "step_1" } as never);
    vi.mocked(db.workflowRunStep.update).mockResolvedValue({ id: "step_1", finishedAt: new Date() } as never);

    const execute = vi.fn().mockResolvedValue({ output: { ok: true }, costCredits: 1 });
    const result = await runWorkflowStep({ run, role: "drafter", round: 0, execute });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(db.workflowRunStep.create).toHaveBeenCalledWith({
      data: { runId: "run_1", role: "drafter", round: 0, idempotencyKey: "run_1:drafter:0" },
    });
    expect(result).toEqual({ id: "step_1", finishedAt: expect.any(Date) });
  });

  it("returns the cached finished step WITHOUT calling execute again (a retry after a timeout never double-writes)", async () => {
    const finished = { id: "step_1", finishedAt: new Date(), output: { ok: true } };
    vi.mocked(db.workflowRunStep.findUnique).mockResolvedValue(finished as never);

    const execute = vi.fn().mockResolvedValue({ output: { ok: false } });
    const result = await runWorkflowStep({ run, role: "drafter", round: 0, execute });

    expect(execute).not.toHaveBeenCalled();
    expect(result).toBe(finished);
    expect(db.workflowRunStep.create).not.toHaveBeenCalled();
  });

  it("re-reads instead of double-executing when a concurrent retry wins the create race", async () => {
    vi.mocked(db.workflowRunStep.findUnique)
      .mockResolvedValueOnce(null) // no row yet
      .mockResolvedValueOnce({ id: "step_1", finishedAt: new Date(), output: { winner: true } } as never); // sibling already finished it
    vi.mocked(db.workflowRun.update).mockResolvedValue({} as never);
    vi.mocked(db.workflowRunStep.create).mockRejectedValue(uniqueViolation("idempotencyKey"));

    const execute = vi.fn();
    const result = await runWorkflowStep({ run, role: "checker", round: 0, execute });

    expect(execute).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ output: { winner: true } }));
  });
});

// --- Guarantee 3/4: evidence must stay inside scope, and must exist --------

describe("checkEvidenceInScope", () => {
  it("passes when every cited source is inside scope", () => {
    const result = checkEvidenceInScope("org_1.dept_sales", [
      { sourceId: "s1", scopePath: "org_1.dept_sales" },
      { sourceId: "s2", scopePath: "org_1.dept_sales.deal_a" },
    ]);
    expect(result).toEqual({ verdict: "pass", reasons: [] });
  });

  it("requests changes when a citation is OUTSIDE the run's scope, even if the drafter included it", () => {
    const result = checkEvidenceInScope("org_1.dept_sales", [
      { sourceId: "s1", scopePath: "org_1.dept_sales" },
      { sourceId: "s2", scopePath: "org_1.dept_eng" }, // sibling scope, not a descendant
    ]);
    expect(result.verdict).toBe("changes_requested");
    expect(result.reasons[0]).toContain("s2");
  });

  it("flags an output with no evidence at all as an unsupported claim", () => {
    const result = checkEvidenceInScope("org_1.dept_sales", []);
    expect(result.verdict).toBe("changes_requested");
    expect(result.reasons[0]).toContain("no sources");
  });

  it("does not flag empty evidence when the caller explicitly says none is required", () => {
    const result = checkEvidenceInScope("org_1.dept_sales", [], { requireEvidence: false });
    expect(result.verdict).toBe("pass");
  });
});

// --- Guarantee 5: budget enforced, reserve then settle ----------------------

describe("reserveWorkflowCredits / settleWorkflowCredits", () => {
  it("succeeds when the atomic UPDATE affects one row (budget covers it)", async () => {
    vi.mocked(db.$executeRaw).mockResolvedValue(1);
    await expect(reserveWorkflowCredits("run_1", 1)).resolves.toBe(true);
  });

  it("a step that would exceed the budget never starts — the UPDATE affects zero rows", async () => {
    vi.mocked(db.$executeRaw).mockResolvedValue(0);
    await expect(reserveWorkflowCredits("run_1", 5)).resolves.toBe(false);
  });

  it("settling releases the estimate and books the real cost", async () => {
    vi.mocked(db.workflowRun.update).mockResolvedValue({} as never);
    await settleWorkflowCredits("run_1", 1, 1);
    expect(db.workflowRun.update).toHaveBeenCalledWith({
      where: { id: "run_1" },
      data: { reservedCredits: { decrement: 1 }, spentCredits: { increment: 1 } },
    });
  });
});

// --- Guarantee 6: stop switch, revokes tokens immediately -------------------

describe("stop switch", () => {
  it("a run-level stopRequestedAt is stopped without an org lookup", async () => {
    const stopped = await isWorkflowRunStopped({ orgId: "org_1", stopRequestedAt: new Date() });
    expect(stopped).toBe(true);
    expect(db.orgWorkflowControl.findUnique).not.toHaveBeenCalled();
  });

  it("falls back to the customer-level control when the run itself has no stop request", async () => {
    vi.mocked(db.orgWorkflowControl.findUnique).mockResolvedValue({ orgId: "org_1", stoppedAt: new Date() } as never);
    const stopped = await isWorkflowRunStopped({ orgId: "org_1", stopRequestedAt: null });
    expect(stopped).toBe(true);
  });

  it("stopWorkflowRun revokes every capability minted for the run's steps immediately", async () => {
    vi.mocked(db.workflowRun.update).mockResolvedValue({ id: "run_1", status: "stopped" } as never);
    vi.mocked(db.workflowRunStep.findMany).mockResolvedValue([
      { capabilityId: "cap_1" },
      { capabilityId: "cap_2" },
    ] as never);
    vi.mocked(db.capability.updateMany).mockResolvedValue({ count: 2 } as never);

    await stopWorkflowRun("run_1");

    expect(db.workflowRun.update).toHaveBeenCalledWith({
      where: { id: "run_1" },
      data: expect.objectContaining({ status: "stopped" }),
    });
    expect(db.capability.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["cap_1", "cap_2"] }, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it("stopWorkflowRun does not touch capabilities when the run minted none", async () => {
    vi.mocked(db.workflowRun.update).mockResolvedValue({ id: "run_1" } as never);
    vi.mocked(db.workflowRunStep.findMany).mockResolvedValue([] as never);

    await stopWorkflowRun("run_1");
    expect(db.capability.updateMany).not.toHaveBeenCalled();
  });
});

// --- Per-role capability minting: never wider than the run's own scope ------

describe("mintWorkflowRoleCapability", () => {
  it("mints a read-only capability scoped to the run's own scopePath, never wider", async () => {
    vi.mocked(db.capability.create).mockResolvedValue({ id: "cap_1" } as never);
    const run = { orgId: "org_1", workflowKey: "handoff-brief", scopePath: "org_1.dept_sales", requestedBy: "user_1" };

    const { capabilityId } = await mintWorkflowRoleCapability(run, "drafter");

    expect(capabilityId).toBe("cap_1");
    expect(db.capability.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orgId: "org_1",
        scopePath: "org_1.dept_sales",
        permission: "read",
        agentId: "workflow:handoff-brief:drafter",
      }),
    });
  });
});

// --- Guarantee 8: no fabricated approvals -----------------------------------

describe("recordWorkflowApproval", () => {
  it("is the only path that writes a WorkflowApproval row", async () => {
    vi.mocked(db.workflowApproval.create).mockResolvedValue({ id: "approval_1" } as never);
    await recordWorkflowApproval({ runId: "run_1", approverId: "user_1", decision: "approved" });
    expect(db.workflowApproval.create).toHaveBeenCalledWith({
      data: { runId: "run_1", approverId: "user_1", decision: "approved", reason: undefined },
    });
  });
});

// --- Guarantee 9: full audit, including denials -----------------------------

describe("recordWorkflowAudit", () => {
  it("writes an allow row", async () => {
    vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_1" } as never);
    await recordWorkflowAudit({
      orgId: "org_1",
      runId: "run_1",
      role: "drafter",
      action: "workflow.draft",
      target: "org_1.dept_sales",
      decision: "allow",
      reason: "drafter produced a brief",
    });
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ decision: "allow", runId: "run_1", actorId: "workflow:drafter" }),
    });
  });

  it("writes a deny row too — denials are audited, not just allows", async () => {
    vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_2" } as never);
    await recordWorkflowAudit({
      orgId: "org_1",
      runId: "run_1",
      role: "checker",
      action: "workflow.check",
      decision: "deny",
      reason: "cites a source outside scope",
    });
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ decision: "deny", reason: "cites a source outside scope" }),
    });
  });
});

// --- Heartbeat + timeout release --------------------------------------------

describe("releaseStuckWorkflowRuns", () => {
  const now = new Date("2026-09-19T12:00:00.000Z");

  it("fails a run whose heartbeat is older than its own timeout, and zeroes its reservation", async () => {
    vi.mocked(db.workflowRun.findMany).mockResolvedValue([
      { id: "stuck_1", heartbeatAt: new Date("2026-09-19T11:00:00.000Z"), timeoutSeconds: 600, reservedCredits: 2 },
    ] as never);
    vi.mocked(db.workflowRun.update).mockResolvedValue({} as never);

    const released = await releaseStuckWorkflowRuns(now);

    expect(released).toEqual(["stuck_1"]);
    expect(db.workflowRun.update).toHaveBeenCalledWith({
      where: { id: "stuck_1" },
      data: expect.objectContaining({ status: "failed", reservedCredits: 0 }),
    });
  });

  it("leaves a run alone whose heartbeat is still within its timeout", async () => {
    vi.mocked(db.workflowRun.findMany).mockResolvedValue([
      { id: "fresh_1", heartbeatAt: new Date("2026-09-19T11:59:00.000Z"), timeoutSeconds: 600, reservedCredits: 1 },
    ] as never);

    const released = await releaseStuckWorkflowRuns(now);

    expect(released).toEqual([]);
    expect(db.workflowRun.update).not.toHaveBeenCalled();
  });
});
