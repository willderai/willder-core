-- Every change event can name the task its write was made for, the `willder/task` key the
-- writer's MCP session sent, so a later session of the same task is served what was
-- decided and written under it. Additive and nullable: events written before this
-- migration, and writes that name no task, keep NULL.

-- AlterTable
ALTER TABLE "change_events" ADD COLUMN "task" TEXT;

-- CreateIndex
CREATE INDEX "change_events_orgId_task_seq_idx" ON "change_events"("orgId", "task", "seq");
