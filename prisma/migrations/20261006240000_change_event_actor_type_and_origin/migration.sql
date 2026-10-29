-- Every change event names its writer's principal type and the entry point it came in
-- through, so the audit timeline export carries all six fields NIST AU-3 asks of an
-- audit record without guessing either one. Additive and nullable: events written
-- before this migration keep NULL, which the export reports as not recorded.

-- AlterTable
ALTER TABLE "change_events" ADD COLUMN "actorType" TEXT,
ADD COLUMN "origin" TEXT;
