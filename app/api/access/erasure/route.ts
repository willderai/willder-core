// POST /api/access/erasure — erase one person from this org on request.
//
// Body: exactly one of { contactId }, { email } or { entityId }. Requires
// access.manage on the org root; the refusal is audited like every other
// decision. The request is checked here and answered at once with 202 and its
// request id; a background job erases the person
// (services/memory/person-erasure-requests.ts), and
// GET /api/access/erasure/:requestId says when it is done. What gets removed,
// and in what order, is services/memory/person-erasure.ts. Sending the same
// request again after a failure completes it; after a success it removes nothing.
import { NextResponse } from "next/server";
import { requireAccessContext } from "@/lib/access-context";
import { queuePersonErasure } from "@/lib/inngest/person-erasure";
import { AccessDeniedError } from "@/services/access";
import { PersonErasureError, type PersonIdentifier } from "@/services/memory/person-erasure";
import { ErasureNotQueuedError, requestPersonErasure } from "@/services/memory/person-erasure-requests";

export async function POST(req: Request) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "body must be an object" }, { status: 400 });
  }

  try {
    const accepted = await requestPersonErasure(rc.ctx, body as PersonIdentifier, queuePersonErasure);
    return NextResponse.json({ ...accepted, statusUrl: `/api/access/erasure/${accepted.requestId}` }, { status: 202 });
  } catch (e) {
    if (e instanceof PersonErasureError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    if (e instanceof AccessDeniedError) {
      return NextResponse.json({ error: e.decision.reason }, { status: 403 });
    }
    console.error("[access/erasure] erasure request failed", { error: e });
    if (e instanceof ErasureNotQueuedError) {
      return NextResponse.json({ error: e.message }, { status: 503 });
    }
    return NextResponse.json(
      { error: "The erasure could not be started, and nothing was erased. Send the same request again." },
      { status: 500 },
    );
  }
}
