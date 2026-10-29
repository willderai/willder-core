// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// `npm run audit:verify` as an administrator runs it: the exit code and the line
// it prints are the contract, since an operator acts on them. An intact chain
// exits 0, a planted break exits 1 and names its position, and a database it
// cannot read exits 2. The verifier's own cases, concurrent writes included,
// are in services/access/audit-chain.realdb.test.ts.
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const QA_URL = process.env.QA_DATABASE_URL;
/** Handed to the spawned CLI, which otherwise gets no environment at all. */
const { HOME, PATH } = process.env;
const PREFIX = "achain-cli-";
const repoRoot = resolve(__dirname, "..");

function runVerify(databaseUrl: string, orgId: string) {
  return spawnSync(join(repoRoot, "node_modules", ".bin", "tsx"), ["scripts/verify-audit-chain.ts", orgId], {
    cwd: repoRoot,
    env: { HOME, PATH, NODE_ENV: "test", DATABASE_URL: databaseUrl },
    encoding: "utf8",
    timeout: 120_000,
  });
}

describe.skipIf(!QA_URL)("npm run audit:verify, real Postgres", () => {
  let pool: Pool;
  const created: string[] = [];

  /** An org with `rows` chained audit rows, written through the insert trigger. */
  const orgWithChain = async (rows: number) => {
    const orgId = `${PREFIX}${randomUUID()}`;
    created.push(orgId);
    await pool.query(`INSERT INTO "orgs" ("id", "name", "updatedAt") VALUES ($1, $1, now())`, [orgId]);
    for (let i = 0; i < rows; i++) {
      await pool.query(
        `INSERT INTO "audit_log" ("id", "orgId", "actorType", "actorId", "action", "decision")
         VALUES ($1, $2, 'agent', $3, 'memory.read', 'allow')`,
        [randomUUID(), orgId, `agent-${i}`],
      );
    }
    return orgId;
  };

  beforeAll(() => {
    pool = new Pool({ connectionString: QA_URL, max: 2 });
  });

  afterAll(async () => {
    // Every org this file made has a chain head; deleting the org cascades its audit rows.
    await pool.query(
      `DELETE FROM "orgs" WHERE "id" IN (SELECT "orgId" FROM "audit_chain_heads" WHERE "orgId" = ANY($1))`,
      [created],
    );
    await pool.end();
  });

  // Each tamper runs as this file's superuser connection, which the append-only trigger exempts.
  const rewriteRow2 = (orgId: string) =>
    pool.query(`UPDATE "audit_log" SET "reason" = 'rewritten' WHERE "orgId" = $1 AND "chainSeq" = 2`, [orgId]);
  const plantAtPosition0 = async (orgId: string) => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      await c.query(
        `INSERT INTO "audit_log" ("id", "orgId", "actorType", "actorId", "action", "decision", "chainSeq")
         VALUES ($1, $2, 'agent', 'planted', 'memory.read', 'allow', 0)`,
        [randomUUID(), orgId],
      );
      await c.query("COMMIT");
    } finally {
      c.release();
    }
  };

  it.each([
    {
      label: "an intact chain exits 0 and prints its head",
      tamper: null,
      status: 0,
      line: /^ok {6}\S+: 3 chained, 0 unchained .*; head 3 [0-9a-f]{64}$/m,
    },
    {
      label: "a planted break exits 1 and names its position",
      tamper: rewriteRow2,
      status: 1,
      line: /^BROKEN {2}\S+: .* row \S+ at position 2 does not match its hash .*; 1 row\(s\) verified before it$/m,
    },
    {
      label: "a row planted at position 0 exits 1",
      tamper: plantAtPosition0,
      status: 1,
      line: /^BROKEN {2}\S+: .* row \S+ is at position 0, which the chain never assigns .*; 3 row\(s\) verified before it$/m,
    },
  ])(
    "$label",
    async ({ tamper, status, line }) => {
      const orgId = await orgWithChain(3);
      if (tamper !== null) await tamper(orgId);
      const result = runVerify(QA_URL!, orgId);
      expect(result.stdout).toMatch(line);
      expect(result.stdout).toContain(`1 org(s) checked, ${status} broken`);
      expect(result.status).toBe(status);
    },
    150_000,
  );

  it("exits 2, not 0, when it cannot read the database", () => {
    const unreachable = new URL(QA_URL!);
    unreachable.port = "1";
    const result = runVerify(unreachable.toString(), `${PREFIX}none`);
    expect(result.stderr).toContain(`audit:verify could not read the audit log of org ${PREFIX}none`);
    expect(result.stdout).toContain("1 org(s) checked, 0 broken, 1 could not be read");
    expect(result.stdout).not.toMatch(/^ok /m);
    expect(result.status).toBe(2);
  }, 150_000);
});
