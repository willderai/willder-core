-- Item realtime-memory-slice-20260923, scope (2): per-agent position in the
-- change feed, so an agent can ask "what changed since I last looked" without
-- carrying a cursor of its own.
--
-- New table, no column added to any table already serving traffic.

CREATE TABLE "agent_cursors" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "lastSeq" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_cursors_pkey" PRIMARY KEY ("id")
);

-- One cursor per agent per org, and the key the read path looks the cursor up by.
CREATE UNIQUE INDEX "agent_cursors_orgId_agentId_key" ON "agent_cursors"("orgId", "agentId");

ALTER TABLE "agent_cursors" ADD CONSTRAINT "agent_cursors_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
