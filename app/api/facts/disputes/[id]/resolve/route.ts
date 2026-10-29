// UC9 — resolve a fact dispute (scope-admin authority). Approves one side or enters a
// reconciled value, stamping the resolver. This updates the governance state (app-state
// over the graph); the graph-side effect of a resolution (invalidating the losing edge /
// writing the reconciled value into Neo4j) is NOT wired here yet — see the state/decisions
// log. The dispute row is the audit-of-record either way.
import { requireAccessContext } from "@/lib/access-context";
import { bodyTypeRefusal } from "@/lib/json-type-name";
import { isHiddenFrom } from "@/lib/hidden-record";
import { authorizeFactDispute, resolveFactDispute } from "@/services/memory/fact-disputes";
import type { FactDisputeStatus } from "@/lib/generated/prisma/client";

const STATUS_BY_RESOLUTION: Record<string, FactDisputeStatus> = {
  proposer: "resolved_proposer",
  existing: "resolved_existing",
  reconciled: "resolved_reconciled",
};

// A dispute at a scope the caller cannot read answers like an absent one
// (lib/hidden-record.ts).
function disputeNotFound(): Response {
  return Response.json({ error: "dispute not found" }, { status: 404 });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;

  let body: { resolution?: string; value?: string };
  try {
    body = (await req.json()) as { resolution?: string; value?: string };
  } catch {
    return Response.json({ error: "invalid json body" }, { status: 400 });
  }
  const wrongType = bodyTypeRefusal(body, ["resolution", "value"]);
  if (wrongType) return Response.json({ error: wrongType }, { status: 400 });
  // Own keys only: "constructor" or "toString" would otherwise read Object.prototype's
  // function as a status and reach the write.
  const status =
    body.resolution && Object.hasOwn(STATUS_BY_RESOLUTION, body.resolution)
      ? STATUS_BY_RESOLUTION[body.resolution]
      : undefined;
  if (!status) {
    return Response.json({ error: "resolution must be one of: proposer, existing, reconciled" }, { status: 400 });
  }
  if (status === "resolved_reconciled" && !body.value?.trim()) {
    return Response.json({ error: "value is required for a reconciled resolution" }, { status: 400 });
  }

  // Authority: admin (access.manage) on the fact's scope, per the scope-admin rule.
  // Decided before the status check, so a 409 cannot report on a hidden dispute.
  // A missing id is probed for read like a refused one, so the two 404s cost the same.
  const access = await authorizeFactDispute(rc.ctx, id);
  if (access.status !== "allowed") {
    const hidden = await isHiddenFrom(rc.ctx, access.scopePath);
    if (access.status === "missing" || hidden) return disputeNotFound();
    return Response.json({ error: `access denied: ${access.decision.reason}` }, { status: 403 });
  }
  if (access.dispute.status !== "disputed") {
    return Response.json({ error: "dispute is already resolved" }, { status: 409 });
  }

  const updated = await resolveFactDispute(access, {
    status,
    resolvedValue: status === "resolved_reconciled" ? body.value!.trim() : null,
    resolverId: rc.user.id,
  });

  return Response.json({ dispute: updated });
}
