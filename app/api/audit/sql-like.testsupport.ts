import {
  ALWAYS_VISIBLE_ACTIONS,
  DENY_ALWAYS_ACTIONS,
  TARGET_CONDITIONAL_ACTIONS,
} from "@/services/audit/audit-actions";

// Test-only support for the audit suites (not collected by vitest, whose
// include is `**/*.test.ts`; not reachable from the served application).
//
// GET /api/audit issues raw SQL through services/access/audit-query.ts, whose
// two guards are both `LIKE ... ESCAPE` predicates: the scope-containment
// filter and the target-aware visibility rule. A suite that mocks
// `db.$queryRaw` therefore has to decide what a pattern matches, and the
// obvious shortcuts -- JS `.startsWith()`, or stripping `%` and calling
// `.includes()` -- have no wildcard semantics at all. That blind spot is
// exactly what let the wildcard half of the leak ship twice: the mocked suite
// passed at a head where real Postgres returned sibling-scope rows.
//
// So these decode a pattern the way Postgres does, rather than reproducing
// how services/access/scope-containment.ts's escapeLikePrefix() builds one.
// The decoder cannot echo the encoder's bugs: removing the escaping in
// production code changes the pattern, and these change what it matches.
//
// The real-Postgres suite (scope-containment-realdb.qa.test.ts) remains the
// authority on the SQL actually issued; this only keeps the fast mocked
// suites from being structurally unable to see a wildcard defect.

/** Compile a Postgres `LIKE` pattern under `ESCAPE '\'`: a backslash makes
 * the next character literal, an unescaped `%` matches any run of characters
 * and an unescaped `_` matches exactly one. */
function likeToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      const next = pattern[++i];
      out += next !== undefined ? `\\${next}` : "\\\\";
    } else if (c === "%") {
      out += ".*";
    } else if (c === "_") {
      out += ".";
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

/** `value LIKE pattern ESCAPE '\'`. A NULL value never matches, as in SQL. */
export function sqlLike(value: string | null, pattern: string): boolean {
  return value !== null && likeToRegExp(pattern).test(value);
}

/** The bound values services/audit/visibility.ts's `visibleAuditRowSql()`
 * contributes, in the order it emits them: the always-visible actions, then
 * for each target-conditional action its own action literal followed by one
 * `LIKE` pattern per marker, then one action literal per deny-always action.
 *
 * Derived from services/audit/audit-actions.ts rather than hardcoded, so
 * changing which actions are visible (or how many markers one carries)
 * cannot silently desynchronise this decoder from the SQL it decodes. A
 * hardcoded count did exactly that when `memory.entity` became visible. */
export const VISIBILITY_VALUE_COUNT =
  ALWAYS_VISIBLE_ACTIONS.length +
  TARGET_CONDITIONAL_ACTIONS.reduce((n, { markers }) => n + 1 + markers.length, 0) +
  DENY_ALWAYS_ACTIONS.length;

export type VisibilityValues = {
  alwaysVisibleActions: string[];
  /** One entry per target-conditional action: its action literal and the
   * `LIKE` patterns that make a row of that action visible. */
  conditional: { action: string; markerPatterns: string[] }[];
  /** Actions whose deny rows are visible whatever their target. */
  denyAlwaysActions: string[];
};

export function parseVisibilityValues(values: unknown[], at: number): VisibilityValues {
  let i = at;
  const alwaysVisibleActions = values.slice(i, i + ALWAYS_VISIBLE_ACTIONS.length) as string[];
  i += ALWAYS_VISIBLE_ACTIONS.length;

  const conditional = TARGET_CONDITIONAL_ACTIONS.map(({ markers }) => {
    const action = values[i++] as string;
    const markerPatterns = values.slice(i, i + markers.length) as string[];
    i += markers.length;
    return { action, markerPatterns };
  });
  const denyAlwaysActions = values.slice(i, i + DENY_ALWAYS_ACTIONS.length) as string[];

  return { alwaysVisibleActions, conditional, denyAlwaysActions };
}

/** Evaluate the visibility fragment against one row, the way Postgres would.
 * A fixture row with no `decision` is treated as an allow row. */
export function rowIsVisible(
  row: { action: string; target: string | null; decision?: string },
  v: VisibilityValues,
): boolean {
  if (v.alwaysVisibleActions.includes(row.action)) return true;
  if (row.decision === "deny" && v.denyAlwaysActions.includes(row.action)) return true;
  const match = v.conditional.find((entry) => entry.action === row.action);
  if (match === undefined) return false;
  return match.markerPatterns.some((pattern) => sqlLike(row.target, pattern));
}

/**
 * Guard for the positional decoders in the audit suites: every value the query
 * bound must have been decoded by the time parsing finishes.
 *
 * Positional decoding is silent when it is wrong. A condition added to
 * services/access/audit-query.ts binds its own values in the middle of the
 * list, so a decoder that does not know about it reads every later leg from
 * the wrong offset and the suite carries on asserting against nonsense — or,
 * worse, quietly stops filtering on the leg it lost. Counting the values is
 * what turns that into a failure with a name.
 */
export function assertAllValuesDecoded(decoded: number, values: unknown[]): void {
  if (decoded !== values.length) {
    throw new Error(
      `audit query fake decoded ${decoded} of ${values.length} bound values: ` +
        `services/access/audit-query.ts emits a condition this decoder does not model. ` +
        `Model it here (and give the fixture rows the column it filters on) so the new ` +
        `predicate is exercised, rather than shifting every later value's offset.`,
    );
  }
}
