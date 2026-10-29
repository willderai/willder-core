// UC6. A human grants a contractor/freelancer/new hire scoped access
// to a sub-scope, then triggers the Handoff agent to generate a briefing bounded to
// exactly that scope. The route verifies the caller can read the scope, mints a
// capability for the Handoff agent scoped to it (never wider), runs the agent, and
// persists the result as a Brief.
import { db } from "@/lib/db";
import { createBrief } from "@/services/memory/create-brief";
import { requireAccessContext } from "@/lib/access-context";
import { AccessDeniedError, check, orgRootPath, resolveCallerScopePath, scopeIsAbsent } from "@/services/access";
import { provisionHandoffAgentCapability } from "@/lib/handoff-agent";
import {
  runHandoffAgent,
  drawioLinkFromMermaid,
  type HandoffAgentOptions,
  type HandoffBrief,
} from "@/services/agents/runner";
import type { BriefCitationInput } from "@/services/memory/brief-citations";
import { handoffManagerEnabled, runHandoffManager } from "@/services/agents/manager-handoff";
import { deriveHandoffCharts } from "@/services/agents/derive-artifacts";
import { recordArtifactUsage } from "@/services/billing";
import { agentDeactivatedResponse } from "@/services/agents/agent-active";

/** POST /api/agents/[id]/handoff: generate a handoff brief bounded to a scope the caller can read. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = (await req.json()) as {
    scopePath?: unknown;
    granteeName?: string;
    granteeRole?: string;
    context?: string;
    fanOut?: boolean;
  };
  // scopePath is required on this route: a missing or blank one is a 400, not a
  // silently-unscoped run. Anything else sent goes to the resolver below, which
  // refuses a malformed or non-string value by name.
  const requestedScope = body.scopePath;
  if (scopeIsAbsent(requestedScope) || !body.granteeName) {
    return Response.json({ error: "scopePath and granteeName are required" }, { status: 400 });
  }

  // A malformed scopePath must never reach check()'s `::ltree` cast raw. This route
  // mints a capability and persists scopePath onto the Brief, so there is no safe
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

  // The human must be able to read the scope they're briefing on — a capability can
  // never grant the agent more access than the human triggering it actually has.
  const decision = await check(rc.ctx, { action: "memory.read", scope: scopePath });
  if (!decision.allowed) {
    return Response.json({ error: `access denied: ${decision.reason}` }, { status: 403 });
  }

  const agentRow = await db.agent.findFirst({
    where: { id, orgId: rc.org.id, role: "handoff" },
    select: {
      active: true,
      id: true,
      agentKey: true,
      name: true,
      role: true,
      model: true,
      systemPrompt: true,
      tools: true,
      settings: true,
    },
  });
  if (!agentRow) return Response.json({ error: "handoff agent not found" }, { status: 404 });
  if (!agentRow.active) return agentDeactivatedResponse();

  const capabilityToken = await provisionHandoffAgentCapability(rc.org.id, scopePath, rc.user.id);

  // Captured before generation starts, not after — GET /api/briefs/:id/staleness
  // uses Brief.createdAt as its lower bound for "did anything change since this
  // was generated", and the agent run below can take real wall-clock time. A
  // write landing after this point but before db.brief.create() below still
  // reflects the true generation window; letting Prisma's own @default(now())
  // stamp createdAt at INSERT time instead would silently exclude exactly that
  // write.
  const generationStartedAt = new Date();

  // Fan-out is opt-in (request flag) AND flag-gated (HANDOFF_MANAGER). Off/unchecked ⇒ the
  // single-agent path. Both return a HandoffBrief, persisted + metered once.
  const usesManager = Boolean(body.fanOut && handoffManagerEnabled());
  // Only the single-agent path records which retrieved facts each section cites; a
  // fanned-out brief is stored without citations.
  const runHandoff: (opts: HandoffAgentOptions) => Promise<HandoffBrief & { citations?: BriefCitationInput[] }> =
    usesManager ? runHandoffManager : runHandoffAgent;
  const sourcesRead = new Set<string>();
  const result = await runHandoff({
    agentRow,
    granteeName: body.granteeName,
    granteeRole: body.granteeRole,
    context: body.context,
    orgId: rc.org.id,
    capabilityToken,
    memoryScope: scopePath,
    sourcesRead,
  });

  const brief = await createBrief(
    {
      orgId: rc.org.id,
      // Persisted at generation time so the completion receipt survives a reload
      // instead of degrading to "Backend: Unknown".
      backend: usesManager ? "manager" : "single",
      type: "handoff",
      granteeName: body.granteeName,
      granteeRole: body.granteeRole,
      scopePath,
      title: result.title,
      summary: result.summary,
      sections: result.sections,
      diagram: result.diagram ?? null,
      diagramUrl: result.diagram ? drawioLinkFromMermaid(result.diagram) : null,
      charts: deriveHandoffCharts(result) as unknown as object,
      createdAt: generationStartedAt,
    },
    { actorType: "agent", actorId: agentRow.id, origin: "agent-run" },
    result.citations ?? [],
    sourcesRead,
  );

  // Meter the accepted artifact. Best-effort; never throws.
  await recordArtifactUsage({
    orgId: rc.org.id,
    artifactType: "handoff",
    briefId: brief.id,
    scopePath,
    actorId: rc.user.id,
  });

  return Response.json({ brief });
}
