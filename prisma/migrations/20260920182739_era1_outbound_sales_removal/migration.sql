-- Era 1 outbound-sales removal (CEO product-coherence decision, 2026-09-20).
-- Drops Campaign / CampaignProspect / Draft — the cold-email campaign feature —
-- and their enums. Conversation/Message/Contact/Org/FeedbackEvent are untouched
-- except for the back-relations/relation fields removed in schema.prisma;
-- FeedbackEvent.draftId stays as a plain, unenforced column (no FK ever existed
-- on it in the reverse direction from Draft — see feedback_events_draftId_fkey
-- below, which IS dropped since it points at the table we're removing).

-- DropForeignKey
ALTER TABLE "campaign_prospects" DROP CONSTRAINT "campaign_prospects_campaignId_fkey";

-- DropForeignKey
ALTER TABLE "campaign_prospects" DROP CONSTRAINT "campaign_prospects_contactId_fkey";

-- DropForeignKey
ALTER TABLE "drafts" DROP CONSTRAINT "drafts_campaignId_fkey";

-- DropForeignKey
ALTER TABLE "drafts" DROP CONSTRAINT "drafts_contactId_fkey";

-- DropForeignKey
ALTER TABLE "drafts" DROP CONSTRAINT "drafts_orgId_fkey";

-- DropForeignKey
ALTER TABLE "campaigns" DROP CONSTRAINT "campaigns_orgId_fkey";

-- DropForeignKey
ALTER TABLE "feedback_events" DROP CONSTRAINT "feedback_events_draftId_fkey";

-- DropTable
DROP TABLE "campaign_prospects";

-- DropTable
DROP TABLE "drafts";

-- DropTable
DROP TABLE "campaigns";

-- DropEnum
DROP TYPE "CampaignStatus";

-- DropEnum
DROP TYPE "ProspectStatus";

-- DropEnum
DROP TYPE "DraftStatus";
