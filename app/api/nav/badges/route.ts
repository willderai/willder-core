import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAccessContext } from "@/lib/access-context";
import { check, readableScopePaths } from "@/services/access";
import { countNewChunksInScopes } from "@/services/memory/activity-counts";
import { countVisibleRunningRuns } from "@/services/agents/run-visibility";

// GET /api/nav/badges — lightweight counts for nav notification badges.
// Polled every 30s by the nav. Returns only what's needed for the badge display.
//
// The one rule: every number here counts only records the caller may read. A
// count is disclosure — "4 chunks were ingested since your last visit" tells a
// member exactly how much content landed in scopes they hold no grant on, which
// is the fact a scoped-access product exists to withhold. So the badges mean
// "activity you can see", not "activity in this organisation", and a caller with
// no grant sees zeros that are indistinguishable from a genuinely quiet period.
//
// Each count asks the question its own data allows:
//   - contacts have no scopePath and are an org-root record (the same rule
//     services/memory/store-overview.ts applies), so the gate is check() for
//     memory.read at the org root. A refused caller gets 0, not a 403, because
//     the other badges are not contact data and are not this route's to gate.
//     The gate is only asked when the count would actually run, so an ordinary
//     poll with no `since` cursor costs no decision and writes no audit row.
//   - memory chunks and agent runs are scoped per row, so they are counted only
//     within readableScopePaths() — the scopes this caller holds a covering read
//     grant on — rather than one audited check() per row. Those two counts live
//     in services/memory/activity-counts.ts and services/agents/run-visibility.ts,
//     beside the rules they have to agree with.
//
// A count that cannot be run is reported as null, never 0, and logged. A 0 would
// put a wrong badge on screen and make a failed read look like an answer to
// anyone measuring what this route discloses. The other counts still answer:
// one failed query is no reason to blank the whole nav.
export async function GET(req: Request) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const orgId = rc.org.id;
  const url = new URL(req.url);
  const since = url.searchParams.get("since");
  const sinceDate = since ? new Date(since) : null;

  const readable = await readableScopePaths(rc.ctx);

  const newContactsCount =
    sinceDate && (await check(rc.ctx, { action: "memory.read", target: "nav:badges:contacts" })).allowed
      ? db.contact.count({ where: { orgId, createdAt: { gt: sinceDate } } })
      : Promise.resolve(0);

  const [activeAgentRuns, newContacts, newMemoryChunks] = await Promise.all([
    // Agents: runs in flight whose own scope the caller may read
    countOrNull("activeAgentRuns", countVisibleRunningRuns(orgId, readable)),

    // Contacts: contacts created since the client's last visit, if allowed above
    countOrNull("newContacts", newContactsCount),

    // Memory: chunks ingested since the client's last visit, in readable scopes
    countOrNull("newMemoryChunks", sinceDate ? countNewChunksInScopes(orgId, readable, sinceDate) : Promise.resolve(0)),
  ]);

  return NextResponse.json({ activeAgentRuns, newContacts, newMemoryChunks });
}

/** The count, or null with the failure logged when it could not be run. */
async function countOrNull(badge: string, count: Promise<number>): Promise<number | null> {
  try {
    return await count;
  } catch (error) {
    console.error(`[nav/badges] ${badge} count failed`, error);
    return null;
  }
}
