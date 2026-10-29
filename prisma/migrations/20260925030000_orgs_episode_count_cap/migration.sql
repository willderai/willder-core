-- orgs.episodeCount and orgs.episodeCapIncluded have been in schema.prisma,
-- and read by services/guardrails.ts, with no migration ever creating them:
-- existing databases got them from `prisma db push`. A database built by
-- `prisma migrate deploy` alone lacked them, so the first memory ingest failed.
--
-- IF NOT EXISTS because the databases that were pushed already have both
-- columns, and for them this must change nothing. Existing orgs get the
-- defaults the schema declares, so no backfill is needed.

ALTER TABLE "orgs"
  ADD COLUMN IF NOT EXISTS "episodeCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "episodeCapIncluded" INTEGER NOT NULL DEFAULT 1000;
