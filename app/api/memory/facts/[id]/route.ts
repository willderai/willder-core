// PATCH/DELETE /api/memory/facts/[id]: correct or remove one fact; both go through the memory.delete
// gate inside guardedMemory.removeFact(), at a scope resolved by the shared write-direction helper.
import { NextResponse } from "next/server";
import { requireAccessContext } from "@/lib/access-context";
import { bodyTypeRefusal } from "@/lib/json-type-name";
import { guardedMemory, MemoryServiceError } from "@/services/memory";
import { factCorrectionName } from "@/services/memory/correction-names";
import { FactAlreadyReplacedError } from "@/services/memory/fact-update";
import { RemovalNotRecordedError } from "@/services/memory/fact-change-event";
import { AccessDeniedError, orgRootPath, resolveCallerScopePath } from "@/services/access";
import { checkEpisodeCap, GuardrailError } from "@/services/guardrails";
import { ingestMemory } from "@/lib/inngest";
import { unstorableText } from "@/lib/unstorable-text";
import type { IngestInput } from "@/types/memory";

// PATCH /api/memory/facts/:id — edit a fact: delete the old one and reingest the
// corrected text as a new human-asserted episode. Gated on memory.delete (write+),
// the one decision guardedMemory.removeFact() checks and audits, so one edit is one
// audit row, same as DELETE. The new version is recorded as the old one's replacement
// when it is announced (`correctionOf`), if both are in one scope.
//
// What can refuse the edit is checked before the old fact is removed: 400 for text Postgres
// cannot store, 402 at the free plan's episode cap, 404 when the fact is not in this tenant
// and scope, 409 (with `currentVersionId`) when another version already replaced it.
// Otherwise 202 with { jobId }, the old fact removed synchronously. If the corrected text then
// cannot be queued, 503 with `factRemoved: true` says the fact is gone and what to do.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;

  let body: { fact?: string; scope?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }
  const wrongType = bodyTypeRefusal(body, ["fact"]);
  if (wrongType) return NextResponse.json({ error: wrongType }, { status: 400 });
  // Refused before the old fact is removed: ingestMemory refuses a NUL, which Postgres
  // cannot store, so an edit that reached it would delete the fact and keep nothing.
  const unstorable = unstorableText({ fact: body.fact });
  if (unstorable) return NextResponse.json({ error: unstorable.message }, { status: 400 });
  const fact = body.fact?.trim();
  if (!fact) return NextResponse.json({ error: "fact is required" }, { status: 400 });
  // Facts ingest under scopePath = scope ?? orgRootPath(orgId), never the bare org id
  // (facts/route.ts's POST). The same default here keeps the delete-then-reingest
  // below on the Graphiti partition ingest wrote to, instead of the bare `<orgId>`
  // guarded-store.ts falls back to when no scope is forwarded (the pattern
  // entities/[id] and briefs/[id]/correct use).
  //
  // A caller-supplied `body.scope` must never reach check()'s `::ltree` cast raw: a
  // malformed value there throws before recordAudit() runs. The shared helper refuses
  // it instead (onInvalid: "refuse", the write/delete direction, same as
  // facts/[id]/provenance/route.ts).
  let scopePath: string;
  try {
    scopePath = await resolveCallerScopePath(
      rc.ctx,
      body.scope,
      { scopePath: orgRootPath(rc.org.id) },
      { onInvalid: "refuse", action: "memory.delete", field: "scope", persists: true },
    );
  } catch (e) {
    if (e instanceof AccessDeniedError) {
      return NextResponse.json({ error: e.decision.reason }, { status: 403 });
    }
    throw e;
  }

  // Refused here, before the old fact is removed, rather than by the ingest after it.
  try {
    await checkEpisodeCap(rc.org.id);
  } catch (e) {
    if (e instanceof GuardrailError) return NextResponse.json({ error: e.message }, { status: 402 });
    throw e;
  }

  // The delete gate inside removeFact() covers both the removal and the correction, so the
  // row it audits is the authorization the corrected version's change event names too: one
  // edit is one audit row, and both changes it produced point back at it.
  let authorizedById: string | undefined;
  let correctionOf: IngestInput["correctionOf"];
  try {
    const removal = await guardedMemory.removeFact(rc.ctx, { groupId: rc.org.id, factId: id }, scopePath, fact);
    if (!removal.removed) {
      return NextResponse.json({ error: "fact not found" }, { status: 404 });
    }
    authorizedById = removal.authorizedById;
    if (removal.removedVersion) {
      correctionOf = {
        factId: id,
        removalId: removal.removedVersion.changeId,
        scopePath: removal.removedVersion.scopePath,
      };
    }
  } catch (e) {
    if (e instanceof RemovalNotRecordedError) {
      // The fact is gone though its removal was not recorded: the correction is kept, and it
      // can name no removal for its lineage.
      console.error(`[memory] ${e.message}`);
      authorizedById = e.authorizedById;
    } else if (e instanceof AccessDeniedError) {
      return NextResponse.json({ error: e.decision.reason }, { status: 403 });
    } else if (e instanceof FactAlreadyReplacedError) {
      return NextResponse.json({ error: e.message, currentVersionId: e.currentVersionId }, { status: 409 });
    } else if (e instanceof MemoryServiceError) {
      return NextResponse.json({ error: e.message }, { status: 502 });
    } else {
      throw e;
    }
  }

  const data: IngestInput = {
    groupId: rc.org.id,
    content: fact,
    source: "text",
    // Names the fact it corrects, so two people's corrections of two facts are two facts,
    // never one fact written twice, which the conflict rule would settle by hiding one.
    name: factCorrectionName(id, new Date()),
    actorType: "human",
    origin: rc.ctx.origin,
    actorId: rc.user.id,
    actorName: rc.user.name ?? undefined,
    scopePath,
    authorizedById,
    correctionOf,
  };
  try {
    await ingestMemory(data);
  } catch (e) {
    console.error(`[memory] fact ${id} was removed, but its correction was not queued:`, e);
    return NextResponse.json(
      {
        error:
          "The fact was removed, but your corrected text was not confirmed as saved. If it does not show in memory within a minute, add it again as a new fact.",
        factRemoved: true,
      },
      { status: 503 },
    );
  }
  return NextResponse.json({ jobId: "queued" }, { status: 202 });
}

// DELETE /api/memory/facts/:id — remove a fact from memory. A privileged action:
// gated by `memory.delete` (needs write+; read-only members are denied) and audited
// via the check() gate. Tenant-scoped. Returns 404 if the fact isn't in this tenant.
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  // Same default as facts/route.ts's POST: an ordinary fact ingests under
  // org_<orgId>, not the bare org id guarded-store.ts falls back to when no scope
  // is forwarded; targeting the bare org id would 404 on every normally-ingested
  // fact. A malformed caller-supplied `?scope=` is refused before it can reach
  // check()'s `::ltree` cast raw, same as PATCH above.
  const scope = new URL(req.url).searchParams.get("scope")?.trim() || undefined;
  let scopePath: string;
  try {
    scopePath = await resolveCallerScopePath(
      rc.ctx,
      scope,
      { scopePath: orgRootPath(rc.org.id) },
      { onInvalid: "refuse", action: "memory.delete", field: "scope" },
    );
  } catch (e) {
    if (e instanceof AccessDeniedError) {
      return NextResponse.json({ error: e.decision.reason }, { status: 403 });
    }
    throw e;
  }

  // delete gate (write+; read-only members are denied) runs inside
  // guardedMemory.removeFact() itself below — no separate check() call here,
  // that would audit the same decision twice.
  try {
    const { removed } = await guardedMemory.removeFact(
      rc.ctx,
      {
        groupId: rc.org.id,
        factId: id,
      },
      scopePath,
    );
    if (!removed) {
      return NextResponse.json({ error: "fact not found" }, { status: 404 });
    }
    return NextResponse.json({ removed: id });
  } catch (e) {
    if (e instanceof RemovalNotRecordedError) {
      // Removed, though the change feed does not say so.
      console.error(`[memory] ${e.message}`);
      return NextResponse.json({ removed: id });
    }
    if (e instanceof AccessDeniedError) {
      return NextResponse.json({ error: e.decision.reason }, { status: 403 });
    }
    if (e instanceof MemoryServiceError) {
      return NextResponse.json({ error: e.message }, { status: 502 });
    }
    throw e;
  }
}
