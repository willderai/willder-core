// POST /api/memory/facts/staleness-check: report a source's current revision; access is enforced per
// matched provenance row, and nothing outside the caller's scope is surfaced, not even a count.
import { NextResponse } from "next/server";
import { requireAccessContext } from "@/lib/access-context";
import { bodyTypeRefusal } from "@/lib/json-type-name";
import { checkFactStaleness } from "@/services/memory/fact-provenance";
import type { FactSourceType } from "@/lib/generated/prisma/client";

const SOURCE_TYPES: readonly FactSourceType[] = ["pr", "commit", "file"];

/**
 * Report that a source (a PR/commit/file `sourceRef`) is at `currentRevision`; any
 * linked fact recorded against an older revision flips to `potentially_stale` (never
 * deleted). Caller-reported by design: Willder does not poll GitHub/git itself; a
 * caller that already has that access (CI, a webhook, a human) is the source of the
 * revision signal.
 *
 * No single scope to check up front (matching provenance rows can span more than one
 * scope, see services/memory/fact-provenance.ts), so enforcement happens per matched row
 * inside checkFactStaleness(): a caller only learns about rows their own access
 * covers. skippedOutOfScope is deliberately NOT surfaced, not even as a count: a bare
 * count of out-of-scope rows still tells a caller "a provenance row for this sourceRef
 * exists in a scope you can't see," which is the existence leak "never surface outside
 * the granted scope" forbids.
 */
export async function POST(req: Request) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { sourceType?: string; sourceRef?: string; currentRevision?: string; reason?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }
  const wrongType = bodyTypeRefusal(body, ["sourceRef", "currentRevision", "reason"]);
  if (wrongType) return NextResponse.json({ error: wrongType }, { status: 400 });

  // sourceType is required: sourceRef alone is free-form text, so without the type
  // a PR/commit/file link that happens to reuse the same reference string as another
  // type would flip stale together on one type's revision report (see
  // services/memory/fact-provenance.ts).
  const sourceType = body.sourceType as FactSourceType | undefined;
  if (!sourceType || !SOURCE_TYPES.includes(sourceType)) {
    return NextResponse.json({ error: `sourceType must be one of: ${SOURCE_TYPES.join(", ")}` }, { status: 400 });
  }
  const sourceRef = body.sourceRef?.trim();
  const currentRevision = body.currentRevision?.trim();
  if (!sourceRef) return NextResponse.json({ error: "sourceRef is required" }, { status: 400 });
  if (!currentRevision) {
    return NextResponse.json({ error: "currentRevision is required" }, { status: 400 });
  }

  const result = await checkFactStaleness(rc.ctx, {
    orgId: rc.org.id,
    sourceType,
    sourceRef,
    currentRevision,
    reason: body.reason?.trim() || undefined,
  });

  return NextResponse.json({
    flagged: result.flagged,
    flaggedCount: result.flagged.length,
    skippedNoRevisionCount: result.skippedNoRevision.length,
  });
}
