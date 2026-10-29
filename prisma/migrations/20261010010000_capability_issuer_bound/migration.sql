-- A capability token is never wider than the person who minted it.
--
-- Two rules, both held by the database so no mint path can forget them:
--
--   1. At mint. A `capabilities` row whose issuer (`createdBy`) is a person is
--      refused unless that person, right now, holds the token's permission on the
--      token's scope in the token's org. Every mint path (POST
--      /api/access/capabilities, the agent provisioners, the workflow engine, a
--      re-mint for a resumed run) ends in this insert, so none of them can mint a
--      token wider than its issuer, and none of them can mint one for a person
--      who has since left the org.
--   2. At use. check() (services/access/check.ts) asks the same question,
--      `access_person_holds`, against the token's issuer for every action, so a
--      token narrows the moment its issuer is narrowed, demoted or removed.
--
-- A token with no person behind it says so explicitly: `createdBy` null, or a
-- `system:<label>` value for a scheduled job. Any other `createdBy` is a person,
-- and one that names nobody in the org is refused rather than read as a system
-- token, because a departed person's id names nobody too.
--
-- `issuedByPerson` records which kind a row is. The trigger sets it on every
-- insert and update, ignoring whatever the writer sent, so it cannot be cleared
-- to escape rule 2.
--
-- Both functions pin `search_path` (schema first, `pg_temp` last), so an object a
-- session creates in another schema cannot stand in for `users`, `grants` or `scopes`.
--
-- Additive: one column, two functions, one trigger. The backfill below marks every
-- existing row person-issued unless its `createdBy` is null or one of the two
-- system labels the code has ever written (`cron`, `scripts/...`). Failing closed
-- is deliberate: an existing token whose issuer has since lost access stops
-- working, which is the point of the change.

ALTER TABLE "capabilities" ADD COLUMN "issuedByPerson" BOOLEAN NOT NULL DEFAULT false;

UPDATE "capabilities"
SET "issuedByPerson" = true
WHERE "createdBy" IS NOT NULL
  AND "createdBy" <> 'cron'
  AND "createdBy" NOT LIKE 'scripts/%'
  AND "createdBy" NOT LIKE 'system:%';

-- Does person `user_id`, a member of `org_id`, hold `needed` (or better) on
-- `target_path` through a live grant to them, their role, or everyone? The same
-- rule check()'s human branch applies to a signed-in person, read from the
-- stored user row so it also answers for a person who is not the caller.
-- Never NULL: the body is one EXISTS, so an unknown person, a missing row or a
-- NULL argument answers false. Callers still compare with IS NOT TRUE.
CREATE FUNCTION "access_person_holds"(org_id TEXT, user_id TEXT, needed "Permission", target_path TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM "users" u
    JOIN "grants" g ON g."orgId" = u."orgId"
    JOIN "scopes" s ON s."id" = g."scopeId" AND s."orgId" = u."orgId"
    WHERE u."id" = user_id
      AND u."orgId" = org_id
      AND (
        (g."granteeType" = 'user' AND g."granteeId" = u."id")
        OR (g."granteeType" = 'role' AND g."granteeId" = u."role"::text)
        OR g."granteeType" = 'everyone'
      )
      AND (g."expiresAt" IS NULL OR g."expiresAt" > now())
      AND g."permission" >= needed
      AND s."path"::ltree @> target_path::ltree
  )
$$;

CREATE FUNCTION "capabilities_issuer_bound"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW."createdBy" IS NULL OR NEW."createdBy" LIKE 'system:%' THEN
    NEW."issuedByPerson" := false;
    RETURN NEW;
  END IF;
  NEW."issuedByPerson" := true;
  -- IS NOT TRUE, not NOT: an answer of NULL (unknown) must refuse the row too.
  IF "access_person_holds"(NEW."orgId", NEW."createdBy", NEW."permission", NEW."scopePath") IS NOT TRUE THEN
    RAISE EXCEPTION USING
      ERRCODE = 'insufficient_privilege',
      MESSAGE = 'capability wider than its issuer',
      DETAIL = format(
        'issuer %s does not hold %s on %s in org %s',
        NEW."createdBy", NEW."permission", NEW."scopePath", NEW."orgId"
      ),
      HINT = 'mint the token at a scope and permission the issuer holds';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "capabilities_issuer_bound"
BEFORE INSERT OR UPDATE OF "createdBy", "orgId", "scopePath", "permission", "issuedByPerson"
ON "capabilities"
FOR EACH ROW
EXECUTE FUNCTION "capabilities_issuer_bound"();
