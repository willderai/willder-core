// GET /api/audit: the paged audit log for the audit page and the Access page's Audit tab;
// access.manage only, and every row comes through services/access/audit-query's visibility
// rule, never a route-local query.
//
// Query: page, decision (allow|deny), scope, actorType + actorId, ids, q (search text, at
// most MAX_LIST_SEARCH_LENGTH characters), order (desc, the default, or asc), and from
// (inclusive) and to (exclusive), each an ISO date or a timestamp with a zone, either one
// optional. The search and the range, like every other filter, narrow the visible rows
// before the page and the counts are taken, so neither can include a row the log does not
// show.
import { NextResponse } from "next/server";
import { requireAccessContext } from "@/lib/access-context";
import { readTimeRangeParams } from "@/lib/date-range";
import { paramHoldingNul, readSearchParam } from "@/lib/list-search";
import { check } from "@/services/access";
import { queryAuditLog } from "@/services/access/audit-query";
import { changeIdsByAuthorizingRow } from "@/services/memory/change-history";
import { MAX_AUDIT_PAGE } from "@/lib/page-limits";
import { erasureCountsOf } from "@/services/audit/erasure-counts";
import { resolveUserNames, resolveActorNames, fallbackAgentName } from "@/services/audit/actor-names";

const PAGE_SIZE = 50;
/** How many rows one `?ids=` lookup may name. */
const MAX_IDS = 50;

export async function GET(req: Request) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { allowed } = await check(rc.ctx, { action: "access.manage", target: "audit:list" });
  if (!allowed) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const url = new URL(req.url);
  // No parameter can hold a NUL: Postgres refuses to bind one, which would turn a bad
  // request into a server error.
  const nul = paramHoldingNul(url.searchParams);
  if (nul !== null) return NextResponse.json({ error: `${nul} must not contain a NUL character` }, { status: 400 });
  const decisionFilter = url.searchParams.get("decision");
  const scopeFilter = url.searchParams.get("scope");
  const actorIdFilter = url.searchParams.get("actorId");
  const actorTypeFilter = url.searchParams.get("actorType");
  const page = Number(url.searchParams.get("page") ?? "1");
  if (!Number.isInteger(page) || page < 1 || page > MAX_AUDIT_PAGE) {
    return NextResponse.json({ error: `page must be a whole number from 1 to ${MAX_AUDIT_PAGE}` }, { status: 400 });
  }
  const searched = readSearchParam(url.searchParams);
  if ("error" in searched) return NextResponse.json({ error: searched.error }, { status: 400 });
  const { search } = searched;
  const order = url.searchParams.get("order") ?? "desc";
  if (order !== "asc" && order !== "desc") {
    return NextResponse.json({ error: "order must be asc or desc" }, { status: 400 });
  }
  const range = readTimeRangeParams(url.searchParams);
  if ("error" in range) return NextResponse.json({ error: range.error }, { status: 400 });
  // `?ids=a,b,c`: exactly these rows, for a caller that already holds the ids and cannot
  // reach them by paging -- a change authorized by a row older than the window being read,
  // which a connector sync's connect row usually is. It only narrows: the visibility rule
  // and the scope filter below still decide whether each named row may be shown. Bounded
  // so one request cannot ask for the whole log by listing it.
  const idsParam = url.searchParams.get("ids");
  const ids =
    idsParam === null
      ? null
      : idsParam
          .split(",")
          .map((id) => id.trim())
          .filter((id) => id !== "")
          .slice(0, MAX_IDS);

  // Identity-picker filter: actorId alone is not a unique
  // identity. A human User.id and an agent capability agentKey/agentId
  // are not guaranteed disjoint namespaces, so filtering on actorId alone
  // could cross-match a human and an agent that happen to share the same
  // id string. Only apply the filter once both halves of the composite
  // key are present; an actorId with no actorType (a stale link, a
  // hand-typed query string) is treated as no filter at all rather than
  // silently matching every actorType for that id. Presence, not
  // truthiness: actorId="" is a real persisted identity (agentContextFromRuntime
  // leaves it "" when a caller has no identity), so a falsy-but-present
  // value must still apply as a filter, not be treated as absent.
  const filters = {
    orgId: rc.org.id,
    scope: scopeFilter,
    actorId: actorIdFilter !== null && actorTypeFilter !== null ? actorIdFilter : null,
    actorType: actorIdFilter !== null && actorTypeFilter !== null ? actorTypeFilter : null,
    ids,
    search: search || null,
    range,
  };
  // The summary's allowed and denied counts cover every page and ignore the
  // decision filter, so the screen never sets a page-scoped zero beside an
  // all-pages total: a "Denied 0" that only means "none on this page" reads to
  // an admin as "no denials".
  const { total, counts, entries } = await queryAuditLog({
    ...filters,
    decision: decisionFilter,
    order,
    page,
    pageSize: PAGE_SIZE,
  });

  // Collect all user IDs to resolve: human actors + agent triggeredBy from metadata.
  const humanActorIds = entries.filter((e) => e.actorType === "human").map((e) => e.actorId);
  const triggeredByIds = entries
    .map((e) => (e.metadata as Record<string, string> | null)?.triggeredBy)
    .filter((id): id is string => !!id);
  const allUserIds = [...new Set([...humanActorIds, ...triggeredByIds])];
  const userNames = await resolveUserNames(allUserIds);

  // Resolve agent actorIds to display names from the agents table.
  const agentActorIds = [...new Set(entries.filter((e) => e.actorType === "agent").map((e) => e.actorId))];
  const agentNames = await resolveActorNames(rc.org.id, agentActorIds);

  // The changes each `memory.write`/`memory.delete` authorization on this page produced.
  // The confirmed-applied rows that record a landed write carry `visibility: "never"`
  // (services/audit/audit-actions.ts), so this is the only place the visible log says
  // which change a row belongs to.
  const changeIds = await changeIdsByAuthorizingRow(
    rc.org.id,
    entries.map((e) => e.id),
  );

  const shaped = entries.map((e) => {
    const meta = (e.metadata as Record<string, string> | null) ?? {};
    const triggeredBy = meta.triggeredBy ? (userNames[meta.triggeredBy] ?? meta.triggeredBy) : undefined;
    const actorName =
      e.actorType === "human"
        ? (userNames[e.actorId] ?? e.actorId)
        : (agentNames[e.actorId] ?? fallbackAgentName(e.actorId));
    return {
      id: e.id,
      actorType: e.actorType,
      actorName,
      triggeredBy,
      action: e.action,
      target: e.target,
      decision: e.decision,
      reason: e.reason,
      // Present on rows written for a capability token (an agent's decision on
      // its own live token, or a refused revoked or expired token), so the row
      // walks back to its token on the Tokens tab.
      capabilityId: typeof meta.capabilityId === "string" ? meta.capabilityId : undefined,
      // The change-feed events this authorization produced, oldest first. Empty on a read,
      // a denial, a write that never landed, and on rows written before change events
      // carried their authorization; two entries for a correction, which supersedes one
      // version and writes another under one decision.
      changeIds: changeIds.get(e.id) ?? [],
      // A person erasure's per-store counts, so the row proves what the request
      // removed without naming anything it removed.
      ...(e.action === "person.erased" ? { erasureCounts: erasureCountsOf(e.metadata) } : {}),
      at: e.at,
    };
  });

  return NextResponse.json({
    entries: shaped,
    total,
    counts,
    page,
    pageSize: PAGE_SIZE,
    totalPages: Math.ceil(total / PAGE_SIZE),
  });
}
