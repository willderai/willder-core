// Per-worker Postgres databases for the real-database test suites.
//
// The rule this module enforces: no two Vitest workers ever share a database.
// The real-database suites seed and delete rows by fixed org ids, so two files
// running at once against one database can wipe each other's fixtures between
// a `beforeEach` and the assertion that reads them. Each run therefore builds
// one template database from the committed migrations, and every worker gets
// its own copy of it (CREATE DATABASE ... TEMPLATE), so concurrency between
// workers cannot reach a shared row.
//
// Databases are only ever created and dropped on the server QA_DATABASE_URL
// names, and only when that server is local: the suites already require that
// variable to name an isolated test database, and this module refuses to run
// administrative statements anywhere else.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

/** Hostnames accepted as a local Postgres server. An empty host means a Unix socket. */
const LOCAL_HOSTS = new Set(["", "localhost", "127.0.0.1", "::1", "[::1]"]);

/** Postgres truncates identifiers longer than this, which would merge two names into one. */
const MAX_IDENTIFIER_BYTES = 63;

/** A database-level setting to give every worker database: `[name, value]`. */
export type DatabaseSetting = [name: string, value: string];

/**
 * What the global setup hands each worker through the environment, so the
 * worker can make its own copies without repeating the template build.
 */
export interface WorkerDatabasePlan {
  /** Identifies this run; part of every database name it creates. */
  runId: string;
  /** The migrated template every worker database is copied from. */
  template: string;
  /** QA_DATABASE_URL as the developer or CI set it, before any rewrite. */
  qaBaseUrl: string;
  /** Settings the QA database carries, plus the test-only vector setting. */
  qaSettings: DatabaseSetting[];
  /** DATABASE_URL as set, when it names a database on the same local server; otherwise null. */
  appBaseUrl: string | null;
  appSettings: DatabaseSetting[];
}

/** The environment variable that carries the plan from the global setup to each worker. */
export const PLAN_ENV = "WILLDER_TEST_DATABASE_PLAN";

/** The database a connection URL names. */
export function databaseName(url: string): string {
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  if (!name) throw new Error(`The database URL names no database: ${redact(url)}`);
  return name;
}

/** The same URL, pointed at another database on the same server. */
export function withDatabase(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${encodeURIComponent(name)}`;
  return parsed.toString();
}

/** Whether two URLs reach the same Postgres server (host and port). */
export function sameServer(a: string, b: string): boolean {
  const left = new URL(a);
  const right = new URL(b);
  return left.hostname === right.hostname && (left.port || "5432") === (right.port || "5432");
}

/**
 * Query parameters naming the server to connect to instead of the URL's host: node-postgres
 * reads `host` from the query string over the host before it, and libpq reads both.
 */
const HOST_PARAMS = ["host", "hostaddr"];

/**
 * Whether a URL names a Postgres server on this machine: its host, and every host its query
 * string names ({@link HOST_PARAMS}, each comma-separated), is local or a Unix socket path. A URL
 * that does not parse is not local. Only the URL is read: a URL with no host, which node-postgres
 * fills from PGHOST, is judged by the socket it names, so PGHOST must not be set to another
 * machine where this is relied on (the retrieval lab starts its sessions without it).
 */
export function isLocalServer(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const queried = HOST_PARAMS.flatMap((name) => parsed.searchParams.getAll(name)).flatMap((value) => value.split(","));
  return [parsed.hostname, ...queried].every((host) => LOCAL_HOSTS.has(host.trim()) || host.trim().startsWith("/"));
}

/** A URL with its password removed, for error messages. */
export function redact(url: string): string {
  const parsed = new URL(url);
  if (parsed.password) parsed.password = "***";
  return parsed.toString();
}

/**
 * The name of a database this run creates: `<base>_<runId>_<role>`, where role
 * is `tpl` for the template or `w<pool id>` for a worker's copy.
 */
export function runDatabaseName(base: string, runId: string, role: string): string {
  const name = `${base}_${runId}_${role}`;
  if (Buffer.byteLength(name) > MAX_IDENTIFIER_BYTES) {
    throw new Error(
      `Test database name "${name}" is longer than Postgres's ${MAX_IDENTIFIER_BYTES}-byte limit. ` +
        `Use a shorter database name in QA_DATABASE_URL or DATABASE_URL.`,
    );
  }
  return name;
}

/**
 * The process id of the run that created `name`, when `name` is one of the
 * databases {@link runDatabaseName} builds from `base`; otherwise null.
 */
export function runPidOf(base: string, name: string): number | null {
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escaped}_r(\\d+)_(tpl|w\\d+)$`).exec(name);
  return match ? Number(match[1]) : null;
}

/** Whether a process with this id is still running on this machine. */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to another user, so it is alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const quoteIdentifier = (name: string) => `"${name.replace(/"/g, '""')}"`;

async function withClient<T>(url: string, work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** Drops a database even while a test's leaked connection is still open on it. */
async function dropDatabase(client: Client, name: string): Promise<void> {
  await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`);
}

/** The settings `ALTER DATABASE ... SET` gave this database, as stored. */
async function databaseSettings(client: Client, name: string): Promise<DatabaseSetting[]> {
  const { rows } = await client.query<{ setting: string }>(
    `SELECT unnest(s.setconfig) AS setting
       FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase
      WHERE d.datname = $1 AND s.setrole = 0`,
    [name],
  );
  return rows.map(({ setting }) => {
    const split = setting.indexOf("=");
    return [setting.slice(0, split), setting.slice(split + 1)];
  });
}

/**
 * The largest `lists` of any IVFFlat index in the database, or null when it
 * has none. Probing that many lists makes an IVFFlat scan exact.
 */
async function largestIvfflatLists(url: string): Promise<number | null> {
  return withClient(url, async (client) => {
    const { rows } = await client.query<{ lists: string | null }>(
      `SELECT max(substring(opt FROM '^lists=(\\d+)$')::int)::text AS lists
         FROM pg_class c
         JOIN pg_am am ON am.oid = c.relam AND am.amname = 'ivfflat'
         CROSS JOIN LATERAL unnest(coalesce(c.reloptions, '{}')) AS opt`,
    );
    return rows[0]?.lists ? Number(rows[0].lists) : null;
  });
}

/** Removes databases left by earlier runs whose process is gone (a crash or a kill). */
async function dropAbandonedRunDatabases(client: Client, bases: string[]): Promise<void> {
  const { rows } = await client.query<{ datname: string }>(`SELECT datname FROM pg_database`);
  for (const { datname } of rows) {
    for (const base of bases) {
      const pid = runPidOf(base, datname);
      if (pid !== null && pid !== process.pid && !processIsAlive(pid)) await dropDatabase(client, datname);
    }
  }
}

/** Applies the committed migrations to `url` with the repository's own Prisma CLI. */
function migrate(url: string): void {
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  const result = spawnSync(`${repoRoot}node_modules/.bin/prisma`, ["migrate", "deploy"], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: url },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `prisma migrate deploy failed against the test template ${redact(url)}:\n${result.stdout}\n${result.stderr}`,
    );
  }
}

/**
 * Builds this run's template database from the migrations and describes, for
 * the workers, how to copy it. Returns null when QA_DATABASE_URL is unset, in
 * which case every real-database suite skips and there is nothing to build.
 */
export async function prepareTemplate(env: NodeJS.ProcessEnv): Promise<WorkerDatabasePlan | null> {
  const qaBaseUrl = env.QA_DATABASE_URL;
  if (!qaBaseUrl) return null;
  if (!isLocalServer(qaBaseUrl)) {
    throw new Error(
      `QA_DATABASE_URL names a server that is not local (${redact(qaBaseUrl)}). The test run creates ` +
        `and drops one database per worker on that server, so it must be a local Postgres.`,
    );
  }
  const qaBase = databaseName(qaBaseUrl);
  const appUrl = env.DATABASE_URL;
  // DATABASE_URL gets per-worker copies only when it is a different database on
  // the same local server. Anywhere else it is left exactly as set: CI points it
  // at a port with nothing listening on purpose, and a remote one is never touched.
  const appBaseUrl =
    appUrl && appUrl !== qaBaseUrl && isLocalServer(appUrl) && sameServer(appUrl, qaBaseUrl) ? appUrl : null;

  const runId = `r${process.pid}`;
  const template = runDatabaseName(qaBase, runId, "tpl");
  const bases = appBaseUrl ? [qaBase, databaseName(appBaseUrl)] : [qaBase];

  const { qaSettings, appSettings } = await withClient(qaBaseUrl, async (client) => {
    await dropAbandonedRunDatabases(client, bases);
    await dropDatabase(client, template);
    await client.query(`CREATE DATABASE ${quoteIdentifier(template)}`);
    return {
      qaSettings: await databaseSettings(client, qaBase),
      appSettings: appBaseUrl ? await databaseSettings(client, databaseName(appBaseUrl)) : [],
    };
  });
  migrate(withDatabase(qaBaseUrl, template));

  // The migrations build the IVFFlat index on an empty table, so its lists are
  // seeded from no data and a default one-list probe can miss a row that is the
  // nearest by distance. Tests assert exact rankings; probing every list makes
  // the scan exact without changing any product query.
  const lists = await largestIvfflatLists(withDatabase(qaBaseUrl, template));
  const vectorSettings: DatabaseSetting[] = lists ? [["ivfflat.probes", String(lists)]] : [];

  return {
    runId,
    template,
    qaBaseUrl,
    qaSettings: [...qaSettings, ...vectorSettings],
    appBaseUrl,
    appSettings: [...appSettings, ...vectorSettings],
  };
}

/**
 * Creates this worker's copy of the template next to `baseUrl` (once per worker
 * per run) and returns its URL.
 */
export async function workerDatabase(
  plan: WorkerDatabasePlan,
  baseUrl: string,
  settings: DatabaseSetting[],
  poolId: string,
): Promise<string> {
  const name = runDatabaseName(databaseName(baseUrl), plan.runId, `w${poolId}`);
  await withClient(plan.qaBaseUrl, async (client) => {
    const exists = await client.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [name]);
    if (exists.rowCount) return;
    await client.query(`CREATE DATABASE ${quoteIdentifier(name)} TEMPLATE ${quoteIdentifier(plan.template)}`);
    // Database-level settings do not travel with a template copy. set_config
    // parses each stored value with the setting's own syntax, and FROM CURRENT
    // records exactly that, so list values such as search_path survive intact.
    for (const [setting, value] of settings) {
      await client.query(`SELECT set_config($1, $2, false)`, [setting, value]);
      await client.query(`ALTER DATABASE ${quoteIdentifier(name)} SET ${quoteIdentifier(setting)} FROM CURRENT`);
    }
  });
  return withDatabase(baseUrl, name);
}

/** Drops every database this run created: the template and each worker's copies. */
export async function dropRunDatabases(plan: WorkerDatabasePlan): Promise<void> {
  const bases = [databaseName(plan.qaBaseUrl)];
  if (plan.appBaseUrl) bases.push(databaseName(plan.appBaseUrl));
  await withClient(plan.qaBaseUrl, async (client) => {
    const { rows } = await client.query<{ datname: string }>(`SELECT datname FROM pg_database`);
    for (const { datname } of rows) {
      if (bases.some((base) => runPidOf(base, datname) === process.pid)) await dropDatabase(client, datname);
    }
  });
}
