// The Prisma client is generated with the small query-compiler build.
//
// The query compiler is a WebAssembly module that each new serverless instance decodes
// and compiles before it can run its first query, so its size is paid on every cold
// start of every route that reads the database. The small build is half the size of
// the default "fast" one; it compiles each query a little slower, which costs well
// under a millisecond on a warm call. That trade is the reason for the setting, and
// this test keeps a schema edit from dropping it without anyone noticing.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCHEMA = join(__dirname, "schema.prisma");

/** The body of the schema's `generator client { ... }` block. */
function generatorClientBlock(schema: string): string {
  const match = /^generator client \{([^}]*)\}/m.exec(schema);
  if (!match) throw new Error("prisma/schema.prisma has no `generator client` block");
  return match[1];
}

describe("the Prisma client generator", () => {
  it('uses the small query-compiler build (compilerBuild = "small")', () => {
    const block = generatorClientBlock(readFileSync(SCHEMA, "utf8"));
    expect(block).toMatch(/^\s*compilerBuild\s*=\s*"small"\s*$/m);
  });
});
