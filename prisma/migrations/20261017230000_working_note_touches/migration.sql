-- Claim touch-sets: the files a claimant edits, so two claims on different tasks that edit the
-- same file are told of each other (services/memory/claim-overlap.ts).
--
-- Additive: one column with a constant default and one index; no existing row, column or index
-- changes. Adding a column with a constant default rewrites no rows on Postgres 11 and later.

ALTER TABLE "working_notes" ADD COLUMN "touches" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- A claim post asks for other live claims whose touches share an element with its own.
CREATE INDEX "working_notes_touches_idx" ON "working_notes" USING GIN ("touches");
