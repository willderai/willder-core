// The memory-access gate (eslint.memory-access.mjs): only the authorizer may
// query a memory table.
//
// Three things are pinned here:
//   1. which tables are memory tables comes from prisma/schema.prisma, and every
//      model that carries a scope has been classified one way or the other, so a
//      new scoped model cannot slip in unclassified;
//   2. the rule, loaded through the config CI runs it with (`npm run
//      scope-gate:check`), reports every query shape in the violation fixture when
//      it sits outside the authorizer, and nothing when the same text sits inside
//      services/access or services/memory, or in a test, and no comment in the
//      linted file can switch it off;
//   3. code that only resembles a query (a plain property named `brief`, prose
//      naming a table) is not reported.
import { readFileSync } from "node:fs";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import { readMemoryTables } from "./eslint.memory-access.mjs";

const RULE = "memory-access/no-memory-query-outside-authorizer";
const fixture = (name: string) => readFileSync(`test-fixtures/memory-access/${name}`, "utf8");

const eslint = new ESLint({ overrideConfigFile: "eslint.memory-access.config.mjs" });

/** Linting loads the TypeScript parser and every plugin; the first call alone takes seconds. */
const LINT_TIMEOUT_MS = 30_000;

/** Lint `text` as if it lived at `filePath`, through the CI gate's own config. */
async function findings(text: string, filePath: string) {
  const [result] = await eslint.lintText(text, { filePath });
  return result.messages.filter((m) => m.ruleId === RULE).map((m) => m.line);
}

describe("memory tables are read from the schema", () => {
  const schema = readMemoryTables(readFileSync("prisma/schema.prisma", "utf8"));

  it("classifies every model that carries a scopePath as memory or not", () => {
    const unclassified = schema.models.filter((m) => m.scoped && m.memory === null).map((m) => m.name);
    expect(unclassified).toEqual([]);
  });

  it("finds the memory tables the authorizer guards", () => {
    expect(schema.tables).toEqual(expect.arrayContaining(["memory_chunks", "briefs", "fact_edges", "change_events"]));
    expect(schema.tables).not.toContain("grants");
    expect(schema.tables).not.toContain("capabilities");
  });

  it("reads tags, table names and relations from a schema it has never seen", () => {
    const parsed = readMemoryTables(`
/// Notes people wrote.
/// @memory
model Note {
  id    String @id
  scopePath String
  pins  Pin[]
  @@map("notes")
}

/// @not-memory: a pointer, not content.
model Pin {
  id     String @id
  noteId String
  note   Note   @relation(fields: [noteId], references: [id])
}

model Loose {
  id String @id
  scopePath String
}
`);
    expect(parsed.memoryModels).toEqual(["Note"]);
    expect(parsed.tables).toEqual(["notes"]);
    expect([...parsed.delegates]).toEqual(["note"]);
    expect([...parsed.relationFields]).toEqual(["note"]);
    expect(parsed.models.map((m) => [m.name, m.memory, m.scoped])).toEqual([
      ["Note", true, true],
      ["Pin", false, false],
      ["Loose", null, true],
    ]);
  });
});

describe("the gate, through the CI config", { timeout: LINT_TIMEOUT_MS }, () => {
  const violations = fixture("violations.ts.txt");
  // The fixture's own line numbers for the five query shapes it holds.
  const expectedLines = [9, 11, 13, 15, 16];

  it("reports every query shape outside the authorizer", async () => {
    expect(await findings(violations, "app/api/fixture/route.ts")).toEqual(expectedLines);
    expect(await findings(violations, "lib/inngest/fixture.ts")).toEqual(expectedLines);
    expect(await findings(violations, "mcp/tools/fixture.ts")).toEqual(expectedLines);
  });

  it("reports nothing inside the authorizer", async () => {
    expect(await findings(violations, "services/memory/fixture.ts")).toEqual([]);
    expect(await findings(violations, "services/access/fixture.ts")).toEqual([]);
  });

  it("reports nothing in a test, which builds these queries to seed and assert", async () => {
    expect(await findings(violations, "app/api/fixture/route.test.ts")).toEqual([]);
  });

  it("reports a memory table reached by an alias, a dynamic key, or SQL the keyword scan would miss", async () => {
    const evasions = fixture("evasions.ts.txt");
    const marked = evasions.split("\n").flatMap((line, i) => (line.includes("// REPORT") ? [i + 1] : []));
    const reported = await findings(evasions, "app/api/fixture/route.ts");
    expect(marked.length).toBeGreaterThan(10);
    expect([...new Set(reported)]).toEqual(marked);
  });

  it.each(["lib/fixture.mts", "lib/fixture.cts", "lib/fixture.mjs", "lib/fixture.cjs"])(
    "reports a memory query in a %s module, an extension a route can import",
    async (filePath) => {
      const helper = `import { db } from "@/lib/db";\nexport const read = () => db.memoryChunk.findMany();\n`;
      expect(await findings(helper, filePath)).toEqual([2]);
    },
  );

  it.each([
    [
      "the module held in a name",
      "app/api/fixture/route.ts",
      `export async function GET() {\n  const mod = await import("@/lib/db");\n  const m = mod.db.memoryChunk;\n  return Response.json(await m.findMany());\n}\n`,
    ],
    [
      "a relative specifier that resolves to lib/db",
      "lib/fixture.ts",
      `export async function read() {\n  const { db: client } = await import("./db");\n  const m = client.memoryChunk;\n  return m.findMany();\n}\n`,
    ],
  ])("reports a memory delegate held off a client loaded at run time: %s", async (_label, filePath, text) => {
    expect(await findings(text, filePath)).toEqual([3]);
  });

  it.each([
    [
      "a delegate destructured two levels deep from require()",
      "lib/fixture.cjs",
      `const {\n  db: { memoryChunk },\n} = require("./db");\nmodule.exports = () => memoryChunk.findMany();\n`,
      [2],
    ],
    [
      "a delegate destructured two levels deep from a namespace import",
      "app/api/fixture/route.ts",
      `import * as mod from "@/lib/db";\nconst {\n  db: { brief },\n} = mod;\nexport const GET = async () => Response.json(await brief.findMany());\n`,
      [3],
    ],
    [
      "a client assigned after its declaration",
      "app/api/fixture/route.ts",
      `import { db } from "@/lib/db";\nlet c;\nc = db;\nconst m = c.memoryChunk;\nexport const GET = async () => Response.json(await m.findMany());\n`,
      [4],
    ],
    [
      "the module assigned after its declaration",
      "app/api/fixture/route.ts",
      `export async function GET() {\n  let mod;\n  mod = await import("@/lib/db");\n  const m = mod.db.memoryChunk;\n  return Response.json(await m.findMany());\n}\n`,
      [4],
    ],
    [
      "a delegate destructured by assignment",
      "app/api/fixture/route.ts",
      `import { db } from "@/lib/db";\nlet memoryChunk;\n({ memoryChunk } = db);\nexport const GET = async () => Response.json(await memoryChunk.findMany());\n`,
      [3],
    ],
    [
      "a client assigned below the code that reads it",
      "app/api/fixture/route.ts",
      `import { db } from "@/lib/db";\nlet c;\nconst read = () => c.memoryChunk;\nc = db;\nexport const GET = async () => Response.json(await read().findMany());\n`,
      [3],
    ],
    [
      "a $transaction callback written as a function expression",
      "app/api/fixture/route.ts",
      `import { db } from "@/lib/db";\nexport const GET = () =>\n  db.$transaction(async function (tx) {\n    const m = tx.memoryChunk;\n    return Response.json(await m.findMany());\n  });\n`,
      [4],
    ],
    [
      "a client behind a type assertion",
      "app/api/fixture/route.ts",
      `import { db } from "@/lib/db";\nconst c = db as unknown as Record<string, never>;\nconst m = c.memoryChunk;\nexport const GET = () => m;\n`,
      [3],
    ],
    [
      "a client chosen by a conditional or a fallback",
      "app/api/fixture/route.ts",
      `import { db } from "@/lib/db";\nexport function read(other: unknown, flag: boolean) {\n  const a = flag ? db : other;\n  const b = other ?? db;\n  return [a.memoryChunk, b.brief];\n}\n`,
      [5, 5],
    ],
    [
      "a client as a parameter default",
      "app/api/fixture/route.ts",
      `import { db } from "@/lib/db";\nexport const read = (c = db) => c.memoryChunk;\n`,
      [2],
    ],
    [
      "a destructured property whose key is chosen at run time",
      "app/api/fixture/route.ts",
      `import { db } from "@/lib/db";\nexport function read(name: string) {\n  const { [name]: m } = db;\n  return m;\n}\n`,
      [3],
    ],
    [
      "a rest element of the module",
      "lib/fixture.cjs",
      `const { ...mod } = require("./db");\nmodule.exports = mod.db.memoryChunk;\n`,
      [2],
    ],
    [
      "an alias of a name that becomes a client further down",
      "app/api/fixture/route.ts",
      `import { db } from "@/lib/db";\nlet a;\nlet b;\nb = a;\na = db;\nexport const m = b.memoryChunk;\n`,
      [6],
    ],
    [
      "the module behind a type assertion",
      "app/api/fixture/route.ts",
      `export async function GET() {\n  const mod = (await import("@/lib/db"))!;\n  return mod.db.memoryChunk;\n}\n`,
      [3],
    ],
  ])("reports a memory delegate reached through %s", async (_label, filePath, text, lines) => {
    expect(await findings(text, filePath)).toEqual(lines);
  });

  it("does not treat a module that only shares a prefix with lib/db as the client", async () => {
    const text = `export async function read() {\n  const { db } = await import("@/lib/db-startup");\n  const m = db.memoryChunk;\n  return m;\n}\n`;
    expect(await findings(text, "app/api/fixture/route.ts")).toEqual([]);
  });

  it("reports nothing for code that only resembles a memory query", async () => {
    expect(await findings(fixture("clean.ts.txt"), "app/api/fixture/route.ts")).toEqual([]);
  });

  // Each disable comment is placed in front of the fixture's first query; the
  // gate must still report all of them, that one included.
  const call = "  const brief = await db.brief.findFirst";
  it.each([
    ["a disable naming the rule on the line before", `  // eslint-disable-next-line ${RULE} -- a reason\n${call}`],
    ["a disable naming the rule on the same line", `${call} /* eslint-disable-line ${RULE} */`],
    ["a file-wide disable naming the rule", `/* eslint-disable ${RULE} */\n${call}`],
    ["a file-wide disable of every rule", `/* eslint-disable */\n${call}`],
  ])("still reports a query behind %s", async (_label, disabled) => {
    expect(await findings(violations.replace(call, disabled), "app/api/fixture/route.ts")).toHaveLength(
      expectedLines.length,
    );
  });
});
