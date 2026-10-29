// The audit-writer gate: only services/access/audit-row.ts writes audit_log.
//
// writeAuditRow() takes the entry point an action came in through as a required
// argument and records it on the row (`metadata.origin`), the source NIST SP 800-53
// AU-3 asks every audit record for. That holds only while nothing else writes the
// table, so this rule makes any other write a build error, repository-wide:
//
//   1. a Prisma write on the `auditLog` delegate, from any client (`db`, a
//      transaction, an injected client): create, createMany, createManyAndReturn,
//      upsert, update, updateMany, updateManyAndReturn, delete, deleteMany;
//   2. the delegate taken off a client without a read being called on it
//      (`const log = db.auditLog`, `const { auditLog } = db`, `insert(tx.auditLog)`),
//      which would hand the write to code this rule cannot follow;
//   3. SQL text that inserts into, updates, deletes from or truncates audit_log, in
//      any string or template.
//
// Updates and deletes are included because a row's origin is only as good as the
// row: the database refuses them too once the append-only trigger is in place, and
// this catches them where they are written rather than when they run.
//
// What it cannot see: a table name assembled at run time, and SQL split across a
// template's `${}` holes in the middle of the statement.
//
// Test files are excluded, as in eslint.scope-gate.mjs: they insert rows to seed the
// state an assertion reads, which is how the trail is tested, not a way around it.

const WRITER = "services/access/audit-row.ts";
const DELEGATE = "auditLog";

/** Prisma delegate methods that only read. Anything else called on the delegate writes. */
const READ_OPERATIONS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
]);

/** SQL that changes audit_log: the table, optionally schema-qualified and quoted, after a
 * statement that writes it. `audit_log_chain_insert` and other longer names do not match. */
const SQL_WRITE =
  /\b(?:insert\s+into|update|delete\s+from|truncate(?:\s+table)?)\s+(?:only\s+)?(?:"?\w+"?\.)?"?audit_log"?(?![\w"])/i;

const MESSAGE =
  `Only ${WRITER} may write audit_log. Call writeAuditRow() from "@/services/access/audit-row" ` +
  "instead: it records the request's origin on every row, the source NIST AU-3 asks an audit " +
  "record for, and a row written any other way carries none.";

/** The property name of a member expression, computed or not; null when not static. */
function propertyName(member) {
  if (!member.computed && member.property.type === "Identifier") return member.property.name;
  if (member.computed && member.property.type === "Literal" && typeof member.property.value === "string") {
    return member.property.value;
  }
  return null;
}

const noAuditWriteOutsideWriter = {
  meta: {
    type: "problem",
    docs: { description: `Disallow writing audit_log outside ${WRITER}` },
    schema: [],
    messages: { restricted: MESSAGE },
  },
  create(context) {
    const report = (node) => context.report({ node, messageId: "restricted" });
    const reportIfSqlWrite = (node, text) => {
      if (typeof text === "string" && SQL_WRITE.test(text)) report(node);
    };
    return {
      MemberExpression(node) {
        if (propertyName(node) !== DELEGATE) return;
        const parent = node.parent;
        const readCalled =
          parent.type === "MemberExpression" && parent.object === node && READ_OPERATIONS.has(propertyName(parent));
        if (!readCalled) report(node);
      },
      Property(node) {
        const destructured = node.parent.type === "ObjectPattern";
        const key = node.key.type === "Identifier" ? node.key.name : node.key.value;
        if (destructured && key === DELEGATE) report(node);
      },
      Literal: (node) => reportIfSqlWrite(node, node.value),
      TemplateLiteral: (node) =>
        reportIfSqlWrite(node, node.quasis.map((q) => q.value.cooked ?? q.value.raw).join(" ")),
    };
  },
};

export const auditWriterGate = {
  files: ["**/*.ts", "**/*.tsx"],
  ignores: [WRITER, "**/*.test.ts", "**/*.test.tsx"],
  plugins: { "audit-writer": { rules: { "no-audit-write-outside-writer": noAuditWriteOutsideWriter } } },
  rules: { "audit-writer/no-audit-write-outside-writer": "error" },
};
