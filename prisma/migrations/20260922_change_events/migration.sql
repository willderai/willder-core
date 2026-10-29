-- Item realtime-memory-slice-20260923, scope (1): the change feed's storage.
-- One row per governed write, inserted in the same transaction as that write.
--
-- New table, no column added to any table already serving traffic.

CREATE TYPE "ChangeOp" AS ENUM ('create', 'update', 'supersede', 'delete', 'revoke');

CREATE TABLE "change_events" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "seq" BIGINT NOT NULL,
    "scopePath" TEXT NOT NULL,
    "recordType" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "op" "ChangeOp" NOT NULL,
    "actorId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "change_events_pkey" PRIMARY KEY ("id")
);

-- Serves both the cursor read (orgId = $1 AND seq > $2 ORDER BY seq) and the
-- next-seq lookup (MAX(seq) WHERE orgId = $1), and enforces the per-org
-- gaplessness the advisory lock in services/memory/change-events.ts produces:
-- if the lock were ever bypassed, two writers racing on the same next seq get a
-- unique violation instead of two events silently sharing a cursor position.
CREATE UNIQUE INDEX "change_events_orgId_seq_key" ON "change_events"("orgId", "seq");

-- Scope filtering on the read path. readChanges() spells the containment in
-- `mode: "ltree"` (`<@` against an `::ltree`-cast column), and per
-- services/access/scope-containment.ts's index note that is served by a GiST
-- expression index, never by a plain btree on ("orgId", "scopePath") -- same
-- spelling drafts and campaigns already use
-- (20260902_draft_campaign_scope_path_gist_idx).
CREATE INDEX "change_events_scopePath_gist_idx" ON "change_events" USING gist (("scopePath"::ltree));

ALTER TABLE "change_events" ADD CONSTRAINT "change_events_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
