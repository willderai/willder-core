-- Feedback users send through the MCP `send_feedback` tool (mcp/tools/send-feedback.ts).
--
-- Additive: one new table, nothing existing changes. Rows belong to their org and go
-- with it on delete. The (orgId, agentId, createdAt) index serves the per-agent hourly
-- limit; the createdAt index serves the operator reading the newest feedback first.
CREATE TABLE "product_feedback" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "context" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_feedback_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "product_feedback_orgId_agentId_createdAt_idx" ON "product_feedback"("orgId", "agentId", "createdAt");

CREATE INDEX "product_feedback_createdAt_idx" ON "product_feedback"("createdAt");

ALTER TABLE "product_feedback" ADD CONSTRAINT "product_feedback_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
