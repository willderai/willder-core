-- The audit log becomes append-only in the database and tamper-evident.
--
-- Until now audit_log was append-only by convention: every writer happened to
-- call create() and nothing called update() or delete(). This migration makes
-- that a property of the table, so no code path has to remember it.
--
-- 1. Append-only. A BEFORE UPDATE OR DELETE row trigger and a BEFORE TRUNCATE
--    statement trigger raise for every role except a superuser.
--
--    Why a trigger and not REVOKE: the application may connect as the table's
--    owner (on Neon the migrating role and the runtime role are usually the
--    same), and an owner can re-grant itself anything it revokes. Worse, a
--    REVOKE DELETE from the owner breaks org deletion: Postgres runs a foreign
--    key's ON DELETE CASCADE as the referencing table's owner, so the cascade
--    from orgs into audit_log would fail. A trigger applies to the owner's
--    ordinary statements too, and can tell a cascade apart.
--
--    What it allows:
--     - DELETE of rows whose org no longer exists. That is exactly the cascade
--       from deleting an org (the org row is already gone when the cascade
--       reaches audit_log), and no other DELETE can match, because the foreign
--       key keeps every live row pointing at a live org.
--     - Anything by a superuser. A superuser can disable the trigger or set
--       session_replication_role, so refusing one protects nothing; exempting
--       it keeps test fixtures and operator maintenance working. The
--       application role is not a superuser on any hosted Postgres we use.
--
--    What it does not stop: the table owner can still ALTER TABLE ... DISABLE
--    TRIGGER or DROP TRIGGER. That is a deliberate DDL act, not an ordinary
--    statement, and the hash chain below is what makes its effect detectable.
--
-- 2. Tamper evidence. A BEFORE INSERT trigger gives every new row its position
--    in its org's chain (chainSeq), the previous row's hash (prevHash) and the
--    SHA-256 of its own canonical content including both (rowHash). It
--    overwrites whatever a writer passed, so no writer can skip or forge it.
--
--    Partition: one chain per org. An org is the tenant boundary, it is the
--    unit an administrator verifies, and deleting an org removes its whole
--    chain with it, so no other org's chain is ever left with a hole.
--
--    Serialization: audit_chain_heads holds each org's last position and hash.
--    The trigger takes that row FOR UPDATE, so two transactions writing audit
--    rows for the same org queue on it until the first commits or rolls back;
--    a rollback also rolls back the head, so positions never skip. The unique
--    index on (orgId, chainSeq) is a second line: a fork cannot be stored.
--    Different orgs never wait on each other.
--
--    Existing rows predate the chain. They keep chainSeq/prevHash/rowHash NULL
--    and are reported as unchained by the verifier; nothing is rewritten or
--    backfilled. The first row written after this migration starts its org's
--    chain at position 1 from the all-zero genesis hash.
--
--    The canonical form must match services/access/audit-chain.ts exactly;
--    its real-Postgres test checks the two agree.

-- AlterTable
ALTER TABLE "audit_log" ADD COLUMN "chainSeq" INTEGER,
ADD COLUMN "prevHash" TEXT,
ADD COLUMN "rowHash" TEXT;

-- CreateTable
CREATE TABLE "audit_chain_heads" (
    "orgId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "hash" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_chain_heads_pkey" PRIMARY KEY ("orgId")
);

-- CreateIndex
CREATE UNIQUE INDEX "audit_log_orgId_chainSeq_key" ON "audit_log"("orgId", "chainSeq");

-- AddForeignKey
ALTER TABLE "audit_chain_heads" ADD CONSTRAINT "audit_chain_heads_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One field of the canonical form: NULL as "N;", a value as "S<utf8 bytes>:<value>;".
CREATE FUNCTION audit_log_canonical_field(value TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE WHEN value IS NULL THEN 'N;'
              ELSE 'S' || octet_length(convert_to(value, 'UTF8')) || ':' || value || ';' END
$$;

-- Whether an org row exists, as the table owner sees it. The append-only
-- triggers below allow a DELETE only when this is false, so it must not be
-- something the caller can make false while the org is still there:
-- SECURITY DEFINER puts it above the caller's row-level security on orgs (an
-- RLS policy that hides an org from the caller must not read as "deleted").
CREATE FUNCTION audit_log_org_exists(org_id TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT EXISTS (SELECT 1 FROM "orgs" WHERE "id" = org_id)
$$;

-- SHA-256 (hex) of one audit row's canonical content: every column but rowHash.
CREATE FUNCTION audit_log_row_hash(r "audit_log") RETURNS TEXT
LANGUAGE sql STABLE
AS $$
  SELECT encode(sha256(convert_to(
    'willder-audit-v1;'
    || audit_log_canonical_field(r."orgId")
    || audit_log_canonical_field(r."chainSeq"::text)
    || audit_log_canonical_field(r."prevHash")
    || audit_log_canonical_field(r."id")
    || audit_log_canonical_field(r."actorType")
    || audit_log_canonical_field(r."actorId")
    || audit_log_canonical_field(r."action")
    || audit_log_canonical_field(r."target")
    || audit_log_canonical_field(r."decision"::text)
    || audit_log_canonical_field(r."reason")
    || audit_log_canonical_field(r."metadata"::text)
    || audit_log_canonical_field(to_char(r."at", 'YYYY-MM-DD"T"HH24:MI:SS.US'))
    || audit_log_canonical_field(r."runId"),
  'UTF8')), 'hex')
$$;

-- Chains every inserted row. SECURITY DEFINER so a runtime role that may insert
-- audit rows needs no privilege of its own on audit_chain_heads.
CREATE FUNCTION audit_log_chain_insert() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  head "audit_chain_heads"%ROWTYPE;
BEGIN
  SELECT * INTO head FROM "audit_chain_heads" WHERE "orgId" = NEW."orgId" FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO "audit_chain_heads" ("orgId", "seq", "hash")
    VALUES (NEW."orgId", 0, repeat('0', 64))
    ON CONFLICT ("orgId") DO NOTHING;
    SELECT * INTO head FROM "audit_chain_heads" WHERE "orgId" = NEW."orgId" FOR UPDATE;
  END IF;

  NEW."chainSeq" := head."seq" + 1;
  NEW."prevHash" := head."hash";
  NEW."rowHash" := audit_log_row_hash(NEW);

  UPDATE "audit_chain_heads" SET "seq" = NEW."chainSeq", "hash" = NEW."rowHash"
   WHERE "orgId" = NEW."orgId";
  RETURN NEW;
END
$$;

CREATE TRIGGER "audit_log_chain"
BEFORE INSERT ON "audit_log"
FOR EACH ROW EXECUTE FUNCTION audit_log_chain_insert();

-- Refuses UPDATE and DELETE on audit rows; see the header for the two exceptions.
CREATE FUNCTION audit_log_refuse_change() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('is_superuser') = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' AND NOT audit_log_org_exists(OLD."orgId") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_log is append-only: % of audit row % is refused', TG_OP, OLD."id"
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Audit rows are removed only by deleting their org.';
END
$$;

CREATE TRIGGER "audit_log_append_only"
BEFORE UPDATE OR DELETE ON "audit_log"
FOR EACH ROW EXECUTE FUNCTION audit_log_refuse_change();

CREATE FUNCTION audit_log_refuse_truncate() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('is_superuser') = 'on' THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'audit_log is append-only: TRUNCATE of % is refused', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Audit rows are removed only by deleting their org.';
END
$$;

CREATE TRIGGER "audit_log_no_truncate"
BEFORE TRUNCATE ON "audit_log"
FOR EACH STATEMENT EXECUTE FUNCTION audit_log_refuse_truncate();

CREATE TRIGGER "audit_chain_heads_no_truncate"
BEFORE TRUNCATE ON "audit_chain_heads"
FOR EACH STATEMENT EXECUTE FUNCTION audit_log_refuse_truncate();

-- A chain head is written only by audit_log_chain_insert(), which runs it one
-- trigger level deep, and removed only with its org. A head set by hand could
-- hide a deleted tail row from the verifier.
CREATE FUNCTION audit_chain_heads_guard() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('is_superuser') = 'on' OR pg_trigger_depth() > 1 THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' AND NOT audit_log_org_exists(OLD."orgId") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_chain_heads is written only by the audit_log insert trigger: % refused', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TRIGGER "audit_chain_heads_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "audit_chain_heads"
FOR EACH ROW EXECUTE FUNCTION audit_chain_heads_guard();

-- Pin every function above to this schema, with pg_temp searched last.
--
-- Postgres searches the session's temporary schema before any schema named in
-- search_path unless pg_temp is listed explicitly. Without this, any role that
-- can create temporary tables (every role, by default) could create an empty
-- temporary "orgs" and have the append-only trigger treat every audit row as
-- belonging to a deleted org, or a temporary "audit_chain_heads" and have the
-- SECURITY DEFINER insert trigger chain rows from a head it made up. The schema
-- is the one this migration runs in, so a database deployed to a non-public
-- schema works the same way.
DO $$
DECLARE
  fn TEXT;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'audit_log_canonical_field(text)',
    'audit_log_org_exists(text)',
    'audit_log_row_hash(audit_log)',
    'audit_log_chain_insert()',
    'audit_log_refuse_change()',
    'audit_log_refuse_truncate()',
    'audit_chain_heads_guard()'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = %I, pg_temp', fn, current_schema());
  END LOOP;
END
$$;
