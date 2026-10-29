-- Read-only Slack + Figma
-- connectors, reusing the existing Source model. New enum values only, no
-- change to existing rows or columns.
ALTER TYPE "SourceType" ADD VALUE IF NOT EXISTS 'slack';
ALTER TYPE "SourceType" ADD VALUE IF NOT EXISTS 'figma';
