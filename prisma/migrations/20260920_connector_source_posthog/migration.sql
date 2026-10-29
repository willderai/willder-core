-- Item posthog-source-connector-20260918: one named PostHog insight per
-- source, fetched with a customer-pasted personal API key (stored encrypted
-- in the existing Source.encryptedTokens column). New enum value only, no
-- change to existing rows or columns.
ALTER TYPE "SourceType" ADD VALUE IF NOT EXISTS 'posthog';
