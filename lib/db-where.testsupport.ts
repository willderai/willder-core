// Prisma `where` semantics for suites that stand in for `@/lib/db` (test-only,
// not collected by vitest, whose include is `**/*.test.ts`; not reachable from
// the served application).
//
// Why this exists: a stand-in written the obvious way reads the keys it expects
// straight off the clause --
//
//   rows.filter((r) => r.orgId === where.orgId && r.scopePath === where.scopePath)
//
// -- and so fails CLOSED when the handler stops passing one of them. An absent
// key becomes `undefined`, nothing compares equal to it, and the query matches
// no rows at all. A boundary case asserting "the other tenant's row does not
// come back" then keeps passing on the guard's ABSENCE rather than on the
// guard, which is the one thing it exists to detect. That is the vacuous-mock
// class: the assertion holds because the filter stopped filtering.
//
// Real Prisma does the opposite: a `where` constrains only the keys it carries,
// so dropping one BROADENS the result set and the boundary case goes red. That
// is the behaviour below.
//
// Three further rules close the same silence one step at a time, since each of
// them also ends in a clause that matches nothing:
//
//   1. A key this stand-in does not model throws rather than being ignored.
//      Ignoring it means a predicate added to the handler tomorrow goes
//      unenforced here while the suite stays green.
//   2. A modelled key whose VALUE is a shape `===` cannot compare throws: a
//      Prisma operator object such as `{ in: [...] }` or `{ not: null }` (which
//      `services/memory/source-retirement.ts` already passes), an array, or a
//      Date, which compares by reference.
//   3. `===` has two sides, and rule 2 reads only the clause's. A Date COLUMN
//      compared against a primitive the clause is entitled to carry -- Prisma
//      accepts an ISO string for a DateTime field -- passes rule 2 and then
//      matches nothing, because no Date equals a string. So a column value
//      `===` cannot compare throws as well.
//
// Rule 3 applies only to the keys the clause actually carries. A column nothing
// filters on is never this accident, and the fixtures are full of them:
// ALL_BRIEFS in services/access/brief-scope-leak.eval.test.ts carries a
// `createdAt` Date and a `sections` array, and models neither.

/**
 * The rows a Prisma `where` carrying only `modelledKeys` would match.
 *
 * Each modelled key is an equality filter that applies only when the clause
 * actually carries it. Any other key throws, rather than being ignored, as does
 * a carried key where either side of the `===` -- the clause's value or the
 * column's -- is a value this helper cannot compare.
 *
 * @param modelledKeys Keys this stand-in knows how to filter on. Each must name
 *   a property of the row that the column maps to.
 */
export function matchWhere<T extends object>(
  rows: readonly T[],
  where: Record<string, unknown>,
  modelledKeys: readonly (keyof T & string)[],
): T[] {
  const unmodelled = Object.keys(where).filter((key) => !modelledKeys.includes(key as keyof T & string));
  if (unmodelled.length > 0) {
    throw new Error(
      `db stand-in does not model where key(s): ${unmodelled.join(", ")}. ` +
        `Add them to this call's modelledKeys (and give the fixture rows the matching property) ` +
        `so the new predicate is actually exercised, instead of being ignored here.`,
    );
  }
  // Checked before filtering rather than during it, so an empty fixture cannot
  // skip the check and leave an uncomparable clause looking like an honest miss.
  for (const key of modelledKeys) {
    const value = where[key];
    if (value === null || typeof value !== "object") continue;
    throw new Error(
      `db stand-in cannot compare the where value on "${key}": ${describeUncomparable(value)}. ` +
        `It filters with ===, which no row satisfies against that, so the clause would match ` +
        `nothing and a boundary case would pass on the filter's absence. Teach this helper the ` +
        `shape, or give the fixture rows a value it can compare directly.`,
    );
  }
  // The other side of that `===`. This half needs the rows to see, so an empty
  // fixture cannot reach it -- but an empty fixture has no column value to
  // mis-compare either, so there is nothing for it to skip.
  for (const key of modelledKeys) {
    const clauseValue = where[key];
    // `undefined` means the clause does not carry the key, which is the
    // broadening this helper exists for. `null` is the one non-primitive `===`
    // compares correctly, and real Prisma (`{ revokedAt: null }`) sends it.
    if (clauseValue === undefined || clauseValue === null) continue;
    for (const row of rows) {
      const columnValue: unknown = row[key];
      if (columnValue === null || typeof columnValue !== "object") continue;
      throw new Error(
        `db stand-in cannot compare the column value on "${key}": ` +
          `${describeUncomparable(columnValue)}, against the clause's ${typeof clauseValue}. ` +
          `It filters with ===, which equates those for no row, so the clause would match ` +
          `nothing and a boundary case would pass on the filter's absence. Give the fixture ` +
          `rows a value it can compare directly, or teach this helper the shape.`,
      );
    }
  }
  return rows.filter((row) => modelledKeys.every((key) => where[key] === undefined || row[key] === where[key]));
}

/** How the throws above name a value that `===` cannot compare. */
function describeUncomparable(value: object): string {
  if (Array.isArray(value)) return "an array";
  if (value instanceof Date) return "a Date";
  const operators = Object.keys(value);
  if (operators.length === 0) return "an empty object";
  return `a Prisma operator object (${operators.join(", ")})`;
}
