// The one shared scope-containment predicate. Every call site that asks "is
// target inside scope" (check.ts, mcp/tools.ts, pgvector-store.ts, the scopes
// delete route) spells it through here, so the ESCAPE handling and the
// untagged/IS NULL leg cannot drift between copies.
//
// Two modes serve two indexes and are deliberately not collapsed: `ltree`
// (`@>`/`<@` on an `::ltree` cast) is what the GiST expression index on
// `(scopePath::ltree)` serves; `text` (`=`/`LIKE ... ESCAPE`) is what a plain
// btree `(orgId, scopePath)` serves. A GiST index cannot serve a LIKE query at
// all, whatever the table size, so the two modes are not interchangeable.
// Call sites pick the mode that matches their table's index.
import { Prisma } from "@/lib/generated/prisma/client";

/** Escape LIKE metacharacters (`%`, `_`) and the escape character itself, so a
 * scope path can only ever match its own subtree literally in a LIKE prefix,
 * never as a wildcard. Postgres LIKE treats `_` as "any single character" and
 * ltree labels permit `_` in user-chosen scope names, so an unescaped
 * `${scope}.%` bound prefix lets a caller scoped to e.g. `org.dept_sales` also
 * match `org.deptXsales.*` -- a same-tenant cross-scope read. Every
 * `mode: "text"` call site shares this one escaping function, never a
 * re-typed copy that could drift.
 */
export function escapeLikePrefix(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export type ScopeContainmentOptions =
  /** `column @> path`: does the scope at `column` (an ancestor-or-self
   * relation, e.g. a grant's or capability's own path) COVER `path`? The
   * direction check.ts's evaluate() uses -- ltree only, both of its tables
   * (`scopes`, `capabilities`) are GiST-indexed on the `::ltree` cast. */
  | { relation: "covers"; mode: "ltree" }
  /** `column <@ path`: is the row at `column` CONTAINED WITHIN `path` (equal
   * to it or a descendant)? The direction every other call site uses --
   * filtering rows by a scope check()/a capability has already authorized. */
  | { relation: "within"; mode: "ltree" }
  | { relation: "within"; mode: "text"; includeUntagged?: boolean };

/**
 * The one containment predicate. `column` is always a hardcoded, non-caller-
 * supplied SQL identifier fragment from this codebase (e.g.
 * `Prisma.raw('"scopePath"')` or `Prisma.raw('s."path"')`) -- never build it
 * from user input. `path` is the (already-authorized or already-resolved)
 * scope path value, always bound as a real query parameter, never spliced in
 * as text.
 */
export function scopeContainsSql(column: Prisma.Sql, path: string, opts: ScopeContainmentOptions): Prisma.Sql {
  if (opts.relation === "covers") {
    return Prisma.sql`${column}::ltree @> ${path}::ltree`;
  }
  if (opts.mode === "ltree") {
    return Prisma.sql`${column}::ltree <@ ${path}::ltree`;
  }
  const prefix = `${escapeLikePrefix(path)}.%`;
  // The untagged/IS NULL leg is only correct when the caller's own checked
  // scope genuinely covers org root -- see each call site's own comment on
  // why `includeUntagged` is set the way it is. Kept as a single `OR` chain
  // (not a nested sub-predicate) so the generated SQL text is byte-for-byte
  // what the leak/scope tests assert against.
  return opts.includeUntagged
    ? Prisma.sql`(${column} IS NULL OR ${column} = ${path} OR ${column} LIKE ${prefix} ESCAPE '\\')`
    : Prisma.sql`(${column} = ${path} OR ${column} LIKE ${prefix} ESCAPE '\\')`;
}

/**
 * `column <@ path` exactly as {@link scopeContainsSql} with `relation: "within", mode: "ltree"`
 * says it, ANDed with a text test every row it admits also passes: `column ^@ path`, the
 * column starts with the path's text. An ltree's text is its labels joined by dots, and ltree's
 * input keeps an accepted text byte for byte, so a path equal to or below `path` starts with
 * `path`'s own text. The text test only rejects rows; the ltree test still decides every row
 * the text test lets through (a sibling such as `org_1.sales_eu` under `org_1.sales` passes the
 * text test and fails the ltree one). Correctness rests on the AND alone, not on the order
 * Postgres evaluates the two in, which SQL does not promise.
 *
 * Why: in a walk of an index that is not by scope, such as the org's change events newest
 * first by (orgId, seq), every row of the org's other scopes is filtered on the way, and
 * casting each one's text to ltree is the costly part. In the plans observed (Postgres 17),
 * the planner evaluates the cheap text test first and casts only the rows it lets through.
 * Measured on 60,000 events in sibling scopes: 59 ms filtering on the cast alone, 37 ms with
 * the text test (2026-10-29). Written as the `^@` operator rather than starts_with() so the
 * planner reads it as the prefix test it is; on the seed both gave the same plans and estimates.
 *
 * Use it only where such a walk is the plan. Elsewhere it changes the planner's row estimates
 * for no gain: tried on the task's session-state captures and on the since-your-last-session
 * walk, it moved both to worse plans.
 */
export function scopeWithinWalkedSql(column: Prisma.Sql, path: string): Prisma.Sql {
  return Prisma.sql`${column} ^@ ${path} AND ${scopeContainsSql(column, path, { relation: "within", mode: "ltree" })}`;
}

/**
 * Flatten a composed `Prisma.Sql` fragment back into the `[strings, ...values]`
 * shape `db.$queryRaw`/`db.$executeRaw` expect from a genuine tagged-template
 * call. Needed because `scopeContainsSql` above returns a `Prisma.Sql` meant
 * to be nested inside a larger query (Prisma's own supported composition,
 * "A SQL instance can be nested within each other to build SQL strings") --
 * composing the FULL query with `Prisma.sql` first (which really does flatten
 * nested fragments) and unpacking it this way keeps each call site's
 * generated SQL text and bound-value order identical to a hand-written
 * tagged template, so it is invisible to a caller (or a test) inspecting either.
 */
export function flattenSql(query: Prisma.Sql): [TemplateStringsArray, ...unknown[]] {
  // Prisma 7's `$queryRaw(n, ...i)` admits the call only when `n.raw !==
  // undefined || n.sql !== undefined` -- a genuine tagged template gets `raw`
  // for free from the JS spec, but `query.strings` here is a plain `string[]`
  // with neither, which Prisma rejects with PrismaClientValidationError
  // before dispatch. Attaching a `.raw` copy makes this a real tagged-
  // template-compatible object while keeping the exact `[strings, ...values]`
  // array shape the mocked-`db.$queryRaw` tests introspect.
  const strings = [...query.strings] as string[] & { raw: readonly string[] };
  strings.raw = [...query.strings];
  return [strings as unknown as TemplateStringsArray, ...query.values];
}
