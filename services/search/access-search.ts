// Text search across one org's access surfaces: scopes, agents, capability
// tokens, connected sources and audit rows. It backs the sidebar search box and
// the Audit tab's search on the Access page.
//
// The one rule this file enforces: every query, including the lookups that turn
// a typed name into actor ids, is pinned to the caller's org. Deciding WHETHER
// the caller may search a kind at all is the route's job (GET
// /api/access/search runs the same check() each kind's own list route runs);
// this module only answers "which rows of this org match".
import type { Prisma } from "@/lib/generated/prisma/client";
import { db } from "@/lib/db";
import { resolveUserNames, resolveActorNames, fallbackAgentName } from "@/services/audit/actor-names";
import { isVisibleAuditRow } from "@/services/audit/visibility";

export const SEARCH_KINDS = ["scopes", "agents", "tokens", "sources", "audit"] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

export const MIN_QUERY_LENGTH = 2;
export const MAX_QUERY_LENGTH = 100;

export type ScopeHit = { id: string; name: string; path: string };
export type AgentHit = { id: string; name: string; agentKey: string };
export type TokenHit = {
  id: string;
  agentId: string;
  scopePath: string;
  permission: string;
  /** `deactivated`: live, but issued to an agent that has been switched off, so check() refuses it. */
  status: "active" | "revoked" | "expired" | "deactivated";
};
export type SourceHit = { id: string; name: string; type: string; status: string };
export type AuditHit = {
  id: string;
  actorType: string;
  actorName: string;
  action: string;
  target: string | null;
  decision: "allow" | "deny";
  reason: string | null;
  capabilityId?: string;
  at: Date;
};

/** One kind's matches, newest or best first. `hasMore` means rows past `limit`
 * exist (or, for audit, may exist past the scan bound), so a screen can say
 * "5+" instead of a bare 5 that reads as the total. */
export type Hits<T> = { items: T[]; hasMore: boolean };

/**
 * Prisma's `contains` compiles to `LIKE '%' || value || '%'` without escaping
 * the value, so a typed `_` or `%` would act as a wildcard. Postgres' default
 * LIKE escape character is the backslash, so escaping here keeps the search a
 * literal substring match. This never widens past the org: every query below
 * also pins `orgId` by equality.
 */
function likeLiteral(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function containsText(q: string) {
  return { contains: likeLiteral(q), mode: "insensitive" as const };
}

/** Takes `limit + 1` rows and reports whether the extra one existed. */
function toHits<T>(rows: T[], limit: number): Hits<T> {
  return { items: rows.slice(0, limit), hasMore: rows.length > limit };
}

export async function searchScopes(orgId: string, q: string, limit: number): Promise<Hits<ScopeHit>> {
  const rows = await db.scope.findMany({
    where: { orgId, OR: [{ name: containsText(q) }, { path: containsText(q) }] },
    orderBy: { path: "asc" },
    take: limit + 1,
    select: { id: true, name: true, path: true },
  });
  return toHits(rows, limit);
}

export async function searchAgents(orgId: string, q: string, limit: number): Promise<Hits<AgentHit>> {
  const rows = await db.agent.findMany({
    where: { orgId, OR: [{ name: containsText(q) }, { agentKey: containsText(q) }] },
    orderBy: { name: "asc" },
    take: limit + 1,
    select: { id: true, name: true, agentKey: true },
  });
  return toHits(rows, limit);
}

/**
 * Tokens match on their id (the Tokens tab shows its last eight characters, so a
 * short id pasted from there finds the token), the agent they were issued to,
 * and their scope, by path or by that scope's display name. A token's status is
 * the first reason check() would refuse it, or `active` when it would not.
 */
export async function searchTokens(orgId: string, q: string, limit: number): Promise<Hits<TokenHit>> {
  const namedScopes = await db.scope.findMany({
    where: { orgId, name: containsText(q) },
    select: { path: true },
  });
  const rows = await db.capability.findMany({
    where: {
      orgId,
      OR: [
        { id: containsText(q) },
        { agentId: containsText(q) },
        { scopePath: containsText(q) },
        { scopePath: { in: namedScopes.map((s) => s.path) } },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    select: { id: true, agentId: true, scopePath: true, permission: true, expiresAt: true, revokedAt: true },
  });
  // A capability names its agent by key, or by database id for an older token.
  const agentIds = [...new Set(rows.map((c) => c.agentId))];
  const deactivatedAgents = await db.agent.findMany({
    where: { orgId, active: false, OR: [{ agentKey: { in: agentIds } }, { id: { in: agentIds } }] },
    select: { id: true, agentKey: true },
  });
  const deactivated = new Set(deactivatedAgents.flatMap((a) => [a.id, a.agentKey]));
  const now = new Date();
  return toHits(
    rows.map((c) => ({
      id: c.id,
      agentId: c.agentId,
      scopePath: c.scopePath,
      permission: c.permission,
      status: c.revokedAt
        ? "revoked"
        : c.expiresAt < now
          ? "expired"
          : deactivated.has(c.agentId)
            ? "deactivated"
            : "active",
    })),
    limit,
  );
}

export async function searchSources(orgId: string, q: string, limit: number): Promise<Hits<SourceHit>> {
  const rows = await db.source.findMany({
    where: { orgId, OR: [{ name: containsText(q) }, { externalId: containsText(q) }] },
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    select: { id: true, name: true, type: true, status: true },
  });
  return toHits(rows, limit);
}

/** Rows read per batch while filtering audit matches for visibility. */
const AUDIT_BATCH = 200;
/** Batches read before the scan stops and reports `hasMore`, so one search
 * never walks an org's whole audit history. */
const AUDIT_MAX_BATCHES = 5;

/**
 * Audit rows whose action, target, reason, actor or token match `q`, newest
 * first, limited to the rows every audit screen shows (isVisibleAuditRow).
 *
 * An actor matches by display name: `q` is first resolved to the user ids and
 * agent keys of THIS org whose name matches. Agent keys are unique only within
 * an org ("research-agent" exists in every org), so resolving a name without
 * the org pin would turn another org's agent name into this org's rows.
 */
export async function searchAudit(
  orgId: string,
  q: string,
  limit: number,
  decision?: "allow" | "deny",
): Promise<Hits<AuditHit>> {
  const [users, agents] = await Promise.all([
    db.user.findMany({
      where: { orgId, OR: [{ name: containsText(q) }, { email: containsText(q) }] },
      select: { id: true },
    }),
    db.agent.findMany({
      where: { orgId, name: containsText(q) },
      select: { agentKey: true },
    }),
  ]);
  const actorIds = [...users.map((u) => u.id), ...agents.map((a) => a.agentKey)];

  const where: Prisma.AuditLogWhereInput = {
    orgId,
    ...(decision ? { decision } : {}),
    OR: [
      { action: containsText(q) },
      { target: containsText(q) },
      { reason: containsText(q) },
      { actorId: containsText(q) },
      { actorId: { in: actorIds } },
      // Capability ids are lowercase cuids; JSON path filters have no
      // case-insensitive mode, so the query is lowered instead.
      { metadata: { path: ["capabilityId"], string_contains: q.toLowerCase() } },
    ],
  };

  const visible: Awaited<ReturnType<typeof readAuditBatch>> = [];
  let scanCut = false;
  for (let batch = 0; visible.length <= limit; batch++) {
    if (batch === AUDIT_MAX_BATCHES) {
      scanCut = true;
      break;
    }
    const rows = await readAuditBatch(where, batch);
    visible.push(...rows.filter((r) => isVisibleAuditRow(r.action, r.target, r.decision)));
    if (rows.length < AUDIT_BATCH) break;
  }

  const page = visible.slice(0, limit);
  return {
    items: await withActorNames(orgId, page),
    hasMore: scanCut || visible.length > limit,
  };
}

function readAuditBatch(where: Prisma.AuditLogWhereInput, batch: number) {
  return db.auditLog.findMany({
    where,
    orderBy: [{ at: "desc" }, { id: "desc" }],
    skip: batch * AUDIT_BATCH,
    take: AUDIT_BATCH,
    select: {
      id: true,
      actorType: true,
      actorId: true,
      action: true,
      target: true,
      decision: true,
      reason: true,
      metadata: true,
      at: true,
    },
  });
}

/** Display names exactly as GET /api/audit renders them. */
async function withActorNames(orgId: string, rows: Awaited<ReturnType<typeof readAuditBatch>>): Promise<AuditHit[]> {
  const humanIds = [...new Set(rows.filter((r) => r.actorType === "human").map((r) => r.actorId))];
  const agentKeys = [...new Set(rows.filter((r) => r.actorType === "agent").map((r) => r.actorId))];
  const [userNames, agentNames] = await Promise.all([resolveUserNames(humanIds), resolveActorNames(orgId, agentKeys)]);
  return rows.map((r) => {
    const meta = (r.metadata as Record<string, unknown> | null) ?? {};
    return {
      id: r.id,
      actorType: r.actorType,
      actorName:
        r.actorType === "human"
          ? (userNames[r.actorId] ?? r.actorId)
          : (agentNames[r.actorId] ?? fallbackAgentName(r.actorId)),
      action: r.action,
      target: r.target,
      decision: r.decision,
      reason: r.reason,
      capabilityId: typeof meta.capabilityId === "string" ? meta.capabilityId : undefined,
      at: r.at,
    };
  });
}
