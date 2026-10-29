-- The task-start block's
-- storage. `conventions` holds the standing rules served at the start of a session;
-- `task_start_deliveries` is the delivered_to edge recording which session got them.
--
-- New tables, no column added to any table already serving traffic.

CREATE TYPE "ConventionKind" AS ENUM ('convention', 'decision');

CREATE TABLE "conventions" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "scopePath" TEXT NOT NULL,
    "kind" "ConventionKind" NOT NULL,
    "subject" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "supersedesId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conventions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "task_start_deliveries" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "sessionKey" TEXT NOT NULL,
    "revision" TEXT NOT NULL,
    "deliveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastCallAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_start_deliveries_pkey" PRIMARY KEY ("id")
);

-- A rule has at most one replacement, so two writers racing to supersede the same
-- rule cannot both succeed; the loser gets a unique violation.
CREATE UNIQUE INDEX "conventions_supersedesId_key" ON "conventions"("supersedesId");

CREATE INDEX "conventions_orgId_createdAt_idx" ON "conventions"("orgId", "createdAt");

-- The task-start read spells scope containment in `mode: "ltree"`, served by a GiST
-- expression index, same as change_events_scopePath_gist_idx.
CREATE INDEX "conventions_scopePath_gist_idx" ON "conventions" USING gist (("scopePath"::ltree));

CREATE UNIQUE INDEX "task_start_deliveries_orgId_agentId_sessionKey_key" ON "task_start_deliveries"("orgId", "agentId", "sessionKey");

ALTER TABLE "conventions" ADD CONSTRAINT "conventions_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "conventions" ADD CONSTRAINT "conventions_supersedesId_fkey"
    FOREIGN KEY ("supersedesId") REFERENCES "conventions"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "task_start_deliveries" ADD CONSTRAINT "task_start_deliveries_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
