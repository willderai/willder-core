-- Nobody but its owner may call audit_log_org_exists(text).
--
-- The function is SECURITY DEFINER, so it reads "orgs" as its owner, past row-level
-- security, and Postgres granted EXECUTE on it to PUBLIC when it was created. On
-- Supabase, PostgREST serves every function in the exposed schema at
-- /rest/v1/rpc/<name>, so the public anon key could ask whether any org id exists
-- even where row-level security hides every org from it. (The owner reads past RLS
-- unless a table FORCEs it; no migration does.)
--
-- Its only callers are the two append-only triggers from
-- 20261006160000_audit_log_tamper_evident, which ask it whether a deleted audit row
-- or chain head belonged to an org that is already gone. Those trigger functions ran
-- as the invoking role, so revoking EXECUTE from PUBLIC alone would make every
-- non-owner writer fail with "permission denied for function" instead of the
-- append-only refusal, and would break org deletion wherever audit_log's owner is not
-- the function's owner (Postgres runs an ON DELETE CASCADE as the referencing table's
-- owner).
--
-- So the two trigger functions become SECURITY DEFINER too, and call the check as
-- their owner. A trigger function cannot be called outside a trigger, and PostgREST
-- does not serve functions that return "trigger", so this exposes nothing new. No
-- role needs a grant: the check works the same for the owner, a plain grantee and a
-- role that was later given ownership of audit_log.
--
-- The superuser exemption is unchanged. current_setting('is_superuser') reports the
-- session's role (after SET ROLE), not the owner a SECURITY DEFINER function switches
-- to; the cascade from an org delete already relied on that, since it too runs as
-- the table owner. prisma/security-definer-functions.realdb.test.ts and
-- services/access/audit-chain.realdb.test.ts check both.
--
-- The SECURITY DEFINER trigger functions lose PUBLIC's EXECUTE as well. Firing an
-- existing trigger does not check EXECUTE; creating one does. With EXECUTE, any role
-- could attach audit_log_refuse_change() to a temporary table of its own with an
-- "orgId" column and learn whether an org exists from whether its own DELETE is
-- refused, the same answer /rpc gave. No role but the owner has a reason to attach
-- any of them, so audit_log_chain_insert() loses it too.
--
-- What this does not close: a role allowed to INSERT into audit_log still fires
-- audit_log_chain_insert() as the owner, before row-level security checks the new
-- row, so its error tells an existing org (an RLS refusal) from a missing one (the
-- chain head's foreign key). That is the chain-start logic, and it is tracked
-- separately; on Supabase it needs anon to hold INSERT on audit_log at all.
--
-- Revoking from PUBLIC is not enough on Supabase: its default privileges grant
-- EXECUTE on every new function in "public" to anon, authenticated and service_role
-- by name. So every grant on these four functions except the owner's own is revoked,
-- with CASCADE so a grant a grantee passed on (WITH GRANT OPTION, to anyone or to
-- PUBLIC) goes too and cannot make the REVOKE fail. No role needs one: the triggers
-- call audit_log_org_exists() as the owner.
--
-- Safe to re-run: ALTER FUNCTION ... SECURITY DEFINER and REVOKE are idempotent, and
-- ALTER FUNCTION keeps the search_path each function was pinned to.

ALTER FUNCTION audit_log_refuse_change() SECURITY DEFINER;
ALTER FUNCTION audit_chain_heads_guard() SECURITY DEFINER;

DO $$
DECLARE
  fn REGPROCEDURE;
  grantee TEXT;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'audit_log_org_exists(text)',
    'audit_log_refuse_change()',
    'audit_chain_heads_guard()',
    'audit_log_chain_insert()'
  ]::REGPROCEDURE[] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', fn);
    FOR grantee IN
      SELECT DISTINCT acl.grantee::regrole::text
        FROM pg_proc p, aclexplode(p.proacl) acl
       WHERE p.oid = fn
         AND acl.grantee <> 0
         AND acl.grantee <> p.proowner
    LOOP
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM %s CASCADE', fn, grantee);
    END LOOP;
  END LOOP;
END
$$;
