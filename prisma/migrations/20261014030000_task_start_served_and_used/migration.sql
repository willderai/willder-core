-- The task-start block's served-vs-used log (services/memory/task-start-served.ts): which
-- items each block served, at which line, and which of them a later call of the same session
-- named or got back. Ids and positions only, never text.
--
-- Additive: two new tables, nothing existing changes. A version's rows go with it, through
-- the version foreign keys, so deleting a fact version (as a person erasure does) deletes
-- every row about it.

-- CreateTable
CREATE TABLE "task_start_served" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "sessionKey" TEXT NOT NULL,
    "scopePath" TEXT NOT NULL,
    "taskKey" TEXT NOT NULL,
    "servingId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "lineCount" INTEGER NOT NULL,
    "itemType" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "namedId" TEXT NOT NULL,
    "versionId" TEXT,
    "servedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_start_served_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_start_item_uses" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "sessionKey" TEXT NOT NULL,
    "namedId" TEXT NOT NULL,
    "versionId" TEXT,
    "field" TEXT NOT NULL,
    "calledAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_start_item_uses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "task_start_served_orgId_agentId_sessionKey_namedId_idx" ON "task_start_served"("orgId", "agentId", "sessionKey", "namedId");

-- CreateIndex
CREATE INDEX "task_start_served_servedAt_idx" ON "task_start_served"("servedAt");

-- CreateIndex
CREATE INDEX "task_start_served_orgId_namedId_idx" ON "task_start_served"("orgId", "namedId");

-- CreateIndex
CREATE INDEX "task_start_served_versionId_idx" ON "task_start_served"("versionId");

-- CreateIndex
CREATE INDEX "task_start_item_uses_orgId_agentId_sessionKey_namedId_idx" ON "task_start_item_uses"("orgId", "agentId", "sessionKey", "namedId");

-- CreateIndex
CREATE INDEX "task_start_item_uses_calledAt_idx" ON "task_start_item_uses"("calledAt");

-- CreateIndex
CREATE INDEX "task_start_item_uses_orgId_namedId_idx" ON "task_start_item_uses"("orgId", "namedId");

-- CreateIndex
CREATE INDEX "task_start_item_uses_versionId_idx" ON "task_start_item_uses"("versionId");

-- AddForeignKey
ALTER TABLE "task_start_served" ADD CONSTRAINT "task_start_served_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_start_served" ADD CONSTRAINT "task_start_served_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "memory_chunks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_start_item_uses" ADD CONSTRAINT "task_start_item_uses_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_start_item_uses" ADD CONSTRAINT "task_start_item_uses_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "memory_chunks"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A served-vs-used report reads these two tables through
-- the production read-only role. Granted only where that role exists, so a database without it
-- (a developer's, CI's) applies this migration unchanged.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'willder_readonly') THEN
    GRANT SELECT ON "task_start_served", "task_start_item_uses" TO willder_readonly;
  END IF;
END
$$;
