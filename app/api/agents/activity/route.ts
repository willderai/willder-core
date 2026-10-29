// GET /api/agents/activity: recent runs across every agent, newest first.
import { NextResponse } from "next/server";
import { requireAccessContext } from "@/lib/access-context";
import { paramHoldingNul } from "@/lib/list-search";
import { readableScopePaths } from "@/services/access";
import { listVisibleActivity } from "@/services/agents/agent-dashboard";
import { publicRunMeta, RUN_STATUSES, type RunStatusFilter } from "@/services/agents/run-visibility";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/**
 * GET /api/agents/activity?status=&before=&limit=
 *
 * Only runs the caller may read (services/agents/run-visibility.ts), filtered by
 * status. `before` is the `next` cursor of the previous page; the
 * response is `{ runs, next }`, `next` null on the last page. No run's QA target
 * credential is returned.
 */
export async function GET(req: Request) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const params = new URL(req.url).searchParams;
  const nul = paramHoldingNul(params);
  if (nul) return NextResponse.json({ error: `${nul} must not contain a NUL character` }, { status: 400 });
  const status = params.get("status");
  if (status !== null && !RUN_STATUSES.includes(status as RunStatusFilter)) {
    return NextResponse.json({ error: `status must be one of ${RUN_STATUSES.join(", ")}` }, { status: 400 });
  }
  const requested = parseInt(params.get("limit") ?? `${DEFAULT_LIMIT}`, 10);
  const limit = Number.isNaN(requested) || requested < 1 ? DEFAULT_LIMIT : Math.min(requested, MAX_LIMIT);
  const before = parseCursor(params.get("before"));
  if (before === "invalid")
    return NextResponse.json({ error: "before must be a cursor from a previous page" }, { status: 400 });

  const readable = await readableScopePaths(rc.ctx);
  const { runs, hasMore } = await listVisibleActivity(
    rc.org.id,
    readable,
    {
      limit,
      before: before ?? undefined,
      status: (status as RunStatusFilter | null) ?? undefined,
    },
    new Date(),
  );
  const last = runs.at(-1);
  return NextResponse.json({
    runs: runs.map((run) => ({ ...run, meta: publicRunMeta(run.meta) })),
    next: hasMore && last ? `${last.startedAt.toISOString()}_${last.id}` : null,
  });
}

/** A `next` cursor, `<ISO start time>_<run id>`, or null when absent. */
function parseCursor(raw: string | null): { startedAt: Date; id: string } | null | "invalid" {
  if (raw === null || raw === "") return null;
  const split = raw.indexOf("_");
  if (split < 0) return "invalid";
  const startedAt = new Date(raw.slice(0, split));
  const id = raw.slice(split + 1);
  if (Number.isNaN(startedAt.getTime()) || !/^[A-Za-z0-9-]{1,64}$/.test(id)) return "invalid";
  return { startedAt, id };
}
