-- Every function the migrations define resolves names only in pg_catalog, and
-- names everything else by its schema.
--
-- They were pinned to `search_path = public, pg_temp`. Postgres searches
-- pg_catalog before that, but an overload in public that matches the call
-- better than the built-in still wins: `convert_to(value, 'UTF8')` passes an
-- untyped literal, which prefers a `convert_to(text, text)` in public over
-- pg_catalog's `convert_to(text, name)`, and `to_jsonb(NEW)` or a five-argument
-- `format(...)` prefers an exact-type overload over pg_catalog's polymorphic
-- one. A role allowed to CREATE in public could plant one and have it run as
-- the function's owner (the four audit SECURITY DEFINER functions) or as
-- whichever role fired the trigger (every trigger function here, on every
-- audit insert, capability mint, sign-up and org-scoped write).
--
-- The pin is now `pg_catalog, pg_temp`, so no schema a role can create in is on
-- the path, and every table, type and function outside pg_catalog is named as
-- public.<name>. Built-in calls are written as pg_catalog.<name> too, so a body
-- stays safe if a later migration ever loosens its pin. Operators are left
-- unqualified: they resolve only in pg_catalog under this pin, because Postgres
-- never searches the temporary schema for operators or functions.
--
-- Why not `search_path = ''`: with pg_temp left off the path, Postgres searches
-- the session's temporary schema FIRST for table and type names, ahead of
-- pg_catalog. Any role (TEMP is granted to PUBLIC) could then create a temporary
-- domain named "text" with a CHECK that calls a function of its own, and every
-- `::text` cast in a SECURITY DEFINER body would run that function as the owner.
-- Naming pg_temp last closes that; prisma/function-search-path.realdb.test.ts
-- reproduces both attacks.
--
-- CREATE OR REPLACE keeps each function's owner, its grants (the EXECUTE revoked
-- by 20261018100000_audit_org_exists_not_public stays revoked) and the triggers
-- that call it; each body's logic is unchanged, and only its names are qualified.
-- `ltree` and its `@>` are named public.*: the old pin already required the
-- extension to live in public, where 20260608162411_day3_uc2_access_control
-- creates it.
--
-- Safe to re-run: every statement is a CREATE OR REPLACE to the same definition.
-- One transaction, so a deploy stopped partway leaves no function half replaced.

BEGIN;

-- One field of the canonical form: NULL as "N;", a value as "S<utf8 bytes>:<value>;".
CREATE OR REPLACE FUNCTION public.audit_log_canonical_field(value TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE WHEN value IS NULL THEN 'N;'
              ELSE 'S' || pg_catalog.octet_length(pg_catalog.convert_to(value, 'UTF8')) || ':' || value || ';' END
$$;

-- Whether an org row exists, as the owner sees it, past the caller's row-level security.
CREATE OR REPLACE FUNCTION public.audit_log_org_exists(org_id TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM public."orgs" WHERE "id" = org_id)
$$;

-- SHA-256 (hex) of one audit row's canonical content: every column but rowHash.
CREATE OR REPLACE FUNCTION public.audit_log_row_hash(r public."audit_log") RETURNS TEXT
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    'willder-audit-v1;'
    || public.audit_log_canonical_field(r."orgId")
    || public.audit_log_canonical_field(r."chainSeq"::text)
    || public.audit_log_canonical_field(r."prevHash")
    || public.audit_log_canonical_field(r."id")
    || public.audit_log_canonical_field(r."actorType")
    || public.audit_log_canonical_field(r."actorId")
    || public.audit_log_canonical_field(r."action")
    || public.audit_log_canonical_field(r."target")
    || public.audit_log_canonical_field(r."decision"::text)
    || public.audit_log_canonical_field(r."reason")
    || public.audit_log_canonical_field(r."metadata"::text)
    || public.audit_log_canonical_field(pg_catalog.to_char(r."at", 'YYYY-MM-DD"T"HH24:MI:SS.US'))
    || public.audit_log_canonical_field(r."runId"),
  'UTF8')), 'hex')
$$;

-- Chains every inserted row, as the owner, so a writer needs no privilege on audit_chain_heads.
CREATE OR REPLACE FUNCTION public.audit_log_chain_insert() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  head public."audit_chain_heads"%ROWTYPE;
BEGIN
  SELECT * INTO head FROM public."audit_chain_heads" WHERE "orgId" = NEW."orgId" FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public."audit_chain_heads" ("orgId", "seq", "hash")
    VALUES (NEW."orgId", 0, pg_catalog.repeat('0', 64))
    ON CONFLICT ("orgId") DO NOTHING;
    SELECT * INTO head FROM public."audit_chain_heads" WHERE "orgId" = NEW."orgId" FOR UPDATE;
  END IF;

  NEW."chainSeq" := head."seq" + 1;
  NEW."prevHash" := head."hash";
  NEW."rowHash" := public.audit_log_row_hash(NEW);

  UPDATE public."audit_chain_heads" SET "seq" = NEW."chainSeq", "hash" = NEW."rowHash"
   WHERE "orgId" = NEW."orgId";
  RETURN NEW;
END
$$;

-- Refuses UPDATE and DELETE on audit rows, except a superuser's and an org delete's.
CREATE OR REPLACE FUNCTION public.audit_log_refuse_change() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF pg_catalog.current_setting('is_superuser') = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' AND NOT public.audit_log_org_exists(OLD."orgId") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_log is append-only: % of audit row % is refused', TG_OP, OLD."id"
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Audit rows are removed only by deleting their org.';
END
$$;

CREATE OR REPLACE FUNCTION public.audit_log_refuse_truncate() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF pg_catalog.current_setting('is_superuser') = 'on' THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'audit_log is append-only: TRUNCATE of % is refused', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Audit rows are removed only by deleting their org.';
END
$$;

-- A chain head is written only by audit_log_chain_insert() and removed only with its org.
CREATE OR REPLACE FUNCTION public.audit_chain_heads_guard() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF pg_catalog.current_setting('is_superuser') = 'on' OR pg_catalog.pg_trigger_depth() > 1 THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' AND NOT public.audit_log_org_exists(OLD."orgId") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_chain_heads is written only by the audit_log insert trigger: % refused', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

-- Whether a person holds `needed` on `target_path` in the org, through a live grant.
-- Grant expiry is compared in UTC: Prisma stores DateTime as UTC without a time zone.
CREATE OR REPLACE FUNCTION public."access_person_holds"(org_id TEXT, user_id TEXT, needed public."Permission", target_path TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public."org_memberships" m
    JOIN public."grants" g ON g."orgId" = m."orgId"
    JOIN public."scopes" s ON s."id" = g."scopeId" AND s."orgId" = m."orgId"
    WHERE m."userId" = user_id
      AND m."orgId" = org_id
      AND m."removedAt" IS NULL
      AND (
        (g."granteeType" = 'user' AND g."granteeId" = m."userId")
        OR (g."granteeType" = 'role' AND g."granteeId" = m."role"::text)
        OR g."granteeType" = 'everyone'
      )
      AND (g."expiresAt" IS NULL OR g."expiresAt" > (pg_catalog.now() AT TIME ZONE 'UTC'))
      AND g."permission" >= needed
      AND s."path"::public.ltree OPERATOR(public.@>) target_path::public.ltree
  )
$$;

-- A person-issued token may not be wider than its issuer; see 20261010010000_capability_issuer_bound.
CREATE OR REPLACE FUNCTION public."capabilities_issuer_bound"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW."createdBy" IS NULL OR NEW."createdBy" LIKE 'system:%' THEN
    NEW."issuedByPerson" := false;
    RETURN NEW;
  END IF;
  NEW."issuedByPerson" := true;
  -- IS NOT TRUE, not NOT: an answer of NULL (unknown) must refuse the row too.
  IF public."access_person_holds"(NEW."orgId", NEW."createdBy", NEW."permission", NEW."scopePath") IS NOT TRUE THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'capability wider than its issuer',
      DETAIL = pg_catalog.format(
        'issuer %s does not hold %s on %s in org %s',
        NEW."createdBy", NEW."permission", NEW."scopePath", NEW."orgId"
      ),
      HINT = 'mint the token at a scope and permission the issuer holds';
  END IF;
  RETURN NEW;
END
$$;

-- Every new person joins the org their row names; see 20261010020000_org_memberships.
CREATE OR REPLACE FUNCTION public."users_join_org"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  INSERT INTO public."org_memberships" ("orgId", "userId", "role", "assertedAt", "createdAt", "updatedAt")
  VALUES (NEW."orgId", NEW."id", NEW."role", TIMESTAMP '1970-01-01', (pg_catalog.now() AT TIME ZONE 'UTC'), (pg_catalog.now() AT TIME ZONE 'UTC'))
  ON CONFLICT ("orgId", "userId") DO NOTHING;
  RETURN NEW;
END
$$;

-- An admin token lives at most two hours from its mint; see 20261014210000_capability_admin_window.
CREATE OR REPLACE FUNCTION public."capabilities_admin_window"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW."permission" <> 'admin' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- UTC wall-clock time, the form Prisma stores in this column (lib/sql-utc-now.ts).
    NEW."createdAt" := pg_catalog.now() AT TIME ZONE 'UTC';
  ELSE
    NEW."createdAt" := OLD."createdAt";
  END IF;
  NEW."expiresAt" := LEAST(NEW."expiresAt", NEW."createdAt" + interval '2 hours');
  RETURN NEW;
END
$$;

-- Refuses a write for an org with an open deletion; see 20261016200000_org_deletions.
-- With no arguments the row carries "orgId"; a child table names its parent table and
-- the column holding the parent's id.
CREATE OR REPLACE FUNCTION public."org_deletion_refuse_write"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  org TEXT;
BEGIN
  -- An account losing its owner, and nothing else about it changing: what deleting a
  -- person's record does (accounts.ownerId is ON DELETE SET NULL). A person who leaves
  -- another org, or whose org's deletion is cancelled, can be deleted while this org is
  -- frozen without the removal failing.
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'accounts' THEN
    IF pg_catalog.to_jsonb(OLD) ->> 'ownerId' IS NOT NULL AND pg_catalog.to_jsonb(NEW) ->> 'ownerId' IS NULL
       AND pg_catalog.to_jsonb(NEW) - 'ownerId' = pg_catalog.to_jsonb(OLD) - 'ownerId' THEN
      RETURN NULL;
    END IF;
  END IF;
  IF TG_NARGS = 0 THEN
    org := NEW."orgId";
  ELSE
    EXECUTE pg_catalog.format('SELECT "orgId" FROM public.%I WHERE id = $1', TG_ARGV[0])
      INTO org
      USING pg_catalog.to_jsonb(NEW) ->> TG_ARGV[1];
  END IF;
  IF org IS NOT NULL
     AND EXISTS (SELECT 1 FROM public."org_deletions" WHERE "orgId" = org AND "status" IN ('pending', 'deleting'))
     AND EXISTS (SELECT 1 FROM public."orgs" WHERE "id" = org) THEN
    RAISE EXCEPTION 'org % is being deleted: % on % is refused', org, TG_OP, TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Cancel the org deletion to write again.';
  END IF;
  RETURN NULL;
END
$$;

COMMIT;
