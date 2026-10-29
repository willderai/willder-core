-- Drive connector: Source + SourceFile models for folder-sync ingestion.
-- Source tracks a connected knowledge source (Drive folder / website).
-- SourceFile tracks per-file idempotency (skip re-ingest if checksum unchanged).

CREATE TYPE "SourceType" AS ENUM ('gdrive', 'website');
CREATE TYPE "SourceStatus" AS ENUM ('active', 'syncing', 'error', 'disconnected');

CREATE TABLE "sources" (
    "id"              TEXT NOT NULL,
    "orgId"           TEXT NOT NULL,
    "type"            "SourceType" NOT NULL,
    "externalId"      TEXT NOT NULL,
    "name"            TEXT NOT NULL,
    "scopePath"       TEXT NOT NULL,
    "status"          "SourceStatus" NOT NULL DEFAULT 'active',
    "encryptedTokens" TEXT,
    "meta"            JSONB NOT NULL DEFAULT '{}',
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,
    CONSTRAINT "sources_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "source_files" (
    "id"             TEXT NOT NULL,
    "sourceId"       TEXT NOT NULL,
    "externalFileId" TEXT NOT NULL,
    "checksum"       TEXT NOT NULL,
    "episodeId"      TEXT,
    "syncedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "source_files_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sources_orgId_type_externalId_key" ON "sources"("orgId", "type", "externalId");
CREATE INDEX "sources_orgId_idx" ON "sources"("orgId");
CREATE UNIQUE INDEX "source_files_sourceId_externalFileId_key" ON "source_files"("sourceId", "externalFileId");
CREATE INDEX "source_files_sourceId_idx" ON "source_files"("sourceId");

ALTER TABLE "sources" ADD CONSTRAINT "sources_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "source_files" ADD CONSTRAINT "source_files_sourceId_fkey"
    FOREIGN KEY ("sourceId") REFERENCES "sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;
