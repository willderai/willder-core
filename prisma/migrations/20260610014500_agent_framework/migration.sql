-- Agent framework: each agent carries its own system prompt and tool set, and
-- may use the custom role.
--
-- Moved here from 20260610_day10_agent_framework, which sorted before the
-- migration that creates the agents table (see the note in that directory).
-- Every statement is conditional because databases migrated before the move
-- already applied the original, and for them this migration must change
-- nothing.

ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "systemPrompt" TEXT;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "tools" TEXT[] NOT NULL DEFAULT '{}';
ALTER TYPE "AgentRole" ADD VALUE IF NOT EXISTS 'custom';
