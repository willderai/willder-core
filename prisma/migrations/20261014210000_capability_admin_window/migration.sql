-- An agent token with `admin` lives at most two hours from minting, by the database's clock.
--
-- Admin on an agent token is a setup convenience, never a standing power. The window is
-- held here, so no mint path and no later update can widen it:
--
--   1. At mint. A new `admin` row takes its `createdAt` from the database clock, whatever
--      the writer sent, and its `expiresAt` is cut to `createdAt` + 2 hours if it asked
--      for longer. A writer whose clock is wrong, or a request asking for 90 days, gets
--      the same two hours.
--   2. After mint. An update keeps the row's original `createdAt` and cuts `expiresAt`
--      the same way, so an `admin` token cannot be extended or refreshed, and a token
--      promoted to `admin` later is bounded by when it was first minted.
--
-- check() (services/access/check.ts) already refuses a token once `expiresAt` has passed,
-- on every call and by the database clock, so these two rules are the whole window.
--
-- Additive: one function, one trigger, and a backfill. Every existing `admin` token is
-- cut to two hours from its own `createdAt`. One minted more than two hours ago expires
-- now; a younger one keeps the rest of its two hours. The backfill runs before the
-- trigger exists. It changes only `expiresAt`, which the `capabilities_issuer_bound`
-- trigger does not watch, so a token whose issuer has since lost access is still
-- expired rather than refused.
--
-- One transaction, so a deploy stopped partway leaves neither the backfill nor the
-- trigger half applied.

BEGIN;

UPDATE "capabilities"
SET "expiresAt" = "createdAt" + interval '2 hours'
WHERE "permission" = 'admin'
  AND "expiresAt" > "createdAt" + interval '2 hours';

CREATE FUNCTION "capabilities_admin_window"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW."permission" <> 'admin' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- UTC wall-clock time, the form Prisma stores in this column (lib/sql-utc-now.ts).
    NEW."createdAt" := now() AT TIME ZONE 'UTC';
  ELSE
    NEW."createdAt" := OLD."createdAt";
  END IF;
  NEW."expiresAt" := LEAST(NEW."expiresAt", NEW."createdAt" + interval '2 hours');
  RETURN NEW;
END
$$;

CREATE TRIGGER "capabilities_admin_window"
BEFORE INSERT OR UPDATE
ON "capabilities"
FOR EACH ROW
EXECUTE FUNCTION "capabilities_admin_window"();

COMMIT;
