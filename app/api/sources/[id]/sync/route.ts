import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAccessContext } from "@/lib/access-context";
import { check } from "@/services/access";
import { inngest, SOURCE_SYNC_EVENT } from "@/lib/inngest";
import type { SourceSyncInput } from "@/lib/inngest";
import { sealSecret, unsealSecret } from "@/lib/crypto";

function sourceNotFound(): Response {
  return NextResponse.json({ error: "source not found" }, { status: 404 });
}

// POST /api/sources/:id/sync — manually trigger a re-sync. gdrive has no
// stored credential (its OAuth token is short-lived and client-held), so the
// client must pass a fresh one every time. Slack/figma have no OAuth flow
// yet either, but the token pasted at connect time is sealed onto
// `Source.encryptedTokens` (app/api/sources/route.ts), so a re-sync that
// omits `token` uses that stored value. Posthog and github need no token from
// here at all.
//
// The one rule it enforces: the queued event never carries a token in clear.
// A token the request supplies is sealed into the event; a stored one stays on
// the row, and the job (lib/inngest/connector-sync.ts) reads it there.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;

  // Decided at the org root, before the source is looked up: the decision does not
  // depend on the source, so a refused caller learns nothing about whether it exists,
  // and a 409 below can only ever answer someone allowed to sync.
  const decision = await check(rc.ctx, { action: "memory.write", target: `sources:sync:${id}` });
  if (!decision.allowed) return NextResponse.json({ error: decision.reason }, { status: 403 });

  const source = await db.source.findFirst({ where: { id, orgId: rc.org.id } });
  if (!source) return sourceNotFound();
  if (source.status === "disconnected") {
    return NextResponse.json({ error: "source is disconnected" }, { status: 409 });
  }

  let body: { token?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* token optional for non-gdrive */
  }

  // website has no re-sync path here: it is absent from TEXT_SOURCE_TYPES, so
  // without this check it would silently fall into the Drive branch below and
  // call the gdrive connector on a domain instead of a folder id.
  if (source.type === "website") {
    return NextResponse.json({ error: "website sources are not syncable via this endpoint" }, { status: 400 });
  }

  const requestToken = body.token;
  let storedToken: string | undefined;
  if (!requestToken && (source.type === "slack" || source.type === "figma") && source.encryptedTokens) {
    // Opened here only to refuse a re-sync that has nothing usable to send; the
    // job reads it again itself. A corrupt or rotated APP_ENCRYPTION_KEY makes
    // unsealSecret throw. That is treated the same as having no usable stored
    // token, rather than surfacing as an uncaught 500. Unlike a bad request
    // body, this is the server failing to open its own data, so it is logged
    // for the operator.
    try {
      storedToken = (unsealSecret(source.encryptedTokens) as { token?: string }).token;
    } catch (e) {
      console.error(`[sources/sync] could not unseal stored token for source ${source.id}:`, e);
      return NextResponse.json(
        { error: `no stored token for this ${source.type} source — reconnect with a token to re-sync` },
        { status: 400 },
      );
    }
  }

  if (source.type === "gdrive" && !requestToken) {
    return NextResponse.json({ error: "token is required to re-sync a gdrive source" }, { status: 400 });
  }
  if ((source.type === "slack" || source.type === "figma") && !requestToken && !storedToken) {
    return NextResponse.json(
      { error: `no stored token for this ${source.type} source — reconnect with a token to re-sync` },
      { status: 400 },
    );
  }

  const { ids } = await inngest.send({
    name: SOURCE_SYNC_EVENT,
    data: {
      sourceId: source.id,
      orgId: rc.org.id,
      ...(requestToken ? { sealedToken: sealSecret({ token: requestToken }) } : {}),
    } satisfies SourceSyncInput,
  });

  return NextResponse.json({ jobId: ids[0] }, { status: 202 });
}
