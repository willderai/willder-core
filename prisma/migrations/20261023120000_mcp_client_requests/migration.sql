-- The hosted MCP endpoint can now ask a client something in the middle of a tool call
-- (sampling/createMessage, elicitation/create). The endpoint is stateless and runs on many
-- instances, so the client's reply arrives on a later HTTP request that may reach another
-- instance. This table carries the reply from that request to the waiting call
-- (mcp/client-requests.ts). A row lives only while its call waits: the call deletes it, and
-- a row a crashed call left behind is deleted by the next request after ten minutes.
-- "credential" names the token that asked (a hash of a bearer token, or the id of the
-- capability an OAuth token was issued for, never a raw token), so only that token's reply is
-- taken, not one from another token of the same agent.
--
-- Additive: one new table; no existing row or column changes. Like the read receipts it
-- stays writable while an org deletion is open: it holds no memory, and the deletion
-- removes its rows with every other orgId table.

-- CreateTable
CREATE TABLE "mcp_client_requests" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "credential" TEXT NOT NULL,
    "reply" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_client_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mcp_client_requests_createdAt_idx" ON "mcp_client_requests"("createdAt");

-- AddForeignKey
ALTER TABLE "mcp_client_requests" ADD CONSTRAINT "mcp_client_requests_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
