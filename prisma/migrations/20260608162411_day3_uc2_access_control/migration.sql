-- Enable the ltree extension for the access-control scope tree. `path`/`scopePath`
-- are declared TEXT in Prisma for client ergonomics; check() casts them to ltree
-- (`path::ltree @> $::ltree`) for ancestor-containment queries. See
-- services/access/check.ts.
CREATE EXTENSION IF NOT EXISTS ltree;

-- CreateEnum
CREATE TYPE "GranteeType" AS ENUM ('user', 'role', 'agent');

-- CreateEnum
CREATE TYPE "Permission" AS ENUM ('read', 'write', 'admin');

-- CreateEnum
CREATE TYPE "AuditDecision" AS ENUM ('allow', 'deny');

-- CreateTable
CREATE TABLE "scopes" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scopes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grants" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "granteeType" "GranteeType" NOT NULL,
    "granteeId" TEXT NOT NULL,
    "permission" "Permission" NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capabilities" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "scopePath" TEXT NOT NULL,
    "permission" "Permission" NOT NULL DEFAULT 'read',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "capabilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target" TEXT,
    "decision" "AuditDecision" NOT NULL,
    "reason" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scopes_orgId_idx" ON "scopes"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "scopes_orgId_path_key" ON "scopes"("orgId", "path");

-- CreateIndex
CREATE INDEX "grants_orgId_idx" ON "grants"("orgId");

-- CreateIndex
CREATE INDEX "grants_orgId_granteeType_granteeId_idx" ON "grants"("orgId", "granteeType", "granteeId");

-- CreateIndex
CREATE UNIQUE INDEX "grants_scopeId_granteeType_granteeId_permission_key" ON "grants"("scopeId", "granteeType", "granteeId", "permission");

-- CreateIndex
CREATE UNIQUE INDEX "capabilities_tokenHash_key" ON "capabilities"("tokenHash");

-- CreateIndex
CREATE INDEX "capabilities_orgId_idx" ON "capabilities"("orgId");

-- CreateIndex
CREATE INDEX "capabilities_orgId_agentId_idx" ON "capabilities"("orgId", "agentId");

-- CreateIndex
CREATE INDEX "audit_log_orgId_at_idx" ON "audit_log"("orgId", "at");

-- GIST indexes on the ltree expression power the ancestor-containment (`@>`)
-- queries in check() (manual: Prisma can't express expression/GIST indexes here).
CREATE INDEX "scopes_path_gist_idx" ON "scopes" USING gist (("path"::ltree));
CREATE INDEX "capabilities_scopePath_gist_idx" ON "capabilities" USING gist (("scopePath"::ltree));

-- AddForeignKey
ALTER TABLE "scopes" ADD CONSTRAINT "scopes_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grants" ADD CONSTRAINT "grants_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grants" ADD CONSTRAINT "grants_scopeId_fkey" FOREIGN KEY ("scopeId") REFERENCES "scopes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capabilities" ADD CONSTRAINT "capabilities_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
