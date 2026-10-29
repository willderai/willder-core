-- agent-scope-full-removal-provenance-gap-20260918: services/access/check.ts's
-- agent branch (agent-scope-rederive-on-grant-change-20260918) answered "is this
-- agentId grant-governed" with a LIVE EXISTS query against "grants". That query
-- cannot distinguish "this agentId was never grant-governed" (the deliberate
-- grandfather case: system agents like copy-agent/research-agent, minted with
-- no /access/grants entry ever) from "this agentId's grants were all deleted
-- outside the DELETE /api/access/grants/:id cascade" — concretely, DELETE
-- /api/access/scopes/:id's `onDelete: Cascade` on Grant.scope, which hard-
-- deletes Grant rows with no application code in the path to stamp
-- Capability.revokedAt. Both land on zero current grant rows, so a stale wide
-- capability minted while grants existed stayed enforceable to natural expiry
-- (up to 90 days) once its last grant was removed this way.
--
-- grantGoverned is a persisted ratchet, not a live-derived flag: set true once
-- (at mint, or retroactively the moment this agentId's first grant is created —
-- see check.ts's deriveGrantGovernance() and the POST /api/access/grants
-- ratchet) and never cleared afterward by anything, including every one of
-- that agentId's grants later being deleted. check.ts now reads this column
-- instead of re-deriving governance from current "grants" existence.
--
-- derivedFromGrantId is provenance only (which grant first established
-- governance), deliberately NOT a foreign key: an `onDelete: SetNull` would
-- erase the exact fact this migration exists to make durable the moment that
-- grant is deleted, and `onDelete: Restrict` would block grant deletion
-- entirely. It may reference a Grant row that no longer exists; nothing reads
-- it back for authorization.
ALTER TABLE "capabilities" ADD COLUMN "grantGoverned" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "capabilities" ADD COLUMN "derivedFromGrantId" TEXT;

-- Backfill for existing tokens: the best available signal is today's "grants"
-- state, the same live signal check.ts used before this migration — this
-- cannot recover a removal that already happened before this deploy (that
-- capability was already, unrecoverably, in the gap), it only stops new ones.
-- One representative grant per (org, agentId) — the earliest on file — is
-- picked deterministically via DISTINCT ON so a capability with several
-- current agent grants gets exactly one provenance value, not an arbitrary
-- per-row planner choice.
UPDATE "capabilities" c
SET "grantGoverned" = true,
    "derivedFromGrantId" = earliest."id"
FROM (
  SELECT DISTINCT ON (g."orgId", g."granteeId") g."id", g."orgId", g."granteeId"
  FROM "grants" g
  WHERE g."granteeType" = 'agent'
  ORDER BY g."orgId", g."granteeId", g."createdAt" ASC
) earliest
WHERE c."orgId" = earliest."orgId" AND c."agentId" = earliest."granteeId";
