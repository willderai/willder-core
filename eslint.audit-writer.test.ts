// The audit-writer gate (eslint.audit-writer.mjs): only services/access/audit-row.ts
// writes audit_log, so every audit row records its origin.
//
// The rule is loaded through the config CI runs (`npm run scope-gate:check`), and each
// case is linted as if it lived at a real path, so the file globs are tested with it.
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const RULE = "audit-writer/no-audit-write-outside-writer";
const WRITER = "services/access/audit-row.ts";
const ELSEWHERE = "services/workflows/example.ts";

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

/** Every way a file can write audit_log without the writer, one per line. */
const WRITES = [
  `await db.auditLog.create({ data: row });`,
  `await tx.auditLog.createMany({ data: rows });`,
  `await client.auditLog.createManyAndReturn({ data: rows });`,
  `await db.auditLog.upsert({ where, create, update });`,
  `await db.auditLog.update({ where, data });`,
  `await db.auditLog.updateMany({ where, data });`,
  `await db.auditLog.delete({ where });`,
  `await db.auditLog.deleteMany({ where });`,
  `await db["auditLog"].create({ data: row });`,
  'await db.$executeRaw`INSERT INTO "audit_log" ("id") VALUES (${id})`;',
  `await db.$executeRawUnsafe('insert into public.audit_log ("id") values ($1)', id);`,
  'await db.$executeRaw`UPDATE audit_log SET "reason" = ${reason}`;',
  'await db.$executeRaw`DELETE FROM "audit_log" WHERE "orgId" = ${orgId}`;',
  `const log = db.auditLog;`,
  `const { auditLog } = db;`,
  `insertRows(tx.auditLog, rows);`,
];

/** Code that touches audit_log without writing it. */
const READS = [
  `const rows = await db.auditLog.findMany({ where });`,
  `const row = await tx.auditLog.findFirst({ where });`,
  `const n = await db.auditLog.count({ where });`,
  `const byAction = await db.auditLog.groupBy({ by: ["action"] });`,
  'const rows = await db.$queryRaw`SELECT "id" FROM "audit_log" WHERE "orgId" = ${orgId}`;',
  `type Client = Pick<Prisma.TransactionClient, "auditLog">;`,
  `const note = "every update to the audit_log table goes through one writer";`,
  "const fn = `audit_log_chain_insert`;",
];

describe("the audit-writer gate", () => {
  it(
    "reports every audit_log write outside the writer, one finding per write",
    async () => {
      const lines = await findings(WRITES.join("\n"), ELSEWHERE);
      expect(lines).toEqual(WRITES.map((_, i) => i + 1));
    },
    LINT_TIMEOUT_MS,
  );

  it(
    "reports writes in scripts, routes and components too, not only services",
    async () => {
      for (const path of [
        "scripts/backfill.ts",
        "app/api/example/route.ts",
        "components/audit/example.tsx",
        "lib/example.ts",
      ]) {
        expect(await findings(WRITES[0]!, path), path).toEqual([1]);
      }
    },
    LINT_TIMEOUT_MS,
  );

  it(
    "allows the writer itself, and tests that seed rows to assert on them",
    async () => {
      const text = WRITES.join("\n");
      expect(await findings(text, WRITER)).toEqual([]);
      expect(await findings(text, "services/access/check.test.ts")).toEqual([]);
      expect(await findings(text, "components/audit/timeline.test.tsx")).toEqual([]);
    },
    LINT_TIMEOUT_MS,
  );

  it(
    "does not report reads, types or prose that merely name the table",
    async () => {
      expect(await findings(READS.join("\n"), ELSEWHERE)).toEqual([]);
    },
    LINT_TIMEOUT_MS,
  );
});
