// What eslint.sql-utc-now.mjs reports, run through ESLint itself on small sources.
// The behaviour that matters, a bare now() really being wrong off UTC, is proven
// against Postgres in lib/sql-utc-now.realdb.test.ts; this proves the gate catches
// the forms that produce it and leaves alone the ones that do not.
import { Linter } from "eslint";
import { describe, expect, it } from "vitest";
import { sqlUtcNowGate } from "./eslint.sql-utc-now.mjs";

const RULE = "sql-utc-now/no-session-time-sql";

function findings(code: string): number {
  const linter = new Linter({ configType: "flat" });
  const messages = linter.verify(code, [
    {
      plugins: sqlUtcNowGate.plugins,
      rules: { [RULE]: "error" },
      languageOptions: { ecmaVersion: "latest", sourceType: "module" },
    },
  ]);
  const parseErrors = messages.filter((m) => m.fatal);
  expect(parseErrors).toEqual([]);
  return messages.filter((m) => m.ruleId === RULE).length;
}

describe("sql-utc-now/no-session-time-sql", () => {
  it.each([
    ["a comparison in a tagged template", 'db.$queryRaw`SELECT 1 WHERE "expiresAt" > now()`'],
    ["an assignment across a template interpolation", 'db.$executeRaw`UPDATE t SET "at" = NOW() WHERE id = ${id}`'],
    ["a multi-line template", 'db.$queryRaw`\n  SELECT 1\n  WHERE "expiresAt" > now()\n  AND id = ${id}`'],
    ["an unsafe string", 'db.$executeRawUnsafe(`UPDATE t SET "at" = CURRENT_TIMESTAMP`)'],
    ["a plain string literal", "const q = 'SELECT 1 FROM t WHERE \"at\" < now() - interval \\'1 day\\'';"],
    ["localtimestamp", 'const q = "SELECT localtimestamp";'],
    ["current_date", 'const q = "WHERE \\"day\\" = current_date";'],
    ["clock_timestamp()", 'const q = "SET \\"at\\" = clock_timestamp()";'],
    ["a conversion to another zone", "const q = \"now() AT TIME ZONE 'America/New_York'\";"],
    // Postgres accepts a precision argument and whitespace before the parentheses;
    // both read the same session-local clock.
    ["current_timestamp with a precision", 'db.$executeRaw`UPDATE t SET "at" = CURRENT_TIMESTAMP(3) WHERE id = ${id}`'],
    ["localtimestamp with a precision", 'const q = "SELECT localtimestamp(0)";'],
    ["current_time with a precision", 'const q = "SELECT current_time(2)";'],
    ["now with a space before its parentheses", 'db.$queryRaw`SELECT 1 WHERE "expiresAt" > now ()`'],
    ["now with a space inside its parentheses", 'db.$queryRaw`SELECT 1 WHERE "expiresAt" > now( )`'],
    ["current_timestamp with a spaced precision", 'const q = "SET at = CURRENT_TIMESTAMP ( 3 )";'],
    // A schema-qualified call, the special input string 'now', and a
    // 'UTC' conversion of a value that is already session-local are each hours off
    // a UTC truth on a non-UTC session (7, 7 and 14 hours on America/Los_Angeles).
    ["a schema-qualified now()", 'db.$executeRaw`UPDATE t SET "at" = pg_catalog.now() WHERE id = ${id}`'],
    ["a schema-qualified clock_timestamp()", 'const q = "SET at = pg_catalog.clock_timestamp()";'],
    ["the 'now' input string cast to timestamp", "const q = \"SET at = 'now'::timestamp\";"],
    ["the 'now' input string cast to timestamptz", "const q = \"SET at = 'now'::timestamptz\";"],
    ["localtimestamp read as if it were UTC", "const q = \"SET at = localtimestamp AT TIME ZONE 'UTC'\";"],
    // The same classes in their other spellings. Every 'now' cast is reported, even one
    // converted to UTC: Postgres folds 'now' to a constant at parse time, so a column
    // default keeps the instant the table was created. A time of day converted to UTC
    // is reported too: no timestamp column wants one, and the exemption is kept to the
    // timestamptz forms, where it is provably the column's own value.
    ["the 'now' input string cast with a precision", "const q = \"SET at = 'now'::timestamp(3)\";"],
    ["the 'now' input string in CAST", "const q = \"SET at = CAST('now' AS timestamptz)\";"],
    ["the 'now' input string as a typed literal", "const q = \"SET at = timestamp 'now'\";"],
    ["the 'now' input string as a long typed literal", "const q = \"SET at = timestamp(3) without time zone 'now'\";"],
    ["the 'now' input string converted to UTC", "const q = \"DEFAULT ('now'::timestamptz AT TIME ZONE 'UTC')\";"],
    [
      "localtimestamp with a precision read as if it were UTC",
      "const q = \"SELECT localtimestamp (0) AT TIME ZONE 'UTC'\";",
    ],
    ["localtime converted to UTC", "const q = \"SELECT localtime AT TIME ZONE 'UTC'\";"],
    [
      "a schema-qualified call converted to another zone",
      "const q = \"pg_catalog.now() AT TIME ZONE 'America/New_York'\";",
    ],
    // The siblings of 'now' in the same Postgres special-values table, and
    // timeofday(), all read the session-local clock (psql 17: 'today'::timestamp is the
    // next day on an Asia/Tokyo session before 15:00 UTC; timeofday()::timestamp is 7 h
    // off on America/Los_Angeles). The bare instant functions get a reported case each,
    // so dropping either name from the rule fails a test.
    ["the 'today' input string cast to timestamp", "const q = \"WHERE at >= 'today'::timestamp\";"],
    ["the 'today' input string cast to date", "const q = \"WHERE at >= 'today'::date\";"],
    ["the 'tomorrow' input string as a typed literal", "const q = \"WHERE at < timestamp 'tomorrow'\";"],
    ["timeofday() cast to a timestamp", 'const q = "SET at = timeofday()::timestamp";'],
    ["a bare statement_timestamp()", 'const q = "SET at = statement_timestamp()";'],
    ["a bare transaction_timestamp()", 'const q = "SET at = transaction_timestamp()";'],
    // Every other spelling of the same inputs psql 17 accepts on an Asia/Tokyo session,
    // each one the next day or 9 h off the UTC truth there: Postgres trims whitespace
    // inside the quotes and ignores case, and takes a function-style cast and E'' strings.
    ["the 'yesterday' input string cast to date", "const q = \"WHERE day > 'yesterday'::date\";"],
    ["the 'today' input string in CAST", "const q = \"WHERE at >= CAST('today' AS timestamp)\";"],
    ["the 'today' input string converted to UTC", "const q = \"WHERE at >= 'today'::timestamptz AT TIME ZONE 'UTC'\";"],
    ["'now' with a leading space", "const q = \"SET at = ' now'::timestamp\";"],
    ["'now' with a trailing tab", "const q = \"SET at = 'now\\t'::timestamp\";"],
    ["'now' in upper case", "const q = \"SET at = 'NOW'::timestamp\";"],
    ["'Today' in mixed case with spaces", "const q = \"WHERE day = ' Today '::date\";"],
    ["'now' as an escape string in CAST", "const q = \"SET at = CAST(E'now' AS timestamp)\";"],
    ["the 'now' input string as a time literal", "const q = \"SELECT time 'now'\";"],
    ["the 'now' input string as a timetz literal", "const q = \"SELECT timetz 'now'\";"],
    ["the 'now' input string as a long time with time zone literal", "const q = \"SELECT time with time zone 'now'\";"],
    ["a function-style timestamptz('now')", "const q = \"SET at = timestamptz('now')\";"],
    ["a function-style timetz('now')", "const q = \"SELECT timetz('now')\";"],
    ["a function-style date('today')", "const q = \"WHERE day = date ( 'today' )\";"],
    ["a schema-qualified timeofday()", 'const q = "SELECT pg_catalog.timeofday()";'],
    ["timeofday() with a space before its parentheses", 'const q = "SELECT timeofday ()";'],
    // Both spellings are reported; without a case each, dropping
    // the space before :: or the timestamptz typed literal from the rule passed every test.
    // psql 17 on Asia/Tokyo: both are 9 h off the UTC truth.
    ["the 'now' input string with a space before its cast", "const q = \"SET at = 'now' ::timestamp\";"],
    ["the 'now' input string as a timestamptz literal", "const q = \"SET at = timestamptz 'now'\";"],
  ])("reports %s", (_name, code) => {
    expect(findings(code)).toBe(1);
  });

  it.each([
    ["the UTC form", "db.$queryRaw`SELECT 1 WHERE \"expiresAt\" > (now() AT TIME ZONE 'UTC')`"],
    ["the UTC form in lower case spacing", "const q = \"now()  at time zone 'UTC'\";"],
    ["the UTC form with a precision", "const q = \"SET at = CURRENT_TIMESTAMP(3) AT TIME ZONE 'UTC'\";"],
    ["the UTC form with spaced parentheses", "const q = \"WHERE at > now ( ) AT TIME ZONE 'UTC'\";"],
    ["the UTC form with a spaced precision", "const q = \"SELECT current_timestamp (0) AT TIME ZONE 'UTC'\";"],
    ["the schema-qualified UTC form", "const q = \"SET at = pg_catalog.now() AT TIME ZONE 'UTC'\";"],
    ["the UTC form of statement_timestamp()", "const q = \"SET at = statement_timestamp() AT TIME ZONE 'UTC'\";"],
    ["a member call on another object in a code sample", 'const help = "clock.now() returns the instant";'],
    ["the word now in quotes, not cast", "const q = \"WHERE label = 'now'\";"],
    ["the word today in quotes, not cast", "const q = \"WHERE label = 'today'\";"],
    // The special inputs that are fixed values, not the clock.
    ["the 'epoch' input string", "const q = \"WHERE at > 'epoch'::timestamp\";"],
    ["the 'infinity' input string", "const q = \"SET until = 'infinity'::timestamp\";"],
    ["the '-infinity' input string", "const q = \"SET since = '-infinity'::timestamp\";"],
    ["the 'allballs' input string", "const q = \"SELECT 'allballs'::time\";"],
    ["a word that only starts like a clock input", "const q = \"WHERE label = 'nowhere'::text\";"],
    ["a quoted word that only ends like one", "const q = \"WHERE label = 'snow'::text\";"],
    ["a column named timeofday", 'const q = "SELECT timeofday FROM t";'],
    ["the sqlUtcNow fragment", 'db.$queryRaw`SELECT 1 WHERE "expiresAt" > ${sqlUtcNow}`'],
    ["Date.now() in code", "const t = Date.now();"],
    ["performance.now() in code", "const t = performance.now() - started;"],
    ["a comment", '// "expiresAt" > now() is wrong off UTC\nconst x = 1;'],
    ["a code sample naming Date.now()", 'const help = "call Date.now() for the instant";'],
    ["an ordinary word", 'const label = "Show current time";'],
  ])("does not report %s", (_name, code) => {
    expect(findings(code)).toBe(0);
  });
});
