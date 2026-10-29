// POST/GET /api/memory/facts/[id]/provenance: link a fact to its source, or list its links; writes are
// gated on memory.write at a server-resolved scope and reads are filtered per row.
import { NextResponse } from "next/server";
import { requireAccessContext } from "@/lib/access-context";
import { bodyTypeRefusal } from "@/lib/json-type-name";
import { AccessDeniedError, check, orgRootPath, resolveCallerScopePath } from "@/services/access";
import { MemoryServiceError } from "@/services/memory";
import {
  recordFactProvenance,
  listReadableFactProvenance,
  UnresolvedFactError,
} from "@/services/memory/fact-provenance";
import type { FactSourceType } from "@/lib/generated/prisma/client";

const SOURCE_TYPES: readonly FactSourceType[] = ["pr", "commit", "file"];

// POST /api/memory/facts/:id/provenance — link an existing confirmed fact (Graphiti
// edge uuid, the same identifier `/api/memory/facts/:id` DELETE/PATCH act on) to the
// PR/commit/file it was recorded from. Gated on memory.write, the same permission
// memory/facts writes require.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;

  let body: { sourceType?: string; sourceRef?: string; recordedRevision?: string; scope?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }
  const wrongType = bodyTypeRefusal(body, ["sourceRef", "recordedRevision"]);
  if (wrongType) return NextResponse.json({ error: wrongType }, { status: 400 });

  const sourceType = body.sourceType as FactSourceType | undefined;
  if (!sourceType || !SOURCE_TYPES.includes(sourceType)) {
    return NextResponse.json({ error: `sourceType must be one of: ${SOURCE_TYPES.join(", ")}` }, { status: 400 });
  }
  const sourceRef = body.sourceRef?.trim();
  if (!sourceRef) return NextResponse.json({ error: "sourceRef is required" }, { status: 400 });
  const recordedRevision = body.recordedRevision?.trim() || undefined;

  // Resolve + enforce scope through the shared write-direction helper (the same
  // pattern POST /api/memory/upload and the MCP door's fact_link_source use) instead
  // of passing the raw body field straight to check(): an absent scope falls back to
  // the org root, but a malformed one is refused and audited here rather than
  // reaching check()'s `::ltree` cast raw and throwing before recordAudit() runs.
  let scopePath: string;
  try {
    scopePath = await resolveCallerScopePath(
      rc.ctx,
      body.scope,
      { scopePath: orgRootPath(rc.org.id) },
      { onInvalid: "refuse", action: "memory.write", field: "scope" },
    );
  } catch (e) {
    if (e instanceof AccessDeniedError) {
      return NextResponse.json({ error: e.decision.reason }, { status: 403 });
    }
    throw e;
  }

  const decision = await check(rc.ctx, { action: "memory.write", scope: scopePath, target: `fact:${id}` });
  if (!decision.allowed) {
    return NextResponse.json({ error: decision.reason }, { status: 403 });
  }

  // `id` is a path segment the client chose, so recordFactProvenance resolves it
  // against `scopePath` through the memory service before writing.
  let provenance;
  try {
    provenance = await recordFactProvenance(rc.ctx, {
      orgId: rc.org.id,
      scopePath,
      graphitiFactUuid: id,
      sourceType,
      sourceRef,
      recordedRevision,
      ownerId: rc.user.id,
    });
  } catch (e) {
    // One 404 for "no such fact here", whether the uuid is unknown or belongs to
    // a scope this caller cannot read — the two must stay indistinguishable.
    if (e instanceof UnresolvedFactError) {
      return NextResponse.json({ error: "fact not found" }, { status: 404 });
    }
    if (e instanceof AccessDeniedError) {
      return NextResponse.json({ error: e.decision.reason }, { status: 403 });
    }
    // Resolving the uuid means talking to the memory service, so this door can
    // fail downstream — the service is unreachable, or older than the route
    // the resolution needs. 502, the same answer every other memory door gives,
    // rather than letting it escape the handler as a bare 500; and not the 404
    // above, which would tell a caller the fact does not exist when we only
    // failed to ask. Nothing is written either way, and the answer is the same
    // for every uuid, so it still says nothing about which facts are real.
    if (e instanceof MemoryServiceError) {
      return NextResponse.json({ error: e.message }, { status: 502 });
    }
    throw e;
  }

  return NextResponse.json({ provenance }, { status: 201 });
}

// GET /api/memory/facts/:id/provenance — list source links for a fact. Filtered
// per-row against the caller's own access (a fact's provenance rows are not
// guaranteed to share one scope — see services/memory/fact-provenance.ts) so a caller
// never learns about a link recorded outside their own granted scope.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;

  const visible = await listReadableFactProvenance(rc.ctx, id);
  return NextResponse.json({ provenance: visible });
}
