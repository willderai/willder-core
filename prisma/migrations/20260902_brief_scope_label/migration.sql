-- Keep Brief.scopePath ALWAYS a valid ltree value. Brief.scopePath is
-- AUTHORIZATION-BEARING (check() enforces against it, cast to
-- `::ltree`, labels restricted to [A-Za-z0-9_]), but services/agents/qa-run.ts
-- and services/agents/run-loop.ts both wrote a human-readable display label
-- ('(target) <host>') straight into scopePath for a scope-less QA run — never a
-- valid ltree value, so check() raises at the cast for these rows instead of
-- allowing or denying. The scope check only guards this in the handler (mcp/tools.ts,
-- get_my_brief's briefId path: deny+audit instead of crash) — this migration
-- plus the two write-path fixes is the real fix underneath.
--
-- Adds a dedicated display-only field for the host label, then backfills every
-- existing malformed row: moves today's bad display-label value out of
-- scopePath into the new scopeLabel column, and sets scopePath to the org root
-- (orgRootPath()'s deterministic `org_<orgId>`, services/access/check.ts) —
-- same backfill shape as the Draft/Campaign scopePath migration. Nobody
-- loses or gains access on migration day: these rows were never actually
-- authorizable before (they crashed at the cast rather than allowing or
-- denying), so landing them on the org root only newly-allows an org-root-
-- scoped token, the same floor every other unscoped row already sits at.
ALTER TABLE "briefs" ADD COLUMN "scopeLabel" TEXT;

UPDATE "briefs"
SET "scopeLabel" = "scopePath",
    "scopePath" = 'org_' || "orgId"
WHERE "scopePath" !~ '^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$';
