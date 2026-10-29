// GET /api/memory/scopes/stale?scope=<path>&limit=<n>: the records in a scope resting on
// a source that moved on after they were built, and the few most worth refreshing:
// { scope, stale, recommend, truncated }. One memory.read decision on the scope, inside
// staleReport(). `limit` is the size of `recommend`, an integer from 1 to 20, default 3.
import { NextResponse } from "next/server";
import { DEFAULT_RECOMMENDATIONS, MAX_RECOMMENDATIONS, staleReport } from "@/services/memory/dependencies";
import { readAtScope } from "../../dependency-scope";

export async function GET(req: Request) {
  return readAtScope(req, async (ctx, scopePath) => {
    // Refused after the scope resolves and before anything is read, so a bad limit costs no read decision.
    const limit = recommendationLimit(new URL(req.url).searchParams.get("limit"));
    if (limit === null) {
      return NextResponse.json({ error: `limit must be an integer from 1 to ${MAX_RECOMMENDATIONS}` }, { status: 400 });
    }
    return staleReport(ctx, scopePath, limit);
  });
}

/** The requested recommendation count, the default when absent, null when not an integer in range. */
function recommendationLimit(raw: string | null): number | null {
  if (raw === null) return DEFAULT_RECOMMENDATIONS;
  if (!/^[0-9]+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= MAX_RECOMMENDATIONS ? n : null;
}
