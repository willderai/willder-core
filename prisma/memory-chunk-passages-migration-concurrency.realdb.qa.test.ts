// The memory_chunk_passages migration (20261011100000) under a live
// writer, beyond "the deploy waits and then applies":
//
// - while the deploy waits on the foreign key's lock, reads of memory_chunks keep
//   answering, and a write that arrives behind the deploy is held, not refused, and lands
//   once the deploy has applied;
// - rows stored before the migration keep their content, get no passages, and a delete
//   after it still removes the row (the cascade has nothing to remove);
// - a deploy killed while it waits leaves no half-built table behind.
//
// Gated on QA_DATABASE_URL like the repo's other real-Postgres suites; it creates its own
// database on that server and drops it afterwards.
import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { Client } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const QA_URL = process.env.QA_DATABASE_URL;
const { HOME, NODE_ENV, PATH } = process.env;
const MIGRATION = "20261011100000_memory_chunk_passages";
const repoRoot = resolve(__dirname, "..");
const DATABASE = `willder_passage_migration_qa_${process.pid}`;

const sleep = (ms: number) => new Promise((wait) => setTimeout(wait, ms));

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

type PrismaRun = { child: ChildProcess; done: Promise<{ status: number | null; output: string }> };

/** Runs the Prisma CLI against `url`; `done` resolves with its exit status and output. */
function spawnPrisma(url: string, args: string[]): PrismaRun {
  const child = spawn(join(repoRoot, "node_modules", ".bin", "prisma"), args, {
    cwd: repoRoot,
    env: { HOME, NODE_ENV, PATH, DATABASE_URL: url },
  });
  let output = "";
  child.stdout?.on("data", (chunk) => (output += chunk));
  child.stderr?.on("data", (chunk) => (output += chunk));
  const done = new Promise<{ status: number | null; output: string }>((settle, fail) => {
    child.on("error", fail);
    child.on("close", (status) => settle({ status, output }));
  });
  return { child, done };
}

const startDeploy = (url: string, config?: string): PrismaRun =>
  spawnPrisma(url, ["migrate", "deploy", ...(config ? ["--config", config] : [])]);

/** Builds the database production had before this migration, in a fresh database. */
async function buildPreMigrationDatabase(url: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "willder-passage-migration-qa-"));
  try {
    // The migrations dated before this one; the later ones apply after it, in order.
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
      `export default { schema: ${JSON.stringify(join(repoRoot, "prisma", "schema.prisma"))}, ` +
        `migrations: { path: ${JSON.stringify(migrations)} }, datasource: { url: process.env.DATABASE_URL } };\n`,
    );
    const built = await startDeploy(url, config).done;
    expect(built.status, built.output).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const isRunning = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

/** Sessions on this database waiting for a relation lock. */
async function lockWaiters(observer: Client): Promise<{ pid: number; query: string }[]> {
  const { rows } = await observer.query<{ pid: number; query: string }>(
    `SELECT pid, query FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'relation'`,
  );
  return rows;
}

async function untilDeployWaits(observer: Client, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (isRunning(child)) {
    if ((await lockWaiters(observer)).some((w) => /FOREIGN KEY|memory_chunk_passages/i.test(w.query))) return;
    if (Date.now() > deadline) throw new Error("the deploy never waited on the open write within 60 s");
    await sleep(100);
  }
  throw new Error("the deploy exited before it waited on the open write");
}

/** An org and one memory_chunks row in it, as the pre-migration app would store it. */
async function seedRow(client: Client, id: string, orgId: string, content: string): Promise<void> {
  await client.query(
    `INSERT INTO memory_chunks (id, "orgId", content, "actorType", "actorId", "createdAt")
     VALUES ($1, $2, $3, 'agent', 'qa-agent', now())`,
    [id, orgId, content],
  );
}

describe.skipIf(!QA_URL)("the memory_chunk_passages migration under a live writer (QA)", () => {
  const url = QA_URL ? withDatabase(QA_URL, DATABASE) : "";
  const ORG = "qa-org-passage-migration";

  beforeEach(async () => {
    await onServer(QA_URL!, `DROP DATABASE IF EXISTS "${DATABASE}" WITH (FORCE)`);
    await onServer(QA_URL!, `CREATE DATABASE "${DATABASE}"`);
    await buildPreMigrationDatabase(url);
    const client = await connect(url);
    try {
      await client.query(`INSERT INTO orgs (id, name, "updatedAt") VALUES ($1, 'QA', now())`, [ORG]);
      await seedRow(client, "qa-before-1", ORG, "stored before the migration ".repeat(60));
    } finally {
      await client.end();
    }
  }, 180_000);

  afterAll(async () => {
    await onServer(QA_URL!, `DROP DATABASE IF EXISTS "${DATABASE}" WITH (FORCE)`);
  }, 60_000);

  it("keeps reads answering and holds, then lands, a write that arrives while the deploy waits", async () => {
    const blocker = await connect(url);
    const reader = await connect(url);
    const lateWriter = await connect(url);
    const observer = await connect(url);
    let deploying: ReturnType<typeof startDeploy> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("UPDATE memory_chunks SET content = content WHERE false");
      deploying = startDeploy(url);
      await untilDeployWaits(observer, deploying.child);

      // A read takes ACCESS SHARE, which the foreign key's SHARE ROW EXCLUSIVE does not
      // conflict with, so it answers while the deploy waits.
      const started = Date.now();
      const { rows: read } = await reader.query(`SELECT id FROM memory_chunks WHERE "orgId" = $1`, [ORG]);
      expect(read.map((r) => r.id)).toEqual(["qa-before-1"]);
      expect(Date.now() - started).toBeLessThan(2_000);

      // A write arriving now queues behind the deploy's lock request: held, not refused.
      const late = seedRow(lateWriter, "qa-during-1", ORG, "written while the deploy waited ".repeat(40));
      let lateSettled = false;
      void late.then(
        () => (lateSettled = true),
        () => (lateSettled = true),
      );
      await sleep(1_000);
      expect(lateSettled, "a write behind the waiting deploy should be held until it applies").toBe(false);

      await blocker.query("COMMIT");
      const result = await deploying.done;
      expect(result.status, result.output).toBe(0);
      await late; // lands once the deploy has applied, no error

      const { rows: rows } = await observer.query<{ id: string; passages: number }>(
        `SELECT c.id, (SELECT count(*)::int FROM memory_chunk_passages p WHERE p."chunkId" = c.id) AS passages
           FROM memory_chunks c WHERE c."orgId" = $1 ORDER BY c.id`,
        [ORG],
      );
      // Rows written by the old app keep their content and have no passages until the backfill.
      expect(rows).toEqual([
        { id: "qa-before-1", passages: 0 },
        { id: "qa-during-1", passages: 0 },
      ]);
      // A delete after the migration still works on a row with no passages.
      await observer.query(`DELETE FROM memory_chunks WHERE "orgId" = $1 AND id = 'qa-before-1'`, [ORG]);
    } finally {
      deploying?.child.kill();
      for (const c of [blocker, reader, lateWriter, observer]) await c.end().catch(() => {});
    }
  }, 120_000);

  it("leaves nothing half-built when the deploy is killed while it waits, so resolve --rolled-back and a redeploy recover", async () => {
    const blocker = await connect(url);
    const observer = await connect(url);
    try {
      await blocker.query("BEGIN");
      await blocker.query("UPDATE memory_chunks SET content = content WHERE false");
      const deploying = startDeploy(url);
      await untilDeployWaits(observer, deploying.child);
      // The build is cancelled or times out while it waits: its connection goes away.
      const waiting = await lockWaiters(observer);
      deploying.child.kill("SIGKILL");
      await deploying.done;
      for (const w of waiting) await observer.query("SELECT pg_terminate_backend($1)", [w.pid]);
      await blocker.query("COMMIT");

      // Prisma records a migration it started and never finished as failed, so the next
      // deploy stops on P3009 whatever the migration was; the documented recovery is
      // `migrate resolve --rolled-back` and a redeploy. That recovery only works when the
      // killed attempt left nothing behind: a table it created would make the redeploy's
      // CREATE TABLE fail with 42P07 and need a hand-written DROP in production.
      const { rows: table } = await observer.query(`SELECT to_regclass('memory_chunk_passages') AS t`);
      const resolved = await spawnPrisma(url, ["migrate", "resolve", "--rolled-back", MIGRATION]).done;
      const next = await startDeploy(url).done;
      expect(table[0].t, "a killed deploy left memory_chunk_passages half-built").toBeNull();
      expect(resolved.status, resolved.output).toBe(0);
      expect(next.status, next.output).toBe(0);
    } finally {
      await blocker.end().catch(() => {});
      await observer.end().catch(() => {});
    }
  }, 120_000);
});
