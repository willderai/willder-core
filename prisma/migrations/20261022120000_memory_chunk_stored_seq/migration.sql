-- The order rows were stored in, as a key that never ties (services/memory/fact-update.ts,
-- services/memory/conflict.ts).
--
-- "Which version was stored first" was decided by ("createdAt", "id"). "createdAt" is a
-- timestamp(3), so two versions stored in one millisecond tie on it, and "id" is a random
-- cuid2, so the tie went either way: the version stored second was told it was stored
-- first about half the time. "storedSeq"
-- is taken from a sequence by the INSERT that stores the row, so it is unique and in
-- insertion order, whatever the clock says; ("createdAt", "storedSeq") never ties.
--
-- Additive: one new column, its sequence and a unique index; no existing column, row value
-- or index changes. Rows stored before it are numbered in the order every reader already
-- put them in, ("createdAt", "id"), so no decision already made about them reads
-- differently, and every row stored after it numbers after all of them.
--
-- One transaction. The ALTER TABLE takes memory_chunks' ACCESS EXCLUSIVE lock and holds it
-- to COMMIT, so no row is inserted between the backfill and the column's default: a row is
-- either numbered by the backfill or by the sequence, never neither. The backfill rewrites
-- every row once. A deploy stopped part way leaves nothing behind, so
-- `prisma migrate resolve --rolled-back` and the next deploy apply it cleanly.

BEGIN;

ALTER TABLE "memory_chunks" ADD COLUMN "storedSeq" BIGINT;

CREATE SEQUENCE "memory_chunks_storedSeq_seq" AS BIGINT;

UPDATE "memory_chunks" m
SET "storedSeq" = ordered."n"
FROM (
  SELECT "id", row_number() OVER (ORDER BY "createdAt", "id") AS "n"
  FROM "memory_chunks"
) ordered
WHERE m."id" = ordered."id";

SELECT setval('"memory_chunks_storedSeq_seq"', COALESCE((SELECT max("storedSeq") FROM "memory_chunks"), 0) + 1, false);

ALTER TABLE "memory_chunks"
  ALTER COLUMN "storedSeq" SET DEFAULT nextval('"memory_chunks_storedSeq_seq"'),
  ALTER COLUMN "storedSeq" SET NOT NULL;

ALTER SEQUENCE "memory_chunks_storedSeq_seq" OWNED BY "memory_chunks"."storedSeq";

-- CreateIndex
CREATE UNIQUE INDEX "memory_chunks_storedSeq_key" ON "memory_chunks"("storedSeq");

COMMIT;
