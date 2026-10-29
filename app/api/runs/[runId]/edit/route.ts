// POST /api/runs/[runId]/edit — apply a boundary-safe live edit to a run's plan
// (docs/design_interactive_agent_loop.md §5).
//
// Contract:
//   body: { editId: string, baseRevision: number, ops: PlanEditOp[] }
//     PlanEditOp = { op: "add", item: { kind, title, detail? }, toIndex? }
//                | { op: "update", itemId, title?, detail? }
//                | { op: "remove", itemId } | { op: "skip", itemId }
//                | { op: "reorder", itemId, toIndex }
//   response: { status: "applied", plan } (200)
//           | { status: "noop", plan } (200 — editId already applied; idempotent)
//           | { status: "conflict", plan } (409 — baseRevision stale; re-render from plan)
//           | { error } (400/404, or 409 when the run's agent has been deactivated:
//             services/agents/agent-active.ts).
//   On "applied" the loop bumps AgentRunPlan.revision, records the editId, persists the plan,
//   and emits `plan_updated` (reason: "user_edit") on the stream. The executor reads the plan
//   fresh each iteration, so the edit takes effect at the next step boundary (never mid-item),
//   and completed items cannot be rewritten.
//
// Per-stage redirect (two-level redirect): the SAME endpoint also accepts a `rerun` body
//   body: { editId: string, baseRevision: number, rerun: { itemId: string, feedback: string } }
//   which re-executes ONLY that one completed/failed plan item with the human's feedback
//   appended (its two-call act→observe + structure), replaces just that item's fragment, and
//   re-emits step_completed + artifact — every other stage untouched. Concurrency-safe like
//   the ops path (editId idempotency + baseRevision). Response mirrors the ops path but with
//   status "reran" on success.
//
// Access: the caller must be able to read the run's scope and its brief's scope
// (services/agents/run-visibility.ts), the same gate as starting the run; one who
// cannot gets the same 404 as an absent run. applyPlanEdit / rerunPlanItem re-check orgId.
import { requireAccessContext } from "@/lib/access-context";
import { applyPlanEdit, rerunPlanItem, type PlanEditOp } from "@/services/agents/run-loop";
import { findReadableRun } from "@/services/agents/run-visibility";
import { agentDeactivatedResponse, isAgentDeactivated } from "@/services/agents/agent-active";

export async function POST(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { runId } = await params;
  const run = await findReadableRun(rc.ctx, rc.org.id, runId);
  if (!run) return Response.json({ error: "run not found" }, { status: 404 });
  if (await isAgentDeactivated(rc.org.id, run.agentId)) return agentDeactivatedResponse();

  const body = (await req.json()) as {
    editId?: string;
    baseRevision?: number;
    ops?: PlanEditOp[];
    rerun?: { itemId?: unknown; feedback?: unknown };
  };

  // Per-stage redirect: re-run a single completed/failed step with feedback.
  if (body.rerun) {
    if (typeof body.editId !== "string" || typeof body.baseRevision !== "number") {
      return Response.json({ error: "invalid rerun (editId + baseRevision required)" }, { status: 400 });
    }
    const { itemId, feedback } = body.rerun;
    if (typeof itemId !== "string" || typeof feedback !== "string" || !feedback.trim()) {
      return Response.json({ error: "invalid rerun (itemId + non-empty feedback required)" }, { status: 400 });
    }
    const result = await rerunPlanItem(runId, rc.org.id, {
      editId: body.editId,
      baseRevision: body.baseRevision,
      itemId,
      feedback,
    });
    switch (result.status) {
      case "reran":
        return Response.json({ status: "reran", plan: result.plan }, { status: 200 });
      case "noop":
        return Response.json({ status: "noop", plan: result.plan }, { status: 200 });
      case "conflict":
        return Response.json({ status: "conflict", plan: result.plan }, { status: 409 });
      case "invalid":
        return Response.json({ error: result.error }, { status: result.error === "run not found" ? 404 : 400 });
    }
  }

  if (typeof body.editId !== "string" || typeof body.baseRevision !== "number" || !Array.isArray(body.ops)) {
    return Response.json({ error: "invalid edit (editId + baseRevision + ops required)" }, { status: 400 });
  }
  if (body.ops.length === 0) {
    return Response.json({ error: "ops must not be empty" }, { status: 400 });
  }

  const result = await applyPlanEdit(runId, rc.org.id, {
    editId: body.editId,
    baseRevision: body.baseRevision,
    ops: body.ops,
  });

  switch (result.status) {
    case "applied":
      return Response.json({ status: "applied", plan: result.plan }, { status: 200 });
    case "noop":
      return Response.json({ status: "noop", plan: result.plan }, { status: 200 });
    case "conflict":
      return Response.json({ status: "conflict", plan: result.plan }, { status: 409 });
    case "invalid":
      return Response.json({ error: result.error }, { status: result.error === "run not found" ? 404 : 400 });
  }
}
