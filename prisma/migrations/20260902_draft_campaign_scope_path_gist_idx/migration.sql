-- Follow-up: draft_list/campaign_list moved from exact scopePath
-- equality to ltree ancestor-or-self containment (`@>`), so the plain btree
-- indexes the prior migration added (`drafts_orgId_scopePath_idx`,
-- `campaigns_orgId_scopePath_idx`) no longer support the operator these
-- queries actually run -- btree supports equality/comparison on ltree, not
-- `@>`. Note: without a matching
-- index, draft_list/campaign_list degrade to a sequential scan + evaluate
-- over every row in the org before LIMIT applies, so latency grows with
-- tenant size. Same fix shape day3's access-control migration already used
-- for the identical problem on scopes/capabilities (manual SQL: Prisma can't
-- express expression/GIST indexes).
CREATE INDEX "drafts_scopePath_gist_idx" ON "drafts" USING gist (("scopePath"::ltree));
CREATE INDEX "campaigns_scopePath_gist_idx" ON "campaigns" USING gist (("scopePath"::ltree));
