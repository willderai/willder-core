// Reading a brief: the lookup and the access decision in one call.
//
// A brief is a copy of memory: the sections an agent wrote from what it read at
// the brief's scope. The rule this file enforces: no caller outside the
// authorizer gets a brief row without check() having decided the requested
// action on the brief's own scope. Routes, pages and MCP tools call these
// functions instead of querying `briefs` themselves, and the memory-access lint
// gate (eslint.memory-access.mjs) refuses a `briefs` query anywhere else.

import { db } from "@/lib/db";
import type { Brief } from "@/lib/generated/prisma/client";
import {
  check,
  isValidLtreePath,
  orgRootPath,
  type AccessAction,
  type AccessContext,
  type AccessDecision,
} from "@/services/access";
import { NOT_RETIRED } from "./brief-retirement";

/**
 * The outcome of {@link authorizeBrief}.
 *
 * - `missing`: no brief with this id in the caller's org, or it was withdrawn
 *   and the caller did not ask for withdrawn briefs. A decision was still made,
 *   at `scopePath`; see {@link authorizeBrief} for why.
 * - `denied`: the brief exists and check() refused. `scopePath` is the scope
 *   the decision was made at (the brief's own, or the org root when the stored
 *   value is not a scope path), so a write route can tell a reader from a
 *   stranger; the caller must not return it.
 * - `allowed`: the brief, and the decision that allowed it.
 */
export type BriefAccess =
  | { status: "missing"; scopePath: string; decision: AccessDecision }
  | { status: "denied"; scopePath: string; decision: AccessDecision }
  | { status: "allowed"; brief: Brief; decision: AccessDecision };

/**
 * Load the brief `briefId` in the caller's org and decide `action` on its scope.
 *
 * The decision is made against the brief's OWN `scopePath`, never a scope the
 * caller supplied, so the audit row names the scope the content came from. A
 * stored scope that is not a valid path is decided at the org root instead of
 * crashing check()'s ltree cast: an org-root reader still reads it, anyone
 * narrower is refused.
 *
 * An id with no brief is decided too, at `request.absentScope`, with the id as
 * the audit target. A refusal must not reveal whether the brief exists, and that includes
 * how long it takes: without the decision an absent id answered in about a
 * quarter of the time a hidden brief did, which let a caller time the 404 to
 * find real ids at scopes they cannot read. The decision does the same grant
 * evaluation and audit write a hidden brief costs, and the row it leaves
 * records the probe.
 *
 * @param request.target the audit target suffix, as check() takes it.
 * @param request.includeWithdrawn also find a brief a source has withdrawn; only
 *   callers that must authorize a withdrawn brief's scope need it.
 * @param request.absentScope the scope to decide at when no brief has this id;
 *   the org root unless the caller has a narrower scope of its own to check.
 * @param request.decidedAt a check() decision this request already made for
 *   the same action, and the scope it was made at. When the brief sits at exactly
 *   that scope the decision is reused rather than made again, so one read leaves
 *   one audit row, not two.
 */
export async function authorizeBrief(
  ctx: AccessContext,
  briefId: string,
  request: {
    action: AccessAction;
    target?: string;
    includeWithdrawn?: boolean;
    absentScope?: string;
    decidedAt?: { scope: string; decision: AccessDecision };
  },
): Promise<BriefAccess> {
  const brief = await db.brief.findFirst({
    where: { id: briefId, orgId: ctx.orgId, ...(request.includeWithdrawn ? {} : NOT_RETIRED) },
  });
  const scope = brief
    ? isValidLtreePath(brief.scopePath)
      ? brief.scopePath
      : orgRootPath(ctx.orgId)
    : (request.absentScope ?? orgRootPath(ctx.orgId));
  const target = brief ? request.target : (request.target ?? `brief:${briefId}`);
  const decision =
    request.decidedAt?.scope === scope
      ? request.decidedAt.decision
      : await check(ctx, { action: request.action, scope, target });
  if (!brief) return { status: "missing", scopePath: scope, decision };
  return decision.allowed ? { status: "allowed", brief, decision } : { status: "denied", scopePath: scope, decision };
}

/**
 * The newest readable brief generated for exactly `scopePath`, after check()
 * allows `memory.read` there. Returns the decision either way; `brief` is null
 * when the read was refused or no brief exists.
 */
export async function latestBriefAtScope(
  ctx: AccessContext,
  scopePath: string,
): Promise<{ decision: AccessDecision; brief: Brief | null }> {
  const decision = await check(ctx, { action: "memory.read", scope: scopePath });
  if (!decision.allowed) return { decision, brief: null };
  const brief = await db.brief.findFirst({
    where: { orgId: ctx.orgId, scopePath, ...NOT_RETIRED },
    orderBy: { createdAt: "desc" },
  });
  return { decision, brief };
}

/**
 * Record the Google Doc a readable brief was exported to. The caller has
 * already been allowed `memory.read` on the brief by {@link authorizeBrief}.
 */
export async function recordBriefExport(
  allowed: Extract<BriefAccess, { status: "allowed" }>,
  googleDocUrl: string,
): Promise<void> {
  await db.brief.update({ where: { id: allowed.brief.id }, data: { googleDocUrl } });
}
