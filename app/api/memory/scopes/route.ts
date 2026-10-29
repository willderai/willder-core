// GET /api/memory/scopes: the scopes the caller can read; can() decides each one, so the access
// policy is never re-derived here.
import { NextResponse } from "next/server";
import { requireAccessContext } from "@/lib/access-context";
import { can, MAX_DESCENDANT_SCOPES, readableScopePaths, scopesWithinGrants } from "@/services/access";

// GET /api/memory/scopes — scopes this user has at least read access to.
// Differs from /api/access/scopes (admin-only, access.manage). Any user who can
// open the memory page can call this.
//
// A real caller of the access layer, never a re-derivation of evaluate()'s
// grants-join logic: the candidates are the org's scopes inside one the caller holds
// a covering read grant on, from readableScopePaths() (the membership and grant query
// evaluate() itself runs), and can() -- the same evaluate() every memory.read goes
// through -- decides each one, so a change to grant/expiry/revocation semantics
// reaches this route automatically instead of drifting. can(), not check(), because
// this is a UI-facing capability listing, not itself a resource read (see can()'s
// own doc comment); it must not write an audit_log row per candidate scope.
//
// Both the list and `truncated` are therefore about
// the scopes this caller can read: a member granted one team in an org of hundreds
// of scopes reads that team and `truncated: false`, and learns nothing about how
// many scopes the org holds beyond it.
//
// One can() query runs per candidate scope, so the candidate list is bounded by
// MAX_DESCENDANT_SCOPES (services/access/check.ts). A caller
// who can read more scopes than that gets the first ones by path and
// `truncated: true`, so the UI can say the list is incomplete instead of it
// silently shrinking.
export async function GET() {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (rc.ctx.actor.type !== "human") {
    return NextResponse.json({ scopes: [], truncated: false });
  }

  const { orgId } = rc.ctx;
  const granted = await readableScopePaths(rc.ctx);
  const rows = await scopesWithinGrants(orgId, granted, MAX_DESCENDANT_SCOPES + 1);
  const truncated = rows.length > MAX_DESCENDANT_SCOPES;
  const candidates = rows.slice(0, MAX_DESCENDANT_SCOPES);

  const decisions = await Promise.all(candidates.map((s) => can(rc.ctx, { action: "memory.read", scope: s.path })));
  const scopes = candidates.filter((_, i) => decisions[i].allowed);

  return NextResponse.json({ scopes, truncated });
}
