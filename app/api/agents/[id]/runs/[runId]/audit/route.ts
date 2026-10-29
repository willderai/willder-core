// GET /api/agents/[id]/runs/[runId]/audit: the audit rows one run produced, a page at a time; admin-only
// (access.manage), and a trail that might contain another agent's reads is withheld.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAccessContext } from "@/lib/access-context";
import { check } from "@/services/access";
import { COPY_AGENT_ID } from "@/lib/copy-agent";
import { queryRunAuditEntries } from "@/services/access/audit-query";
import { RUN_TRAIL_PAGE_SIZE } from "@/lib/agent-lists";
import { encodeListCursor, parseListCursor } from "@/lib/list-cursor";

function runMetaOf(meta: unknown): Record<string, unknown> | undefined {
  return meta != null && typeof meta === "object" && !Array.isArray(meta)
    ? (meta as Record<string, unknown>)
    : undefined;
}

// The actorId a given run is really audited under. Mirrors runCopyAgent's
// (lib/copy-agent.ts) and runResearchAgent's (services/agents/runner.ts)
// hardcoded stamping so this route can query for what a run actually wrote,
// not what its own role/agentKey would naively suggest:
//   - a "custom" agent's run always goes through runCopyAgent -> COPY_AGENT_ID,
//     never its own "custom-<ts>" agentKey.
//   - any OTHER role's test-run (POST /api/agents/:id/run, meta.type ===
//     "test-run") also goes through runCopyAgent -> COPY_AGENT_ID -- EXCEPT
//     "research", whose test-run path (POST .../research) calls
//     runResearchAgent instead, which always stamps RESEARCH_AGENT_ID.
//   - anything else (a real campaign/enrichment-triggered run, or the
//     builtin copy-role agent itself, whose own agentKey already IS
//     COPY_AGENT_ID) resolves to the agent's own agentKey.
function resolveActorId(role: string, agentKey: string, meta: unknown): string {
  const isTestRun = runMetaOf(meta)?.type === "test-run";
  return role === "custom" || (role !== "research" && isTestRun) ? COPY_AGENT_ID : agentKey;
}

/**
 * The memory.read/memory.write audit_log entries this specific run produced (its
 * agent's actorId, scoped to the run's own startedAt/finishedAt window). Read-only
 * presentation over data check()/GuardedMemoryStore records; never touches the
 * enforcement path or audit_log's shape. Same admin gate as /api/audit, since this
 * surfaces the same class of access data, pre-filtered.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string; runId: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { allowed } = await check(rc.ctx, { action: "access.manage", target: "audit:run" });
  if (!allowed) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id, runId } = await params;
  const after = parseListCursor(new URL(req.url).searchParams.get("cursor"));
  if (after && "error" in after) return NextResponse.json({ error: after.error }, { status: 400 });

  const run = await db.agentRun.findFirst({
    where: { id: runId, agentId: id, orgId: rc.org.id },
    select: { id: true, agentId: true, triggeredBy: true, startedAt: true, finishedAt: true, meta: true },
  });
  if (!run) return NextResponse.json({ error: "not found" }, { status: 404 });

  const agent = await db.agent.findFirst({
    where: { id: run.agentId, orgId: rc.org.id },
    select: { agentKey: true, role: true },
  });
  if (!agent) return NextResponse.json({ error: "not found" }, { status: 404 });

  // A seeded builtin role's agentKey is the actorId its dedicated runner stamps on
  // every audit row (lib/tenant.ts AGENT_SEEDS mirrors lib/*-agent.ts's *_AGENT_ID
  // constants), which holds for a real campaign/enrichment-triggered run. A test run
  // (POST /api/agents/:id/run, meta.type "test-run") of any non-research agent goes
  // through runCopyAgent instead and is stamped COPY_AGENT_ID; a research agent's
  // test run goes through runResearchAgent and is stamped RESEARCH_AGENT_ID.
  // Filtering by agent.agentKey alone would render an empty trail for those, so
  // resolveActorId() applies the runner's rule.
  const actorId = resolveActorId(agent.role, agent.agentKey, run.meta);

  // Runs still in progress have no finishedAt — use "now" so a live run shows
  // what it has touched so far instead of an empty window.
  const windowEnd = run.finishedAt ?? new Date();

  // actorId + time window alone cannot tell apart two overlapping runs of the
  // SAME agent: AuditLog has no runId to isolate by.
  //
  // Never narrowed on metadata.triggeredBy. check()'s recordAudit() stamps that
  // from the CAPABILITY's createdBy (whoever provisioned the run's token), while
  // agentRun.triggeredBy is whoever started this particular run; the two only
  // match when the provisioner personally starts every run of the token. Filtering
  // `entries` on it produces a false-empty trail for any other run, and narrowing
  // the cross-agent probe on it lets a different agent's run slip past undetected
  // and be served as this run's own.
  //
  // Issued as raw SQL through services/access/audit-query.ts rather than a
  // Prisma typed `where`: the row-visibility rule this query applies matches
  // an access.manage row's target against `fact_dispute:`, whose `_` is a LIKE
  // wildcard, so only a `LIKE ... ESCAPE` clause expresses it correctly and
  // Prisma's typed API cannot emit one.
  //
  // One row past the page is read to tell whether another page follows.
  const rows = await queryRunAuditEntries({
    orgId: rc.org.id,
    actorId,
    from: run.startedAt,
    to: windowEnd,
    limit: RUN_TRAIL_PAGE_SIZE + 1,
    ...(after ? { after } : {}),
  });
  const entries = rows.slice(0, RUN_TRAIL_PAGE_SIZE);
  const hasMore = rows.length > RUN_TRAIL_PAGE_SIZE;
  const last = entries[entries.length - 1];

  // Residual ambiguity, case 1: another run of this SAME agent (attribution
  // ambiguity, not a leak: every row either run produced is still this agent's
  // own activity). Surfaced as a caveat; the merged entries above stay as-is.
  // Any overlapping run of this agent counts, regardless of who triggered it:
  // `entries` is not isolated by triggeredBy, so narrowing here would merge two
  // concurrent runs of the same agent started by two different people into one
  // trail while possibleOverlap reports false.
  const sameAgentOverlap = await db.agentRun.findFirst({
    where: {
      orgId: rc.org.id,
      agentId: run.agentId,
      id: { not: run.id },
      startedAt: { lte: windowEnd },
      OR: [{ finishedAt: null }, { finishedAt: { gte: run.startedAt } }],
    },
    select: { id: true },
  });

  // Residual ambiguity, case 2: a DIFFERENT agent's run that shares this run's
  // actorId. This only happens when actorId resolved to COPY_AGENT_ID: every
  // non-research agent, builtin or custom, runs through runCopyAgent, which
  // stamps that one shared identity regardless of which real agent it is. A
  // same-agentId probe cannot see this: entries queried by actorId alone would
  // silently merge in a genuinely different agent's memory.read rows (a real
  // leak, not an attribution ambiguity), so this probes across ALL agents, and
  // on a hit the entries above are withheld rather than shown as this run's own.
  // Not narrowed by triggeredBy (see the comment above `entries`): a collision
  // between two different people's runs must still be caught.
  //
  // Only a candidate whose OWN resolveActorId() (its agent's real
  // role/agentKey/meta, the same rule `actorId` was computed with) is
  // COPY_AGENT_ID counts. A run that could never have produced one of the rows
  // `entries` queries for (a research agent's own run, a builtin agent's real
  // campaign/enrichment run) is not ambiguous with this trail and must not
  // blank it.
  const crossAgentOverlap =
    actorId === COPY_AGENT_ID
      ? (
          await db.agentRun.findMany({
            where: {
              orgId: rc.org.id,
              id: { not: run.id },
              startedAt: { lte: windowEnd },
              OR: [{ finishedAt: null }, { finishedAt: { gte: run.startedAt } }],
            },
            select: { meta: true, agent: { select: { agentKey: true, role: true } } },
          })
        ).some(
          (r) =>
            resolveActorId(r.agent.role, r.agent.agentKey, r.meta) === COPY_AGENT_ID &&
            // A candidate whose real agentKey (agent is @@unique([orgId, agentKey]))
            // matches the run under view is the SAME real agent sharing an identity
            // via the override (two runs of one custom agent, or a builtin agent's
            // own test run), which sameAgentOverlap above reports as a caveat, not
            // a suppression.
            r.agent.agentKey !== agent.agentKey,
        )
      : false;

  return NextResponse.json({
    // Never present a merged list that might contain another agent's reads —
    // an honest "can't show this trail right now" beats a trail that looks
    // exact but is silently leaking a different agent's memory access.
    entries: crossAgentOverlap ? [] : entries,
    // Paging, oldest first: `hasMore` says rows follow this page, and `endCursor`
    // (`?cursor=`) reads from after its last row. A live run's poll re-reads its last
    // page from that page's start cursor, so a row that commits late, behind one
    // already read, still appears. Both are empty when the entries are withheld, so
    // the next read starts over.
    hasMore: !crossAgentOverlap && hasMore,
    endCursor: !crossAgentOverlap && last ? encodeListCursor(last) : null,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    // memory.read targets are query-based, not per-fact: a read row shows the
    // query it ran, not which exact facts came back.
    readTargetsAreQueryLevel: true,
    // True when another run — of this same agent, or (when actorId is the
    // shared copy-agent identity) of any agent — could genuinely overlap this
    // trail. The UI should show a caveat, not claim the list above is
    // certainly only this run's activity.
    possibleOverlap: !!sameAgentOverlap || !!crossAgentOverlap,
    // `possibleOverlap` conflates two signals: sameAgentOverlap is a caveat on a
    // still-shown `entries`; crossAgentOverlap is the ONLY thing that blanks
    // `entries` to `[]`. `entriesSuppressed` is the real signal, so a UI can tell a
    // genuinely empty run from one whose entries were withheld.
    entriesSuppressed: crossAgentOverlap,
  });
}
