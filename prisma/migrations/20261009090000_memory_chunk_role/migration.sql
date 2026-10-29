-- Records what a fact version is to the task that wrote it, when its writer says:
-- cause, constraint, decision, rejected or progress. The task-start block serves a
-- task's facts that decide it ahead of its progress notes (services/memory/task-start.ts).
--
-- Additive: one new type and one nullable column, no row changes. Existing rows stay
-- null, which ranks exactly as every row ranked before, so nothing is backfilled.

-- CreateEnum
CREATE TYPE "FactRole" AS ENUM ('cause', 'constraint', 'decision', 'rejected', 'progress');

-- AlterTable
ALTER TABLE "memory_chunks" ADD COLUMN     "role" "FactRole";
