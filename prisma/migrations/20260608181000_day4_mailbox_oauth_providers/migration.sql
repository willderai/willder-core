-- Day 4 (revised): connect mailboxes via direct provider OAuth (Gmail API +
-- Microsoft Graph) instead of a paid aggregator. Swap the IntegrationProvider
-- enum values (unipile -> gmail/outlook) and add encryptedTokens (we now hold the
-- OAuth tokens ourselves, encrypted at rest). The integrations table is empty at
-- this point, so dropping the old value is safe.

-- AlterEnum: recreate IntegrationProvider with the new values.
ALTER TYPE "IntegrationProvider" RENAME TO "IntegrationProvider_old";
CREATE TYPE "IntegrationProvider" AS ENUM ('gmail', 'outlook');
ALTER TABLE "integrations"
  ALTER COLUMN "provider" TYPE "IntegrationProvider"
  USING ("provider"::text::"IntegrationProvider");
DROP TYPE "IntegrationProvider_old";

-- AlterTable: store the (encrypted) OAuth tokens we now hold directly.
ALTER TABLE "integrations" ADD COLUMN "encryptedTokens" TEXT;
