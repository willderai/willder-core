// POST /api/runs/[runId]/reply — a free-text follow-up ("reply to the AI agent") on a
// FINISHED agent run (the "done" items in the unified Inbox).
//
// The human types "focus more on the auth section" / "also check rate limits" / "redo
// assuming 10x traffic" on a completed run, and the agent acts on it — producing a NEW
// result that lands back in the Inbox. A two-way conversation, not one-shot.
//
// ARCHITECTURE (per the 2026-07-22 user correction): the reply is routed THROUGH THE
// MANAGER/SUPERVISOR mechanism, NOT a plain single-agent redirect/edit re-run. A reply on a
// finished item kicks off a MANAGER run of that agent (services/agents/manager +
// manager-arch), seeded with the prior output as context + the human's reply as the
// directive. The manager then interprets the reply and decomposes/delegates/coordinates the
// follow-up — fanning out ≤5 sub-agents (depth-1) and folding their fragments into ONE brief
// that surfaces back in the Inbox. This mirrors the /run-manager + /plan-manager start routes;
// we reuse createQaManagerRun / createArchManagerRun + driveManager rather than the
// single-agent createQaInteractiveRun / applyPlanEdit ("Redirect the run") path.
//
// Why a follow-up RUN, not the workspace /edit redirect: the whole-run redirect appends a
// step to a run whose plan is still LIVE (non-terminal). A `done` run is terminal — there is
// no mutable plan to append to. So the correct move is a fresh MANAGER run seeded with (prior
// brief + reply). It is a normal run, so its completion emits the usual `done` AgentRunEvent +
// Brief — the new result surfaces in the Inbox automatically (no inbox route change).
//
// Contract:
//   body: { message: string }   (the human's reply / new directive)
//   response: { runId } (201 — the NEW manager follow-up run) | { error } (400/401/404/409).
//
// Access: the caller must be able to read the original run's scope (the org root for a
// scope-less run) and its brief's scope (services/agents/run-visibility.ts) before anything
// else is decided; one who cannot gets the same 404 as an absent run. That is the gate the
// run-start routes apply, and it covers the brief summary copied into the follow-up. The
// manager flag gates are intentionally NOT applied here: replying to a finished item IS the
// manager surface for follow-ups, so it always routes through the manager engine.
//
// Scope: MVP only — reply on a `done` run of a supported role (qa | architecture). Other
// roles are rejected gracefully (400). No threaded history / multi-turn state machine.
import { requireAccessContext } from "@/lib/access-context";
import { findReadableRunWithBrief } from "@/services/agents/run-visibility";
import { after } from "next/server";
import { createQaManagerRun, createArchManagerRun, driveManager } from "@/services/agents/manager";
import { agentDeactivatedResponse, isAgentDeactivated } from "@/services/agents/agent-active";

// The prior run's meta — either a single-agent (`*-interactive`) or a manager (`*-manager`)
// meta. Both shapes expose the fields we reseed the follow-up from, so this loose read covers
// replying to a run started either way.
interface PriorRunMeta {
  agentRole?: "qa" | "architecture" | string;
  // QA
  target?: { baseUrl: string; allowedHosts?: string[]; openApiUrl?: string; authHeader?: string };
  focus?: string;
  mode?: "api" | "browser";
  // shared
  scopePath?: string;
  // architecture
  prompt?: string;
  context?: string;
}

const MAX_MESSAGE = 4000;
const PRIOR_SUMMARY_MAX = 1200;

function trim(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

export async function POST(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { runId } = await params;
  const body = (await req.json()) as { message?: unknown };
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return Response.json({ error: "message is required" }, { status: 400 });
  const instruction = message.length > MAX_MESSAGE ? message.slice(0, MAX_MESSAGE) : message;

  // The run and the brief it produced, decided together: the brief's scope is
  // checked once, as part of deciding whether this caller may see the run at all.
  const readable = await findReadableRunWithBrief(rc.ctx, rc.org.id, runId);
  if (!readable) return Response.json({ error: "run not found" }, { status: 404 });
  const { run, brief } = readable;
  if (await isAgentDeactivated(rc.org.id, run.agentId)) return agentDeactivatedResponse();
  // Reply is only for a FINISHED run — a done item in the Inbox. Anything still in flight
  // (planning/consulting/paused/executing) has its own live affordances in the workspace.
  if (run.phase !== "done") {
    return Response.json(
      { error: "run is not finished — reply is only available on a completed run" },
      { status: 409 },
    );
  }

  const meta = (run.meta ?? {}) as unknown as PriorRunMeta;
  const role = meta.agentRole;
  if (role !== "qa" && role !== "architecture") {
    return Response.json({ error: "reply is not supported for this agent" }, { status: 400 });
  }

  // Prior output as context — the Brief the finished run produced (its RESULT, not a title).
  const priorContext = brief?.summary
    ? `Previous result "${brief.title}" (${brief.type}): ${trim(brief.summary, PRIOR_SUMMARY_MAX)}`
    : undefined;

  if (role === "architecture") {
    if (!meta.scopePath) {
      return Response.json({ error: "run is missing its memory scope" }, { status: 409 });
    }
    // The reply is the new directive; the prior framing + prior brief become the context the
    // manager fans out over.
    const context = [meta.context, priorContext].filter(Boolean).join("\n\n") || undefined;
    const newRunId = await createArchManagerRun({
      orgId: rc.org.id,
      agentId: run.agentId,
      triggeredBy: rc.user.id,
      scopePath: meta.scopePath,
      prompt: instruction,
      context,
    });
    after(() => driveManager(newRunId));
    return Response.json({ runId: newRunId }, { status: 201 });
  }

  // role === "qa"
  if (!meta.target?.baseUrl) {
    return Response.json({ error: "run is missing its QA target" }, { status: 409 });
  }
  // QA-manager meta carries a single `focus` (no separate context field) — fold the prior
  // result + original focus into it so the manager's fan-out is seeded with the full history.
  const focus = [
    priorContext,
    meta.focus ? `Original focus: ${meta.focus}` : null,
    `Follow-up instruction: ${instruction}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const newRunId = await createQaManagerRun({
    orgId: rc.org.id,
    agentId: run.agentId,
    triggeredBy: rc.user.id,
    target: meta.target,
    focus,
    mode: meta.mode ?? "api",
    scopePath: meta.scopePath,
  });
  after(() => driveManager(newRunId));
  return Response.json({ runId: newRunId }, { status: 201 });
}
