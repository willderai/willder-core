-- Store every agent reference in grants and capabilities under the agent's key.
--
-- The access page's grant form submitted an Agent row's database id as an agent
-- grant's "granteeId", and its token form took free text, where a person could
-- only type the agent's name, while runtime actors and check() name the same
-- agent by its "agentKey". The grant-revoke cascade and check()'s grant
-- re-derivation match those columns by equality, so revoking such a grant left
-- the agent's tokens live. Both write routes now canonicalize to the key
-- (services/access/agent-identity.ts); this migration rewrites rows stored
-- before that, in two passes that share one shape: first references by database
-- id, then references by name. A name is rewritten only when exactly one agent
-- in the org carries it and no agent's key equals it, the same rule the routes
-- apply. Data only, no schema change; every statement is a no-op on a database
-- with no such rows, so it is safe to re-run.

-- Every reference to rewrite, as (orgId, agentKey, ref, pass). Dropped at the end.
CREATE OR REPLACE VIEW "agent_reference_rewrites" AS
SELECT a."orgId", a."agentKey", a."id" AS "ref", 'id' AS "pass"
FROM "agents" AS a
UNION ALL
SELECT n."orgId", n."agentKey", n."name" AS "ref", 'name' AS "pass"
FROM "agents" AS n
WHERE NOT EXISTS (
    SELECT 1 FROM "agents" AS same_name
    WHERE same_name."orgId" = n."orgId" AND same_name."name" = n."name" AND same_name."id" <> n."id"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "agents" AS key_owner
    WHERE key_owner."orgId" = n."orgId" AND key_owner."agentKey" = n."name"
  );

-- 1. A database-id grant whose key-form twin already exists on the same scope and
--    permission would collide on the unique index once rewritten. Fold it into
--    the twin, keeping the longer-lived expiry (NULL means permanent), then drop it.
UPDATE "grants" AS twin
SET "expiresAt" = CASE
    WHEN twin."expiresAt" IS NULL OR legacy."expiresAt" IS NULL THEN NULL
    ELSE GREATEST(twin."expiresAt", legacy."expiresAt")
  END
FROM "grants" AS legacy
JOIN "agent_reference_rewrites" AS a ON a."ref" = legacy."granteeId" AND a."orgId" = legacy."orgId"
WHERE a."pass" = 'id'
  AND legacy."granteeType" = 'agent'
  AND twin."granteeType" = 'agent'
  AND twin."granteeId" = a."agentKey"
  AND twin."scopeId" = legacy."scopeId"
  AND twin."permission" = legacy."permission"
  AND twin."id" <> legacy."id";

DELETE FROM "grants" AS legacy
USING "agent_reference_rewrites" AS a, "grants" AS twin
WHERE a."pass" = 'id'
  AND a."ref" = legacy."granteeId"
  AND a."orgId" = legacy."orgId"
  AND legacy."granteeType" = 'agent'
  AND twin."granteeType" = 'agent'
  AND twin."granteeId" = a."agentKey"
  AND twin."scopeId" = legacy."scopeId"
  AND twin."permission" = legacy."permission"
  AND twin."id" <> legacy."id";

-- 2. Rewrite the remaining database-id agent grants to the key.
UPDATE "grants" AS g
SET "granteeId" = a."agentKey"
FROM "agent_reference_rewrites" AS a
WHERE a."pass" = 'id'
  AND g."granteeType" = 'agent'
  AND g."granteeId" = a."ref"
  AND g."orgId" = a."orgId";

-- 3. Rewrite database-id capability tokens the same way.
UPDATE "capabilities" AS c
SET "agentId" = a."agentKey"
FROM "agent_reference_rewrites" AS a
WHERE a."pass" = 'id'
  AND c."agentId" = a."ref"
  AND c."orgId" = a."orgId";

-- The name pass runs after the id pass, so a grant stored under both an id and
-- a name folds into the key-form row the id pass produced.

-- 4. A name-typed grant whose key-form twin already exists on the same scope and
--    permission would collide on the unique index once rewritten. Fold it into
--    the twin, keeping the longer-lived expiry (NULL means permanent), then drop it.
UPDATE "grants" AS twin
SET "expiresAt" = CASE
    WHEN twin."expiresAt" IS NULL OR legacy."expiresAt" IS NULL THEN NULL
    ELSE GREATEST(twin."expiresAt", legacy."expiresAt")
  END
FROM "grants" AS legacy
JOIN "agent_reference_rewrites" AS a ON a."ref" = legacy."granteeId" AND a."orgId" = legacy."orgId"
WHERE a."pass" = 'name'
  AND legacy."granteeType" = 'agent'
  AND twin."granteeType" = 'agent'
  AND twin."granteeId" = a."agentKey"
  AND twin."scopeId" = legacy."scopeId"
  AND twin."permission" = legacy."permission"
  AND twin."id" <> legacy."id";

DELETE FROM "grants" AS legacy
USING "agent_reference_rewrites" AS a, "grants" AS twin
WHERE a."pass" = 'name'
  AND a."ref" = legacy."granteeId"
  AND a."orgId" = legacy."orgId"
  AND legacy."granteeType" = 'agent'
  AND twin."granteeType" = 'agent'
  AND twin."granteeId" = a."agentKey"
  AND twin."scopeId" = legacy."scopeId"
  AND twin."permission" = legacy."permission"
  AND twin."id" <> legacy."id";

-- 5. Rewrite the remaining name-typed agent grants to the key.
UPDATE "grants" AS g
SET "granteeId" = a."agentKey"
FROM "agent_reference_rewrites" AS a
WHERE a."pass" = 'name'
  AND g."granteeType" = 'agent'
  AND g."granteeId" = a."ref"
  AND g."orgId" = a."orgId";

-- 6. Rewrite name-typed capability tokens the same way.
UPDATE "capabilities" AS c
SET "agentId" = a."agentKey"
FROM "agent_reference_rewrites" AS a
WHERE a."pass" = 'name'
  AND c."agentId" = a."ref"
  AND c."orgId" = a."orgId";

-- 7. Tokens minted while their agent's grant sat under the other identifier were
--    stamped ungoverned. Apply the same ratchet POST /api/access/grants applies
--    when an agent's first grant lands, now that the identifiers match.
UPDATE "capabilities" AS c
SET "grantGoverned" = true,
    "derivedFromGrantId" = (
      SELECT g."id" FROM "grants" AS g
      WHERE g."orgId" = c."orgId" AND g."granteeType" = 'agent' AND g."granteeId" = c."agentId"
      ORDER BY g."createdAt" ASC
      LIMIT 1
    )
WHERE c."grantGoverned" = false
  AND EXISTS (
    SELECT 1 FROM "grants" AS g
    WHERE g."orgId" = c."orgId" AND g."granteeType" = 'agent' AND g."granteeId" = c."agentId"
  );

DROP VIEW "agent_reference_rewrites";
