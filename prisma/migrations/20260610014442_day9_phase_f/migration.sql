-- CreateEnum
CREATE TYPE "FeedbackEventType" AS ENUM ('edited', 'approved', 'rejected', 'replied', 'booked');

-- CreateTable
CREATE TABLE "feedback_events" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "draftId" TEXT,
    "eventType" "FeedbackEventType" NOT NULL,
    "originalBody" TEXT,
    "editedBody" TEXT,
    "actorId" TEXT,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_preferences" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "toneOverride" TEXT,
    "forbiddenTopics" TEXT,
    "customInstruction" TEXT,
    "preferredOpener" TEXT,
    "signOffName" TEXT,
    "maxDraftsPerDay" INTEGER NOT NULL DEFAULT 200,
    "maxSendsPerDay" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "feedback_events_orgId_idx" ON "feedback_events"("orgId");

-- CreateIndex
CREATE INDEX "feedback_events_orgId_eventType_idx" ON "feedback_events"("orgId", "eventType");

-- CreateIndex
CREATE INDEX "feedback_events_orgId_draftId_idx" ON "feedback_events"("orgId", "draftId");

-- CreateIndex
CREATE UNIQUE INDEX "org_preferences_orgId_key" ON "org_preferences"("orgId");

-- AddForeignKey
ALTER TABLE "feedback_events" ADD CONSTRAINT "feedback_events_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_events" ADD CONSTRAINT "feedback_events_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "drafts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_preferences" ADD CONSTRAINT "org_preferences_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
