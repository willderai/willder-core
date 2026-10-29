// The half of the startup check no synthetic error can prove: run it against a
// real Postgres that the committed migrations built, and against a real Postgres
// that nothing built.
//
// Why this file exists. lib/db-startup.test.ts asserts the message the check
// produces for a hand-made 42P01, which is true of the message and says nothing
// about whether the probe names a table the migrations actually create. It did
// not for seven weeks: the probe read "Capability", the Prisma model name, while
// the migrations create "capabilities", so every documented setup path stopped on
// "it has no Willder tables" one step after `prisma migrate deploy` reported 56
// migrations applied. The unit file passed the whole time.
//
// Gated on QA_DATABASE_URL, the same variable the repo's other real-Postgres
// suites use, which .github/workflows/ci.yml provisions from pgvector/pgvector:pg16
// and migrates before `npm test` (see scripts/ci-realdb-coverage.test.ts, which
// fails if a gate like this one ever stops being satisfied in CI). Locally:
// QA_DATABASE_URL=postgresql://postgres:willder@localhost:5432/willder npx vitest run lib/db-startup
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseUnavailableError, assertDatabaseReachable } from "./db-startup";

const QA_URL = process.env.QA_DATABASE_URL;
/** Handed to the spawned server, which otherwise gets no environment at all. */
const { HOME, NODE_ENV, PATH } = process.env;

/** The same server, a database with nothing in it. Named per process so parallel runs cannot collide. */
const EMPTY_DATABASE = `willder_probe_empty_${process.pid}`;

function withDatabase(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

async function onServer(url: string, sql: string): Promise<void> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

describe.skipIf(!QA_URL)("the startup check against a real database", () => {
  const emptyUrl = QA_URL ? withDatabase(QA_URL, EMPTY_DATABASE) : "";

  beforeAll(async () => {
    await onServer(QA_URL!, `DROP DATABASE IF EXISTS "${EMPTY_DATABASE}"`);
    await onServer(QA_URL!, `CREATE DATABASE "${EMPTY_DATABASE}"`);
  }, 60_000);

  afterAll(async () => {
    await onServer(QA_URL!, `DROP DATABASE IF EXISTS "${EMPTY_DATABASE}"`);
  }, 60_000);

  it("passes against the database the committed migrations built", async () => {
    await expect(assertDatabaseReachable({ DATABASE_URL: QA_URL })).resolves.toBeUndefined();
  }, 30_000);

  it("tells a migrated database apart from an empty one on the same server", async () => {
    const failure = await assertDatabaseReachable({ DATABASE_URL: emptyUrl }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DatabaseUnavailableError);
    const message = (failure as DatabaseUnavailableError).message;
    expect(message).toContain("but it has no Willder tables");
    expect(message).toContain("npx prisma migrate deploy");
    // The reader has to be able to tell this from a database that never answered.
    expect(message).not.toContain("Cannot reach");
  }, 30_000);

  // What a stranger following docs/development.md actually runs. On a migrated
  // database the server has to get past the probe and fail on the token instead,
  // which is the whole symptom: the setup path has to be able to end.
  it("lets npm run mcp past the database check on a migrated database", () => {
    const repoRoot = resolve(__dirname, "..");
    const result = spawnSync(join(repoRoot, "node_modules", ".bin", "tsx"), ["mcp/server.ts"], {
      cwd: repoRoot,
      env: {
        NODE_ENV,
        PATH,
        HOME,
        DATABASE_URL: QA_URL,
        WILLDER_CAPABILITY_TOKEN: "wcap_not_a_real_token",
        GRAPHITI_SERVICE_URL: "http://127.0.0.1:1",
        GRAPHITI_SERVICE_API_KEY: "test",
      },
      encoding: "utf8",
      timeout: 120_000,
    });
    expect(result.stderr).not.toContain("no Willder tables");
    expect(result.stderr.trim()).toBe(
      "willder MCP server failed: WILLDER_CAPABILITY_TOKEN is not a live token in this database (unknown, expired or revoked). Mint a fresh one with: npm run selfhost:token (a self-hosted install, docs/self-host.md) or bash scripts/run-check.sh scripts/dev-token.ts (development).",
    );
    expect(result.status).toBe(1);
  }, 150_000);
});
