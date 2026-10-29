// The lookup gate: an API route decides access before it looks a record up.
//
// A route that loads a record by id and only then asks check() answers two different
// things to a caller without access: 404 for an id that does not exist, 403 for one
// that does. The difference is the disclosure (an existence probe). So in
// every `app/api/**/route.ts`, a Prisma single-record lookup (`findFirst`,
// `findUnique` and their `OrThrow` forms) may not come before the function's first
// access decision: check(), requireOrgRole(), or authorizeRecord().
//
// Two ways to satisfy it:
//   1. decide first, when the decision does not depend on the record (an org-root
//      permission, or a scope the request names);
//   2. load through authorizeRecord() (services/access/authorize-record.ts) when the
//      decision is made at the record's own scope. It answers an absent id and a
//      record the caller cannot read the same way, by construction.
//
// A function that makes no access decision at all is not checked: whether it should
// is a different question, answered by the refusal and memory-access gates.
//
// What it cannot see: a lookup or a decision inside a helper the route calls. Those
// helpers are written against authorizeRecord(). Test files are excluded.

const LOOKUPS = new Set(["findFirst", "findUnique", "findFirstOrThrow", "findUniqueOrThrow"]);

/** Calls that decide access. authorizeRecord() is both the lookup and the decision. */
const DECISIONS = new Set(["check", "requireOrgRole", "authorizeRecord"]);

/** `db.<model>.findFirst(...)` and the like, on the client or a transaction client. */
function isRecordLookup(callee) {
  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier" &&
    LOOKUPS.has(callee.property.name) &&
    callee.object.type === "MemberExpression" &&
    callee.object.object.type === "Identifier" &&
    (callee.object.object.name === "db" || callee.object.object.name === "tx")
  );
}

const isDecision = (callee) => callee.type === "Identifier" && DECISIONS.has(callee.name);

const FUNCTIONS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

/** The function a call is written in, or the program for a top-level call. */
function enclosingFunction(context, node) {
  const ancestors = context.sourceCode.getAncestors(node);
  for (let i = ancestors.length - 1; i >= 0; i--) {
    if (FUNCTIONS.has(ancestors[i].type)) return ancestors[i];
  }
  return ancestors[0];
}

const noLookupBeforeDecision = {
  meta: {
    type: "problem",
    docs: { description: "Disallow a record lookup before the route's access decision" },
    schema: [],
    messages: {
      lookupFirst:
        "This lookup runs before the access decision, so a caller without access can tell a " +
        "missing id (404) from a forbidden one (403). Decide first when the decision does not " +
        "depend on the record; otherwise load it through authorizeRecord() from " +
        '"@/services/access", which answers both the same way.',
    },
  },
  create(context) {
    /** Per function: the start of its first decision, and its lookups. */
    const byFunction = new Map();
    const entry = (fn) => {
      if (!byFunction.has(fn)) byFunction.set(fn, { firstDecision: Infinity, lookups: [] });
      return byFunction.get(fn);
    };
    return {
      CallExpression(node) {
        if (isRecordLookup(node.callee)) entry(enclosingFunction(context, node)).lookups.push(node);
        if (isDecision(node.callee)) {
          const e = entry(enclosingFunction(context, node));
          e.firstDecision = Math.min(e.firstDecision, node.range[0]);
        }
      },
      "Program:exit"() {
        for (const { firstDecision, lookups } of byFunction.values()) {
          if (firstDecision === Infinity) continue;
          for (const lookup of lookups) {
            if (lookup.range[0] < firstDecision) context.report({ node: lookup, messageId: "lookupFirst" });
          }
        }
      },
    };
  },
};

export const lookupGate = {
  files: ["app/api/**/route.ts"],
  ignores: ["**/*.test.ts"],
  plugins: { "lookup-gate": { rules: { "no-lookup-before-decision": noLookupBeforeDecision } } },
  rules: { "lookup-gate/no-lookup-before-decision": "error" },
};
