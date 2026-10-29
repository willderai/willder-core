-- Record that a connector text item's episode delete has started, so a retry
-- after a failure between the graph delete and the pointer drop can finish the
-- retirement instead of failing on an episode that is already gone. Nullable and
-- additive only: existing rows get NULL, which means no delete is in flight.

ALTER TABLE "source_files" ADD COLUMN "episodeRetireStartedAt" TIMESTAMP(3);
