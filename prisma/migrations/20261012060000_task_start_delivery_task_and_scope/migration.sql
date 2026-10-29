-- A task-start delivery is told once per session, task and scope, not once per session.
-- Keyed on the session alone, a block served for one task silenced the next task's block
-- for the whole idle window, and one agent's token on a second scope lost its block to
-- the first: a client that names no session (an agent CLI's MCP calls, the change-feed
-- hook before it sent one) shares a single session per agent.
--
-- Additive: two columns defaulting to "" and a wider unique key. Existing rows keep "",
-- so a session served before this migration is re-served at most once, on its next call
-- that names a task or a scope, and nothing is backfilled.

-- AlterTable
ALTER TABLE "task_start_deliveries" ADD COLUMN     "scopePath" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "taskKey" TEXT NOT NULL DEFAULT '';

-- DropIndex
DROP INDEX "task_start_deliveries_orgId_agentId_sessionKey_key";

-- CreateIndex
CREATE UNIQUE INDEX "task_start_deliveries_delivery_key" ON "task_start_deliveries"("orgId", "agentId", "sessionKey", "scopePath", "taskKey");
