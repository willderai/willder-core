// GET /api/access/erasure/:requestId — how an erasure request (POST /api/access/erasure) stands.
//
// Requires access.manage on the org root, as the request did; the refusal is audited. Answers
// 200 with `status`: `running`; `done` with the counts of the request's `person.erased` audit
// row (the same fields that row's `erasureCounts` holds, never a value it erased); or `failed`
// with `error`, after which sending the same POST again completes the erasure. 404 when this
// org has no such request.
import { NextResponse } from "next/server";
import { requireAccessContext } from "@/lib/access-context";
import { AccessDeniedError } from "@/services/access";
import { personErasureStatus } from "@/services/memory/person-erasure-requests";

export async function GET(_req: Request, { params }: { params: Promise<{ requestId: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { requestId } = await params;
  try {
    const status = await personErasureStatus(rc.ctx, requestId);
    if (!status) return NextResponse.json({ error: "no such erasure request" }, { status: 404 });
    return NextResponse.json(status);
  } catch (e) {
    if (e instanceof AccessDeniedError) {
      return NextResponse.json({ error: e.decision.reason }, { status: 403 });
    }
    throw e;
  }
}
