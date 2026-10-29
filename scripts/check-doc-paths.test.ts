// Coverage for the dangling-path scan (scripts/check-doc-paths.mjs).
//
// The scan is only useful if a reader can trust its total, which means it has
// to be right about two things at once: a path written in prose that no
// longer resolves is a finding, and the many path-shaped strings that are not
// repository paths at all -- an API method, a git ref, a scoped package, a
// config file the reader writes on their own machine -- are not. These tests
// pin both sides.
import { describe, expect, it } from "vitest";
import { looksLikePath, extractPathTokens, resolveToken, findDanglingPaths } from "./check-doc-paths.mjs";

describe("looksLikePath", () => {
  it("accepts a repository path and a bare filename with a known extension", () => {
    expect(looksLikePath("services/agents/run-loop.ts")).toBe(true);
    expect(looksLikePath("prisma/schema.prisma")).toBe(true);
    expect(looksLikePath("run-loop.ts")).toBe(true);
    expect(looksLikePath(".github/workflows/ci.yml")).toBe(true);
  });

  it("rejects the path-shaped things that are not paths", () => {
    expect(looksLikePath("tools/list")).toBe(false);
    expect(looksLikePath("origin/main")).toBe(false);
    expect(looksLikePath("@prisma/client")).toBe(false);
    expect(looksLikePath("https://willder.ai/docs")).toBe(false);
    expect(looksLikePath("DATABASE_URL")).toBe(false);
    expect(looksLikePath("npm run build")).toBe(false);
  });

  it("rejects `.env` and `.txt`, which are prose far more often than paths", () => {
    expect(looksLikePath(".env")).toBe(false);
    expect(looksLikePath("process.env")).toBe(false);
    expect(looksLikePath(".txt")).toBe(false);
  });
});

describe("extractPathTokens", () => {
  it("reads both link targets and inline code spans", () => {
    const tokens = extractPathTokens("See [the loop](services/agents/run-loop.ts) and `mcp/tools.ts`.\n");
    expect(tokens.map((t) => t.token)).toEqual(["services/agents/run-loop.ts", "mcp/tools.ts"]);
  });

  it("skips a fenced code block, where a path is usually an example", () => {
    expect(extractPathTokens("```sh\ncat some/made-up/file.ts\n```\n")).toEqual([]);
  });

  it("drops a fragment before reporting the token", () => {
    expect(extractPathTokens("[x](docs/README.md#start-here)\n")[0].token).toBe("docs/README.md");
  });
});

describe("resolveToken", () => {
  const exists = (rel: string) => ["docs/environment.md", "mcp/tools.ts"].includes(rel);

  it("resolves a root-relative path written in prose", () => {
    expect(resolveToken("docs/README.md", "mcp/tools.ts", exists)).toBe(true);
  });

  it("resolves a path written relative to the document", () => {
    expect(resolveToken("docs/connect/README.md", "../environment.md", exists)).toBe(true);
  });

  it("gives an explicitly relative path no second chance from the root", () => {
    expect(resolveToken("docs/README.md", "./mcp/tools.ts", exists)).toBe(false);
  });

  it("checks the directory above a glob rather than expanding it", () => {
    expect(resolveToken("README.md", "mcp/*.ts", (rel: string) => rel === "mcp")).toBe(true);
  });

  it("accepts a config file the reader creates on their own machine", () => {
    expect(resolveToken("docs/connect/cursor.md", ".cursor/mcp.json", () => false)).toBe(true);
  });
});

describe("findDanglingPaths", () => {
  it("reports a path that resolves nowhere and stays quiet about one that does", () => {
    const exists = (rel: string) => rel === "mcp/tools.ts";
    const findings = findDanglingPaths(
      "docs/guide.md",
      "Live: `mcp/tools.ts`. Gone: `services/gone/old.ts`.\n",
      exists,
    );
    expect(findings).toEqual([{ file: "docs/guide.md", line: 1, token: "services/gone/old.ts" }]);
  });
});
