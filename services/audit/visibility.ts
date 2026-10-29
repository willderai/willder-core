import { Prisma } from "@/lib/generated/prisma/client";
// Imported from the concrete module rather than the "@/services/access"
// barrel: this is a leaf SQL-escaping utility, not part of the access
// service's public surface, and route suites that mock the barrel wholesale
// (to stub can()) must not have to know this file needs it.
import { escapeLikePrefix } from "@/services/access/scope-containment";
import {
  ALWAYS_VISIBLE_ACTIONS,
  DENY_ALWAYS_ACTIONS,
  TARGET_CONDITIONAL_ACTIONS,
} from "@/services/audit/audit-actions";

// The three forms of one rule: which AuditLog rows every audit-adjacent
// screen shows. All three derive from AUDIT_ACTIONS
// (services/audit/audit-actions.ts) rather than restating it, so they cannot
// drift apart. See that file for
// why the map itself lives in a separate, runtime-dependency-free module:
// this one needs Prisma at runtime and is therefore server-only, while the
// labels are read from client components.

/** The rule stated over an in-memory (action, target, decision) row, for a
 * caller that already has the row rather than a query to filter. Derived from the same
 * AUDIT_ACTIONS map as {@link visibleAuditRowSql}, and the reference semantics
 * that function is documented and tested against -- which is what makes the
 * SQL form's escaping checkable at all: a literal `String.includes` has no
 * wildcard behaviour to reproduce. */
export function isVisibleAuditRow(action: string, target: string | null, decision: "allow" | "deny"): boolean {
  if ((ALWAYS_VISIBLE_ACTIONS as readonly string[]).includes(action)) return true;
  if (decision === "deny" && (DENY_ALWAYS_ACTIONS as readonly string[]).includes(action)) {
    return true;
  }
  const conditional = TARGET_CONDITIONAL_ACTIONS.find((entry) => entry.action === action);
  if (conditional === undefined || target == null) return false;
  return conditional.markers.some((marker) => target.includes(marker));
}

/**
 * Raw-SQL form of the same rule, and the only query form this module offers.
 * All three audit readers issue their queries through
 * `services/access/audit-query.ts` as raw SQL: GET /api/audit because its
 * scope-containment predicate needs a `LIKE ... ESCAPE` clause Prisma's typed
 * `where` API cannot express at all, and the actors and per-run readers
 * because this rule does too (see below).
 *
 * Returns a self-contained parenthesised boolean fragment to be `AND`-ed into
 * a larger WHERE clause. Every value is bound as a query parameter.
 *
 * The markers are escaped with {@link escapeLikePrefix} before being wrapped
 * in `%`, which makes this form match {@link isVisibleAuditRow} EXACTLY:
 * `fact_dispute:` contains an `_`, a LIKE wildcard, so an unescaped pattern
 * would also match a target reading `factXdispute:` -- where the JS
 * predicate's `String.includes` is a literal substring test. This is the same
 * wildcard class as the scope-containment leak in the caller, applied to a
 * constant rather than to user input.
 *
 * There is deliberately no Prisma typed `where` form
 * (`target: { contains: marker }`) beside this one: `contains` compiles to an
 * unescaped `LIKE`, and the typed API has no `ESCAPE` clause to offer, so the
 * rule cannot be expressed correctly in it at all. With a single export the
 * escaping cannot be bypassed by picking the other one.
 *
 * A NULL `target` fails every `LIKE` leg (SQL NULL is not true), matching
 * {@link isVisibleAuditRow}'s explicit `target == null` rejection.
 *
 * Each action marked `denyAlways` adds one more leg, `"action" = <a> AND
 * "decision" = 'deny'`, so its refusals are shown whatever their target. The
 * decision is a SQL literal rather than a bound value because the column is an
 * enum and the value is a constant; only the action is bound.
 */
export function visibleAuditRowSql(): Prisma.Sql {
  const conditionalLegs = TARGET_CONDITIONAL_ACTIONS.map(
    ({ action, markers }) => Prisma.sql`(
      "action" = ${action}
      AND (${Prisma.join(
        markers.map((marker) => Prisma.sql`"target" LIKE ${`%${escapeLikePrefix(marker)}%`} ESCAPE '\\'`),
        " OR ",
      )})
    )`,
  );
  const denyLegs = DENY_ALWAYS_ACTIONS.map((action) => Prisma.sql`("action" = ${action} AND "decision" = 'deny')`);
  return Prisma.sql`(
    "action" IN (${Prisma.join([...ALWAYS_VISIBLE_ACTIONS])})
    OR (${Prisma.join([...conditionalLegs, ...denyLegs], " OR ")})
  )`;
}
