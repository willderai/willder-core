-- Contact type (one of CONTACT_TYPES in lib/contact-types.ts)
-- Stored as TEXT for flexibility — no enum migration needed to add new types.
ALTER TABLE "contacts" ADD COLUMN "type" TEXT NOT NULL DEFAULT 'prospect';

-- Account enrichment fields
ALTER TABLE "accounts" ADD COLUMN "linkedin"    TEXT;
ALTER TABLE "accounts" ADD COLUMN "twitter"     TEXT;
ALTER TABLE "accounts" ADD COLUMN "description" TEXT;
ALTER TABLE "accounts" ADD COLUMN "industry"    TEXT;

-- Index contact type for filter queries
CREATE INDEX "contacts_orgId_type_idx" ON "contacts"("orgId", "type");
