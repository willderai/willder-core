// Finding, and removing, versions that escaped person erasures made before
// services/memory/erasure-lineage.ts.
//
// Before it, an erasure removed what named the person and kept what was written in place of
// it: a correction of a fact that named them survived. Those erasures recorded no ids of the
// versions they removed, and the text that named the person is gone by design, so the only
// trace left is the blanked announcement: the `create` event of a version that is no longer
// stored, with an empty summary. A fact's or a connector item's announcement is the first line
// of its text, so an empty one was blanked by an erasure, or, rarely, began with a blank line:
// the report lists the ids for a person to check before anything is removed.
//
// THE ONE RULE: a version is removed here only when it was written in place of such a
// version, through the same links an erasure follows now (`versionsWrittenInPlaceOf`). The
// blanked versions are marked erased too, which blanks the rest of their events: a correction's
// removal announced before 2026-10-13 carries the corrected text. What it cannot find: a version an earlier erasure removed whose
// announcement never named the person (a fact filed under them whose text said only "She ..."),
// whose correction is linked to nothing that says so. Nor a correction made before
// 2026-10-05, which shares no authorization with its removal and has no edge.
//
// It is a report first: `findEscapedReplacements` reads and changes nothing, and
// `eraseEscapedReplacements` removes what it found as one audited erasure request. Running it
// again finds nothing more. Run by scripts/erase-escaped-replacements.ts.
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { AccessDeniedError, check, type AccessContext } from "@/services/access";
import { FACT_RECORD_TYPE } from "./change-events";
import { addCounts, noCounts, recordErasureCounts, recordErasureStep, type ErasureRequest } from "./erasure-accounting";
import {
  markVersionsErased,
  removeGraphCopies,
  removeVersions,
  storedCopiesOf,
  versionsWrittenInPlaceOf,
} from "./erasure-lineage";
import { markApplied, versionIdEntry } from "./erasure-suppression";

/** What a look for escaped versions found in one org: ids only, never text. */
export interface EscapedReplacements {
  /** Versions an earlier erasure blanked that are no longer stored: where the look starts. */
  erasedVersions: string[];
  /** Versions written in place of those, still stored. */
  replacements: string[];
}

/**
 * The versions in `orgId` written in place of a version an earlier erasure blanked. Reads only.
 * An org no erasure ever ran in has none.
 */
export async function findEscapedReplacements(orgId: string): Promise<EscapedReplacements> {
  const lastErasure = await db.erasureSuppression.findFirst({
    where: { orgId },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (!lastErasure) return { erasedVersions: [], replacements: [] };
  // A blanked announcement, of a version announced before the latest erasure, that is no
  // longer stored as a fact's row or as a connector item's episode.
  const blanked = await db.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT e."recordId" AS id
    FROM change_events e
    WHERE e."orgId" = ${orgId} AND e."recordType" = ${FACT_RECORD_TYPE} AND e.op = 'create' AND e.summary = ''
      AND e."createdAt" <= (${lastErasure.createdAt.toISOString()}::timestamptz AT TIME ZONE 'UTC')
      AND NOT EXISTS (SELECT 1 FROM memory_chunks c WHERE c."orgId" = e."orgId" AND c.id = e."recordId")
      AND NOT EXISTS (
        SELECT 1 FROM source_files f JOIN sources s ON s.id = f."sourceId"
        WHERE s."orgId" = e."orgId" AND (f."episodeId" = e."recordId" OR e."recordId" = ANY (f."episodeIds"))
      )
    ORDER BY id
  `;
  const erasedVersions = blanked.map((row) => row.id);
  // A version an erasure removed has blank announcements and is no longer stored, so it is one
  // of the versions the walk starts from, never one it finds.
  return { erasedVersions, replacements: await versionsWrittenInPlaceOf(db, orgId, erasedVersions) };
}

/**
 * Remove what {@link findEscapedReplacements} finds in `ctx.orgId`, as one erasure request: the
 * graph copies first, then the rows, the text of their change events and their ids, in one
 * transaction with the request's `person.erased` row. Only a caller with `access.manage` on the
 * org root may run it. Returns nothing removed, and writes no `person.erased` row, when nothing
 * escaped; the access decision is audited either way.
 */
export async function eraseEscapedReplacements(
  ctx: AccessContext,
): Promise<EscapedReplacements & { requestId: string | null; removedChunks: number }> {
  const requestId = randomUUID();
  const decision = await check(ctx, { action: "access.manage", target: `person_erasure:${requestId}` });
  if (!decision.allowed) throw new AccessDeniedError(decision);

  const found = await findEscapedReplacements(ctx.orgId);
  if (found.replacements.length === 0) return { ...found, requestId: null, removedChunks: 0 };
  const request: ErasureRequest = { requestId, contactIds: [] };
  const copies = await storedCopiesOf(ctx.orgId, found.replacements);
  const graph = await removeGraphCopies(ctx.orgId, copies);
  const removed = await db.$transaction(async (tx) => {
    const seeds = await markVersionsErased(tx, ctx.orgId, requestId, found.erasedVersions);
    const versions = await removeVersions(tx, ctx.orgId, requestId, found.replacements, copies);
    const counts = {
      graph,
      vector: { chunks: versions.chunks },
      changeFeed: { summariesBlanked: seeds + versions.summariesBlanked },
      lineage: { replacements: found.replacements.length, announced: 0 },
    };
    await recordErasureStep(tx, ctx, request, counts);
    await recordErasureCounts(tx, ctx, requestId, addCounts(noCounts(), counts), []);
    // Removed in this transaction, so applied: the org still reads as having carried out every erasure.
    await markApplied(tx, ctx.orgId, `person_erasure:${requestId}`, {
      requestIds: [requestId],
      entries: [...found.erasedVersions, ...found.replacements].map((id) => versionIdEntry(ctx.orgId, id)),
    });
    return versions;
  });
  return { ...found, requestId, removedChunks: removed.chunks };
}
