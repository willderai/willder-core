-- Phase 1 (UC6) + Phase 2 (UC7) + Phase 3 (UC8) agent roles.
ALTER TYPE "AgentRole" ADD VALUE IF NOT EXISTS 'handoff';
ALTER TYPE "AgentRole" ADD VALUE IF NOT EXISTS 'architecture';
ALTER TYPE "AgentRole" ADD VALUE IF NOT EXISTS 'qa';
