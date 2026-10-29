-- Remember that an
-- agent polling GET /api/changes/notice is currently denied, so the denial is
-- audited once instead of on every poll. Nullable, no default, no backfill: every
-- existing cursor starts in the "not denied" state it is already in.

ALTER TABLE "agent_cursors" ADD COLUMN "deniedSince" TIMESTAMP(3);
