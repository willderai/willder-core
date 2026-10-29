// The README's "Prove it does not leak" section is a stranger's only route to the leak
// suite, so what it says has to be what the repository does: the command it names exists,
// Vitest resolves it to the leak and revocation tests, the one file it says skips without a
// database is the only one that needs one, and the refusal it quotes is the one the MCP
// endpoint sends.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = __dirname;
const read = (file: string) => readFileSync(resolve(repoRoot, file), "utf8");

const readme = read("README.md");
const sectionStart = readme.indexOf("## Prove it does not leak");
const section = readme.slice(sectionStart, readme.indexOf("\n## ", sectionStart + 1));
const scripts: Record<string, string> = JSON.parse(read("package.json")).scripts;

const scriptName = /^npm run (\S+)$/m.exec(section)?.[1] ?? "";
const vitestArgs = (scripts[scriptName] ?? "").split(" ");

/** The test files Vitest selects for the script's arguments, listed without running them. */
function listSelectedFiles(): string[] {
  const output = execFileSync("npx", ["vitest", "list", "--filesOnly", ...vitestArgs.slice(2)], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return [...output.matchAll(/^\[node\] (\S+)$/gm)].map((m) => m[1]!);
}
let selected: string[] | undefined;
const selectedFiles = () => (selected ??= listSelectedFiles());

describe("README: Prove it does not leak", () => {
  it("names an npm script that runs Vitest's node project", () => {
    expect(sectionStart).toBeGreaterThan(-1);
    expect(scripts).toHaveProperty(scriptName);
    expect(vitestArgs.slice(0, 4)).toEqual(["vitest", "run", "--project", "node"]);
  });

  it("selects the scope-leak and revocation tests, and only files that exist", () => {
    const files = selectedFiles();
    expect(files).toEqual(
      expect.arrayContaining([
        "services/memory/access-leakage-eval.test.ts",
        "services/memory/graph-read-scope-leak.eval.test.ts",
        "services/access/token-lifecycle.eval.test.ts",
        "services/access/actor-identity-leak.eval.test.ts",
        "app/api/changes-denial-no-label-leak.test.ts",
        "app/api/agents/[id]/runs/[runId]/audit/route.leakage.test.ts",
      ]),
    );
    for (const file of files) expect(() => read(file)).not.toThrow();
  });

  it("needs a database only for the file the README says is skipped without one", () => {
    const needsDatabase = selectedFiles().filter((file) => read(file).includes("QA_DATABASE_URL"));
    const namedAsSkipped = [...section.matchAll(/`([^`]+\.test\.ts)`, reports as skipped/g)].map((m) => m[1]);
    expect(needsDatabase).toEqual(namedAsSkipped);
  });

  it("quotes the refusal the MCP endpoint sends a revoked token", () => {
    expect(section).toContain("https://willder.ai/api/mcp");
    const refusal = /`HTTP 401` with\s+`([^`]+)`/.exec(section)?.[1] ?? "";
    expect(refusal).not.toBe("");
    expect(read("app/api/mcp/route.ts")).toContain(`unauthorized(req, "${refusal}")`);
  });
});
