-- A connected source records whether connecting it let more people read its content
-- than can read it at the source, and how that was decided.
--
-- A source takes the access of the scope it lands in, not its own sharing list, so a
-- Drive folder shared with two people becomes readable by everyone in its scope. The
-- connect now measures that widening (services/access/source-widening.ts) and refuses
-- to go ahead without an explicit acknowledgement when it is above zero or unknown.
-- These columns record the path the connect took, the count, who decided and when,
-- and the audit row of the acknowledgement, beside "connectAuthorizationId".
--
-- Additive and reversible: one new enum and five nullable columns, no index (read by
-- source id), no backfill. A source connected before this existed carries nulls,
-- because nobody made this decision for it and none is invented.
CREATE TYPE "SourceWideningPath" AS ENUM ('no_widening', 'acknowledged', 'acknowledged_unknown');

ALTER TABLE "sources"
  ADD COLUMN "connectWideningPath" "SourceWideningPath",
  ADD COLUMN "connectWideningCount" INTEGER,
  ADD COLUMN "connectWideningById" TEXT,
  ADD COLUMN "connectWideningAt" TIMESTAMP(3),
  ADD COLUMN "connectWideningAuditId" TEXT;
