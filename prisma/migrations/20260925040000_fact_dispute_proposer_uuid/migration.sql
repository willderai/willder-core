-- Item handoff-gate-c2-dispute-per-pair-key-20260921: record the proposing side's
-- edge uuid so the scope scan can de-duplicate on the real (existing, proposer)
-- pair. Nullable and additive: existing rows keep NULL, since their proposer edge
-- was never stored and cannot be recovered.

ALTER TABLE "fact_disputes" ADD COLUMN "proposerFactUuid" TEXT;
