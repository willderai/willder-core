// The refusal gate: an API route refuses only through a gate that records the refusal.
//
// Every authorization refusal leaves one deny row on the audit trail.
// check() writes one for each decision it makes, and lib/org-role.ts requireOrgRole()
// writes one when a person lacks the org role an operation needs. A route that decides
// any other way refuses without a row, so this rule makes those ways build errors in
// every `app/api/**/route.ts`:
//
//   1. comparing an org role itself: `rc.user.role !== "admin"`, `"member" === user.role`,
//      or `[...].includes(rc.user.role)`. Call requireOrgRole() instead;
//   2. calling can(), which decides without recording. Call check() instead. The routes
//      in CAN_ALLOWED use can() for something other than refusing, each with its reason;
//   3. calling requireOrgRole() without naming the operation as a string literal, or a
//      module-level `const` holding one. The name becomes the row's target, and the
//      route tests read it to prove every operation's refusal is reached.
//
// What it cannot see: a role read under another property name, or a comparison made in
// a helper the route calls. Test files are excluded.

const ORG_ROLES = new Set(["owner", "admin", "member"]);

/**
 * Routes that call can(), and why that is not an unrecorded refusal. Keyed by the path
 * from the repository root.
 */
export const CAN_ALLOWED = {
  // Narrows the scope picker to the scopes the caller may read. Nothing is refused.
  "app/api/memory/scopes/route.ts": "filters a listing",
  // A token that may not read its scope gets the quiet answer, and the denial is
  // recorded through check() once when it starts, not on every poll of the hook.
  "app/api/changes/notice/route.ts": "records the denial once per episode via check()",
};

const isRoleRead = (node) =>
  node?.type === "MemberExpression" &&
  !node.computed &&
  node.property.type === "Identifier" &&
  node.property.name === "role";

const isRoleLiteral = (node) => node?.type === "Literal" && ORG_ROLES.has(node.value);

/** The path of the file being linted, from the repository root, with forward slashes. */
function repoPath(context) {
  const file = (context.filename ?? context.getFilename()).replace(/\\/g, "/");
  const cwd = (context.cwd ?? context.getCwd()).replace(/\\/g, "/");
  return file.startsWith(`${cwd}/`) ? file.slice(cwd.length + 1) : file;
}

/** Whether `node` is a string literal, or names a module-level const initialized to one. */
function isNamedOperation(context, node) {
  if (node?.type === "Literal" && typeof node.value === "string" && node.value.length > 0) return true;
  if (node?.type !== "Identifier") return false;
  let scope = context.sourceCode.getScope(node);
  while (scope) {
    const variable = scope.set.get(node.name);
    if (variable) {
      const def = variable.defs[0];
      return (
        variable.scope.type === "module" &&
        def?.type === "Variable" &&
        def.parent.kind === "const" &&
        def.node.init?.type === "Literal" &&
        typeof def.node.init.value === "string" &&
        def.node.init.value.length > 0
      );
    }
    scope = scope.upper;
  }
  return false;
}

const noUnrecordedRefusal = {
  meta: {
    type: "problem",
    docs: { description: "Disallow an API route refusing without an audit row" },
    schema: [],
    messages: {
      roleCompared:
        'Compare org roles through requireOrgRole() from "@/lib/org-role": it records the refusal ' +
        "as one deny row, and a comparison in the route refuses with none.",
      canGate:
        "can() decides without an audit row. Decide with check(), which records the decision, or " +
        "add this route to CAN_ALLOWED in eslint.refusal-gate.mjs with the reason it refuses nothing.",
      operationUnnamed:
        "Name the operation requireOrgRole() guards with a string literal or a module-level const " +
        "string: it is the refusal row's target.",
    },
  },
  create(context) {
    const canAllowed = Object.hasOwn(CAN_ALLOWED, repoPath(context));
    return {
      BinaryExpression(node) {
        if (!["===", "!==", "==", "!="].includes(node.operator)) return;
        const { left, right } = node;
        if ((isRoleRead(left) && isRoleLiteral(right)) || (isRoleRead(right) && isRoleLiteral(left))) {
          context.report({ node, messageId: "roleCompared" });
        }
      },
      CallExpression(node) {
        const { callee } = node;
        if (callee.type === "Identifier" && callee.name === "can" && !canAllowed) {
          context.report({ node, messageId: "canGate" });
        }
        if (
          callee.type === "Identifier" &&
          callee.name === "requireOrgRole" &&
          !isNamedOperation(context, node.arguments[2])
        ) {
          context.report({ node, messageId: "operationUnnamed" });
        }
        if (
          callee.type === "MemberExpression" &&
          !callee.computed &&
          callee.property.type === "Identifier" &&
          callee.property.name === "includes" &&
          isRoleRead(node.arguments[0])
        ) {
          context.report({ node, messageId: "roleCompared" });
        }
      },
    };
  },
};

export const refusalGate = {
  files: ["app/api/**/route.ts"],
  ignores: ["**/*.test.ts"],
  plugins: { "refusal-gate": { rules: { "no-unrecorded-refusal": noUnrecordedRefusal } } },
  rules: { "refusal-gate/no-unrecorded-refusal": "error" },
};
