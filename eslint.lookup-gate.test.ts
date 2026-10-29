// The lookup gate (eslint.lookup-gate.mjs): an API route decides access before it
// looks a record up, or looks it up through authorizeRecord().
//
// The rule is loaded through the config CI runs (`npm run scope-gate:check`), and each
// case is linted as if it lived at a real path, so the file globs are tested with it.
// That the routes really answer a missing and a forbidden record alike is proven
// against Postgres in app/api/existence-probes.realdb.qa.test.ts.
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const RULE = "lookup-gate/no-lookup-before-decision";
const ROUTE = "app/api/things/[id]/route.ts";

const eslint = new ESLint({ overrideConfigFile: "eslint.scope-gate.config.mjs" });

/** Linting loads the TypeScript parser and every plugin; the first call alone takes seconds. */
const LINT_TIMEOUT_MS = 30_000;

/** The lines the gate reports in `text`, linted as if it lived at `filePath`. */
async function findings(text: string, filePath = ROUTE): Promise<number[]> {
  const [result] = await eslint.lintText(text, { filePath });
  const fatal = result!.messages.filter((m) => m.fatal);
  if (fatal.length > 0) throw new Error(`fixture does not parse: ${fatal[0]!.message}`);
  return result!.messages.filter((m) => m.ruleId === RULE).map((m) => m.line);
}

const handler = (...body: string[]) =>
  ["export async function POST() {", ...body.map((line) => `  ${line}`), "}"].join("\n");

describe("the lookup gate", () => {
  it(
    "reports every single-record lookup that runs before the decision",
    async () => {
      const text = handler(
        `const a = await db.thing.findFirst({ where: { id } });`,
        `const b = await db.thing.findUnique({ where: { id } });`,
        `const c = await db.thing.findFirstOrThrow({ where: { id } });`,
        `const d = await tx.thing.findUniqueOrThrow({ where: { id } });`,
        `const decision = await check(rc.ctx, { action: "memory.write" });`,
      );
      expect(await findings(text)).toEqual([2, 3, 4, 5]);
    },
    LINT_TIMEOUT_MS,
  );

  it(
    "counts requireOrgRole() as the decision too",
    async () => {
      const text = handler(
        `const a = await db.thing.findFirst({ where: { id } });`,
        `if (!(await requireOrgRole(rc, ORG_ADMIN_ROLES, "things:save"))) return forbidden();`,
      );
      expect(await findings(text)).toEqual([2]);
    },
    LINT_TIMEOUT_MS,
  );

  it(
    "accepts a lookup after the decision, and one made through authorizeRecord()",
    async () => {
      expect(
        await findings(
          handler(
            `const decision = await check(rc.ctx, { action: "memory.write" });`,
            `const a = await db.thing.findFirst({ where: { id } });`,
          ),
        ),
      ).toEqual([]);
      expect(
        await findings(
          handler(
            `const access = await authorizeRecord(rc.ctx, () => db.thing.findFirst({ where: { id } }), request);`,
            `const b = await db.other.findUnique({ where: { id } });`,
          ),
        ),
      ).toEqual([]);
    },
    LINT_TIMEOUT_MS,
  );

  it(
    "leaves alone a function that makes no access decision, and listings",
    async () => {
      expect(await findings(handler(`const a = await db.thing.findFirst({ where: { id } });`))).toEqual([]);
      expect(
        await findings(
          handler(`const all = await db.thing.findMany({ where: { orgId } });`, `await check(rc.ctx, read);`),
        ),
      ).toEqual([]);
    },
    LINT_TIMEOUT_MS,
  );

  it(
    "judges each function on its own decision",
    async () => {
      const text = [
        `async function load(id: string) { return db.thing.findFirst({ where: { id } }); }`,
        handler(`await check(rc.ctx, read);`, `const a = await load(id);`),
        handler(`const b = await db.thing.findFirst({ where: { id } });`, `await check(rc.ctx, read);`),
      ].join("\n");
      expect(await findings(text)).toEqual([7]);
    },
    LINT_TIMEOUT_MS,
  );

  it(
    "applies to route files only, not tests or services",
    async () => {
      const text = handler(`const a = await db.thing.findFirst({ where: { id } });`, `await check(rc.ctx, read);`);
      expect(await findings(text, "app/api/things/[id]/route.test.ts")).toEqual([]);
      expect(await findings(text, "services/memory/things.ts")).toEqual([]);
    },
    LINT_TIMEOUT_MS,
  );
});
