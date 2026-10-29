import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAccessContext } from "@/lib/access-context";
import { briefNotFound } from "@/lib/brief-access";
import { AccessDeniedError, check, pathCovers, readableScopePaths, scopeCacheStamp } from "@/services/access";
import type { AccessContext, ScopeCacheStamp } from "@/services/access";
import { findScopeContradictions } from "@/services/facts/conflicts";
import { fileSameTierScopeDisputes } from "@/services/memory/scope-dispute-scan";
import { getCachedScan, scanFingerprint, setCachedScan } from "@/services/facts/scope-scan-cache";
import { authorizeBrief } from "@/services/memory/briefs";
import { checkBriefStaleness } from "@/services/memory/brief-staleness";

// GET /api/briefs/:id/staleness: "did memory change after this briefing was
// generated?" A handoff brief is a point-in-time read; if the scope it was
// drawn from picked up a new memory.write/memory.delete since then, the
// grantee may be working from something already out of date. Read-only: it
// queries the append-only audit_log for writes/deletes whose resolved scope
// falls under the brief's own scopePath, timestamped after brief.createdAt.
//
// Source visibility: "answered from N of M connected sources; K out of scope"
// is a second, independent fact from the staleness flag. It does not say
// whether anything changed, it says what this brief could and could not see.
// A connected Source is "in scope" for this brief exactly when its own
// scopePath sits at or below the brief's granted scopePath, the same
// ancestor-or-self relation pathCovers()/evaluate() enforce for every read,
// applied to Source rows instead of audit rows. "Connected" excludes a
// disconnected source, which stopped being part of what this org has access
// to.
//
// Existence leak: total/outOfScope are never an org-wide count. A grantee
// narrowed to one scope must not see every other scope's connected-source
// count show up as "out of scope", which discloses that content exists where
// the reader holds no covering grant (the same bare-existence-count class
// app/api/memory/facts/staleness-check/route.ts withholds via
// skippedOutOfScope). Source rows are first filtered down to
// readableScopePaths(rc.ctx), the scopes this actor holds a covering grant
// on, before total/inScope/outOfScope are computed over what is left.
//
// Same access pattern as GET /api/briefs/:id: org-scoped, and re-gated
// through check() on the brief's own scopePath, so a revoked grantee cannot
// read this route. Deliberately NOT the access.manage-gated /api/audit
// endpoint, since an external grantee reading their own briefing has no
// reason to hold that permission. The response is minimal (action/target/
// timestamp only, no actor identity or deny reason) for the same reason.
//
// Containment: scopePath is AUTHORIZATION-BEARING (schema.prisma) and an
// audit row's target is `${targetPath}` or `${targetPath}/${req.target}`
// (recordAudit, services/access/check.ts), targetPath itself being either the
// brief's exact scope or a dot-descendant of it. A bare `startsWith(scopePath)`
// matches any sibling scope that merely shares a character prefix (a brief
// scoped `acme.eng` would be handed `acme.engineering`'s writes, a
// same-tenant cross-scope disclosure), and Prisma's `startsWith` compiles to
// a Postgres LIKE with no ESCAPE clause: LIKE treats `_` as "any single
// character", and isValidLtreePath() permits `_` in an ordinary scope label,
// so a brief scoped `org_1.dept_sales` would be handed `org_1.deptXsales`'s
// writes with no attacker needed (an org holding both `dept-sales` and
// `dept_sales` leaks one into the other's brief).
//
// `services/access/check.ts`'s `auditChangesUnderScope()` is the predicate:
// the three containment legs as raw SQL, built on
// services/access/scope-containment.ts's escapeLikePrefix() with a real
// `LIKE ... ESCAPE`, which Prisma's own `startsWith` cannot express. It lives
// in services/access, not here, because raw SQL against a scoped model
// belongs behind the access-control seam and because it is the read-side
// counterpart to recordAudit()'s own target-tagging convention in that file.
//
// Self-write exclusion: POST /api/briefs/:id/persist and /correct both
// check() memory.write at this brief's own scopePath with target
// `brief:${id}`, then tag their actual ingest with the same string via
// `IngestInput.auditTag`, so the confirmed-applied row `recordAppliedChange()`
// writes once that write really lands carries the identical target. Otherwise
// it would satisfy the containment predicate and flag the brief as stale
// against its own just-accepted content. Excluded by exact target match: this
// tag is unique to this brief's own persist/correct writes.
//
// Citations: `changed` says something moved somewhere under the scope; it does
// not say whether a fact this brief actually quoted is still true. Each fact a
// section cited (services/memory/brief-citations.ts) is re-resolved at the
// brief's scope and reported current, changed, superseded, gone or unknown, so
// a citation never vouches for a fact that has since been replaced. A brief
// generated before citations were recorded, or by the fanned-out runner, has
// none and returns an empty list.
//
// Stale: `changed` is scope activity, not a verdict on this brief. `stale` is
// the verdict (services/memory/brief-staleness.ts): true when something this
// brief was derived from changed, a cited fact or a source its run read, and
// false for a write elsewhere in its scope. `staleBasis` says whether the brief
// recorded what it read (`derivation`) or fell back to its scope (`scope`).
const MAX_CHANGES = 20;

// The plain changed/changes signal answers "did anything change", not "do
// two things now actively disagree": a benign correction and a genuine
// same-tier conflict render identically. The generic ingest path
// (lib/inngest.ts memoryIngest) does NOT get its own contradiction check,
// since that fires on every Slack/Drive/Figma sync and agent fact, not just
// ones anyone will ever read through a brief. Instead this route, already
// computing `changed` per brief and already bounded to MAX_CHANGES, runs the
// scan (services/facts/conflicts.ts findScopeContradictions, the same
// retrieve-then-LLM-flag shape services/agents/runner.ts's architecture-plan
// generation uses) ONLY when `changed` is true, so cost tracks this brief's
// own staleness events instead of the org's total ingest volume.
//
// Cost guard: this is a real paid LLM call on a GET with no rate limit, so a
// grantee refreshing an unchanged, still-stale brief must not re-buy it on
// every view. The cached scan (services/facts/scope-scan-cache.ts) holds fact
// text, so it is keyed on scopeCacheStamp() (services/access/check.ts): the org's
// removal epoch, which every erasure and removal moves, and the count of every applied
// change under the scope, not the bounded `changes` list above, which stops moving
// once it holds MAX_CHANGES rows. Both are counters read by primary key. The stamp is read before the scan
// runs, so a removal committed during the scan leaves its result under the old
// stamp, which the next GET misses.
//
// A hit is still a read of the scope's graph, so it records the same audited
// memory.read decision a miss records inside guardedMemory.graph(), and serves
// nothing if that decision is a deny.
async function scanForContradictions(
  ctx: AccessContext,
  orgId: string,
  scopePath: string,
  briefId: string,
  stamp: ScopeCacheStamp,
): Promise<{ factA: string; factB: string; note: string }[]> {
  const fingerprint = scanFingerprint(stamp);
  const cached = getCachedScan(briefId, fingerprint);
  if (cached) {
    const decision = await check(ctx, { action: "memory.read", scope: scopePath, target: "graph" });
    return decision.allowed ? cached : [];
  }

  const found = await findScopeContradictions(ctx, orgId, scopePath);
  if (found.length) await fileSameTierScopeDisputes(ctx, orgId, scopePath, found);
  setCachedScan(briefId, fingerprint, found);
  return found;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const access = await authorizeBrief(rc.ctx, id, { action: "memory.read" });
  if (access.status !== "allowed") return briefNotFound();
  const { brief } = access;

  const [staleness, sources, readableScopes, stamp] = await Promise.all([
    // Its own audited decision on the same scope; a grant revoked in between
    // answers like an absent brief, not a server error.
    checkBriefStaleness(
      rc.ctx,
      { id, orgId: rc.org.id, scopePath: brief.scopePath, createdAt: brief.createdAt },
      MAX_CHANGES,
    ).catch((error: unknown) => {
      if (error instanceof AccessDeniedError) return null;
      throw error;
    }),
    db.source.findMany({
      where: { orgId: rc.org.id, status: { not: "disconnected" } },
      select: { scopePath: true },
    }),
    readableScopePaths(rc.ctx),
    scopeCacheStamp({ orgId: rc.org.id, scopePath: brief.scopePath }),
  ]);
  if (staleness === null) return briefNotFound();
  const { changes, citations } = staleness;

  // Only ever count what THIS reader holds a covering grant on: a source in
  // a scope they cannot see must never contribute to total or outOfScope.
  const visibleSources = sources.filter((s) => readableScopes.some((granted) => pathCovers(granted, s.scopePath)));
  const inScope = visibleSources.filter((s) => pathCovers(brief.scopePath, s.scopePath)).length;

  // Bounded, gated on `changed` — see scanForContradictions' own comment above.
  const contradictions =
    changes.length > 0 ? await scanForContradictions(rc.ctx, rc.org.id, brief.scopePath, id, stamp) : [];

  return NextResponse.json({
    stale: staleness.stale,
    staleBasis: staleness.basis,
    changed: changes.length > 0,
    changes,
    contradictions,
    citations,
    sources: {
      total: visibleSources.length,
      inScope,
      outOfScope: visibleSources.length - inScope,
    },
  });
}
