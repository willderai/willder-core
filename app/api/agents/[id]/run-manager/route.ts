// POST /api/agents/[id]/run-manager — start a SUPERVISED (manager/supervisor) QA run.
// Flag-gated (QA_MANAGER, default OFF), backend-only, parallel to /run-interactive and
// the one-shot /qa route.
//
// Contract:
//   body: { target: { baseUrl, allowedHosts?, openApiUrl?, authHeader? }, focus?,
//           mode?: "api"|"browser", scopePath?, stoppingMode? }
//   response: { runId } (201) — the client then opens GET /api/runs/[runId]/stream, which
//     renders the PARENT run's synthesized manager events: plan = children, step_* per
//     child, artifact = aggregated verified findings, done.
//
// Semantics: create the parent manager AgentRun (phase=planning), then drive the manager in
// the BACKGROUND via after(() => driveManager(runId)) — mirroring /run-interactive — so the
// workspace tab opens instantly and streams the manager's synthesized events LIVE (plan =
// children, step_* per child, artifact = aggregated verified findings, done) instead of
// blocking this POST on the whole fan-out + convergence loop. driveManager rebuilds from the
// DB and catches its own errors (flips to failed + emits `error`), so the client sees any
// failure on the stream it opens next.
//
// Access: identical to /run-interactive — requireAccessContext (tenant scoping via orgId),
// the agent must be role "qa", and the human must pass check({ action: "memory.read" }) on
// the run's scope, or the org root for a scope-less run. When the flag is OFF we return 404 (disabled).
import { requireAccessContext } from "@/lib/access-context";
import { bodyTypeRefusal } from "@/lib/json-type-name";
import { check, isMintableScopePath, normalizeScopePath, orgRootPath } from "@/services/access";
import { db } from "@/lib/db";
import { after } from "next/server";
import { createQaManagerRun, driveManager, qaManagerEnabled, type StoppingMode } from "@/services/agents/manager";
import { agentDeactivatedResponse } from "@/services/agents/agent-active";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // Flag gate first — when disabled the surface does not exist.
  if (!qaManagerEnabled()) {
    return Response.json({ error: "QA manager is disabled" }, { status: 404 });
  }

  const rc = await requireAccessContext();
  if (!rc) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  let body: {
    scopePath?: unknown;
    target?: { baseUrl?: string; allowedHosts?: string[]; openApiUrl?: string; authHeader?: string };
    focus?: string;
    mode?: "api" | "browser";
    stoppingMode?: StoppingMode;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid json body" }, { status: 400 });
  }
  const wrongType = bodyTypeRefusal(body, [
    "target.baseUrl",
    "target.openApiUrl",
    "target.authHeader",
    "target.allowedHosts[]",
    "focus",
    "mode",
    "stoppingMode",
  ]);
  if (wrongType) return Response.json({ error: wrongType }, { status: 400 });
  // Empty/whitespace scopePath collapses to undefined here so it never survives
  // downstream past a `scopePath ?? orgRootPath(...)` write as a non-ltree value.
  // A non-empty but malformed or dashed scopePath (fails isMintableScopePath: the run stores briefs at it) is likewise
  // discarded rather than reaching check()'s `::ltree` cast raw. Either way the
  // run is scope-less, and the check below then asks for the org root.
  let scopePath = normalizeScopePath(body.scopePath);
  if (scopePath && !isMintableScopePath(scopePath)) scopePath = undefined;

  // Validate the target URL up front (fail clearly, not deep in the loop).
  const baseUrl = body.target?.baseUrl?.trim();
  if (!baseUrl) return Response.json({ error: "target.baseUrl is required" }, { status: 400 });
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return Response.json({ error: "target.baseUrl is not a valid URL" }, { status: 400 });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return Response.json({ error: "target.baseUrl must be http(s)" }, { status: 400 });
  }
  const openApiUrl = body.target?.openApiUrl?.trim();
  if (openApiUrl) {
    try {
      const o = new URL(openApiUrl);
      if (o.protocol !== "http:" && o.protocol !== "https:") throw new Error("scheme");
    } catch {
      return Response.json({ error: "target.openApiUrl must be a valid http(s) URL" }, { status: 400 });
    }
  }

  // The human must be able to read the scope the run's stream will be checked against:
  // the given scope, or the org root for a scope-less run, where its brief is stored
  // (GET /api/runs/:runId/stream). Refusing here, before the run exists, keeps a member
  // from starting a run they could never follow.
  const decision = await check(rc.ctx, { action: "memory.read", scope: scopePath ?? orgRootPath(rc.org.id) });
  if (!decision.allowed) {
    return Response.json({ error: `access denied: ${decision.reason}` }, { status: 403 });
  }

  const agentRow = await db.agent.findFirst({
    where: { id, orgId: rc.org.id, role: "qa" },
    select: { active: true, id: true },
  });
  if (!agentRow) return Response.json({ error: "QA agent not found" }, { status: 404 });
  if (!agentRow.active) return agentDeactivatedResponse();

  const runId = await createQaManagerRun({
    orgId: rc.org.id,
    agentId: agentRow.id,
    triggeredBy: rc.user.id,
    target: {
      baseUrl,
      allowedHosts: body.target?.allowedHosts,
      openApiUrl,
      authHeader: body.target?.authHeader,
    },
    focus: body.focus,
    mode: body.mode ?? "api",
    scopePath,
    stoppingMode: body.stoppingMode,
  });

  // Kick the manager in the BACKGROUND so the workspace tab opens instantly instead of
  // blocking on the fan-out + convergence loop. `after` keeps the function alive to run it
  // post-response; driveManager rebuilds from the DB and catches its own errors (flips to
  // failed + emits `error`), so the client sees progress — and any failure — on the stream.
  after(() => driveManager(runId));

  return Response.json({ runId }, { status: 201 });
}
