-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('draft', 'active', 'paused', 'completed');

-- CreateEnum
CREATE TYPE "ProspectStatus" AS ENUM ('queued', 'drafting', 'drafted', 'sent', 'replied', 'booked', 'failed');

-- CreateEnum
CREATE TYPE "DraftStatus" AS ENUM ('pending', 'approved', 'sent', 'rejected');

-- CreateTable
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "icp" TEXT NOT NULL DEFAULT '',
    "tone" TEXT NOT NULL DEFAULT '',
    "status" "CampaignStatus" NOT NULL DEFAULT 'draft',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_prospects" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "status" "ProspectStatus" NOT NULL DEFAULT 'queued',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_prospects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drafts" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "campaignId" TEXT,
    "contactId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "editedBody" TEXT,
    "status" "DraftStatus" NOT NULL DEFAULT 'pending',
    "generatedBy" TEXT,
    "model" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "campaigns_orgId_idx" ON "campaigns"("orgId");

-- CreateIndex
CREATE INDEX "campaigns_orgId_status_idx" ON "campaigns"("orgId", "status");

-- CreateIndex
CREATE INDEX "campaign_prospects_orgId_idx" ON "campaign_prospects"("orgId");

-- CreateIndex
CREATE INDEX "campaign_prospects_campaignId_status_idx" ON "campaign_prospects"("campaignId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_prospects_campaignId_contactId_key" ON "campaign_prospects"("campaignId", "contactId");

-- CreateIndex
CREATE INDEX "drafts_orgId_idx" ON "drafts"("orgId");

-- CreateIndex
CREATE INDEX "drafts_orgId_status_idx" ON "drafts"("orgId", "status");

-- CreateIndex
CREATE INDEX "drafts_campaignId_idx" ON "drafts"("campaignId");

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_prospects" ADD CONSTRAINT "campaign_prospects_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_prospects" ADD CONSTRAINT "campaign_prospects_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
