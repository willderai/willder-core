-- Org deletion: one rule for an owner's request in the app and for Clerk's
-- `organization.deleted` (services/memory/org-deletion). The request revokes the org's agent
-- tokens, refuses new writes and starts a final export; seven days later every store
-- is cleared and this row, the receipt, is all that is left.
--
-- Additive: two enums, two tables, one function and its triggers; no existing row or
-- column changes.
--
-- 1. `org_deletions` has no foreign key to `orgs`, on purpose: it is the receipt of
--    the org's deletion and has to outlive the org. One open deletion per org is a
--    partial unique index, so a redelivered Clerk event and an owner's click cannot
--    start two.
--
-- 2. `org_admin_departures` keeps, for three days, the Clerk id of an owner or admin whose
--    last membership ended and whose `users` row went with it, so an `organization.deleted`
--    Clerk sent with that departure still names them a recipient of the final export.
--
-- 3. While an org has an open deletion the database refuses new rows, and changes to
--    rows, in its content and access tables. check() already refuses every write it is
--    asked about (services/access/check.ts); these triggers cover the writers that never
--    ask it: connector syncs, ingest jobs, system-issued tokens. They are AFTER triggers,
--    so an upsert that finds its row unchanged is still an update and is refused too;
--    lib/tenant.ts skips its seeding while a deletion is open for that reason.
--
--    Not refused: deletes (the deletion itself is one), any write once the org row is
--    gone, which is the deletion's own cascade setting a column to NULL, and an account
--    losing its owner when that person's `users` row is deleted. `capabilities`
--    refuses new rows only: revoking a token is an update, and so is a cancel restoring
--    one. Tables written by reads or by Clerk stay writable, so reads during the seven
--    days are still audited and still work: audit_log, audit_chain_heads, change_events,
--    fact_version_reads, session_scope_reads, task_start_*, agent_cursors, artifact_usage,
--    org_memberships, org_admin_departures, users, erasure_suppressions,
--    erasure_suppressions_applied.
--
-- CreateEnum
CREATE TYPE "OrgDeletionTrigger" AS ENUM ('owner', 'clerk');

-- CreateEnum
CREATE TYPE "OrgDeletionStatus" AS ENUM ('pending', 'deleting', 'deleted', 'cancelled');

-- CreateTable
CREATE TABLE "org_deletions" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "orgName" TEXT NOT NULL,
    "trigger" "OrgDeletionTrigger" NOT NULL,
    "requestedBy" TEXT,
    "clerkEventId" TEXT,
    "clerkDeletedAt" TIMESTAMP(3),
    "recipientClerkIds" TEXT[],
    "recipientsFixedAt" TIMESTAMP(3),
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "status" "OrgDeletionStatus" NOT NULL DEFAULT 'pending',
    "cancelledAt" TIMESTAMP(3),
    "cancelledBy" TEXT,
    "revokedCapabilityIds" TEXT[],
    "exportUrl" TEXT,
    "exportBytes" INTEGER,
    "exportedAt" TIMESTAMP(3),
    "exportError" TEXT,
    "progress" JSONB NOT NULL DEFAULT '{}',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "receipt" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_deletions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "org_deletions_clerkEventId_key" ON "org_deletions"("clerkEventId");

-- CreateIndex
CREATE INDEX "org_deletions_status_effectiveAt_idx" ON "org_deletions"("status", "effectiveAt");

-- CreateIndex
CREATE INDEX "org_deletions_orgId_idx" ON "org_deletions"("orgId");

-- One open deletion per org.
CREATE UNIQUE INDEX "org_deletions_one_open_per_org" ON "org_deletions"("orgId") WHERE "status" IN ('pending', 'deleting');

-- CreateTable
CREATE TABLE "org_admin_departures" (
    "orgId" TEXT NOT NULL,
    "clerkUserId" TEXT NOT NULL,
    "removedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_admin_departures_pkey" PRIMARY KEY ("orgId","clerkUserId")
);

-- CreateIndex
CREATE INDEX "org_admin_departures_removedAt_idx" ON "org_admin_departures"("removedAt");

-- AddForeignKey
ALTER TABLE "org_admin_departures" ADD CONSTRAINT "org_admin_departures_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Refuses a write for an org with an open deletion. With no arguments the row carries
-- "orgId"; a child table names its parent table and the column holding the parent's id.
CREATE FUNCTION "org_deletion_refuse_write"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  org TEXT;
BEGIN
  -- An account losing its owner, and nothing else about it changing: what deleting a
  -- person's record does (accounts.ownerId is ON DELETE SET NULL). A person who leaves
  -- another org, or whose org's deletion is cancelled, can be deleted while this org is
  -- frozen without the removal failing.
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'accounts' THEN
    IF to_jsonb(OLD) ->> 'ownerId' IS NOT NULL AND to_jsonb(NEW) ->> 'ownerId' IS NULL
       AND to_jsonb(NEW) - 'ownerId' = to_jsonb(OLD) - 'ownerId' THEN
      RETURN NULL;
    END IF;
  END IF;
  IF TG_NARGS = 0 THEN
    org := NEW."orgId";
  ELSE
    EXECUTE format('SELECT "orgId" FROM %I WHERE id = $1', TG_ARGV[0])
      INTO org
      USING to_jsonb(NEW) ->> TG_ARGV[1];
  END IF;
  IF org IS NOT NULL
     AND EXISTS (SELECT 1 FROM "org_deletions" WHERE "orgId" = org AND "status" IN ('pending', 'deleting'))
     AND EXISTS (SELECT 1 FROM "orgs" WHERE "id" = org) THEN
    RAISE EXCEPTION 'org % is being deleted: % on % is refused', org, TG_OP, TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Cancel the org deletion to write again.';
  END IF;
  RETURN NULL;
END
$$;

DO $$
DECLARE
  t TEXT;
  child TEXT[];
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'accounts', 'agent_runs', 'agents', 'briefs', 'contact_idempotency_keys', 'contacts',
    'conventions', 'conversations', 'entity_aliases', 'fact_disputes', 'fact_edges',
    'fact_provenance', 'feedback_events', 'grants', 'integrations', 'memory_chunks',
    'memory_ingest_keys', 'messages', 'oauth_connections', 'org_preferences', 'org_roles',
    'org_workflow_controls', 'product_feedback', 'scopes', 'sources', 'uploaded_files',
    'workflow_runs', 'working_notes'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER "org_deletion_refuse_write" AFTER INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION "org_deletion_refuse_write"()',
      t
    );
  END LOOP;

  EXECUTE 'CREATE TRIGGER "org_deletion_refuse_write" AFTER INSERT ON "capabilities" FOR EACH ROW EXECUTE FUNCTION "org_deletion_refuse_write"()';

  FOREACH child SLICE 1 IN ARRAY ARRAY[
    ['agent_run_events', 'agent_runs', 'runId'],
    ['brief_citations', 'briefs', 'briefId'],
    ['brief_provenance', 'briefs', 'briefId'],
    ['brief_retirement_waivers', 'briefs', 'briefId'],
    ['brief_retirements', 'briefs', 'briefId'],
    ['memory_chunk_passages', 'memory_chunks', 'chunkId'],
    ['source_files', 'sources', 'sourceId'],
    ['workflow_approvals', 'workflow_runs', 'runId'],
    ['workflow_run_steps', 'workflow_runs', 'runId']
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER "org_deletion_refuse_write" AFTER INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION "org_deletion_refuse_write"(%L, %L)',
      child[1], child[2], child[3]
    );
  END LOOP;
END
$$;
