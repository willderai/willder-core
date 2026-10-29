// Tests for the memory-access gate (eslint.memory-access.mjs).
//
// The gate exempts test files because they seed and assert. A file that only
// carries a test-like suffix is not a test: production code can import it, so
// a memory query placed there reaches a request path with no
// eslint-disable comment for a reviewer to see. The scope and blob gates do not
// exempt this suffix either.
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const RULE = "memory-access/no-memory-query-outside-authorizer";
const eslint = new ESLint({ overrideConfigFile: "eslint.scope-gate.config.mjs" });

async function findings(text: string, filePath: string) {
  const [result] = await eslint.lintText(text, { filePath });
  return result.messages.filter((m) => m.ruleId === RULE).length;
}

describe("memory-access gate: a test-like name is not a test", () => {
  it("reports a memory query in a .testsupport.ts module a route can import", async () => {
    const helper = `import { db } from "@/lib/db";\nexport const leak = () => db.memoryChunk.findMany();\n`;
    expect(await findings(helper, "app/api/qa-leak/leak.testsupport.ts")).toBe(1);
  }, 30_000);

  it("still exempts a real test file", async () => {
    const seed = `import { db } from "@/lib/db";\nexport const seed = () => db.memoryChunk.findMany();\n`;
    expect(await findings(seed, "app/api/qa-leak/leak.test.ts")).toBe(0);
  }, 30_000);
});

// Planted 2026-10-06: tsconfig sets allowJs and next.config sets
// no pageExtensions, so Next serves app/**/route.js and page.jsx exactly as it
// serves .ts. The gate's `files` lists only .ts, .tsx and .mjs, so a JavaScript
// route reading memory_chunks passed `npm run scope-gate:check` with exit 0 and
// no disable comment for a reviewer to see.
describe("memory-access gate: every extension Next compiles is scanned", () => {
  it.each(["app/api/qa-leak/route.js", "app/qa-leak/page.jsx"])(
    "reports a memory query in %s",
    async (filePath) => {
      const route = `import { db } from "@/lib/db";\nexport async function GET() { return Response.json(await db.memoryChunk.findMany()); }\n`;
      expect(await findings(route, filePath)).toBe(1);
    },
    30_000,
  );
});

// A Prisma client obtained with `await import("@/lib/db")` or `require("../lib/db")`
// is still a client: a memory delegate taken off it and called later must be
// reported, not only a direct `db.memoryChunk.findMany()`.
describe("memory-access gate: a client loaded at run time is still a client", () => {
  const cases: [string, string, string][] = [
    [
      "dynamic import, destructured delegate",
      "app/api/qa-leak/route.ts",
      `export async function GET() {\n  const { db } = await import("@/lib/db");\n  const { memoryChunk } = db;\n  return Response.json(await memoryChunk.findMany());\n}\n`,
    ],
    [
      "require, aliased delegate",
      "app/api/qa-leak/route.js",
      `const { db } = require("../../../lib/db");\nexport async function GET() {\n  const m = db.memoryChunk;\n  return Response.json(await m.findMany());\n}\n`,
    ],
    [
      "require property, delegate chosen at run time",
      "app/api/qa-leak/route.cjs",
      `const prisma = require("../../../lib/db").db;\nmodule.exports.GET = async (name) => prisma[name].findMany();\n`,
    ],
  ];
  it.each(cases)(
    "reports a memory delegate off a client from %s",
    async (_label, filePath, text) => {
      expect(await findings(text, filePath)).toBeGreaterThanOrEqual(1);
    },
    30_000,
  );
});

// Each form below needs its own case: deleting the code that handles it would
// otherwise leave every test green. Covered: a namespace import, an extension on
// the specifier, a template-literal specifier, default-valued destructuring.
describe("memory-access gate: every way of writing the lib/db module is pinned", () => {
  const cases: [string, string, string][] = [
    [
      "a namespace import, delegate aliased off its db member",
      "app/api/qa-leak/route.ts",
      `import * as mod from "@/lib/db";\nconst m = mod.db.memoryChunk;\nexport const GET = async () => Response.json(await m.findMany());\n`,
    ],
    [
      "a require of lib/db with a .js extension",
      "lib/qa-leak.cjs",
      `const { db } = require("./db.js");\nconst m = db.memoryChunk;\nmodule.exports = () => m.findMany();\n`,
    ],
    [
      "a template-literal specifier",
      "app/api/qa-leak/route.ts",
      "export async function GET() {\n  const { db } = await import(`@/lib/db`);\n  const m = db.memoryChunk;\n  return Response.json(await m.findMany());\n}\n",
    ],
    [
      "a destructured client with a default value",
      "app/api/qa-leak/route.ts",
      `export async function GET() {\n  const { db: client = null } = await import("@/lib/db");\n  const m = client.memoryChunk;\n  return Response.json(await m.findMany());\n}\n`,
    ],
  ];
  it.each(cases)(
    "reports a memory delegate off %s",
    async (_label, filePath, text) => {
      expect(await findings(text, filePath)).toBeGreaterThanOrEqual(1);
    },
    30_000,
  );
});
