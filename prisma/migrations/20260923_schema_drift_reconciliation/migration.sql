-- Reconcile the migration history with schema.prisma for five live features whose
-- tables and columns were only ever created by an ad-hoc `prisma db push`, so no
-- migration file records them. A database built from the migration history alone
-- (a new developer, staging, or DR environment) is missing all of them, which
-- breaks org roles, entity aliases, the founder-interest waitlist, contact/account
-- enrichment, and the onboarding and memory-chat preferences.
--
-- Every statement is idempotent. Environments that already carry these objects from
-- the earlier `db push` (production is expected to) apply this as a no-op; only the
-- environments genuinely missing them are changed. That keeps `migrate deploy` safe
-- to run everywhere without a manual `migrate resolve` step first.
--
-- Deliberately NOT reconciled here:
--   * memory_chunks.embedding — `migrate diff` reports it as a drop because the
--     column is intentionally unmapped in schema.prisma (Prisma has no native vector
--     type; the column is managed by raw SQL). See MemoryChunk's schema comment.
--   * orgs.episodeCount / orgs.episodeCapIncluded — owned by the separate migration
--     ordering item, added by 20260919_orgs_episode_count_cap.

-- Entity resolver: org-level role registry ("our CEO" -> a specific user).
CREATE TABLE IF NOT EXISTS "org_roles" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "aliases" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_roles_pkey" PRIMARY KEY ("id")
);

-- Entity resolver: alias registry, one row per entity.
CREATE TABLE IF NOT EXISTS "entity_aliases" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "canonicalName" TEXT NOT NULL,
    "aliases" TEXT[],
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "entity_aliases_pkey" PRIMARY KEY ("id")
);

-- Public founder-rate interest log (no tenant column by design: sign-ups happen
-- before an org exists).
CREATE TABLE IF NOT EXISTS "founder_interest" (
    "id" TEXT NOT NULL,
    "clerkUserId" TEXT,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "founder_interest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "org_roles_orgId_idx" ON "org_roles"("orgId");
CREATE UNIQUE INDEX IF NOT EXISTS "org_roles_orgId_role_key" ON "org_roles"("orgId", "role");
CREATE INDEX IF NOT EXISTS "entity_aliases_orgId_idx" ON "entity_aliases"("orgId");
CREATE UNIQUE INDEX IF NOT EXISTS "entity_aliases_orgId_entityId_key" ON "entity_aliases"("orgId", "entityId");

-- Account ownership and the transient enrichment-phase field the contacts and
-- accounts UIs read.
ALTER TABLE "accounts"
  ADD COLUMN IF NOT EXISTS "enrichStatus" TEXT,
  ADD COLUMN IF NOT EXISTS "ownerId" TEXT;

ALTER TABLE "contacts"
  ADD COLUMN IF NOT EXISTS "enrichStatus" TEXT;

CREATE INDEX IF NOT EXISTS "accounts_ownerId_idx" ON "accounts"("ownerId");

-- Onboarding completion flag and the memory-chat display name.
ALTER TABLE "org_preferences"
  ADD COLUMN IF NOT EXISTS "memoryChatName" TEXT,
  ADD COLUMN IF NOT EXISTS "onboardingDone" BOOLEAN NOT NULL DEFAULT false;

-- Pricing pivoted to PAYG free/founder plans; the day-1 'trial' default was never
-- updated to match schema.prisma, so a fresh database issued the wrong plan to
-- every org created without an explicit value.
ALTER TABLE "orgs" ALTER COLUMN "plan" SET DEFAULT 'free';

-- Foreign keys. ALTER TABLE ... ADD CONSTRAINT has no IF NOT EXISTS in Postgres 16,
-- so each is guarded on the catalog by constraint name.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounts_ownerId_fkey') THEN
    ALTER TABLE "accounts" ADD CONSTRAINT "accounts_ownerId_fkey"
      FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_roles_orgId_fkey') THEN
    ALTER TABLE "org_roles" ADD CONSTRAINT "org_roles_orgId_fkey"
      FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_roles_userId_fkey') THEN
    ALTER TABLE "org_roles" ADD CONSTRAINT "org_roles_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entity_aliases_orgId_fkey') THEN
    ALTER TABLE "entity_aliases" ADD CONSTRAINT "entity_aliases_orgId_fkey"
      FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;
