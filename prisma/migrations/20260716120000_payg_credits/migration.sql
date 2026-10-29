-- Pay-as-you-go credits.
-- Replaces the governance-tier subscription model with a single prepaid credit
-- balance: a welcome grant plus purchased packs, drawn down by accepted
-- artifacts.
--
-- Moved here from 20260716_payg_credits, which sorted before
-- 20260716_v2_billing, the migration that adds the columns read and dropped
-- below (see the note in that directory).
--
-- The whole change is conditional on "bonusCredits" still existing, which is
-- true only for a database that has the v2 billing columns and has not yet
-- converted them. Databases migrated before the move already applied the
-- original and no longer have the column, so for them this changes nothing,
-- and in particular never recomputes a live credit balance.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'orgs'
      AND column_name = 'bonusCredits'
  ) THEN
    -- 1. Single spendable balance.
    ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "creditBalance" INTEGER NOT NULL DEFAULT 0;

    -- 2. Backfill the balance from any prior welcome grant + unused tier allowance.
    UPDATE "orgs"
    SET "creditBalance" = "bonusCredits" + GREATEST(0, "includedCredits" - "usedCredits");

    -- 3. Drop the subscription/tier columns: no tiers under PAYG.
    ALTER TABLE "orgs"
      DROP COLUMN "stripeSubscriptionId",
      DROP COLUMN "stripeSubscriptionStatus",
      DROP COLUMN "billingTier",
      DROP COLUMN "includedCredits",
      DROP COLUMN "usedCredits",
      DROP COLUMN "bonusCredits",
      DROP COLUMN "creditsPeriodEnd";
  END IF;
END $$;
