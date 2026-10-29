// POST /api/runs/[runId]/answer — resume a paused interactive run by answering its
// open clarification checkpoint (docs/design_interactive_agent_loop.md §4).
//
// Contract:
//   body: ResumePayload { checkpointId, answers: [{ questionId, acceptedDefault?, answer? }] }
//   response: { status: "resumed" | "noop" } (200) | { error } (400/404, or 409 when the
//   run's agent has been deactivated: services/agents/agent-active.ts).
//     "noop" = nothing to resume (never paused, or a duplicate resume already ran — idempotent).
//   On resume the loop folds the answers (untouched questions fall back to their recommended
//   default, recorded as an agent assumption), clears pendingInput, flips phase→executing, and
//   emits `resumed` + `phase: executing`. It then drives execution; the client reopens (or keeps
//   open) the stream to receive step_* / artifact / done events.
//
// Access: the caller must be able to read the run's scope and its brief's scope
// (services/agents/run-visibility.ts), the same gate as starting the run; one who
// cannot gets the same 404 as an absent run. resumeRun re-checks the run's org.
import { requireAccessContext } from "@/lib/access-context";
import { resumeRun, driveRun } from "@/services/agents/run-loop";
import { findReadableRun } from "@/services/agents/run-visibility";
import { agentDeactivatedResponse, isAgentDeactivated } from "@/services/agents/agent-active";
import type { ResumePayload } from "@/types/agent-run";

export async function POST(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { runId } = await params;
  const run = await findReadableRun(rc.ctx, rc.org.id, runId);
  if (!run) return Response.json({ error: "run not found" }, { status: 404 });
  if (await isAgentDeactivated(rc.org.id, run.agentId)) return agentDeactivatedResponse();

  const body = (await req.json()) as Partial<ResumePayload>;
  if (!body || typeof body.checkpointId !== "string" || !Array.isArray(body.answers)) {
    return Response.json({ error: "invalid ResumePayload (checkpointId + answers required)" }, { status: 400 });
  }

  const result = await resumeRun(runId, rc.org.id, {
    checkpointId: body.checkpointId,
    answers: body.answers,
  });

  if (result.status === "invalid") {
    const status = result.error === "run not found" ? 404 : 400;
    return Response.json({ error: result.error }, { status });
  }

  // Drive execution forward. Backgrounded so the POST returns promptly; the stream
  // route also re-drives on connect (guarded), so progress is guaranteed either way.
  if (result.status === "resumed") void driveRun(runId, rc.org.id);

  return Response.json({ status: result.status }, { status: 200 });
}
