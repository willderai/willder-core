-- OAuth connections for the hosted MCP endpoint (services/access/oauth-connection.ts):
-- which capability a person's OAuth client runs as in one org.
--
-- Additive: one new table, nothing existing changes. A row goes with its org, its
-- person or its capability on delete. The unique index on (org, person, client) is
-- what makes a reconnect replace the binding instead of adding a second live one.

-- CreateTable
CREATE TABLE "oauth_connections" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "capabilityId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "oauth_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "oauth_connections_capabilityId_key" ON "oauth_connections"("capabilityId");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_connections_orgId_userId_clientId_key" ON "oauth_connections"("orgId", "userId", "clientId");

-- AddForeignKey
ALTER TABLE "oauth_connections" ADD CONSTRAINT "oauth_connections_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_connections" ADD CONSTRAINT "oauth_connections_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_connections" ADD CONSTRAINT "oauth_connections_capabilityId_fkey" FOREIGN KEY ("capabilityId") REFERENCES "capabilities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

