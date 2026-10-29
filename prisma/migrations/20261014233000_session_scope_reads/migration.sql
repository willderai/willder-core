-- The scopes each agent has been shown content from, for the derived-write rule
-- (services/access/derived-writes.ts): a write into scope B after reading a scope whose
-- readers are not all B's readers is refused unless it declares the share.
--
-- Additive: one new table, nothing existing changes. Rows go with their org.

-- CreateTable
CREATE TABLE "session_scope_reads" (
    "orgId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "scopePath" TEXT NOT NULL,
    "lastReadAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_scope_reads_pkey" PRIMARY KEY ("orgId","agentId","scopePath")
);

-- AddForeignKey
ALTER TABLE "session_scope_reads" ADD CONSTRAINT "session_scope_reads_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
