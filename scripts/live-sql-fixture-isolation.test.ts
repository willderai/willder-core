// Repo-wide guard: a test file's raw-SQL cleanup must delete only its own
// org's rows.
//
// An unscoped `DELETE FROM "grants"` / `"scopes"` / `"capabilities"` /
// `"audit_log"` with no WHERE clause is a real hazard: every live-SQL file in
// this repo points DATABASE_URL at the ONE database QA_DATABASE_URL names,
// and Vitest runs test files in parallel workers, so an unscoped delete in
// one file can wipe rows a sibling file's own beforeEach just inserted. The
// sibling's next grant insert then dies on `grants_scopeId_fkey`, at
// whatever rate the two files happen to interleave, making the sources+access
// suite flaky. Nothing in production is affected (CI sets no
// QA_DATABASE_URL, so these files skip there entirely), but it makes every
// real-Postgres QA verdict unreliable, which is the verification the
// access-control review rests on.
//
// This guard is the recurrence prevention rather than the fix: it needs no
// database, so unlike the live-SQL files themselves it actually runs in CI,
// and it fails the moment a new fixture reintroduces the pattern.
//
// Limits worth knowing. It reads raw SQL only: a Prisma `deleteMany()` with
// no `where` is the same hazard and is not detected here, though there is
// none in the repo today. And it finds SQL by scanning for quoted string
// literals, so an unpaired quote outside a string (in a regex literal, say)
// can mis-group the text that follows it. That second limit is live rather
// than theoretical: a meaningful fraction of test files scanned hold such a
// quote. None of them puts a raw DELETE in the stretch that gets mis-grouped,
// which is the only reason it has cost nothing so far.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "..");
const skipDirs = new Set(["node_modules", ".next", ".git", "generated", "public"]);

/** Every `*.test.ts` in the repo except this file, which quotes the banned
 * pattern in its own fixtures and would otherwise flag itself. */
function testFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) testFiles(full, found);
    } else if (entry.name.endsWith(".test.ts") && full !== __filename) {
      found.push(full);
    }
  }
  return found;
}

/** `source` with its comments blanked out, line count preserved. Only
 * whole-line `//` comments and `/* ... *\/` blocks are removed, never a
 * trailing `//`, so a `//` inside a string literal cannot swallow real code
 * after it. Files here describe deletes in prose ("the DELETE from
 * facts/[id]"), which reads as SQL to the scanner below. */
function withoutComments(source: string): string {
  const blank = (text: string) => text.replace(/[^\n]/g, " ");
  return source.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/^[ \t]*\/\/[^\n]*/gm, blank);
}

/** A stretch of the scanned source, and the offset it starts at. */
type Span = { text: string; start: number };

/** Every quoted string literal in `code`. A SQL statement always lives inside
 * one of these, so the closing quote is the furthest its predicate can reach.
 * Bounding on that matters: read past it and unrelated code supplies the
 * `orgId` that makes an unscoped delete look scoped. */
function stringLiterals(code: string): Span[] {
  const quotes = new Set(["'", '"', "`"]);
  const literals: Span[] = [];
  for (let index = 0; index < code.length; index++) {
    if (!quotes.has(code[index])) continue;
    const quote = code[index];
    const start = index + 1;
    let end = start;
    while (end < code.length && code[end] !== quote) end += code[end] === "\\" ? 2 : 1;
    literals.push({ text: code.slice(start, end), start });
    index = end;
  }
  return literals;
}

/** `literal` cut at each `;` that ends a statement, so one statement's
 * predicate cannot stand in for an earlier one's in the same literal. A `;`
 * inside a SQL string (`WHERE "note" = 'a;b'`) is data, not a terminator. */
function statements(literal: Span): Span[] {
  const pieces: Span[] = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < literal.text.length; index++) {
    const character = literal.text[index];
    if (character === "'") quoted = !quoted;
    else if (character === ";" && !quoted) {
      pieces.push({ text: literal.text.slice(start, index), start: literal.start + start });
      start = index + 1;
    }
  }
  pieces.push({ text: literal.text.slice(start), start: literal.start + start });
  return pieces;
}

/** Line numbers of raw `DELETE FROM` statements in `source` whose predicate
 * does not mention `orgId`. A predicate runs from `DELETE FROM` to the end of
 * its own statement, so one wrapped onto later lines counts and one belonging
 * to a neighbouring statement does not. */
export function unscopedDeleteLines(source: string): number[] {
  const code = withoutComments(source);
  // A table name as these fixtures write it: bare (`grants`), quoted
  // (`"grants"`), quoted inside a plain JS string where the quotes arrive
  // escaped (`\"grants\"`), or interpolated (`"${table}"`). A name shape the
  // pattern misses hides the whole statement, predicate and all.
  const deletion = /DELETE\s+FROM\s+(?:\\?")?(?:\$\{[^}]*\}|\w+)(?:\\?")?([\s\S]*)/i;
  const lines: number[] = [];
  for (const literal of stringLiterals(code)) {
    for (const statement of statements(literal)) {
      const match = deletion.exec(statement.text);
      if (!match || /\borgId\b/.test(match[1])) continue;
      lines.push(code.slice(0, statement.start + match.index).split("\n").length);
    }
  }
  return lines;
}

describe("live-SQL test fixtures clean up only their own org's rows", () => {
  it("finds no raw DELETE without an orgId predicate in any test file", () => {
    const offenders: string[] = [];
    for (const file of testFiles(repoRoot)) {
      for (const line of unscopedDeleteLines(readFileSync(file, "utf8"))) {
        offenders.push(`${relative(repoRoot, file)}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // The detector itself, against hand-written samples rather than the repo,
  // so a green repo scan above can never be a vacuous pass.
  it("flags an unscoped delete", () => {
    expect(unscopedDeleteLines('await db.$executeRawUnsafe(`DELETE FROM "grants"`);')).toEqual([1]);
  });

  it("accepts a delete scoped by orgId, including one wrapped across lines", () => {
    expect(unscopedDeleteLines('await db.$executeRawUnsafe(`DELETE FROM "grants" WHERE "orgId" = $1`, ORG);')).toEqual(
      [],
    );
    expect(
      unscopedDeleteLines('await db.$executeRawUnsafe(\n  `DELETE FROM "grants"\n   WHERE "orgId" = $1`,\n  ORG,\n);'),
    ).toEqual([]);
  });

  it("flags a delete whose only predicate is not org-bound", () => {
    expect(
      unscopedDeleteLines('await db.$executeRawUnsafe(`DELETE FROM "grants" WHERE "granteeId" = $1`, id);'),
    ).toEqual([1]);
  });

  // Each statement is checked on its own: a scoped delete elsewhere must not
  // supply the `orgId` that silences an unscoped one.
  it("flags the first of two statements in one template when only the second is scoped", () => {
    expect(
      unscopedDeleteLines('await raw(`DELETE FROM "grants"; DELETE FROM "scopes" WHERE "orgId" = $1`, ORG);'),
    ).toEqual([1]);
  });

  it("flags an unscoped delete in a plain string, whatever the rest of the file says", () => {
    const nearbyMention = ["await raw('DELETE FROM \"grants\"');", "const orgId = ORG;", "await raw(`SELECT 1`);"].join(
      "\n",
    );
    expect(unscopedDeleteLines(nearbyMention)).toEqual([1]);

    const scopedSibling = [
      "const cleanup = [",
      "  'DELETE FROM \"grants\"',",
      '  \'DELETE FROM "scopes" WHERE "orgId" = $1\',',
      "];",
    ].join("\n");
    expect(unscopedDeleteLines(scopedSibling)).toEqual([2]);
  });

  // The table name pattern reads interpolated and escape-quoted names, not only
  // bare or plainly quoted ones, which would hide the whole statement. The
  // scoped case guards the other direction: a delete that is fine stays unflagged.
  it("flags an unscoped delete whose table name is interpolated", () => {
    expect(unscopedDeleteLines('await db.$executeRawUnsafe(`DELETE FROM "${table}"`);')).toEqual([1]);
  });

  it("accepts an interpolated-table delete scoped by orgId", () => {
    expect(
      unscopedDeleteLines('await db.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "orgId" = ANY($1)`, orgs);'),
    ).toEqual([]);
  });

  it("flags an unscoped delete whose identifier quotes arrive escaped", () => {
    expect(unscopedDeleteLines('await raw("DELETE FROM \\"grants\\"");')).toEqual([1]);
  });

  // The same shape, but read off the file that actually runs it rather than
  // hand-written, because a hand-written twin is what lets this one hide: a
  // guard that only checks a copy of the line can stay green after the real
  // line drops its predicate, letting a cross-tenant wipe ship. If the line
  // moves, move this with it.
  it("sees the interpolated delete this repo runs today", () => {
    const fixture = readFileSync(join(repoRoot, "app/api/contact-read-gate-live-sql.test.ts"), "utf8");
    const scoped = 'DELETE FROM "${table}" WHERE "orgId" = ANY($1)';
    expect(fixture).toContain(scoped);
    expect(unscopedDeleteLines(fixture)).toEqual([]);

    const wiped = fixture.replace(scoped, 'DELETE FROM "${table}"');
    const line = fixture.slice(0, fixture.indexOf(scoped)).split("\n").length;
    expect(unscopedDeleteLines(wiped)).toEqual([line]);
  });

  it("accepts a scoped delete whose predicate holds a semicolon in a SQL string", () => {
    expect(
      unscopedDeleteLines('await raw(`DELETE FROM "audit_log" WHERE "note" = \'a;b\' AND "orgId" = $1`, ORG);'),
    ).toEqual([]);
  });

  it("accepts a scoped delete whose predicate quotes a SQL string first", () => {
    expect(
      unscopedDeleteLines('await raw(`DELETE FROM "audit_log" WHERE "action" = \'read\' AND "orgId" = $1`, ORG);'),
    ).toEqual([]);
  });

  it("ignores a delete described in prose in a comment", () => {
    expect(unscopedDeleteLines("// covers the DELETE from facts/[id]")).toEqual([]);
    expect(unscopedDeleteLines("/*\n * the DELETE from facts/[id]\n */")).toEqual([]);
  });

  it("still flags code on a line holding a string with a // in it", () => {
    expect(unscopedDeleteLines('const url = "https://x.test"; await raw(`DELETE FROM "grants"`);')).toEqual([1]);
  });

  it("reports the line each offending statement starts on", () => {
    const source = ["const a = 1;", 'await db.$executeRawUnsafe(`DELETE FROM "scopes"`);'].join("\n");
    expect(unscopedDeleteLines(source)).toEqual([2]);
  });
});
