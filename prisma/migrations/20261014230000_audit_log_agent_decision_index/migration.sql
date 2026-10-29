-- One agent's newest allowed and newest denied call, without walking the org's audit log.
--
-- The agents dashboard shows each connected agent's last allowed and last denied token
-- call side by side, sorts and filters by them, and counts its calls this week
-- (services/agents/agent-dashboard.ts listRoster). Without this index each lookup scans
-- the org's whole audit log through (orgId, at); with it, each one reads that agent's
-- rows for one decision newest first and stops at the first visible row.
--
-- Additive: one index, no data change.
CREATE INDEX IF NOT EXISTS "audit_log_orgId_actorType_actorId_decision_at_idx"
  ON "audit_log"("orgId", "actorType", "actorId", "decision", "at");
