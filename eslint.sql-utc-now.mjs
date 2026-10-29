// The lint gate that keeps raw SQL on `sqlUtcNow` (lib/sql-utc-now.ts) instead of
// a bare now() or CURRENT_TIMESTAMP.
//
// Every Prisma DateTime column is `timestamp(3) without time zone` holding UTC
// wall-clock time. Postgres's current-time functions return `timestamptz` (or a
// session-local date or time), and comparing or assigning one against such a
// column converts through the session TimeZone. On a UTC server, which is every
// server CI and production use, the bare form is right by accident; on any other
// it is hours off, so an expired grant stays live or a live token reads as expired.
// No test notices unless it happens to run off UTC, so the rule is structural.
//
// It reads the text of string literals and template literal chunks, the only
// places SQL lives in this codebase, so `Date.now()` and comments never match.
// Test files are excluded: their fixtures only need to agree with themselves.
// A real exception (SQL that prints the server's clock, say) takes an
// `eslint-disable-next-line sql-utc-now/no-session-time-sql` with a reason.
//
// Not matched, by design of a text scan; none is used in this codebase:
// - dollar-quoted strings (`$$now$$::timestamp`) and Unicode-escape strings (`U&'now'`);
// - a comment inside a call (`now/**/()`) or a quoted function name (`"now"()`);
// - SQL in files this gate does not lint: migrations and `.sql` files.
// The runtime guarantee does not rest on this rule alone: lib/sql-utc-now.realdb.test.ts
// runs the real queries on sessions west and east of UTC.

// Each piece below is one spelling class; SESSION_TIME_SQL joins them.

/** Not part of a longer name or a JS member call (`Date.now()`), but `pg_catalog.now()` is SQL. */
const SQL_NAME_START = String.raw`(?:(?<![\w.$])|(?<=\bpg_catalog\.))`;
/** The optional precision argument of the SQL-standard forms: `CURRENT_TIMESTAMP(3)`. */
const PRECISION = String.raw`(?:\s*\(\s*\d+\s*\))?`;
/** The name ends here: not a longer identifier, and no argument list left unmatched. */
const SQL_NAME_END = String.raw`(?![\w(])(?!\s*\()`;

/**
 * The current instant as `timestamptz`. Converting it with `AT TIME ZONE 'UTC'` gives
 * UTC wall-clock time, the column's own form, so that spelling is exempt.
 */
const INSTANT =
  SQL_NAME_START +
  String.raw`(?:(?:now|clock_timestamp|statement_timestamp|transaction_timestamp)\s*\(\s*\)|current_timestamp${PRECISION})` +
  SQL_NAME_END +
  String.raw`(?!\s*AT\s+TIME\s+ZONE\s+'UTC')`;

/**
 * A session-local date or time of day, or `timeofday()`, which prints the session-local
 * wall clock as text. Never exempt: `localtimestamp AT TIME ZONE 'UTC'` reads the local
 * wall clock as if it were UTC, so it is off by twice the offset, and a time of day or a
 * date has no correct use against a timestamp column either way.
 */
const SESSION_LOCAL =
  String.raw`(?<![\w.$])(?:(?:localtimestamp|current_time|localtime)${PRECISION}|current_date)${SQL_NAME_END}` +
  String.raw`|${SQL_NAME_START}timeofday\s*\(\s*\)`;

/**
 * A quoted special input string that reads the clock: 'now', 'today', 'tomorrow' or
 * 'yesterday', in any case, with the surrounding whitespace Postgres trims, plain or as
 * an E'' escape string. The other special inputs ('epoch', 'infinity', '-infinity',
 * 'allballs') are fixed values and are not matched.
 */
const CLOCK_INPUT_STRING = String.raw`E?'\s*(?:now|today|tomorrow|yesterday)\s*'`;

/**
 * A clock input string turned into a date or time: a `::` cast, `CAST(... AS ...)`, a typed
 * literal (`timestamp 'now'`, `time with time zone 'now'`) or a function-style cast
 * (`date('today')`). Postgres turns it into a constant when the statement is parsed, so a
 * column default or a prepared statement keeps that first instant forever, and every type
 * reads 'today' on the session's own calendar. Never exempt, even converted to UTC:
 * `'today'::timestamptz AT TIME ZONE 'UTC'` is the session's midnight, not UTC's.
 */
const CLOCK_INPUT_CAST =
  String.raw`${CLOCK_INPUT_STRING}\s*::` +
  String.raw`|\bCAST\s*\(\s*${CLOCK_INPUT_STRING}\s+AS\b` +
  String.raw`|\b(?:timestamptz|timestamp|timetz|time|date)${PRECISION}(?:\s+with(?:out)?\s+time\s+zone)?\s+${CLOCK_INPUT_STRING}` +
  String.raw`|\b(?:timestamptz|timetz|date)\s*\(\s*${CLOCK_INPUT_STRING}\s*\)`;

/**
 * Raw SQL that reads the session-local clock, matched case-insensitively in every
 * spelling Postgres accepts: whitespace before and inside the parentheses (`now ()`),
 * the optional precision argument (`localtimestamp(0)`), the schema-qualified function
 * (`pg_catalog.now()`), `timeofday()`, and the clock input strings ('now', 'today',
 * 'tomorrow', 'yesterday') when cast. `now()` is matched only as SQL, so a code sample
 * like "Date.now()" in a string is not reported. The bare-word forms are matched as whole
 * words, and never with their argument left off, so
 * `CURRENT_TIMESTAMP (3) AT TIME ZONE 'UTC'` is exempt rather than reported at its name.
 */
export const SESSION_TIME_SQL = new RegExp(`${INSTANT}|${SESSION_LOCAL}|${CLOCK_INPUT_CAST}`, "i");

const MESSAGE =
  "Raw SQL compares or writes a timestamp column against the session-local clock. " +
  "Use sqlUtcNow from \"@/lib/sql-utc-now\" (or `(now() AT TIME ZONE 'UTC')` in an unsafe string): " +
  "Willder's timestamp columns hold UTC, and a bare now() is hours off on any Postgres whose TimeZone is not UTC.";

/**
 * Reports a string or template chunk that contains session-local SQL time.
 *
 * @type {import("eslint").Rule.RuleModule}
 */
const noSessionTimeSql = {
  meta: {
    type: "problem",
    docs: { description: "Disallow bare now()/CURRENT_TIMESTAMP in raw SQL; use sqlUtcNow" },
    schema: [],
    messages: { sessionTime: MESSAGE },
  },
  create(context) {
    const reportIfSessionTime = (node, text) => {
      if (typeof text === "string" && SESSION_TIME_SQL.test(text)) {
        context.report({ node, messageId: "sessionTime" });
      }
    };
    return {
      Literal: (node) => reportIfSessionTime(node, node.value),
      TemplateElement: (node) => reportIfSessionTime(node, node.value.raw),
    };
  },
};

export const sqlUtcNowGate = {
  files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.mjs"],
  // This file names the forms it bans, in its own messages.
  ignores: ["eslint.sql-utc-now.mjs", "**/*.test.ts", "**/*.test.tsx", "**/*.testsupport.ts", "lib/generated/**"],
  plugins: { "sql-utc-now": { rules: { "no-session-time-sql": noSessionTimeSql } } },
  rules: { "sql-utc-now/no-session-time-sql": "error" },
};
