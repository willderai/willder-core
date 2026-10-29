// UC7 — the Architecture & Planning agent. A human triggers a plan bounded to a
// sub-scope they can read; the agent grounds an architecture + schedule in the
// confirmed decisions/constraints/system-design/UX/business-logic already in memory,
// and flags contradictions it finds among those facts. Same auth flow as the handoff
// route: verify the human can read the scope, mint a capability scoped to it (never
// wider), run the agent, persist a Brief. Same-tier contradictions surfaced by the run
// open fact_disputes rows (UC9) so the scope admin can resolve them.
import { db } from "@/lib/db";
import { requireAccessContext } from "@/lib/access-context";
import { AccessDeniedError, check, orgRootPath, resolveCallerScopePath, scopeIsAbsent } from "@/services/access";
import { provisionArchitectureAgentCapability } from "@/lib/architecture-agent";
import { runAndPersistArchitecturePlan } from "@/services/agents/architecture-run";
import { agentDeactivatedResponse } from "@/services/agents/agent-active";

/** POST /api/agents/[id]/architecture: generate an architecture plan bounded to a scope the caller can read. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = (await req.json()) as {
    scopePath?: unknown;
    title?: string;
    context?: string;
  };
  // scopePath is required on this route: a missing or blank one is a 400, not a
  // silently-unscoped run. Anything else sent goes to the resolver below, which
  // refuses a malformed or non-string value by name.
  const requestedScope = body.scopePath;
  if (scopeIsAbsent(requestedScope)) {
    return Response.json({ error: "scopePath is required" }, { status: 400 });
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

  // The human must be able to read the scope they're planning over — the agent's
  // capability can never grant more access than the human triggering it actually has.
  const decision = await check(rc.ctx, { action: "memory.read", scope: scopePath });
  if (!decision.allowed) {
    return Response.json({ error: `access denied: ${decision.reason}` }, { status: 403 });
  }

  const agentRow = await db.agent.findFirst({
    where: { id, orgId: rc.org.id, role: "architecture" },
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
  if (!agentRow) return Response.json({ error: "architecture agent not found" }, { status: 404 });
  if (!agentRow.active) return agentDeactivatedResponse();

  const capabilityToken = await provisionArchitectureAgentCapability(rc.org.id, scopePath, rc.user.id);

  const { brief, disputeIds } = await runAndPersistArchitecturePlan({
    agentRow,
    agentId: agentRow.id,
    orgId: rc.org.id,
    scopePath,
    capabilityToken,
    title: body.title,
    context: body.context,
  });

  return Response.json({ brief, disputeIds });
}
