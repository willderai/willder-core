// The passage-embeddings migration has to survive a busy production database.
//
// prisma/migrations/20261011100000_memory_chunk_passages adds a foreign key from the new
// memory_chunk_passages table to memory_chunks. Adding it takes a lock on memory_chunks
// that conflicts with every open write to that table, so the migration must wait for those
// writes to finish, never give up on a lock timeout. Giving up is not a retry: Prisma
// records the migration as failed, with its table already created, and every later
// `prisma migrate deploy` stops on P3009 until someone resolves it by hand. build.sh
// retries only an unreachable database (P1002), so one slow write during a deploy would
// freeze every production build after it.
//
// This suite reproduces that deploy: a migrated database without this one migration, a
// write transaction open on memory_chunks, and a real `prisma migrate deploy` started
// behind it. The deploy has to wait and then apply.
//
// Gated on QA_DATABASE_URL like the repo's other real-Postgres suites; it creates its own
// database on that server and drops it afterwards. Locally:
// QA_DATABASE_URL=postgresql://postgres:willder@localhost:5432/willder npx vitest run prisma/memory-chunk-passages-migration
import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const QA_URL = process.env.QA_DATABASE_URL;
/** Handed to the spawned Prisma CLI, which otherwise gets no environment at all. */
const { HOME, NODE_ENV, PATH } = process.env;

const MIGRATION = "20261011100000_memory_chunk_passages";
/**
 * How long the write stays open once the deploy is waiting on it: longer than a short
 * `lock_timeout` such as 5 s, so a migration that sets one fails here.
 */
const WRITE_HELD_MS = 8_000;
/** Named per process so parallel runs cannot collide. */
const DATABASE = `willder_passage_migration_${process.pid}`;

const repoRoot = resolve(__dirname, "..");

function withDatabase(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

async function connect(url: string): Promise<Client> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  await client.connect();
  return client;
}

async function onServer(url: string, sql: string): Promise<void> {
  const client = await connect(url);
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

const sleep = (ms: number) => new Promise((wait) => setTimeout(wait, ms));

interface DeployResult {
  status: number | null;
  output: string;
}

/**
 * Starts `prisma migrate deploy` against `url`, with the repository's Prisma config or
 * the one at `config`; `done` resolves when it exits.
 */
function startDeploy(url: string, config?: string): { child: ChildProcess; done: Promise<DeployResult> } {
  const args = ["migrate", "deploy", ...(config ? ["--config", config] : [])];
  const child = spawn(join(repoRoot, "node_modules", ".bin", "prisma"), args, {
    cwd: repoRoot,
    env: { HOME, NODE_ENV, PATH, DATABASE_URL: url },
  });
  let output = "";
  child.stdout?.on("data", (chunk) => (output += chunk));
  child.stderr?.on("data", (chunk) => (output += chunk));
  const done = new Promise<DeployResult>((settle, fail) => {
    child.on("error", fail);
    child.on("close", (status) => settle({ status, output }));
  });
  return { child, done };
}

/**
 * Writes a Prisma config whose migrations are the committed ones dated before `MIGRATION`,
 * so a deploy with it builds the database production had before this migration shipped;
 * the later ones apply after it, in order, as they did there. Returns the config's path;
 * the caller removes `dir`.
 */
function configWithoutThisMigration(dir: string): string {
  const source = join(repoRoot, "prisma", "migrations");
  const migrations = join(dir, "migrations");
  cpSync(source, migrations, {
    recursive: true,
    filter: (path) => {
      const [top] = relative(source, path).split(sep);
      return !/^\d{14}_/.test(top) || top < MIGRATION;
    },
  });
  const config = join(dir, "prisma.config.mjs");
  writeFileSync(
    config,
    [
      "export default {",
      `  schema: ${JSON.stringify(join(repoRoot, "prisma", "schema.prisma"))},`,
      `  migrations: { path: ${JSON.stringify(migrations)} },`,
      "  datasource: { url: process.env.DATABASE_URL },",
      "};",
      "",
    ].join("\n"),
  );
  return config;
}

const isRunning = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

/**
 * Resolves once a session on the database `observer` is connected to waits for a table
 * lock, which here can only be the deploy reaching the foreign key, or once the deploy has
 * exited. Starting the clock there, not at spawn, keeps the CLI's own start-up time out of
 * the measurement. `observer` must not be inside a transaction: Postgres keeps one
 * pg_stat_activity snapshot for a whole transaction.
 */
async function deployWaitingOnLock(observer: Client, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (isRunning(child)) {
    const { rows } = await observer.query(
      `SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'relation'`,
    );
    if (rows.length > 0) return;
    if (Date.now() > deadline) throw new Error("prisma migrate deploy never waited on the open write within 60 s");
    await sleep(100);
  }
}

describe.skipIf(!QA_URL)("the memory_chunk_passages migration behind an open write", () => {
  const url = QA_URL ? withDatabase(QA_URL, DATABASE) : "";

  beforeAll(async () => {
    await onServer(QA_URL!, `DROP DATABASE IF EXISTS "${DATABASE}"`);
    await onServer(QA_URL!, `CREATE DATABASE "${DATABASE}"`);
    const dir = mkdtempSync(join(tmpdir(), "willder-passage-migration-"));
    try {
      const built = await startDeploy(url, configWithoutThisMigration(dir)).done;
      expect(built.status, built.output).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  afterAll(async () => {
    await onServer(QA_URL!, `DROP DATABASE IF EXISTS "${DATABASE}" WITH (FORCE)`);
  }, 60_000);

  it("waits for the write to finish, then applies, and is never recorded as failed", async () => {
    const writer = await connect(url);
    const observer = await connect(url);
    let deploying: ReturnType<typeof startDeploy> | undefined;
    try {
      await writer.query("BEGIN");
      // Any INSERT, UPDATE or DELETE takes this table lock (ROW EXCLUSIVE); this one
      // changes no row, so the test needs no fixture.
      await writer.query("UPDATE memory_chunks SET content = content WHERE false");

      deploying = startDeploy(url);
      await deployWaitingOnLock(observer, deploying.child);
      await sleep(WRITE_HELD_MS);
      // Still waiting past the point where the old migration gave up.
      expect(isRunning(deploying.child), "the deploy gave up behind the write").toBe(true);
      await writer.query("COMMIT");

      const result = await deploying.done;
      expect(result.status, result.output).toBe(0);

      const { rows: applied } = await observer.query<{ finished: boolean; rolled_back: boolean }>(
        `SELECT finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back
           FROM _prisma_migrations WHERE migration_name = $1`,
        [MIGRATION],
      );
      expect(applied).toEqual([{ finished: true, rolled_back: false }]);
      const { rows: foreignKeys } = await observer.query(
        `SELECT 1 FROM pg_constraint WHERE conname = 'memory_chunk_passages_chunkId_fkey'`,
      );
      expect(foreignKeys).toHaveLength(1);
    } finally {
      deploying?.child.kill();
      await writer.end();
      await observer.end();
    }

    // The next deploy, which a failed record would stop with P3009, has nothing to do.
    const next = await startDeploy(url).done;
    expect(next.status, next.output).toBe(0);
  }, 120_000);
});
