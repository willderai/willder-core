-- Replace fixed linkedin/twitter columns with a flexible JSON bag on both tables.
-- No data to migrate — columns were just added this session with no writes yet.

ALTER TABLE "contacts" DROP COLUMN IF EXISTS "linkedin";
ALTER TABLE "contacts" DROP COLUMN IF EXISTS "twitter";
ALTER TABLE "contacts" ADD COLUMN "socialLinks" JSONB NOT NULL DEFAULT '{}';

ALTER TABLE "accounts" DROP COLUMN IF EXISTS "linkedin";
ALTER TABLE "accounts" DROP COLUMN IF EXISTS "twitter";
ALTER TABLE "accounts" ADD COLUMN "socialLinks" JSONB NOT NULL DEFAULT '{}';
