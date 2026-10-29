// POST /api/agents/[id]/plan-interactive — start an INTERACTIVE, resumable
// ARCHITECTURE planning run (docs/design_architecture_agent_v2.md §3). Sibling to the
// QA /run-interactive route.
// Architecture reasons over memory + docs — there is NO target URL / live product.
//
// Contract:
//   body: { scopePath: string (required), prompt: string (required),
//           context?: string, attachmentIds?: string[], autopilot?: boolean }
//   response: { runId } (201) — the client then opens GET /api/runs/[runId]/stream.
//
// Semantics: create the AgentRun (phase=planning), then drive the loop synchronously
// far enough that it PLANS and, in the consulting phase, PAUSES on a needs_input
// checkpoint (or, in autopilot, runs to completion). driveRun stops at the pause, so
// this POST returns quickly with the plan + first checkpoint already persisted and
// replayable on the stream. Emits (via the loop): plan, phase, needs_input (+ paused).
//
// Access: same spine as /run-interactive but gated to role "architecture" (like the
// one-shot /architecture route). scopePath is REQUIRED (the plan is grounded in it),
// and the human must pass check({ action: "memory.read", scope }): the
// agent capability can never exceed the human's grant.
import { requireAccessContext } from "@/lib/access-context";
import { bodyTypeRefusal } from "@/lib/json-type-name";
import { AccessDeniedError, check, orgRootPath, resolveCallerScopePath, scopeIsAbsent } from "@/services/access";
import { db } from "@/lib/db";
import { after } from "next/server";
import { createArchInteractiveRun, driveRun, normalizeRunAttachments } from "@/services/agents/run-loop";
import { agentDeactivatedResponse } from "@/services/agents/agent-active";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  let body: {
    scopePath?: unknown;
    prompt?: string;
    context?: string;
    attachmentIds?: string[];
    attachments?: { name?: unknown; content?: unknown }[];
    autopilot?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid json body" }, { status: 400 });
  }
  const wrongType = bodyTypeRefusal(body, ["prompt", "context", "attachmentIds[]"]);
  if (wrongType) return Response.json({ error: wrongType }, { status: 400 });

  // Validate the required inputs up front (fail clearly, not deep in the loop).
  const requestedScope = body.scopePath;
  if (scopeIsAbsent(requestedScope)) return Response.json({ error: "scopePath is required" }, { status: 400 });
  const prompt = body.prompt?.trim();
  if (!prompt) return Response.json({ error: "prompt is required" }, { status: 400 });

  // A malformed scopePath must never reach check()'s `::ltree` cast raw. This route
  // mints a capability and persists scopePath onto the run, so there is no safe
  // fallback scope: the shared write-direction resolver refuses it, with one deny row
  // that records the scope as sent. scopePath is non-empty here, so the resolver's
  // fallback is never used.
  let scopePath: string;
  try {
    scopePath = await resolveCallerScopePath(
      rc.ctx,
      requestedScope,
      { scopePath: orgRootPath(rc.org.id) },
      { onInvalid: "refuse", action: "memory.read", persists: true },
    );
  } catch (e) {
    if (e instanceof AccessDeniedError) {
      return Response.json({ error: `access denied: ${e.decision.reason}` }, { status: 403 });
    }
    throw e;
  }

  // The human must be able to read the scope the plan is grounded in
  // (same access boundary as the one-shot /architecture route and interactive QA).
  const decision = await check(rc.ctx, { action: "memory.read", scope: scopePath });
  if (!decision.allowed) {
    return Response.json({ error: `access denied: ${decision.reason}` }, { status: 403 });
  }

  const agentRow = await db.agent.findFirst({
    where: { id, orgId: rc.org.id, role: "architecture" },
    select: { active: true, id: true },
  });
  if (!agentRow) return Response.json({ error: "Architecture agent not found" }, { status: 404 });
  if (!agentRow.active) return agentDeactivatedResponse();

  const runId = await createArchInteractiveRun({
    orgId: rc.org.id,
    agentId: agentRow.id,
    triggeredBy: rc.user.id,
    scopePath,
    prompt,
    context: body.context,
    attachmentIds: body.attachmentIds,
    attachments: normalizeRunAttachments(body.attachments),
    autopilot: body.autopilot ?? false,
  });

  // Kick the loop in the BACKGROUND so the workspace tab opens instantly instead of
  // blocking on the first LLM planning call. `after` keeps the function alive to run it
  // post-response; driveRun rebuilds from the DB (re-mints its own capability) and catches
  // its own errors, so the client sees the plan — and any failure — on the stream.
  after(() => driveRun(runId, rc.org.id));

  return Response.json({ runId }, { status: 201 });
}
