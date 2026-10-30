// A whole-module stand-in (`vi.mock("@/x", () => import("@/x.testsupport"))`) replaces every
// export of the module it mocks. An export the real module gained and the stand-in lacks is
// undefined in every suite that mocks it, and a caller that swallows its errors shows that only
// as missing output: a change added scopesShownCte to services/access/derived-writes.ts, the
// stand-in fell behind, and the task-start handoff suite saw empty blocks instead of a failure.
// This holds each stand-in to the real module's runtime exports (types leave no trace at run time).
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const DIRS = ["app", "components", "lib", "mcp", "scripts", "services", "tests"];
const STAND_IN = /vi\.mock\("(@\/[^"]+)",\s*\(\)\s*=>\s*import\("(@\/[^"]+\.testsupport)"\)\)/g;

/** Every [mocked module, stand-in] pair a test file names, by `@/` path. */
function standIns(): [string, string][] {
  const pairs = new Map<string, string>();
  for (const dir of DIRS) {
    let files: string[];
    try {
      files = readdirSync(path.join(ROOT, dir), { recursive: true, encoding: "utf8" });
    } catch {
      continue;
    }
    for (const file of files) {
      // This file's own comment shows the pattern; it mocks nothing.
      if (!/\.test\.tsx?$/.test(file) || file.includes("node_modules") || path.join(ROOT, dir, file) === __filename)
        continue;
      for (const [, real, standIn] of readFileSync(path.join(ROOT, dir, file), "utf8").matchAll(STAND_IN))
        pairs.set(real!, standIn!);
    }
  }
  return [...pairs];
}

describe("whole-module testsupport stand-ins", () => {
  const pairs = standIns();

  it("are found (the two in use when this test was written)", () => {
    expect(pairs.map(([real]) => real)).toEqual(
      expect.arrayContaining(["@/services/access/derived-writes", "@/services/memory/rule-copies"]),
    );
  });

  it.each(pairs)("%s: the stand-in exports everything the real module does", async (real, standIn) => {
    const [realExports, standInExports] = await Promise.all([
      import(/* @vite-ignore */ real),
      import(/* @vite-ignore */ standIn),
    ]);
    const missing = Object.keys(realExports).filter((name) => !(name in standInExports));
    expect(missing, `${standIn} lacks these exports of ${real}`).toEqual([]);
  });
});
