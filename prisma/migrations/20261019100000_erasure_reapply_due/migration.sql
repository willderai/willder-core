-- An org whose suppression list gained entries this database did not list itself: a restore
-- copied the live list back over an older backup (docs/consent-deletion-suite.md, "Restore
-- procedure"), and the erasures since that backup have not been re-applied here yet. While an
-- org has this row, check() refuses everything in it but access.manage (services/access/check.ts),
-- and the restore-completion job re-applies its erasures and deletes the row
-- (services/memory/erasure-reapply.ts, completeRestore).
--
-- Additive: one new table, one function, one trigger; no existing row or column changes.
CREATE TABLE "erasure_reapply_due" (
    "orgId" TEXT NOT NULL,

    CONSTRAINT "erasure_reapply_due_pkey" PRIMARY KEY ("orgId")
);

ALTER TABLE "erasure_reapply_due" ADD CONSTRAINT "erasure_reapply_due_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The app lists a person only inside a transaction that sets app.erasure_listing
-- (services/memory/erasure-suppression.ts, listingInThisTransaction). Any other insert into the
-- list, a restore's copy-back by psql or \copy among them, marks the org due. BEFORE, so a row
-- the backup already holds (which ON CONFLICT DO NOTHING then skips) marks its org too: a backup
-- taken while an erasure ran holds that erasure's entries without their applied markers. It
-- takes the org's applied-markers lock first (the same advisory lock as lockAppliedMarkers), so a
-- re-apply that is marking entries applied and clearing the row either commits before this
-- insert, and then the copied entry reads as not applied and the row stays, or waits for it.
-- Every object the function touches is named with its schema, and its search_path is pinned to
-- `pg_catalog, pg_temp` like every function the migrations define
-- (20261018120000_functions_resolve_only_pg_catalog): pg_dump's output and pg_restore load with
-- an empty search_path, where an unqualified name would fail the copy (and pg_restore goes on,
-- leaving the list not copied back at all), and the pin puts no schema a role can create in on
-- the path. Not `''`: that leaves pg_temp off the path, and Postgres then searches the session's
-- temporary schema first for table and type names.
CREATE FUNCTION public."erasure_suppressions_mark_reapply_due"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF pg_catalog.current_setting('app.erasure_listing', true) IS DISTINCT FROM 'on' THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(8241006, pg_catalog.hashtext(NEW."orgId"));
    INSERT INTO public."erasure_reapply_due" ("orgId") VALUES (NEW."orgId") ON CONFLICT ("orgId") DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "erasure_suppressions_copied_in"
BEFORE INSERT ON public."erasure_suppressions"
FOR EACH ROW EXECUTE FUNCTION public."erasure_suppressions_mark_reapply_due"();

-- ALWAYS, so it fires under session_replication_role = replica too, as some loaders set it. A
-- DISABLE TRIGGER by the table's owner or a superuser (pg_restore --disable-triggers) gets past
-- it, which the restore procedure rules out. A logical-replication subscriber of this table would
-- fire it for every replicated row too; none exists.
ALTER TABLE public."erasure_suppressions" ENABLE ALWAYS TRIGGER "erasure_suppressions_copied_in";
