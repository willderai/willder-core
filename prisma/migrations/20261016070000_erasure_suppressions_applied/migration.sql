-- That what one suppression list entry stands for has been removed from this database
-- (services/memory/erasure-suppression.ts, markApplied). A new table, so no query on a live
-- table changes. Every applied row names a listed entry, so an org whose entries all have one
-- is the org whose two counts are equal.
CREATE TABLE "erasure_suppressions_applied" (
    "orgId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "by" TEXT NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "erasure_suppressions_applied_pkey" PRIMARY KEY ("orgId","kind","digest")
);

ALTER TABLE "erasure_suppressions_applied" ADD CONSTRAINT "erasure_suppressions_applied_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "erasure_suppressions_applied" ADD CONSTRAINT "erasure_suppressions_applied_orgId_kind_digest_fkey" FOREIGN KEY ("orgId", "kind", "digest") REFERENCES "erasure_suppressions"("orgId", "kind", "digest") ON DELETE CASCADE ON UPDATE CASCADE;

-- Only entries known to be carried out are marked; every other entry stays unapplied, and its
-- org's memory_query value check makes no claim until `scripts/complete-restore.ts` (or the
-- erasure sent again) carries it out. An erasure lists its person first and removes them after,
-- so an entry listed by an erasure that failed, or was running as this runs, is not known to be:
--  - an entry of a request that wrote its `person.erased` audit row, or that a later request
--    completed (that row's `earlierRequestIds`): the request removed everything it listed.
--    An address or name entry, though, has its time moved by any later erasure of the same
--    person that lists it again, and then stands for copies only that erasure removes; the
--    list does not say which erasure that was. So such an entry is marked only when no
--    erasure that has not completed started (its allowed access decision on
--    `person_erasure:<requestId>`) at or before the entry's time. Both times come from the
--    same erasure's clock, so the two are ordered whatever the app instances' clocks say;
--  - a `rule_id` entry: written in the transaction that redacts the rule (erasure-rules.ts);
--  - an entry a correction of an erased version was withdrawn under: written in the
--    transaction that removes it (erasure-lineage.ts, withdrawCorrectionOfErased).
-- A `version_id` entry is not marked on its own: an erasure lists the graph episodes it plans
-- to remove before it removes them.
INSERT INTO "erasure_suppressions_applied" ("orgId", "kind", "digest", "by")
WITH completed AS (
  SELECT a."orgId", a.metadata->>'requestId' AS "requestId"
  FROM "audit_log" a
  WHERE a.action = 'person.erased'
  UNION
  SELECT a."orgId", earlier."requestId"
  FROM "audit_log" a, jsonb_array_elements_text(COALESCE(a.metadata->'earlierRequestIds', '[]'::jsonb)) AS earlier("requestId")
  WHERE a.action = 'person.erased'
), unfinished AS (
  SELECT a."orgId", min(a."at") AS "startedAt"
  FROM "audit_log" a
  WHERE a.target LIKE '%person_erasure:%'
    AND a.decision = 'allow'
    AND a.action <> 'person.erased'
    AND substring(a.target FROM 'person_erasure:([^/]+)$') IS NOT NULL
    AND substring(a.target FROM 'person_erasure:([^/]+)$') <> 'reapply'
    AND NOT EXISTS (SELECT 1 FROM completed c
                    WHERE c."orgId" = a."orgId" AND c."requestId" = substring(a.target FROM 'person_erasure:([^/]+)$'))
  GROUP BY a."orgId", substring(a.target FROM 'person_erasure:([^/]+)$')
)
SELECT s."orgId", s."kind", s."digest", 'backfill'
FROM "erasure_suppressions" s
WHERE s."kind" = 'rule_id'
   OR s."requestId" LIKE 'correction-of-erased:%'
   OR (EXISTS (SELECT 1 FROM completed c WHERE c."orgId" = s."orgId" AND c."requestId" = s."requestId")
       AND (s."kind" IN ('contact_id', 'version_id')
            OR NOT EXISTS (SELECT 1 FROM unfinished u WHERE u."orgId" = s."orgId" AND u."startedAt" <= s."createdAt")));
