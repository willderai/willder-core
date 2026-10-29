// GET /api/agents/roster: one page of the agents dashboard's roster.
import { NextResponse } from "next/server";
import { requireAccessContext } from "@/lib/access-context";
import { paramHoldingNul, readSearchParam } from "@/lib/list-search";
import { readableScopePaths } from "@/services/access";
import { dailyAgentDecisions } from "@/services/access/agent-access-activity";
import {
  ACTIVITY_DAYS,
  dailyVisibleRuns,
  emptySeries,
  listRoster,
  placeDay,
  ROSTER_KINDS,
  ROSTER_PAGE_SIZE,
  ROSTER_SORTS,
  ROSTER_STATUSES,
  ROSTER_USES,
  type RosterKind,
  type RosterSort,
  type RosterStatus,
  type RosterUse,
} from "@/services/agents/agent-dashboard";
import { mayReadAgentAccessActivity } from "@/services/agents/dashboard-access";

const MAX_PAGE = 100_000;

/**
 * GET /api/agents/roster?kind=&status=&use=&q=&sort=&order=&page=
 *
 * `kind` is builtin, custom or connected; `status` running, failing, idle, paused or
 * revoked; `use` is denied (a token call refused in the last seven days) or unused (a
 * live token with no allowed call in thirty); `q` matches the name or key; `sort` is
 * name, lastActive, runs, lastAllowed or lastDenied, `order` asc or desc. The response is `{ rows, total, page, pageSize }`,
 * each row with a seven-day `series` (oldest day first): visible runs and failed runs
 * for an Agent row, token calls and denied calls for a connected agent.
 *
 * Connected agents are listed only to an access manager; for
 * anyone else `kind=connected` matches nothing rather than failing, so a link shared
 * by a manager opens as an empty list, not an error.
 */
export async function GET(req: Request) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const params = new URL(req.url).searchParams;
  const nul = paramHoldingNul(params);
  if (nul) return NextResponse.json({ error: `${nul} must not contain a NUL character` }, { status: 400 });
  const kind = params.get("kind");
  if (kind !== null && !ROSTER_KINDS.includes(kind as RosterKind)) {
    return NextResponse.json({ error: `kind must be one of ${ROSTER_KINDS.join(", ")}` }, { status: 400 });
  }
  const status = params.get("status");
  if (status !== null && !ROSTER_STATUSES.includes(status as RosterStatus)) {
    return NextResponse.json({ error: `status must be one of ${ROSTER_STATUSES.join(", ")}` }, { status: 400 });
  }
  const use = params.get("use");
  if (use !== null && !ROSTER_USES.includes(use as RosterUse)) {
    return NextResponse.json({ error: `use must be one of ${ROSTER_USES.join(", ")}` }, { status: 400 });
  }
  const sort = params.get("sort") ?? "name";
  if (!ROSTER_SORTS.includes(sort as RosterSort)) {
    return NextResponse.json({ error: `sort must be one of ${ROSTER_SORTS.join(", ")}` }, { status: 400 });
  }
  const order = params.get("order") ?? (sort === "name" ? "asc" : "desc");
  if (order !== "asc" && order !== "desc")
    return NextResponse.json({ error: "order must be asc or desc" }, { status: 400 });
  const rawPage = params.get("page") ?? "1";
  if (!/^[1-9]\d*$/.test(rawPage) || Number(rawPage) > MAX_PAGE) {
    return NextResponse.json({ error: `page must be a whole number from 1 to ${MAX_PAGE}` }, { status: 400 });
  }
  const searched = readSearchParam(params);
  if ("error" in searched) return NextResponse.json({ error: searched.error }, { status: 400 });

  const now = new Date();
  const [readable, admin] = await Promise.all([
    readableScopePaths(rc.ctx),
    mayReadAgentAccessActivity(rc.ctx, "agents:roster"),
  ]);
  const page = Number(rawPage);
  const { rows, total } = await listRoster(
    rc.org.id,
    readable,
    {
      includeConnected: admin,
      kind: (kind as RosterKind | null) ?? undefined,
      status: (status as RosterStatus | null) ?? undefined,
      use: (use as RosterUse | null) ?? undefined,
      search: searched.search || undefined,
      sort: sort as RosterSort,
      order,
      page,
      pageSize: ROSTER_PAGE_SIZE,
    },
    now,
  );

  const own = rows.filter((row) => row.kind !== "connected").map((row) => row.id);
  const connected = rows.filter((row) => row.kind === "connected").map((row) => row.key);
  const [runSeries, callRows] = await Promise.all([
    dailyVisibleRuns(rc.org.id, readable, own, now),
    admin ? dailyAgentDecisions(rc.org.id, connected, now, ACTIVITY_DAYS) : [],
  ]);
  const callSeries = new Map(connected.map((key) => [key, emptySeries()]));
  for (const row of callRows) placeDay(callSeries.get(row.actorId), row);

  return NextResponse.json({
    rows: rows.map((row) => ({
      ...row,
      series: (row.kind === "connected" ? callSeries.get(row.key) : runSeries.get(row.id)) ?? emptySeries(),
    })),
    total,
    page,
    pageSize: ROSTER_PAGE_SIZE,
  });
}
