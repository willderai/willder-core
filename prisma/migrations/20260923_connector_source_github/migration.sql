-- GitHub source connector, stage 1 (decided 2026-09-22): one repository per
-- source, read-only, fetched with a customer-pasted fine-grained token stored
-- encrypted in the existing Source.encryptedTokens column. New enum value only.
ALTER TYPE "SourceType" ADD VALUE IF NOT EXISTS 'github';
