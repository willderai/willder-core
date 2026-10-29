-- Caller-supplied idempotency keys on memory writes (services/memory/ingest-key.ts):
-- memory_ingest's `idempotencyKey` and the `Idempotency-Key` header on
-- POST /api/memory/ingest.
--
-- Additive: one new table, nothing existing changes. Rows belong to their org and go
-- with it on delete. The unique index is the claim: two calls with one key from one
-- principal cannot both insert, so exactly one of them writes.
CREATE TABLE "memory_ingest_keys" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "claimToken" TEXT NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL,
    "reply" JSONB,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_ingest_keys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "memory_ingest_keys_orgId_actorType_actorId_key_key" ON "memory_ingest_keys"("orgId", "actorType", "actorId", "key");

ALTER TABLE "memory_ingest_keys" ADD CONSTRAINT "memory_ingest_keys_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
