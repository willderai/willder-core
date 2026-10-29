// POST /api/agents/[id]/plan-manager — start a SUPERVISED (manager/supervisor)
// ARCHITECTURE planning run (docs/design_manager_fanout.md §3 Architecture, §5/§6).
// Flag-gated (ARCH_MANAGER, default OFF), backend-only, parallel to the single-agent
// /plan-interactive route, which stays the default.
// Architecture reasons over memory + docs — there is NO target URL / live product.
//
// Contract:
//   body: { scopePath: string (required), prompt: string (required),
//           context?: string, attachmentIds?: string[] }
//   response: { runId } (201) — the client then opens GET /api/runs/[runId]/stream, which
//     renders the PARENT manager run's synthesized events (plan = ≤5 domain-bucket children,
//     step_* per child, artifact = one folded architecture_plan brief, done).
//
// Semantics: create the parent Arch manager AgentRun (phase=planning), then drive the manager
// in the BACKGROUND via after(() => driveManager(runId)) — mirroring /plan-interactive — so
// the workspace tab opens instantly and streams the fan-out LIVE. The manager decomposes the
// scope into ≤5 independent domain-bucket child arch runs (grounded in the SAME scopePath),
// then folds their fragments into ONE architecture_plan brief. driveManager rebuilds from the
// DB and catches its own errors (flips to failed + emits `error`), so any failure surfaces on
// the stream the client opens next.
//
// Access: same spine as /plan-interactive — requireAccessContext (tenant scoping via orgId),
// the agent must be role "architecture", scopePath is REQUIRED (the plan is grounded in it),
// and the human must pass check({ action: "memory.read", scope }): the agent
// capability can never exceed the human's grant. When the flag is OFF we return 404 (disabled).
import { requireAccessContext } from "@/lib/access-context";
import { bodyTypeRefusal } from "@/lib/json-type-name";
import { AccessDeniedError, check, orgRootPath, resolveCallerScopePath, scopeIsAbsent } from "@/services/access";
import { db } from "@/lib/db";
import { after } from "next/server";
import { createArchManagerRun, driveManager, archManagerEnabled } from "@/services/agents/manager";
import { agentDeactivatedResponse } from "@/services/agents/agent-active";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // Flag gate first — when disabled the surface does not exist and single-agent stays default.
  if (!archManagerEnabled()) {
    return Response.json({ error: "Architecture manager is disabled" }, { status: 404 });
  }

  const rc = await requireAccessContext();
  if (!rc) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  let body: {
    scopePath?: unknown;
    prompt?: string;
    context?: string;
    attachmentIds?: string[];
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
  // (same access boundary as /plan-interactive and the one-shot /architecture route).
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

  const runId = await createArchManagerRun({
    orgId: rc.org.id,
    agentId: agentRow.id,
    triggeredBy: rc.user.id,
    scopePath,
    prompt,
    context: body.context,
    // NOTE: per-run attachments aren't threaded to arch-manager children yet (MVV);
    // createArchManagerRun doesn't accept them. Single-agent arch keeps attachments.
  });

  // Kick the manager in the BACKGROUND so the workspace tab opens instantly instead of
  // blocking on the domain-bucket fan-out. `after` keeps the function alive to run it
  // post-response; driveManager rebuilds from the DB and catches its own errors (flips to
  // failed + emits `error`), so the client sees progress — and any failure — on the stream.
  after(() => driveManager(runId));

  return Response.json({ runId }, { status: 201 });
}
