-- Willder's own OAuth authorization server for the hosted MCP endpoint
-- (services/access/oauth-client.ts, services/access/oauth-authorization.ts):
-- registered clients, one-time authorization codes, and access and refresh tokens.
--
-- Additive: three new tables, nothing existing changes. Codes and tokens store only
-- a SHA-256 of their secret, and go with their client, their connection or their
-- capability on delete, so revoking or deleting any of those ends them. Codes and tokens
-- refuse new rows for an org whose deletion is open, as capabilities do (end of file).

-- CreateTable
CREATE TABLE "oauth_clients" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "redirectUris" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_authorization_codes" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "capabilityId" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "codeChallenge" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_authorization_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_tokens" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "capabilityId" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "oauth_authorization_codes_codeHash_key" ON "oauth_authorization_codes"("codeHash");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_tokens_tokenHash_key" ON "oauth_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "oauth_tokens_familyId_idx" ON "oauth_tokens"("familyId");

-- AddForeignKey
ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "oauth_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "oauth_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_capabilityId_fkey" FOREIGN KEY ("capabilityId") REFERENCES "capabilities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "oauth_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "oauth_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_capabilityId_fkey" FOREIGN KEY ("capabilityId") REFERENCES "capabilities"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- An org being deleted gains no new code or token (org_deletion_refuse_write,
-- 20261016200000_org_deletions), resolved through the connection's org. Inserts only, as on
-- "capabilities": revoking a token while the deletion is open must still work.
CREATE TRIGGER "org_deletion_refuse_write" AFTER INSERT ON "oauth_authorization_codes"
  FOR EACH ROW EXECUTE FUNCTION "org_deletion_refuse_write"('oauth_connections', 'connectionId');
CREATE TRIGGER "org_deletion_refuse_write" AFTER INSERT ON "oauth_tokens"
  FOR EACH ROW EXECUTE FUNCTION "org_deletion_refuse_write"('oauth_connections', 'connectionId');
