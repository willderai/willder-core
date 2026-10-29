// The scope-containment gate, factored out of eslint.config.mjs so it can be
// loaded standalone (see eslint.scope-gate.config.mjs): CI runs *only* this
// rule, to tell a new violation from the pre-existing eslint baseline.
//
// What it closes: the next hand-rolled scope predicate outside
// services/access/** and services/memory/** becomes a build error at write
// time instead of something a review has to happen to catch:
//   1. a raw `::ltree` cast or a `"scopePath"` column reference inside any
//      SQL template literal, and
//   2. a direct `db.$queryRaw`/`$queryRawUnsafe`/`$executeRaw`/
//      `$executeRawUnsafe` escape hatch off the Prisma client at all,
// each banned outside services/access/** and services/memory/** (the two
// modules that own scope-containment SQL) so a future call site can't
// reimplement the predicate. What it does not close: a defect inside those
// two modules, or one with no raw predicate at its site.
//
// Test files are excluded: they intentionally construct raw SQL to prove a
// leak scenario, which is the thing this rule exists to make unnecessary in
// production code, not a violation of it. scripts/** is excluded too --
// one-off operator diagnostics (run manually, never on a request path), not
// the served application. A real, narrow exception still goes through a
// documented `eslint-disable`/`eslint-disable-next-line` with a reason at the
// call site, in the diff, in front of the reviewer -- not a distant allowlist.
export const scopeContainmentGate = {
  files: ["**/*.ts", "**/*.tsx"],
  ignores: ["services/access/**", "services/memory/**", "scripts/**", "**/*.test.ts", "**/*.test.tsx"],
  rules: {
    "no-restricted-syntax": [
      "error",
      {
        selector: 'TemplateElement[value.raw=/::ltree|"scopePath"/]',
        message:
          "Raw ::ltree/scopePath predicate outside services/access or services/memory. " +
          "Route scope containment through services/access/check.ts or a services/memory data-access " +
          "helper instead of hand-rolling the predicate here -- this is exactly the recurring leak " +
          "class (items 34/35/37/38/53/55/59/60/61/62). A real, reviewed exception needs an inline " +
          "eslint-disable-next-line with a reason, not a wider rule change.",
      },
      {
        selector: "MemberExpression[object.name='db'][property.name=/^\\$(queryRaw|executeRaw)(Unsafe)?$/]",
        message:
          "Direct db.$queryRaw/$executeRaw access outside services/access or services/memory. " +
          "Raw SQL against a scoped model bypasses the typed Prisma layer and the access-control seam -- " +
          "add the query to services/access or services/memory instead, or add a documented " +
          "eslint-disable-next-line if this one call site is a real, reviewed exception.",
      },
    ],
  },
};
