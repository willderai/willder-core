import { NextResponse } from "next/server";
import { requireAccessContext } from "@/lib/access-context";
import { check } from "@/services/access";
import { queryAuditActors } from "@/services/access/audit-query";
import { resolveUserNames, resolveActorNames, fallbackAgentName } from "@/services/audit/actor-names";

// GET /api/audit/actors — the distinct (actorType, actorId) pairs that have
// ever appeared in this org's visible audit trail, for the audit page's
// identity picker. Same admin gate as the audit list itself (access.manage),
// decided by check() so a refused caller leaves a deny row like any other.
export async function GET() {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { allowed } = await check(rc.ctx, { action: "access.manage", target: "audit:actors" });
  if (!allowed) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  // Raw SQL via services/access/audit-query.ts, not a Prisma typed `where`:
  // the row-visibility rule matches `fact_dispute:` against a row's target,
  // and `_` is a LIKE wildcard, so the rule is only correct with a
  // `LIKE ... ESCAPE` clause the typed API cannot emit. That query also
  // dedupes server-side.
  const rows = await queryAuditActors(rc.org.id);

  const humanIds = rows.filter((r) => r.actorType === "human").map((r) => r.actorId);
  const agentIds = rows.filter((r) => r.actorType === "agent").map((r) => r.actorId);

  const [userNames, agentNames] = await Promise.all([
    resolveUserNames(humanIds),
    resolveActorNames(rc.org.id, agentIds),
  ]);

  const actors = rows
    .map((r) => ({
      actorType: r.actorType,
      actorId: r.actorId,
      name:
        r.actorType === "human"
          ? (userNames[r.actorId] ?? r.actorId)
          : (agentNames[r.actorId] ?? fallbackAgentName(r.actorId)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return NextResponse.json({ actors });
}
