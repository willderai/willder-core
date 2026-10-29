-- The smallest possible contact search/read/upsert agent-API surface. Both new
-- Contact columns are additive with defaults on a table already serving live
-- traffic (the standing schema rule for such a table, decided 2026-09-04) —
-- no backfill needed, no existing query affected.

ALTER TABLE "contacts" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "contacts" ADD COLUMN "suppressed" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: an existing contact already opted out via the human-facing `status`
-- field (unsubscribed/bounced) must read as suppressed through the new agent-API
-- surface too, or an agent would treat a known opt-out/bounce as still
-- contactable (the file header's "no backfill needed"
-- claim above covers the column defaults being safe for unrelated existing
-- queries, not this). New rows still take the plain `false` column default.
UPDATE "contacts" SET "suppressed" = true WHERE "status" IN ('unsubscribed', 'bounced');

-- contactId is nullable with ON DELETE SET NULL, not the CASCADE this table
-- shipped with : a hard delete
-- of the contact (app/api/contacts/[id]/route.ts DELETE) must not silently
-- wipe this row, or a delayed create retry presenting the same idempotencyKey
-- finds no recorded key at all and recreates the contact a human just deleted.
-- resultSnapshot freezes the full result (see agent-contacts.ts's
-- AgentContactSummary) at the moment the write was accepted, so a replay
-- never needs a live contact row to answer from — it returns the exact
-- recorded outcome whether or not the contact still exists.
-- ingestedAt : null until
-- this row's write has actually reached the memory graph. A replay of this
-- key while it's still null must repair the ingestion gap before returning
-- the recorded success, instead of reporting success again with the graph
-- never told (see agent-contacts.ts's replayIdempotentResult). Round 6
-- redefines exactly WHEN this gets set -- delivery, not enqueue/dispatch --
-- but the column itself is unchanged.
--
-- actorId : the actor who made
-- the ORIGINAL accepted write. replayIdempotentResult's graph-sync repair
-- must attribute the fact to this actor, not whichever caller happens to be
-- retrying -- otherwise a retry from a different agent/capability silently
-- reassigns authorship and skews provenance ranking.
--
-- deliveryClaimedAt :
-- round 6 correctly moved ingestedAt to mean delivery-complete, not
-- enqueue-complete, but that widened the null window to the whole delivery
-- latency -- an ordinary client retry-on-timeout landing in that window took
-- the repair branch and re-dispatched a delivery that was only ever still in
-- flight, burning org episode-cap quota on a real duplicate episode
-- (reproduced against real upsertContact). This is a lease-style claim on
-- the right to dispatch, atomically set by agent-contacts.ts's
-- claimDeliveryAttempt (an updateMany CAS) so a second dispatch attempt
-- arriving before the first finishes sees the row already claimed and skips
-- re-ingesting instead of racing it; see agent-contacts.ts for the full design and the lease-duration
-- tradeoff. Still edited in place, not appended -- this migration remains
-- unapplied anywhere (see round-4's same note above); confirmed again this
-- round the same way.
--
-- deliveryClaimToken (found in review): round 7's release fenced only on
-- `ingestedAt IS NULL`, so a stale dispatch attempt's late failure could
-- clear a DIFFERENT, live claim taken by a reclaiming attempt in the
-- meantime -- reproduced, 3 `ingestMemory` calls for one accepted write. A
-- timestamp-equality fence on `deliveryClaimedAt` was tried first and
-- rejected: `new Date()` has millisecond resolution, and a reclaim landing
-- in the same millisecond as the stale claim produces an equal timestamp,
-- silently degrading that fence back to unfenced. This column holds a fresh
-- `randomUUID()` per attempt instead (agent-contacts.ts's
-- `claimDeliveryAttempt`/`releaseDeliveryClaim`), so a release only succeeds
-- while its own token is still the one on the row. Still edited in place,
-- not appended -- this migration remains unapplied anywhere (see round-4's
-- and round-7's same note above); confirmed again this round the same way.
CREATE TABLE "contact_idempotency_keys" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "contactId" TEXT,
    "resultAction" TEXT NOT NULL,
    "resultRevision" INTEGER NOT NULL,
    "resultSnapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ingestedAt" TIMESTAMP(3),
    "actorId" TEXT NOT NULL,
    "deliveryClaimedAt" TIMESTAMP(3),
    "deliveryClaimToken" TEXT,

    CONSTRAINT "contact_idempotency_keys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "contact_idempotency_keys_orgId_key_key" ON "contact_idempotency_keys"("orgId", "key");
CREATE INDEX "contact_idempotency_keys_orgId_idx" ON "contact_idempotency_keys"("orgId");

ALTER TABLE "contact_idempotency_keys" ADD CONSTRAINT "contact_idempotency_keys_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "contact_idempotency_keys" ADD CONSTRAINT "contact_idempotency_keys_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
