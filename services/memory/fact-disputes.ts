// UC9 fact-dispute persistence (docs/willder_conflict_resolution.md): the `fact_disputes`
// table, the app-state that sits above the Graphiti graph and tracks a disputed edge's
// governance state. Only the same-tier-contradiction case creates rows here; the
// auto-merge case invalidates-and-appends in Neo4j directly.
//
// The rule this file enforces: a dispute is shown or resolved only to a caller check()
// allows `access.manage` on the disputed fact's scope, the scope-admin rule. Routes call
// these functions rather than querying `fact_disputes` themselves.
import { db } from "@/lib/db";
import type { FactDispute, FactDisputeStatus } from "@/lib/generated/prisma/client";
import { check, orgRootPath, type AccessContext, type AccessDecision } from "@/services/access";
import type { ActorType } from "@/types/memory";
import { keepServedAnchors } from "./raw-rows";

export interface OpenDisputeInput {
  orgId: string;
  scopePath: string;
  /** The disputed Graphiti RELATES_TO edge uuid (the existing/confirmed fact). */
  graphitiFactUuid: string;
  /** The proposing side's edge uuid, when it is a real graph edge. */
  proposerFactUuid?: string;
  proposerActorType: ActorType;
  proposerActorId: string;
  existingActorType: ActorType;
  existingActorId: string;
}

/** Open a fact dispute (status `disputed`). Idempotency is intentionally NOT enforced —
 *  a fresh assertion contradicting the same edge is a new PR each time. */
export async function openFactDispute(input: OpenDisputeInput) {
  return db.factDispute.create({ data: { ...input, status: "disputed" } });
}

/**
 * Every open dispute in the caller's org that the caller may resolve, newest
 * first. Authority is decided once per distinct scope (each decision audited),
 * so a scope admin sees only their own scopes' disputes, not the whole org's.
 *
 * On a tier whose reads do not include the graph, a dispute anchored on a graph edge is
 * not listed, since the edge is not served either; one anchored on a raw row is.
 */
export async function listResolvableFactDisputes(ctx: AccessContext): Promise<FactDispute[]> {
  const rows = await keepServedAnchors(
    ctx.orgId,
    await db.factDispute.findMany({
      where: { orgId: ctx.orgId, status: "disputed" },
      orderBy: { createdAt: "desc" },
    }),
  );
  const scopes = [...new Set(rows.map((r) => r.scopePath))];
  const allowed = new Set<string>();
  await Promise.all(
    scopes.map(async (scope) => {
      const decision = await check(ctx, { action: "access.manage", scope, target: "fact_disputes" });
      if (decision.allowed) allowed.add(scope);
    }),
  );
  return rows.filter((r) => allowed.has(r.scopePath));
}

/**
 * The outcome of {@link authorizeFactDispute}: no such dispute in the caller's
 * org, a refusal (with the dispute's scope, which the caller must not return),
 * or the dispute the caller may resolve. `missing` carries the scope it was
 * decided at too, so a route can answer it with the same work as a refusal.
 */
export type FactDisputeAccess =
  | { status: "missing"; scopePath: string; decision: AccessDecision }
  | { status: "denied"; scopePath: string; decision: AccessDecision }
  | { status: "allowed"; dispute: FactDispute };

/**
 * Load dispute `disputeId` in the caller's org and decide `access.manage` on its scope.
 *
 * An id with no dispute is decided at the org root, so it costs the same grant
 * evaluation and audit write as a dispute the caller may not resolve; without it
 * an absent id answered sooner and could be timed to find real disputes
 * (app/api/existence-timing.realdb.test.ts).
 */
export async function authorizeFactDispute(ctx: AccessContext, disputeId: string): Promise<FactDisputeAccess> {
  const dispute = await db.factDispute.findFirst({ where: { id: disputeId, orgId: ctx.orgId } });
  const scopePath = dispute?.scopePath ?? orgRootPath(ctx.orgId);
  const decision = await check(ctx, {
    action: "access.manage",
    scope: scopePath,
    target: `fact_dispute:${disputeId}`,
  });
  if (!dispute) return { status: "missing", scopePath, decision };
  return decision.allowed ? { status: "allowed", dispute } : { status: "denied", scopePath, decision };
}

/** Record the resolution of a dispute {@link authorizeFactDispute} allowed. */
export async function resolveFactDispute(
  allowed: Extract<FactDisputeAccess, { status: "allowed" }>,
  resolution: { status: FactDisputeStatus; resolvedValue: string | null; resolverId: string },
): Promise<FactDispute> {
  return db.factDispute.update({
    where: { id: allowed.dispute.id },
    data: { ...resolution, resolvedAt: new Date() },
  });
}
