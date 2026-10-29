// The refusal gate (eslint.refusal-gate.mjs): an API route refuses only through a
// gate that records the refusal as a deny row.
//
// The rule is loaded through the config CI runs (`npm run scope-gate:check`), and each
// case is linted as if it lived at a real path, so the file globs are tested with it.
// That each recording gate really writes its one row is proven against Postgres in
// app/api/refusal-audit.realdb.qa.test.ts.
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import { CAN_ALLOWED } from "./eslint.refusal-gate.mjs";

const RULE = "refusal-gate/no-unrecorded-refusal";
const ROUTE = "app/api/settings/example/route.ts";

const eslint = new ESLint({ overrideConfigFile: "eslint.scope-gate.config.mjs" });

/** Linting loads the TypeScript parser and every plugin; the first call alone takes seconds. */
const LINT_TIMEOUT_MS = 30_000;

/** The lines the gate reports in `text`, linted as if it lived at `filePath`. */
async function findings(text: string, filePath: string): Promise<number[]> {
  const [result] = await eslint.lintText(text, { filePath });
  const fatal = result!.messages.filter((m) => m.fatal);
  if (fatal.length > 0) throw new Error(`fixture does not parse: ${fatal[0]!.message}`);
  return result!.messages.filter((m) => m.ruleId === RULE).map((m) => m.line);
}

/** Every way a route can refuse without a row, one per line. */
const UNRECORDED = [
  `if (rc.user.role !== "admin") return forbidden();`,
  `if (rc.user.role === "member") return forbidden();`,
  `if ("member" == user.role) return forbidden();`,
  `if (!["owner", "admin"].includes(rc.user.role)) return forbidden();`,
  `if (!ORG_ADMIN_ROLES.includes(rc.user.role)) return forbidden();`,
  `if (!(await can(rc.ctx, { action: "access.manage" })).allowed) return forbidden();`,
  `if (!(await requireOrgRole(rc, ORG_ADMIN_ROLES))) return forbidden();`,
  `if (!(await requireOrgRole(rc, ORG_ADMIN_ROLES, \`billing:\${kind}\`))) return forbidden();`,
  `if (!(await requireOrgRole(rc, ORG_ADMIN_ROLES, ""))) return forbidden();`,
];

/** Recording gates, and code that reads a role without deciding on it. */
const RECORDED = [
  `const OPERATION = "updates:export";`,
  `if (!(await requireOrgRole(rc, ORG_ADMIN_ROLES, "billing:checkout"))) return forbidden();`,
  `if (!(await requireOrgRole(rc, ORG_ADMIN_ROLES, OPERATION))) return forbidden();`,
  `const d = await check(rc.ctx, { action: "access.manage", target: "audit:list" });`,
  `if (agentRow.role !== "research") return badRequest();`,
  `const history = body.history.filter((m) => m.role && m.content);`,
  `const shown = { role: rc.user.role };`,
];

describe("the refusal gate", () => {
  it(
    "reports every unrecorded refusal in a route, one finding per line",
    async () => {
      expect(await findings(UNRECORDED.join("\n"), ROUTE)).toEqual(UNRECORDED.map((_, i) => i + 1));
    },
    LINT_TIMEOUT_MS,
  );

  it(
    "does not report recording gates or a role that is only read",
    async () => {
      expect(await findings(RECORDED.join("\n"), ROUTE)).toEqual([]);
    },
    LINT_TIMEOUT_MS,
  );

  it(
    "does not accept an operation named by a const that is not module-level or not a string",
    async () => {
      const text = [
        `export async function POST() {`,
        `  const op = "billing:checkout";`,
        `  return requireOrgRole(rc, ORG_ADMIN_ROLES, op);`,
        `}`,
      ].join("\n");
      expect(await findings(text, ROUTE)).toEqual([3]);
    },
    LINT_TIMEOUT_MS,
  );

  it(
    "lets only the listed routes call can(), and only can()",
    async () => {
      const probe = `const d = await can(ctx, read);\nif (rc.user.role !== "admin") return forbidden();`;
      for (const path of Object.keys(CAN_ALLOWED)) {
        expect(await findings(probe, path), path).toEqual([2]);
      }
      expect(await findings(probe, "app/api/memory/route.ts")).toEqual([1, 2]);
    },
    LINT_TIMEOUT_MS,
  );

  it(
    "applies to route files only, not tests or the gate's own helpers",
    async () => {
      const text = UNRECORDED[0]!;
      expect(await findings(text, "app/api/settings/example/route.test.ts")).toEqual([]);
      expect(await findings(text, "lib/org-role.ts")).toEqual([]);
    },
    LINT_TIMEOUT_MS,
  );
});
