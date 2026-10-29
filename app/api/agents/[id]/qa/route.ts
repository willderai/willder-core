// UC8 — the QA agent. A human points it at a running product (an API base URL, or a
// web app to drive in a browser) and it black-box tests it: probes for bugs,
// measures observed performance, and reports suggestions. The target itself is the
// product under test, not memory. An OPTIONAL memory scope lets the agent check the
// product against stored specs/acceptance criteria — when given, the same access rule as
// the other agents applies (the human must be able to read that scope, and the agent's
// capability is minted from, never wider than, that grant). With no scope it's a pure
// black-box run against the URL.
import { db } from "@/lib/db";
import { requireAccessContext } from "@/lib/access-context";
import { bodyTypeRefusal } from "@/lib/json-type-name";
import { check, isMintableScopePath, normalizeScopePath } from "@/services/access";
import { provisionQaAgentCapability } from "@/lib/qa-agent";
import { runAndPersistQaReview } from "@/services/agents/qa-run";
import { agentDeactivatedResponse } from "@/services/agents/agent-active";

/** POST /api/agents/[id]/qa: run a one-shot QA review of a target URL, optionally grounded in a readable scope. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  let body: {
    scopePath?: unknown;
    target?: {
      baseUrl?: string;
      allowedHosts?: string[];
      openApiUrl?: string;
      authHeader?: string;
    };
    focus?: string;
    mode?: "api" | "browser";
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
  ]);
  if (wrongType) return Response.json({ error: wrongType }, { status: 400 });
  // Empty/whitespace scopePath collapses to undefined so it can never silently
  // skip the check() gate below nor survive downstream past a
  // `scopePath ?? orgRootPath(...)` write as a non-ltree value. A non-empty but
  // malformed or dashed scopePath (fails isMintableScopePath: the run stores briefs at it) is likewise discarded rather
  // than reaching check()'s `::ltree` cast raw. This is the read direction (an
  // optional grounding scope), so falling back to no scope is safe: it can only
  // narrow what the run consults, never widen it.
  let scopePath = normalizeScopePath(body.scopePath);
  if (scopePath && !isMintableScopePath(scopePath)) scopePath = undefined;

  // Validate the target URL up front so we fail with a clear message, not deep in the agent.
  const baseUrl = body.target?.baseUrl?.trim();
  if (!baseUrl) {
    return Response.json({ error: "target.baseUrl is required" }, { status: 400 });
  }
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

  // Optional memory grounding: only when a scope is supplied does access control apply — the
  // human must be able to read it, and the agent's capability is bounded to exactly it.
  // Decided before the agent lookup, so a refused caller cannot learn whether it exists.
  if (scopePath) {
    const decision = await check(rc.ctx, { action: "memory.read", scope: scopePath });
    if (!decision.allowed) {
      return Response.json({ error: `access denied: ${decision.reason}` }, { status: 403 });
    }
  }

  const agentRow = await db.agent.findFirst({
    where: { id, orgId: rc.org.id, role: "qa" },
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
  if (!agentRow) return Response.json({ error: "QA agent not found" }, { status: 404 });
  if (!agentRow.active) return agentDeactivatedResponse();

  const capabilityToken = scopePath ? await provisionQaAgentCapability(rc.org.id, scopePath, rc.user.id) : undefined;

  try {
    const { brief, report } = await runAndPersistQaReview({
      agentRow,
      agentId: agentRow.id,
      orgId: rc.org.id,
      scopePath,
      capabilityToken,
      target: {
        baseUrl,
        allowedHosts: body.target?.allowedHosts,
        openApiUrl,
        authHeader: body.target?.authHeader,
      },
      focus: body.focus,
      mode: body.mode ?? "api",
    });
    return Response.json({ brief, report });
  } catch (e) {
    // Don't leak internal fetch errors / hostnames to the client; log server-side.
    console.error("QA run failed:", e);
    return Response.json({ error: "QA run failed" }, { status: 500 });
  }
}
