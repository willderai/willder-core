-- v2 billing: governance tier + accepted-artifact credits

ALTER TABLE "orgs"
  ADD COLUMN "stripeCustomerId" TEXT,
  ADD COLUMN "stripeSubscriptionId" TEXT,
  ADD COLUMN "stripeSubscriptionStatus" TEXT,
  ADD COLUMN "billingTier" TEXT NOT NULL DEFAULT 'free',
  ADD COLUMN "includedCredits" INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN "usedCredits" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "bonusCredits" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "creditsPeriodEnd" TIMESTAMP(3);

CREATE UNIQUE INDEX "orgs_stripeCustomerId_key" ON "orgs"("stripeCustomerId");

CREATE TABLE "artifact_usage" (
  "id"             TEXT NOT NULL,
  "orgId"          TEXT NOT NULL,
  "artifactType"   TEXT NOT NULL,
  "briefId"        TEXT,
  "draftId"        TEXT,
  "credits"        INTEGER NOT NULL,
  "scopePath"      TEXT,
  "actorId"        TEXT,
  "overage"        BOOLEAN NOT NULL DEFAULT false,
  "stripeReported" BOOLEAN NOT NULL DEFAULT false,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "artifact_usage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "artifact_usage_orgId_createdAt_idx" ON "artifact_usage"("orgId", "createdAt");

ALTER TABLE "artifact_usage"
  ADD CONSTRAINT "artifact_usage_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
