-- CreateEnum
CREATE TYPE "IntegrationProvider" AS ENUM ('unipile');

-- CreateEnum
CREATE TYPE "IntegrationStatus" AS ENUM ('pending', 'connected', 'error', 'disconnected');

-- CreateTable
CREATE TABLE "integrations" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "externalAccountId" TEXT,
    "status" "IntegrationStatus" NOT NULL DEFAULT 'pending',
    "meta" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integrations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "integrations_orgId_idx" ON "integrations"("orgId");

-- CreateIndex
CREATE INDEX "integrations_orgId_provider_idx" ON "integrations"("orgId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "integrations_orgId_provider_externalAccountId_key" ON "integrations"("orgId", "provider", "externalAccountId");

-- AddForeignKey
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
