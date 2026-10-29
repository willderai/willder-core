-- Real per-resource scope on Draft and Campaign, mirroring
-- Brief.scopePath. Root cause of the org-wide draft/campaign leak found
-- in review: draft_list, campaign_list,
-- draft_approve, draft_reject each gated on
-- check(ctx, { scope: cap.scopePath }) -- the capability's OWN scope, which a
-- live token always covers -- and then queried the DB by orgId alone. Neither
-- Draft nor Campaign had a scope column at all, so there was no row-level
-- value to gate against; a child-scoped capability token could see (contact
-- emails included) or approve/reject every draft and campaign in the org, not
-- just its own scope's.
--
-- Backfilled to the org root (orgRootPath()'s deterministic `org_<orgId>`,
-- services/access/check.ts) for every existing row so nobody loses access on
-- migration day: that is exactly current (unscoped) behavior, since every row
-- was effectively org-root-visible before this column existed, and an
-- org-root-scoped capability's own scope trivially covers the org root.
-- NOT NULL with no DB-level default on purpose -- unlike audit_log's runId
-- (nullable, no backfill possible), a resource's scope is a real value every
-- row must carry for the gate to mean anything, and the right value is always
-- org-specific, so every creation call site sets it explicitly rather than
-- relying on a static column default.
ALTER TABLE "drafts" ADD COLUMN "scopePath" TEXT;
UPDATE "drafts" SET "scopePath" = 'org_' || "orgId" WHERE "scopePath" IS NULL;
ALTER TABLE "drafts" ALTER COLUMN "scopePath" SET NOT NULL;

ALTER TABLE "campaigns" ADD COLUMN "scopePath" TEXT;
UPDATE "campaigns" SET "scopePath" = 'org_' || "orgId" WHERE "scopePath" IS NULL;
ALTER TABLE "campaigns" ALTER COLUMN "scopePath" SET NOT NULL;

-- Equality lookups only (mcp/tools.ts filters draft_list/campaign_list by
-- `scopePath: cap.scopePath`, same exact-match pattern get_my_brief already
-- uses for Brief.scopePath) -- a plain btree index, not the GIST/ltree index
-- day3's scopes/capabilities tables use for ancestor-containment (`@>`)
-- queries.
CREATE INDEX "drafts_orgId_scopePath_idx" ON "drafts"("orgId", "scopePath");
CREATE INDEX "campaigns_orgId_scopePath_idx" ON "campaigns"("orgId", "scopePath");
