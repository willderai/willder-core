// The test a plan names (services/memory/planned-test.ts), read from the plans agent A wrote in
// a paired handoff study.
import { describe, expect, it } from "vitest";
import { narrowestTestCommand, plannedTestOf, plannedTestSentence, withoutTestCommands } from "./planned-test";

describe("plannedTestOf", () => {
  it("reads a test runner's command to its line end, and the test files outside it", () => {
    expect(plannedTestOf("Command: npx vitest run components/a.test.tsx components/b.test.tsx\nThen ship.")).toEqual({
      command: "npx vitest run components/a.test.tsx components/b.test.tsx",
      files: [],
    });
    expect(
      plannedTestOf(
        'TESTS: extend app/api/sources/[id]/sync/route.test.ts. **Command:** npx vitest run "app/api/sources/[id]/sync"',
      ),
    ).toEqual({
      command: 'npx vitest run "app/api/sources/[id]/sync"',
      files: ["app/api/sources/[id]/sync/route.test.ts"],
    });
  });

  it("stops a command at a sentence end, a backtick or a shell separator", () => {
    expect(plannedTestOf("Run npm test. Then deploy.")?.command).toBe("npm test");
    expect(plannedTestOf("run `pnpm test:unit` first")?.command).toBe("pnpm test:unit");
    expect(plannedTestOf("pytest tests/test_api.py && echo ok")?.command).toBe("pytest tests/test_api.py");
  });

  it("names each test file once, in the order first named, Python's included", () => {
    expect(plannedTestOf("edit lib/x.test.ts, then lib/x.test.ts again and tests/test_y.py")?.files).toEqual([
      "lib/x.test.ts",
      "tests/test_y.py",
    ]);
  });

  it("reads 20,000 characters built to backtrack in one pass", () => {
    const started = performance.now();
    for (const text of [
      `npm test${" ".repeat(20_000)}x`,
      `npm test${".".repeat(20_000)}`,
      "a/".repeat(10_000),
      "a.test.".repeat(3_000),
    ])
      plannedTestOf(text);
    // Each took 140 to 420 ms with the nested patterns this replaced.
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("finds nothing in text that names no test runner and no test file", () => {
    expect(plannedTestOf("The latest test of time; contest results are in.")).toBeNull();
    expect(plannedTestOf("Lower MAX_DPR to 1.5 and gate frames at 30fps.")).toBeNull();
  });
});

describe("narrowestTestCommand", () => {
  it.each([
    [
      "a test file over a directory",
      ["npx vitest run services/access", "npx vitest run services/access/check.test.ts"],
      "npx vitest run services/access/check.test.ts",
    ],
    [
      "a directory over the whole suite",
      ["npm test", "npx vitest run services/access"],
      "npx vitest run services/access",
    ],
    [
      "test files alone over test files beside a directory",
      ["npx vitest run mcp a.test.ts", "npx vitest run a.test.ts b.test.ts"],
      "npx vitest run a.test.ts b.test.ts",
    ],
    ["fewer targets among equals", ["npx vitest run a b c", "npx vitest run a b"], "npx vitest run a b"],
    [
      "the first written among equals",
      ["npx vitest run a.test.ts", "npx vitest run b.test.ts"],
      "npx vitest run a.test.ts",
    ],
    [
      "a pytest node id, as its file",
      ["pytest tests/test_scope.py", "pytest tests/test_scope.py::test_drop"],
      "pytest tests/test_scope.py::test_drop",
    ],
    [
      "a real command over a match that runs on into prose",
      ["npx vitest run on all of it and it passed", "npm test"],
      "npm test",
    ],
    [
      "a quoted path, not its quotes",
      ["npm test", 'npx vitest run "app/(app)/agents"'],
      'npx vitest run "app/(app)/agents"',
    ],
  ])("prefers %s", (_case, commands, narrowest) => {
    expect(narrowestTestCommand(commands)).toBe(narrowest);
  });

  it("finds none in none", () => {
    expect(narrowestTestCommand([])).toBeNull();
  });

  it("is what plannedTestOf says of a verify list, unless told the one command to say", () => {
    const text =
      "Verify with: npx vitest run services/access app/api/memory ; npx tsc --noEmit ; npx vitest run services/access/check.test.ts ; npm test.";
    expect(plannedTestOf(text)?.command).toBe("npx vitest run services/access/check.test.ts");
    expect(plannedTestOf(text, { command: "npm test" })?.command).toBe("npm test");
    // Told a command another write names, it says none, and only the test files this text names.
    expect(plannedTestOf(text, { command: "npx vitest run elsewhere.test.ts" })).toEqual({
      command: null,
      files: ["services/access/check.test.ts"],
    });
    expect(plannedTestOf("Verify with: npm test ; npx vitest run services/access.", { command: null })).toBeNull();
  });
});

describe("withoutTestCommands", () => {
  it.each([
    [
      "a verify list",
      "Plan: gate the route. Verify with: npx vitest run a ; npx tsc --noEmit ; npm run lint ; npm test.",
      "Plan: gate the route.",
    ],
    [
      "a bare command",
      "Mirror transferEntity.\nnpx vitest run next.config.redirects.test.ts",
      "Mirror transferEntity.",
    ],
    ["a command on its own line, labelled", "Test command: `npx vitest run a.test.ts`", ""],
    [
      "nothing when there is no test command",
      "Run npx tsc --noEmit first. Then ship.",
      "Run npx tsc --noEmit first. Then ship.",
    ],
    [
      "nothing from a command sentence that says what to set",
      "Run npx vitest run app/api/webhooks with QA_DATABASE_URL set; the default npm script skips the database suite.",
      "Run npx vitest run app/api/webhooks with QA_DATABASE_URL set; the default npm script skips the database suite.",
    ],
    [
      "nothing from a sentence that says more",
      "Mirror transferEntity in removeEntity; check with npx vitest run a.test.ts that the scope is kept.",
      "Mirror transferEntity in removeEntity; check with npx vitest run a.test.ts that the scope is kept.",
    ],
  ])("takes out %s", (_case, text, kept) => {
    expect(withoutTestCommands(text)).toBe(kept);
  });
});

describe("plannedTestSentence", () => {
  it("says the command and the files, and counts files past four", () => {
    expect(plannedTestSentence({ command: "npm test", files: [] })).toBe("Planned test: npm test.");
    expect(plannedTestSentence({ command: null, files: ["a.test.ts"] })).toBe("Test files it names: a.test.ts.");
    expect(
      plannedTestSentence({
        command: "npm test",
        files: ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts", "e.test.ts"],
      }),
    ).toBe("Planned test: npm test; test files it names: a.test.ts, b.test.ts, c.test.ts, d.test.ts (+1 more).");
  });
});
