// The connector records that point at graph episodes (`SourceFile.episodeId` and
// `episodeIds`), and dropping a pointer once its episode is gone.
//
// The rule: a record never points at an episode the graph no longer holds. A sync that
// replaces or removes a file retires every episode its record points at, and reads an
// episode it cannot find as a failure (lib/inngest/connector-records.ts, retireEpisode).
// So whatever removes an episode by another path drops the pointers to it: a person
// erasure (services/memory/person-erasure.ts) and the retirement of one stored chunk's
// episodes, when a fact is deleted or erased (`removeChunkFacts`). A record left pointing
// at a removed episode would fail every later sync of its file, and leave the old
// version's content served.
import { db } from "@/lib/db";

/** Drop this org's connector records' pointers to `episodeIds`, episodes the graph no longer holds. */
export async function dropEpisodePointers(orgId: string, episodeIds: readonly string[]): Promise<void> {
  if (episodeIds.length === 0) return;
  const ids = [...episodeIds];
  await db.$executeRaw`
    UPDATE source_files AS f
    SET "episodeId" = CASE WHEN f."episodeId" = ANY (${ids}::text[]) THEN NULL ELSE f."episodeId" END,
        "episodeIds" = ARRAY(SELECT e FROM unnest(f."episodeIds") AS e WHERE e <> ALL (${ids}::text[]))
    FROM sources AS s
    WHERE f."sourceId" = s.id
      AND s."orgId" = ${orgId}
      AND (f."episodeId" = ANY (${ids}::text[]) OR f."episodeIds" && ${ids}::text[])
  `;
  // A record left with no episode no longer addresses any partition.
  await db.$executeRaw`
    UPDATE source_files AS f
    SET "episodeScopePath" = NULL
    FROM sources AS s
    WHERE f."sourceId" = s.id
      AND s."orgId" = ${orgId}
      AND f."episodeId" IS NULL
      AND cardinality(f."episodeIds") = 0
      AND f."episodeScopePath" IS NOT NULL
  `;
}
