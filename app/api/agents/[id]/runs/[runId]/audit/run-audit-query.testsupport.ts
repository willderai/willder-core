// Test-only support for this route's suites (not collected by vitest, whose
// include is `**/*.test.ts`; not reachable from the served application).
//
// The run's entries query lives in services/access/audit-query.ts, where it is
// issued as raw SQL: the visible-row rule it applies matches an access.manage
// target against markers containing `_`, a LIKE wildcard, so it needs a
// `LIKE ... ESCAPE` clause Prisma's typed `where` API cannot emit.
//
// The suites here are about which actorId and window the route asks for and
// how it reasons about overlapping runs -- not about SQL. They mock
// queryRunAuditEntries and keep their existing where-clause fixtures, and this
// translates the function's arguments into that shape.
import type { RunAuditEntryQuery } from "@/services/access/audit-query";

/** The Prisma-shaped `where` equivalent to what queryRunAuditEntries() asks
 * the database for. `actorType: "agent"` is included because the real function
 * applies it internally -- a run's rows are always written by the agent
 * executing it -- and a fake that dropped it would let a suite's human-actor
 * fixture rows reach a trail the real query would never return. */
export function whereFor(q: RunAuditEntryQuery): Record<string, unknown> {
  return {
    orgId: q.orgId,
    actorType: "agent",
    actorId: q.actorId,
    at: { gte: q.from, lte: q.to },
  };
}
