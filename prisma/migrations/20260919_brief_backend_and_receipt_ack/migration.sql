-- Found by a live end-to-end run of the handoff flow: the UC6 completion receipt
-- was a transient client render only -- no field on the brief API response, no
-- stored backend, so a reload showed "Backend: Unknown". Additive, nullable
-- column on a table already serving live traffic (the standing schema rule
-- for a table under live traffic, decided 2026-09-04) -- no
-- backfill needed, existing rows simply read null (the same "Unknown" label
-- the UI already renders for that case). No new table: grantee acknowledgement
-- is a new audit_log row (action "brief.acknowledged"), not a schema change --
-- audit_log is already append-only and already the read/write pattern
-- services/access/check.ts owns for this brief.

ALTER TABLE "briefs" ADD COLUMN "backend" TEXT;
