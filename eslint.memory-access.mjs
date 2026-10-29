// The memory-access gate: only the authorizer may query a memory table.
//
// Memory is what `check()` (services/access/check.ts) guards as `memory.read` and
// `memory.write`. A query against a memory table that does not go through the
// authorizer reads or writes memory without that decision, so this rule makes
// such a query a build error everywhere except in the authorizer's own modules:
//
//   services/access/**   the decision itself and its audit trail
//   services/memory/**   the guarded store and the data-access helpers that run
//                        a query only after check() has decided it
//
// Which tables are memory tables is read from prisma/schema.prisma, not listed
// here: a model whose doc comment carries the line `/// @memory` is one. That
// way a new memory model is covered from the commit that adds it, and
// eslint.memory-access.test.ts fails if a model with a `scopePath` column has
// not been marked one way or the other (`@memory` or `@not-memory`).
//
// Four shapes are reported outside the authorizer:
//
//   1. a Prisma delegate call on a memory model, from any client
//      (`db.brief.findFirst`, `tx.memoryChunk.create`, ...);
//   2. a memory delegate taken off a Prisma client without being called there
//      (`const m = db.brief`, `const { brief } = db`, `tx[name]`). A client is a
//      name taken from the lib/db module, a `new PrismaClient()`, a `$transaction`
//      callback's parameter, or a name typed `PrismaClient`/`TransactionClient`.
//      The lib/db module is reached by a static `import`, by `require(...)`, or by
//      `import(...)` with or without `await`, under any specifier that resolves
//      to lib/db (`@/lib/db`, a relative path, with or without an extension):
//      every name destructured from it, at any depth, and every member read off
//      it is a client. A name becomes a client or the module however it is bound
//      (a declaration, a later assignment `c = db`, a destructuring assignment, a
//      parameter default), wherever that binding sits in the file, and through a
//      type assertion (`db as X`, `db!`) or a choice (`flag ? db : x`, `x ?? db`);
//   3. a memory relation inside a Prisma argument (`include`, `select`, `where`,
//      `orderBy`, `data`, ...): `db.agentRun.findFirst({ include: { brief: true } })`
//      reads memory, and a `where` on a memory relation filters by its content;
//   4. raw SQL naming a memory table. Text that is SQL by position (a `sql`,
//      `$queryRaw` or `$executeRaw` template, an argument to `$queryRawUnsafe`,
//      `$executeRawUnsafe` or `Prisma.raw`) is reported for the table name as a
//      whole word; any other string only where it reads as SQL (`FROM
//      "memory_chunks"`, `JOIN public.briefs`, `FROM sources s, briefs b`).
//
// What it cannot see. Clients are tracked by name within one file, so a client
// that leaves a name and comes back is lost: one stored in an object or array
// and read back (`const box = { c: db }; box.c.brief`, `this.c = db`,
// `const [c] = [db]`), returned from a function or handed in through an untyped
// parameter and then aliased, or exported and imported by another file. A
// delegate reached by reflection rather than member access
// (`Reflect.get(db, "memoryChunk")`, `Object.values(db)`) is not seen, nor is
// anything assembled at run time: a table name (`Prisma.raw(name)`) or a module
// specifier (`import(path)`). (`db[name]` and `const { [name]: m } = db` with a
// computed key are written in the source, and are reported.) A direct delegate
// call is reported from any receiver (shape 1), so each of these escapes only
// when the delegate is taken off the client and called somewhere else. Memory
// outside Postgres is out of scope: the memory graph is reached through
// services/memory's store, and a call to its unguarded `memory` export is not
// a query this rule recognizes.
//
// Test files are excluded, as in eslint.scope-gate.mjs: they build these queries
// to seed and assert, which is how the gate is proven, not a way around it.
// There is no inline exemption. CI runs this rule through
// eslint.memory-access.config.mjs, which ignores every `eslint-disable` comment,
// so a system path that must touch a memory table (a connector sync retiring what
// its own source wrote) does it through a services/memory helper. The only other
// exemptions are the operator scripts in OPERATOR_SCRIPTS below, listed in this
// file so that adding one is a change to the gate a reviewer sees. The README's
// "Credentials that bypass the authorizer" section lists what can reach these
// tables without any application code at all.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_SCHEMA = fileURLToPath(new URL("./prisma/schema.prisma", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL(".", import.meta.url));
const DB_MODULE = path.join(REPO_ROOT, "lib", "db");
const SCRIPT_EXTENSION = /\.(?:[cm]?[jt]s|[jt]sx)$/;

/**
 * Does this module specifier, written in `filename`, resolve to lib/db?
 * `@/` is the repository root (tsconfig `paths`); a relative specifier resolves
 * against the importing file; any other specifier ending in `lib/db` counts too,
 * which can only add a report.
 */
function isDbModuleSpecifier(specifier, filename) {
  if (typeof specifier !== "string") return false;
  const bare = specifier.replace(SCRIPT_EXTENSION, "");
  if (/(^|\/)lib\/db$/.test(bare)) return true;
  if (bare.startsWith("@/")) return path.join(REPO_ROOT, bare.slice(2)) === DB_MODULE;
  if (bare.startsWith(".")) return path.resolve(path.dirname(filename), bare) === DB_MODULE;
  return false;
}

/** The authorizer's own modules: the decision, and the store and helpers that query only after it. */
export const AUTHORIZER_MODULES = ["services/access/**", "services/memory/**"];

/**
 * Diagnostics an operator runs with a database credential, never imported by the
 * app or reached from a request. Each seeds and inspects its own rows.
 */
export const OPERATOR_SCRIPTS = ["scripts/check-fact-governance.ts"];

/** Every Prisma delegate method that runs a query. */
const PRISMA_OPERATIONS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
  "delete",
  "deleteMany",
  "count",
  "aggregate",
  "groupBy",
]);

/** The model name a field's type refers to: `Brief`, `Brief?` and `Brief[]` are all `Brief`. */
const baseType = (type) => type.replace(/[?[\]]/g, "");

/** Prisma's client delegate name for a model: `MemoryChunk` -> `memoryChunk`. */
const delegateName = (model) => model.charAt(0).toLowerCase() + model.slice(1);

/**
 * Parse a Prisma schema into the memory tables it declares.
 *
 * @param {string} schema the full text of a schema.prisma file.
 * @returns {{
 *   models: { name: string, table: string, memory: boolean | null, scoped: boolean }[],
 *   memoryModels: string[],
 *   delegates: Set<string>,
 *   tables: string[],
 *   relationFields: Set<string>,
 * }}
 *   `memory` is true for `@memory`, false for `@not-memory`, null when the model
 *   says neither. `relationFields` holds every field name, on any model, whose
 *   type is a memory model: the keys that pull memory rows into a nested read.
 */
export function readMemoryTables(schema) {
  const models = [];
  const fields = [];
  let doc = [];
  let current = null;
  for (const line of schema.split("\n")) {
    const trimmed = line.trim();
    if (!current) {
      if (trimmed.startsWith("///")) {
        doc.push(trimmed.slice(3).trim());
        continue;
      }
      const open = /^model\s+(\w+)\s*\{/.exec(trimmed);
      if (open) {
        const tags = new Set(doc.map((l) => /^@[\w-]+/.exec(l)?.[0]).filter(Boolean));
        current = {
          name: open[1],
          table: open[1],
          memory: tags.has("@memory") ? true : tags.has("@not-memory") ? false : null,
          scoped: false,
        };
      }
      doc = [];
      continue;
    }
    if (trimmed === "}") {
      models.push(current);
      current = null;
      continue;
    }
    const map = /^@@map\("([^"]+)"\)/.exec(trimmed);
    if (map) current.table = map[1];
    const field = /^(\w+)\s+([\w?[\]]+)/.exec(trimmed);
    if (field && !trimmed.startsWith("//")) {
      fields.push({ name: field[1], type: baseType(field[2]) });
      if (field[1] === "scopePath") current.scoped = true;
    }
  }
  const memoryModels = models.filter((m) => m.memory === true).map((m) => m.name);
  const memorySet = new Set(memoryModels);
  return {
    models,
    memoryModels,
    delegates: new Set(memoryModels.map(delegateName)),
    tables: models.filter((m) => m.memory === true).map((m) => m.table),
    relationFields: new Set(fields.filter((f) => memorySet.has(f.type)).map((f) => f.name)),
  };
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Regexes that find a memory table named in SQL text.
 *
 * `anywhere` is for text that is known to be SQL (a tagged `sql`/`$queryRaw`
 * template, or an argument to `$queryRawUnsafe`/`$executeRawUnsafe`/`Prisma.raw`):
 * the table name as a whole word, quoted or not, schema-qualified or not.
 *
 * `statement` is for any other string, which may or may not be SQL: the name
 * quoted as an identifier, after a keyword that takes a table (`FROM`, `JOIN`,
 * `INTO`, `UPDATE`, `TABLE`, `TRUNCATE`, `USING`), or in a comma-separated `FROM`
 * list. Prose that merely mentions a table ("the briefs you want") is not SQL.
 */
function tableNamePatterns(tables) {
  const names = tables.map(escapeRegExp).join("|");
  const qualifier = `(?:"?\\w+"?\\.)?`;
  const table = `${qualifier}"?(?:${names})"?(?![\\w"])`;
  return {
    anywhere: new RegExp(`(?<![\\w$])"?(?:${names})"?(?![\\w$])`, "i"),
    statement: new RegExp(
      `"(?:${names})"|\\b(?:from|join|into|update|table|truncate|using)\\s+(?:only\\s+)?${table}|\\bfrom\\s+[\\w".]+(?:\\s+\\w+)?(?:\\s*,\\s*[\\w".]+(?:\\s+\\w+)?)*\\s*,\\s*${table}`,
      "i",
    ),
  };
}

/** Call names whose string arguments are SQL. */
const RAW_SQL_CALLS = new Set(["$queryRawUnsafe", "$executeRawUnsafe", "raw"]);
/** Template tags whose text is SQL. */
const SQL_TAGS = new Set(["sql", "$queryRaw", "$executeRaw"]);

/** Type annotations that mark a value as a Prisma client or transaction client. */
const CLIENT_TYPE = /\b(?:PrismaClient|TransactionClient)\b|\btypeof\s+db\b/;

/** Relation-taking keys of a Prisma query argument: a memory relation under one reads memory. */
const RELATION_CONTAINERS = new Set([
  "include",
  "select",
  "where",
  "orderBy",
  "cursor",
  "data",
  "some",
  "every",
  "none",
  "is",
  "isNot",
  "AND",
  "OR",
  "NOT",
]);

const MESSAGE =
  "Memory table {{what}} queried outside the authorizer. Only services/access and " +
  "services/memory may query a memory table (a model marked `/// @memory` in " +
  "prisma/schema.prisma): call a services/memory helper that runs check() before the " +
  "query instead; a system path such as a connector sync goes through a services/memory " +
  "helper too. An eslint-disable comment does not silence this rule in CI.";

const noMemoryQueryOutsideAuthorizer = {
  meta: {
    type: "problem",
    docs: { description: "Disallow memory-table queries outside services/access and services/memory" },
    schema: [
      {
        type: "object",
        properties: { schema: { type: "string" } },
        additionalProperties: false,
      },
    ],
    messages: { outside: MESSAGE },
  },
  create(context) {
    const schemaPath = context.options[0]?.schema ?? DEFAULT_SCHEMA;
    const { delegates, tables, relationFields } = readMemoryTables(readFileSync(schemaPath, "utf8"));
    if (tables.length === 0) return {};
    const sql = tableNamePatterns(tables);
    const sourceCode = context.sourceCode;
    const report = (node, what) => context.report({ node, messageId: "outside", data: { what } });
    // The text of a string literal or a template with no substitutions, else null.
    const staticText = (node) =>
      node?.type === "Literal"
        ? node.value
        : node?.type === "TemplateLiteral" && node.expressions.length === 0
          ? node.quasis[0].value.cooked
          : null;
    // `db as X`, `<X>db`, `db!` and `db satisfies X` are still `db`.
    const withoutTypeAssertion = (node) =>
      ["TSAsExpression", "TSTypeAssertion", "TSNonNullExpression", "TSSatisfiesExpression"].includes(node?.type)
        ? withoutTypeAssertion(node.expression)
        : node;
    const propertyName = (node) =>
      node.type === "Identifier" ? node.name : node.type === "Literal" ? String(node.value) : null;

    // Names in this file that hold a Prisma client. Name-based, not scope-exact:
    // a shadowing local of the same name is treated as a client too, which can
    // only add a report, never hide one.
    const clients = new Set();
    // Names in this file that hold the lib/db module itself (`import * as m`,
    // `const m = require(...)`, `const m = await import(...)`).
    const dbModules = new Set();
    const isDbModule = (node) => {
      const unwrapped = withoutTypeAssertion(node);
      const n = unwrapped?.type === "AwaitExpression" ? withoutTypeAssertion(unwrapped.argument) : unwrapped;
      if (n?.type === "Identifier") return dbModules.has(n.name);
      if (n?.type === "ImportExpression") return isDbModuleSpecifier(staticText(n.source), context.filename);
      return (
        n?.type === "CallExpression" &&
        n.callee.type === "Identifier" &&
        n.callee.name === "require" &&
        isDbModuleSpecifier(staticText(n.arguments[0]), context.filename)
      );
    };
    const isClient = (expression) => {
      const node = withoutTypeAssertion(expression);
      return (
        (node?.type === "Identifier" && clients.has(node.name)) ||
        // `flag ? db : other`, `other ?? db`: either side may be the value.
        (node?.type === "ConditionalExpression" && (isClient(node.consequent) || isClient(node.alternate))) ||
        (node?.type === "LogicalExpression" && (isClient(node.left) || isClient(node.right))) ||
        // `require("@/lib/db").db`, `(await import("@/lib/db")).db`
        (node?.type === "MemberExpression" && isDbModule(node.object)) ||
        // `db.$extends(...)` and `new PrismaClient(...)` are clients too.
        (node?.type === "CallExpression" &&
          node.callee.type === "MemberExpression" &&
          propertyName(node.callee.property) === "$extends" &&
          isClient(node.callee.object)) ||
        (node?.type === "NewExpression" && node.callee.type === "Identifier" && node.callee.name === "PrismaClient")
      );
    };
    const addTypedName = (node) => {
      const id = node?.type === "AssignmentPattern" ? node.left : node;
      if (id?.type === "Identifier" && id.typeAnnotation && CLIENT_TYPE.test(sourceCode.getText(id.typeAnnotation))) {
        clients.add(id.name);
      }
    };

    // Every `target = source` in the file: declarations, assignments and parameter
    // defaults. Whether a source holds the module or a client can depend on a
    // binding written further down (`let c; const read = () => c.brief; c = db;`),
    // so they are resolved together once the whole file has been read.
    const bindings = [];
    // Destructured properties that take a memory delegate off a client, and what to call it.
    const delegateProperties = new Map();
    // Record what each name in `target` receives from a value that is the lib/db
    // module (`kind` "module") or a client (`kind` "client"), at any depth.
    const bind = (target, kind) => {
      const id = target?.type === "AssignmentPattern" ? target.left : target;
      if (id?.type === "Identifier") (kind === "module" ? dbModules : clients).add(id.name);
      if (id?.type !== "ObjectPattern") return;
      for (const prop of id.properties) {
        if (prop.type === "RestElement") {
          bind(prop.argument, kind);
        } else if (kind === "module") {
          // Every member of the module is a client: `{ db }`, `{ db: { brief } }`.
          bind(prop.value, "client");
        } else if (prop.computed && prop.key.type !== "Literal") {
          delegateProperties.set(prop, "chosen at run time");
        } else {
          const key = propertyName(prop.key);
          if (key && delegates.has(key)) delegateProperties.set(prop, `\`${key}\``);
        }
      }
    };
    const addParams = (fn) => {
      fn.params.forEach(addTypedName);
      for (const param of fn.params) {
        if (param.type === "AssignmentPattern") bindings.push({ target: param.left, source: param.right });
      }
      // `db.$transaction(async (tx) => ...)`: the callback's first parameter is a client.
      const call = fn.parent;
      if (
        call?.type === "CallExpression" &&
        call.arguments[0] === fn &&
        call.callee.type === "MemberExpression" &&
        propertyName(call.callee.property) === "$transaction" &&
        fn.params[0]?.type === "Identifier"
      ) {
        clients.add(fn.params[0].name);
      }
    };
    // Member expressions that may take a memory delegate off a client without calling it.
    const heldMembers = [];
    // `<client>.<memoryDelegate>` held, passed or indexed rather than called, and
    // `<client>[expr]`, a delegate chosen at run time.
    const checkHeldMember = (node) => {
      if (!isClient(node.object)) return;
      if (node.computed && node.property.type !== "Literal") return report(node, "chosen at run time");
      const parent = node.parent;
      const calledOn =
        parent?.type === "MemberExpression" &&
        parent.object === node &&
        !parent.computed &&
        PRISMA_OPERATIONS.has(propertyName(parent.property));
      const model = propertyName(node.property);
      if (model && delegates.has(model) && !calledOn) report(node, `\`${model}\``);
    };

    // Is this string or template text SQL by where it sits?
    const inSqlContext = (node) => {
      for (let n = node.parent; n; n = n.parent) {
        if (n.type === "TaggedTemplateExpression") {
          const tag = n.tag.type === "MemberExpression" ? propertyName(n.tag.property) : n.tag.name;
          return SQL_TAGS.has(tag);
        }
        if (n.type === "CallExpression") {
          const callee = n.callee.type === "MemberExpression" ? propertyName(n.callee.property) : n.callee.name;
          if (RAW_SQL_CALLS.has(callee)) return true;
        }
        if (n.type.includes("Function") || n.type === "Program") return false;
      }
      return false;
    };
    const checkSqlText = (node, text) => {
      if ((inSqlContext(node) ? sql.anywhere : sql.statement).test(text)) report(node, "in raw SQL");
    };

    return {
      ImportDeclaration(node) {
        if (isDbModuleSpecifier(node.source.value, context.filename)) {
          for (const spec of node.specifiers) {
            clients.add(spec.local.name);
            if (spec.type === "ImportNamespaceSpecifier") dbModules.add(spec.local.name);
          }
        }
      },
      VariableDeclarator(node) {
        addTypedName(node.id);
        if (node.init) bindings.push({ target: node.id, source: node.init });
      },
      AssignmentExpression(node) {
        if (node.operator === "=") bindings.push({ target: node.left, source: node.right });
      },
      FunctionDeclaration: addParams,
      FunctionExpression: addParams,
      ArrowFunctionExpression: addParams,
      MemberExpression(node) {
        // 1. `<anything>.<memoryDelegate>.<operation>(...)`
        const operation = !node.computed && propertyName(node.property);
        if (operation && PRISMA_OPERATIONS.has(operation)) {
          const delegate = node.object;
          if (delegate.type === "MemberExpression") {
            const model = propertyName(delegate.property);
            if (model && delegates.has(model)) return report(node, `\`${model}\``);
          }
        }
        // 1b. resolved once every binding in the file is known.
        heldMembers.push(node);
      },
      // 2. a memory relation under `include`, `select`, `where`, `orderBy`, ...
      Property(node) {
        const key = !node.computed && propertyName(node.key);
        if (!key || !relationFields.has(key)) return;
        const container = node.parent?.parent;
        if (container?.type !== "Property") return;
        if (RELATION_CONTAINERS.has(propertyName(container.key))) report(node, `relation \`${key}\``);
      },
      // 3. raw SQL naming a memory table
      TemplateElement(node) {
        checkSqlText(node, node.value.raw);
      },
      Literal(node) {
        if (typeof node.value === "string") checkSqlText(node, node.value);
      },
      "Program:exit"() {
        // Resolve the bindings until no new client or module name appears; the
        // sets only grow, so this ends.
        let known;
        do {
          known = clients.size + dbModules.size;
          for (const { target, source } of bindings) {
            if (isDbModule(source)) bind(target, "module");
            else if (isClient(source)) bind(target, "client");
          }
        } while (clients.size + dbModules.size !== known);
        // `const { brief } = db`, `({ brief } = db)`, `const { db: { brief } } = require(...)`
        for (const [prop, what] of delegateProperties) report(prop, what);
        heldMembers.forEach(checkHeldMember);
      },
    };
  },
};

/**
 * The flat-config block both eslint.config.mjs and eslint.scope-gate.config.mjs load.
 * `files` names every extension the app can run: tsconfig sets `allowJs` and Next
 * serves `route.js` and `page.jsx` as it serves `.ts`, so a gate limited to
 * TypeScript would pass a JavaScript route that queries memory.
 */
export const memoryAccessGate = {
  files: ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
  ignores: [
    ...AUTHORIZER_MODULES,
    ...OPERATOR_SCRIPTS,
    "lib/generated/**",
    "**/*.test.ts",
    "**/*.test.tsx",
    "eslint.memory-access.mjs",
  ],
  plugins: { "memory-access": { rules: { "no-memory-query-outside-authorizer": noMemoryQueryOutsideAuthorizer } } },
  rules: { "memory-access/no-memory-query-outside-authorizer": "error" },
};
