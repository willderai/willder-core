-- 5 tables carry an
-- authorization-bearing `scopePath` with zero index covering it --
-- briefs, sources, fact_disputes, memory_chunks, artifact_usage. Same
-- latency/DoS-shaped completeness gap already caught on
-- drafts/campaigns (2026-09-02, `20260902_draft_campaign_scope_path`):
-- without a matching index, a scope-filtered read degrades to a
-- sequential scan + evaluate over every row in the org.
--
-- Unlike that same PR's own gist follow-up
-- (`20260902_draft_campaign_scope_path_gist_idx`), this is NOT a gist/
-- ltree-expression index. Verified against each of these 5 tables' real
-- read paths first (services/memory/pgvector-store.ts's retrieve(),
-- app/api/briefs/[id]/route.ts's get_my_brief -> mcp/tools.ts,
-- app/api/sources/route.ts, app/api/facts/disputes/route.ts,
-- services/billing/index.ts's getBillingSummary) -- every one of them
-- filters scopePath by plain equality or a `LIKE 'prefix.%'` predicate,
-- never an `::ltree` cast/containment operator (`@>`/`<@`), so a gist
-- expression index on scopePath::ltree could not serve any of these
-- queries at all, on any table size. A plain btree on (orgId, scopePath)
-- is the index construct these queries actually use -- same as the
-- btree half drafts/campaigns already shipped alongside their gist half.
--
-- Mirrors schema.prisma's new `@@index([orgId, scopePath])` on Brief,
-- Source, FactDispute, MemoryChunk, ArtifactUsage (Prisma expresses a
-- plain btree natively, no raw-SQL escape hatch needed here unlike the
-- gist case).
CREATE INDEX "briefs_orgId_scopePath_idx" ON "briefs"("orgId", "scopePath");
CREATE INDEX "sources_orgId_scopePath_idx" ON "sources"("orgId", "scopePath");
CREATE INDEX "fact_disputes_orgId_scopePath_idx" ON "fact_disputes"("orgId", "scopePath");
CREATE INDEX "memory_chunks_orgId_scopePath_idx" ON "memory_chunks"("orgId", "scopePath");
CREATE INDEX "artifact_usage_orgId_scopePath_idx" ON "artifact_usage"("orgId", "scopePath");
