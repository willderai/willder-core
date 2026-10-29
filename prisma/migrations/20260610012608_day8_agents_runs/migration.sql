-- CreateEnum
CREATE TYPE "AgentRole" AS ENUM ('research', 'copy');

-- CreateEnum
CREATE TYPE "AgentRunStatus" AS ENUM ('running', 'completed', 'failed');

-- CreateTable
CREATE TABLE "agents" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "AgentRole" NOT NULL,
    "model" TEXT,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "status" "AgentRunStatus" NOT NULL DEFAULT 'running',
    "triggeredBy" TEXT,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agents_orgId_idx" ON "agents"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "agents_orgId_agentKey_key" ON "agents"("orgId", "agentKey");

-- CreateIndex
CREATE INDEX "agent_runs_orgId_agentId_idx" ON "agent_runs"("orgId", "agentId");

-- CreateIndex
CREATE INDEX "agent_runs_orgId_status_idx" ON "agent_runs"("orgId", "status");

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
