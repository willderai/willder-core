// GET /api/audit/sessions: the audit page's "Session starts" view. For each recent agent
// session, what its task-start block served and which of those items the session then used,
// read from the served-vs-used log (services/memory/task-start-sessions.ts).
//
// Same gate as the rest of the audit page (access.manage). The response carries ids, positions
// and times, never a record's text: a record is opened one at a time through
// GET /api/audit/timeline/:changeId, which is an audited memory.read.
//
// Query: `scope` (defaults to the org root), `page`, and `from` (inclusive) and `to` (exclusive),
// each an ISO date or a timestamp with a zone, either one optional.
import { NextResponse } from "next/server";
import { requireAccessContext } from "@/lib/access-context";
import { readTimeRangeParams } from "@/lib/date-range";
import { MAX_SESSION_PAGE } from "@/lib/page-limits";
import { check, isValidLtreePath, orgRootPath, pathCovers } from "@/services/access";
import { fallbackAgentName, resolveActorNames } from "@/services/audit/actor-names";
import { readSessionStarts } from "@/services/memory/task-start-sessions";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

export async function GET(req: Request) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { allowed } = await check(rc.ctx, { action: "access.manage", target: "audit:sessions" });
  if (!allowed) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const root = orgRootPath(rc.org.id);
  const scope = url.searchParams.get("scope") || root;
  if (!isValidLtreePath(scope) || !pathCovers(root, scope)) {
    return NextResponse.json({ error: "scope must be a scope path inside this organization" }, { status: 400 });
  }
  const page = Number(url.searchParams.get("page") ?? "1");
  if (!Number.isInteger(page) || page < 1 || page > MAX_SESSION_PAGE) {
    return NextResponse.json({ error: `page must be a whole number from 1 to ${MAX_SESSION_PAGE}` }, { status: 400 });
  }

  const range = readTimeRangeParams(url.searchParams);
  if ("error" in range) return NextResponse.json({ error: range.error }, { status: 400 });

  const { sessions, total } = await readSessionStarts({ orgId: rc.org.id, scope, page, pageSize: PAGE_SIZE, range });
  const agentNames = await resolveActorNames(rc.org.id, [...new Set(sessions.map((s) => s.agentId))]);

  return NextResponse.json({
    sessions: sessions.map((s) => ({ ...s, agentName: agentNames[s.agentId] ?? fallbackAgentName(s.agentId) })),
    total,
    page,
    pageSize: PAGE_SIZE,
    totalPages: Math.ceil(total / PAGE_SIZE),
  });
}
