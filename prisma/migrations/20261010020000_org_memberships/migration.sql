-- A person can belong to several orgs, and their membership and role in each is
-- stored per org.
--
-- Before this, `users` held one row per person with a single `orgId` and `role`,
-- and signing in to another org moved that row there. Anything that asked "is
-- this person a member of org X, with what role?" by reading `users.orgId` got
-- the wrong answer for a person in two orgs: a token they minted in org A was
-- refused while they had org B open, and came back when they reopened A.
--
-- `org_memberships` holds one row per (org, person). Authorization reads it;
-- `users.orgId`/`users.role` stay as they are and mean "the org the person last
-- used", for display. A removed membership keeps its row with `removedAt` set,
-- so a late or replayed write older than the removal can be recognised and
-- ignored (see `assertedAt` and services/access/membership.ts).
--
-- Additive: one table, one trigger, one replaced function body, and a backfill
-- that copies one membership per existing `users` row. No `users` row is moved,
-- changed or deleted.

CREATE TABLE "org_memberships" (
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "assertedAt" TIMESTAMP(3) NOT NULL,
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_memberships_pkey" PRIMARY KEY ("orgId", "userId")
);

CREATE INDEX "org_memberships_userId_idx" ON "org_memberships"("userId");

ALTER TABLE "org_memberships" ADD CONSTRAINT "org_memberships_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "org_memberships" ADD CONSTRAINT "org_memberships_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A new `users` row is a person joining the org it names, so it gets that
-- membership in the same statement. Every writer that creates a person (the
-- signed-in request, scripts, test fixtures) therefore leaves a member behind.
-- Only inserts: moving `users.orgId` later is not joining or leaving anything.
-- Like the backfill, it carries no Clerk assertion time (the epoch), so the
-- session token or webhook event that follows decides the role.
CREATE FUNCTION "users_join_org"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO "org_memberships" ("orgId", "userId", "role", "assertedAt", "createdAt", "updatedAt")
  VALUES (NEW."orgId", NEW."id", NEW."role", TIMESTAMP '1970-01-01', (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC'))
  ON CONFLICT ("orgId", "userId") DO NOTHING;
  RETURN NEW;
END
$$;

CREATE TRIGGER "users_join_org"
AFTER INSERT ON "users"
FOR EACH ROW
EXECUTE FUNCTION "users_join_org"();

-- backfill:start
-- One membership per existing person, in the org and role their row holds now.
-- A membership with no known Clerk assertion time carries the epoch, so the first
-- real one (a session token or a webhook event) supersedes it.
-- It runs after the trigger exists: creating the trigger waits for in-flight
-- inserts into `users` to finish, so a person who signs up during the migration
-- is either committed before this statement (backfilled) or inserted after the
-- trigger exists (joined by it). Neither order leaves them without a membership.
INSERT INTO "org_memberships" ("orgId", "userId", "role", "assertedAt", "createdAt", "updatedAt")
SELECT u."orgId", u."id", u."role", TIMESTAMP '1970-01-01', (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')
FROM "users" u
ON CONFLICT ("orgId", "userId") DO NOTHING;
-- backfill:end

-- Does person `user_id`, a current member of `org_id`, hold `needed` (or better)
-- on `target_path` through a live grant to them, their role in that org, or
-- everyone? Same signature and meaning as before (migration
-- 20261010010000_capability_issuer_bound); membership and role now come from
-- `org_memberships`, so the answer no longer depends on which org the person
-- last had open. A removed membership answers false, `everyone` grants included.
-- Still never NULL: the body is one EXISTS, so a missing membership row, an
-- unknown person or a NULL argument answers false, and callers compare with
-- IS NOT TRUE all the same.
--
-- Grant expiry is compared against `now() AT TIME ZONE 'UTC'`: Prisma stores a
-- DateTime as UTC in a column without a time zone, and a bare now() would be
-- read in the session's zone, keeping an expired grant live for hours west of
-- UTC. The same rule applies to every timestamp this migration writes.
CREATE OR REPLACE FUNCTION "access_person_holds"(org_id TEXT, user_id TEXT, needed "Permission", target_path TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM "org_memberships" m
    JOIN "grants" g ON g."orgId" = m."orgId"
    JOIN "scopes" s ON s."id" = g."scopeId" AND s."orgId" = m."orgId"
    WHERE m."userId" = user_id
      AND m."orgId" = org_id
      AND m."removedAt" IS NULL
      AND (
        (g."granteeType" = 'user' AND g."granteeId" = m."userId")
        OR (g."granteeType" = 'role' AND g."granteeId" = m."role"::text)
        OR g."granteeType" = 'everyone'
      )
      AND (g."expiresAt" IS NULL OR g."expiresAt" > (now() AT TIME ZONE 'UTC'))
      AND g."permission" >= needed
      AND s."path"::ltree @> target_path::ltree
  )
$$;
