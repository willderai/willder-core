// Fact roles: what a fact version is to the task that wrote it.
//
// A writer may say, on memory_ingest, that a fact is the task's cause, a constraint on
// it, a decision, an option it rejected, or a note of its progress. A later session of
// the same task is served the facts that decide it before the ones that only record how
// far it got (services/memory/task-start.ts). Nothing infers a role: a fact carries one
// only when its writer declared it.
//
// The one rule this file enforces: deciding facts come first, then facts with no role, then
// progress notes, whatever the session is doing. Within each tier the task-start read orders
// them by what the session is doing, the newest first among equals, so a task whose writers
// never declare a role is ranked as one tier.
import { Prisma } from "@/lib/generated/prisma/client";
import type { FactRole } from "@/lib/generated/prisma/enums";

export type { FactRole };

/** Every role, for input validation. */
export const FACT_ROLES = [
  "cause",
  "constraint",
  "decision",
  "rejected",
  "progress",
] as const satisfies readonly FactRole[];

/** The roles that decide a task: served ahead of facts with no role and of progress notes. */
const DECIDING_ROLES = ["cause", "constraint", "decision", "rejected"] as const satisfies readonly FactRole[];

/**
 * The serving tier of `role`, lowest first, as {@link factRoleTierSql} computes it in the
 * database: 0 for a role that decides the task, 1 for no role, 2 for progress.
 */
export function factRoleTier(role: FactRole | null): number {
  if (role === null) return 1;
  return (DECIDING_ROLES as readonly FactRole[]).includes(role) ? 0 : 2;
}

/**
 * The serving tier of the role in `column`, lowest first: 0 for a role that decides the
 * task, 1 for no role, 2 for progress. Order by it ascending, then by recency.
 */
export function factRoleTierSql(column: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`CASE
    WHEN ${column}::text IN (${Prisma.join(DECIDING_ROLES)}) THEN 0
    WHEN ${column} IS NULL THEN 1
    ELSE 2
  END`;
}
