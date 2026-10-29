// GET /api/agents/dashboard: the agents dashboard's top row of numbers.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAccessContext } from "@/lib/access-context";
import { readableScopePaths } from "@/services/access";
import { countAgentDecisions } from "@/services/access/agent-access-activity";
import { ACTIVITY_DAYS, countVisibleRunWindows, listRoster } from "@/services/agents/agent-dashboard";
import { mayReadAgentAccessActivity } from "@/services/agents/dashboard-access";
import { countAgentFactWrites } from "@/services/memory/agent-fact-writes";

/**
 * GET /api/agents/dashboard
 *
 * - `agents`: the org's own agents (every member sees the roster) and how many are
 *   switched on; for an access manager also the connected agents, the agent ids that
 *   hold capability tokens but have no Agent row, and how many still hold a live one.
 * - `runs`: runs started in the last 24 hours and last 7 days, by outcome, counting
 *   only runs the caller may read (services/agents/run-visibility.ts).
 * - `decisions`: allowed and denied agent access decisions in the last 7 days, from
 *   the audit log. Null unless the caller may read the audit log.
 * - `factsWritten`: facts agents created in the last 7 days in scopes the caller may read.
 *
 * Every number in one window counts one set, so allowed beside denied, or failed
 * beside total, never mixes denominators.
 */
export async function GET() {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const now = new Date();
  const weekStart = new Date(now.getTime() - ACTIVITY_DAYS * 24 * 60 * 60 * 1000);
  const [readable, admin] = await Promise.all([
    readableScopePaths(rc.ctx),
    mayReadAgentAccessActivity(rc.ctx, "agents:dashboard"),
  ]);

  const connectedCount = (status?: "revoked") =>
    listRoster(
      rc.org.id,
      readable,
      { includeConnected: true, kind: "connected", status, sort: "name", order: "asc", page: 1, pageSize: 1 },
      now,
    ).then((page) => page.total);

  const [ownTotal, ownActive, runs, factsWritten, decisions, connectedTotal, connectedRevoked] = await Promise.all([
    db.agent.count({ where: { orgId: rc.org.id } }),
    db.agent.count({ where: { orgId: rc.org.id, active: true } }),
    countVisibleRunWindows(rc.org.id, readable, now),
    countAgentFactWrites(rc.org.id, readable, weekStart),
    admin ? countAgentDecisions(rc.org.id, weekStart) : null,
    admin ? connectedCount() : null,
    admin ? connectedCount("revoked") : null,
  ]);

  return NextResponse.json({
    windowDays: ACTIVITY_DAYS,
    agents: {
      own: { total: ownTotal, active: ownActive },
      connected:
        connectedTotal === null ? null : { total: connectedTotal, live: connectedTotal - (connectedRevoked ?? 0) },
    },
    runs,
    decisions,
    factsWritten,
  });
}
