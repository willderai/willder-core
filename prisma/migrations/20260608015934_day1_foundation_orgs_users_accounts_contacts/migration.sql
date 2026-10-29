-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('owner', 'admin', 'member');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('active', 'inactive', 'archived');

-- CreateEnum
CREATE TYPE "ContactStatus" AS ENUM ('active', 'unsubscribed', 'bounced', 'archived');

-- CreateTable
CREATE TABLE "orgs" (
    "id" TEXT NOT NULL,
    "clerkOrgId" TEXT,
    "name" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'trial',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orgs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "clerkId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "status" "AccountStatus" NOT NULL DEFAULT 'active',
    "entityId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "accountId" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "title" TEXT,
    "status" "ContactStatus" NOT NULL DEFAULT 'active',
    "entityId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "orgs_clerkOrgId_key" ON "orgs"("clerkOrgId");

-- CreateIndex
CREATE UNIQUE INDEX "users_clerkId_key" ON "users"("clerkId");

-- CreateIndex
CREATE INDEX "users_orgId_idx" ON "users"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "users_orgId_email_key" ON "users"("orgId", "email");

-- CreateIndex
CREATE INDEX "accounts_orgId_idx" ON "accounts"("orgId");

-- CreateIndex
CREATE INDEX "accounts_orgId_domain_idx" ON "accounts"("orgId", "domain");

-- CreateIndex
CREATE INDEX "contacts_orgId_idx" ON "contacts"("orgId");

-- CreateIndex
CREATE INDEX "contacts_orgId_accountId_idx" ON "contacts"("orgId", "accountId");

-- CreateIndex
CREATE INDEX "contacts_orgId_email_idx" ON "contacts"("orgId", "email");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
