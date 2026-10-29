-- Counters a cache of text derived from a scope is keyed on (services/access/check.ts
-- scopeCacheStamp(), read by the staleness route's contradiction-scan cache,
-- services/facts/scope-scan-cache.ts). The rule: derived data never outlives its source.
--
-- org_removal_epochs: one row per org, its "epoch" moved by every removal of text in the
--   org. Read with one primary-key lookup.
-- scope_change_counts: one row per (org, exact scope), counting the applied writes and
--   deletes recorded there. A brief's count is the sum over its scope and the scopes
--   below it: one short range of the primary key per org.
--
-- What moves the epoch, so no removal path can forget to:
--   - an audit row recording a removal (applied deletes, every erasure step, the closing
--     and failed erasure rows, an admin's permanent removal of a record);
--   - a change-feed event that deletes, supersedes or revokes an item;
--   - a memory_chunks row deleted, or its text changed;
--   - an explicit call, public.bump_org_removal_epoch(org), for a removal that is only in
--     the graph (services/access/removal-epoch.ts), made after the graph removal returns.
--
-- The triggers are DEFERRABLE INITIALLY DEFERRED constraint triggers: they run at commit,
-- so the removal and the bump commit together, and the counter row is locked last, after
-- every other lock the transaction took, and only until it commits. A transaction bumps
-- an org's epoch once however many rows it removes (a transaction-local setting marks it).
-- Both tables reference the org with ON DELETE CASCADE, so an org deletion takes their
-- rows (and the scope names they hold) with the org row. A bump for an org that no longer
-- exists, such as the org deletion's own cascade to its chunks, is skipped rather than
-- inserting a row the foreign key would refuse at commit.
--
-- Locks: CREATE TRIGGER takes a SHARE ROW EXCLUSIVE lock on audit_log, change_events and
-- memory_chunks for the moment it runs, blocking writes to them (not reads) until this
-- migration commits. No index is built on an existing table, and no row is changed or
-- backfilled: a counter that starts at zero is correct, since the cache it keys lives in
-- process memory and starts empty on deploy.

-- CreateTable
CREATE TABLE "org_removal_epochs" (
    "orgId" TEXT NOT NULL,
    "epoch" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_removal_epochs_pkey" PRIMARY KEY ("orgId")
);

-- CreateTable
CREATE TABLE "scope_change_counts" (
    "orgId" TEXT NOT NULL,
    "scopePath" TEXT NOT NULL,
    "count" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scope_change_counts_pkey" PRIMARY KEY ("orgId", "scopePath")
);

-- AddForeignKey
ALTER TABLE "org_removal_epochs" ADD CONSTRAINT "org_removal_epochs_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scope_change_counts" ADD CONSTRAINT "scope_change_counts_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Move `org`'s removal epoch, once per transaction.
CREATE OR REPLACE FUNCTION public.bump_org_removal_epoch(org TEXT) RETURNS VOID
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  mark TEXT := 'willder_removal_epoch.o' || pg_catalog.md5(org);
BEGIN
  IF org IS NULL OR pg_catalog.current_setting(mark, true) = '1' THEN
    RETURN;
  END IF;
  PERFORM pg_catalog.set_config(mark, '1', true);
  IF NOT EXISTS (SELECT 1 FROM public."orgs" WHERE "id" = org) THEN
    RETURN;
  END IF;
  INSERT INTO public."org_removal_epochs" ("orgId", "epoch", "updatedAt")
  VALUES (org, 1, (pg_catalog.now() AT TIME ZONE 'UTC'))
  ON CONFLICT ("orgId") DO UPDATE
    SET "epoch" = public."org_removal_epochs"."epoch" + 1, "updatedAt" = (pg_catalog.now() AT TIME ZONE 'UTC');
END
$$;

-- An audit row: a removal moves the org's epoch; an applied write or delete counts
-- under its scope, the part of its target before any '/'.
CREATE OR REPLACE FUNCTION public.scope_cache_audit_bump() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW."action" IN (
    'memory.delete.applied', 'memory.delete.effect', 'person.erasure_step',
    'person.erased', 'person.erasure_failed', 'record.removed'
  ) THEN
    PERFORM public.bump_org_removal_epoch(NEW."orgId");
  END IF;
  IF NEW."action" IN ('memory.write.applied', 'memory.delete.applied')
     AND NEW."decision" = 'allow' AND NEW."target" IS NOT NULL THEN
    INSERT INTO public."scope_change_counts" ("orgId", "scopePath", "count", "updatedAt")
    VALUES (NEW."orgId", pg_catalog.split_part(NEW."target", '/', 1), 1, (pg_catalog.now() AT TIME ZONE 'UTC'))
    ON CONFLICT ("orgId", "scopePath") DO UPDATE
      SET "count" = public."scope_change_counts"."count" + 1, "updatedAt" = (pg_catalog.now() AT TIME ZONE 'UTC');
  END IF;
  RETURN NULL;
END
$$;

-- A change event or a stored chunk: a removal moves the org's epoch.
CREATE OR REPLACE FUNCTION public.scope_cache_removal_bump() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM public.bump_org_removal_epoch(CASE WHEN TG_OP = 'INSERT' THEN NEW."orgId" ELSE OLD."orgId" END);
  RETURN NULL;
END
$$;

-- CreateTrigger
CREATE CONSTRAINT TRIGGER "audit_log_scope_cache_bump"
  AFTER INSERT ON "audit_log"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW."action" IN (
    'memory.write.applied', 'memory.delete.applied', 'memory.delete.effect', 'person.erasure_step',
    'person.erased', 'person.erasure_failed', 'record.removed'
  ))
  EXECUTE FUNCTION public.scope_cache_audit_bump();

-- CreateTrigger
CREATE CONSTRAINT TRIGGER "change_events_removal_epoch_bump"
  AFTER INSERT ON "change_events"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW."op" IN ('delete', 'supersede', 'revoke'))
  EXECUTE FUNCTION public.scope_cache_removal_bump();

-- CreateTrigger
CREATE CONSTRAINT TRIGGER "memory_chunks_removal_epoch_bump_delete"
  AFTER DELETE ON "memory_chunks"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.scope_cache_removal_bump();

-- CreateTrigger
CREATE CONSTRAINT TRIGGER "memory_chunks_removal_epoch_bump_update"
  AFTER UPDATE OF "content" ON "memory_chunks"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD."content" IS DISTINCT FROM NEW."content")
  EXECUTE FUNCTION public.scope_cache_removal_bump();
