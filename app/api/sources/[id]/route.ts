import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAccessContext } from "@/lib/access-context";
import { isHiddenFrom } from "@/lib/hidden-record";
import { authorizeRecord, check } from "@/services/access";
import { listIngestedScopePaths, retireSourceContent } from "@/services/memory/source-retirement";
import { recordSourceChange } from "@/services/memory/source-change-event";
import { MemoryServiceError } from "@/services/memory/graphiti-store";

// A source at a scope the caller cannot read answers like an absent one
// (lib/hidden-record.ts).
function sourceNotFound(): Response {
  return NextResponse.json({ error: "source not found" }, { status: 404 });
}

// DELETE /api/sources/:id: disconnect a source and retire everything it
// ingested, so revoked or deleted content becomes unavailable to retrieval
// for every source type (Slack, Figma, Drive, website alike).
//
// Retirement runs BEFORE the source is marked disconnected and before its
// SourceFile rows are dropped: if either store call throws, the route returns
// an error naming the failure, with the source still "active" and its sync
// history intact, so the next DELETE re-attempts retirement rather than
// reporting success on content that is still reachable. Both calls are
// individually idempotent (0 facts/chunks left the second time), so a partial
// prior failure is safe to retry as a whole.
//
// Only facts and chunks are retired, not entity nodes: entities can be shared
// across sources (the same person/company mentioned in two synced channels),
// so hard-deleting a node here could silently remove content another
// still-connected source legitimately contributed. Graph facts are retired by
// group via `removeGroupFacts`, not per-episode: a Drive row synced before
// `SourceFile.episodeIds` existed holds an Inngest event id, not a real
// Graphiti episode id, so a per-episode purge cannot be complete. pgvector
// chunks are deleted the same way, filtered on the identical (orgId,
// scopePath) pair every ingest for this source wrote them with.
//
// A scope is never exclusive to one source. POST /api/sources accepts a
// caller-supplied `scopePath`, validated only as "an existing Scope row in
// this org"; Source is unique on (orgId, type, externalId), not on scopePath,
// so two sources can share one, and chat or manually entered memory written
// at that scope shares it too. Purging by scope alone would destroy
// co-located content that was never this source's. So both purges filter on
// the provenance marker instead: `MemoryChunk.sourceId` and every Graphiti
// fact's `source_description.source_id` carry the connector Source.id that
// produced them, written by every connector-sync ingest path and NEVER by
// chat, manual facts, or a document upload. This source's own content comes
// out wherever it lives; anything not stamped with this exact id is
// structurally untouched, whether or not the scope is shared.
//
// Retirement covers every scope this source ever wrote under
// (`SourceFile.episodeScopePath`, recorded at write time) plus its current
// one. POST /api/sources rewrites `source.scopePath` on a reconnect that
// passes an explicit scopePath while already-ingested episodes stay in the
// group they were written to, so purging only the current scope would leave
// the earlier one live.
//
// A sync already in flight when a disconnect lands can still write after the
// first retirement. Nothing here cancels the job. Two retirements close the
// gap instead: this route purges again once the row is marked disconnected,
// and `sourceSync` stops before its next write and purges once it sees the
// disconnect (see `retireAfterDisconnect` in lib/inngest.ts). A write that
// finishes before the row is marked is caught by the second purge here; one
// that finishes after it is caught by the sync's own. Still open: a write the
// memory service applies after the sync stopped waiting for it (a timed-out
// request it kept processing) lands after both purges.
//
// Known, deliberate limit: content ingested before the provenance marker
// existed has no sourceId/source_id stamp and is NOT retired by a disconnect;
// there is no backfill.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;

  // Authorize every scope this disconnect destroys content in, not the org
  // root. check() with no `scope` defaults to the org root, and grants match
  // ancestor-or-self, so asking about the root is the strictest question
  // available: passing it requires an org-root grant, which lib/tenant.ts
  // seeds only for the owner and admin roles. An explicit admin of the scope
  // a source lives in can connect it there (POST resolves its own target
  // scope), so the same admin has to be able to disconnect it.
  //
  // The source's current scope is decided as it is loaded, so a caller who
  // cannot read it gets the same 404 as for an id that was never issued.
  const access = await authorizeRecord(rc.ctx, () => db.source.findFirst({ where: { id, orgId: rc.org.id } }), {
    action: "memory.write",
    scopeOf: (s) => s.scopePath,
    target: `sources:disconnect:${id}`,
  });
  if (access.status === "absent") return sourceNotFound();
  if (access.status === "denied") return NextResponse.json({ error: access.decision.reason }, { status: 403 });
  const source = access.record;

  // Then every earlier scope its own sync records captured: the ones
  // `retireSourceContent` below also purges. All of them come from stored
  // rows, never from the caller, so none of the ltree validation POST needs on
  // a caller-supplied path applies here.
  //
  // Every one of them has to pass, not just the current one. A source that a
  // reconnect moved still has content under the scope it left, and this route
  // destroys that too; authorizing only where the source points now would let
  // an admin of the scope it was moved into destroy content in a scope they
  // hold nothing on. POST's own move guard closes the same asymmetry from the
  // other direction.
  //
  // A deny reason names the scope it was decided on, so a caller who cannot
  // read an earlier scope gets a 403 that does not name it.
  const scopePaths = await listIngestedScopePaths(source);
  for (const scopePath of scopePaths) {
    if (scopePath === source.scopePath) continue;
    const decision = await check(rc.ctx, {
      action: "memory.write",
      scope: scopePath,
      target: `sources:disconnect:${id}`,
    });
    if (decision.allowed) continue;
    if (await isHiddenFrom(rc.ctx, scopePath)) {
      return NextResponse.json(
        { error: "access denied: this source still holds content in a scope you have no grant on" },
        { status: 403 },
      );
    }
    return NextResponse.json({ error: decision.reason }, { status: 403 });
  }

  // A retirement failure leaves the source connected (see the ordering note at
  // the top of this file), and the response says so. A bare 500 with no body
  // gives the settings panel nothing to show, so every failure here carries a
  // message naming what happened and that the source is still connected.
  let retired: { retiredFacts: number; retiredChunks: number };
  try {
    retired = await retireSourceContent(source, null);
  } catch (e) {
    if (e instanceof MemoryServiceError) {
      return NextResponse.json(
        {
          error: `Could not remove this source's facts from memory, so it is still connected. ${e.message}`,
        },
        { status: 502 },
      );
    }
    console.error("[sources] content retirement failed", { sourceId: id, error: e });
    return NextResponse.json(
      { error: "Could not remove this source's content from memory, so it is still connected. Try again." },
      { status: 500 },
    );
  }
  const { retiredFacts, retiredChunks } = retired;

  // The disconnect and its change-feed event commit together. The row is kept,
  // marked disconnected, so the event is an `update` of it rather than a delete.
  await db.$transaction(async (tx) => {
    await tx.sourceFile.deleteMany({ where: { sourceId: id } });
    // encryptedTokens: null — a disconnected posthog source stops holding the
    // customer's key at rest the moment they revoke it; harmless no-op for
    // every other type, which never sets this column today.
    const disconnected = await tx.source.update({
      where: { id },
      data: { status: "disconnected", encryptedTokens: null },
      select: { id: true, orgId: true, scopePath: true, name: true },
    });
    await recordSourceChange(tx, disconnected, "update", rc.user.id, rc.ctx.origin);
  });

  // The second purge (see the top of this file). The source is already
  // disconnected, so a failure here says so rather than claiming it is still
  // connected; retrying the DELETE runs the whole retirement again.
  let swept: { retiredFacts: number; retiredChunks: number };
  try {
    swept = await retireSourceContent(source, null);
  } catch (e) {
    console.error("[sources] post-disconnect retirement failed", { sourceId: id, error: e });
    return NextResponse.json(
      {
        error:
          "The source is disconnected, but content its last sync wrote may still be in memory. " +
          "Disconnect it again to remove it.",
      },
      { status: e instanceof MemoryServiceError ? 502 : 500 },
    );
  }

  return NextResponse.json({
    disconnected: id,
    retiredFacts: retiredFacts + swept.retiredFacts,
    retiredChunks: retiredChunks + swept.retiredChunks,
  });
}
