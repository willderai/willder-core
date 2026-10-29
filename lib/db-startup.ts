// Startup check for the application database, for processes that touch it
// before anything else (the stdio MCP server and the local scripts). It opens
// one plain node-postgres connection and asks whether the first table the
// process will need is there, so a missing, unreachable or unmigrated database
// fails with one line that names the fix instead of a Prisma invocation stack.
//
// The one rule: the two failures stay apart. "Nothing answered at this address"
// and "the server answered but holds no Willder tables" have different next
// steps, and telling a reader to re-run a migration that already succeeded is
// worse than saying nothing.
//
// Deliberately free of Prisma: the shared client in lib/db.ts logs every error
// it sees, so a probe through it could never fail quietly.
import { Client } from "pg";

/**
 * The physical table the probe looks for: the first table the MCP server reads.
 * Absent means the migrations never ran.
 *
 * This is the table name, not the Prisma model name — `model Capability` carries
 * `@@map("capabilities")`, so a probe for `"Capability"` fails on a correctly
 * migrated database. Written out here rather than read from the generated Prisma
 * client on purpose: this check runs before anything else precisely so that a
 * broken database produces one line instead of a Prisma stack, and loading the
 * client to learn a table name would put the thing being diagnosed in the path.
 * lib/db-startup.test.ts reads `prisma/schema.prisma` and fails if this string
 * stops matching the model's `@@map`, so the two cannot drift apart unnoticed.
 */
export const PROBE_TABLE = "capabilities";
const CONNECT_TIMEOUT_MS = 5_000;
/**
 * Bound on the probe query. connectionTimeoutMillis only covers the startup
 * handshake; node-postgres leaves query reads unbounded by default, so without
 * this a server that connects and then stops answering hangs the process.
 */
const QUERY_TIMEOUT_MS = 5_000;

/** Thrown by {@link assertDatabaseReachable}; `message` is the one line to print. */
export class DatabaseUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseUnavailableError";
  }
}

const SOCKET_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "ECONNRESET", "EHOSTUNREACH"]);

/**
 * The one-line explanation for a failed connection or probe query, or null when the
 * error is not one this check knows how to name. Never includes the connection
 * string, only its host and port.
 */
export function describeDatabaseFailure(
  error: unknown,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (!env.DATABASE_URL) {
    return "DATABASE_URL is not set. Copy .env.example to .env and fill it in (docs/development.md, Ten-minute path).";
  }
  const code = errorCode(error);
  const where = hostAndPort(env.DATABASE_URL);
  if (code === undefined) {
    return error instanceof Error && /timeout/i.test(error.message) ? unreachable(where) : null;
  }
  if (SOCKET_CODES.has(code)) return unreachable(where);
  switch (code) {
    case "28P01":
    case "28000":
      return `The database at ${where} rejected the user or password in DATABASE_URL. Check them against the Postgres you started (docs/development.md, Ten-minute path).`;
    case "3D000":
      return `The database named in DATABASE_URL does not exist at ${where}. Create it, or start Postgres with the docker command in docs/development.md's Ten-minute path, which creates it.`;
    case "42P01":
      return unmigrated(where);
    default:
      return null;
  }
}

/**
 * Connect once and check that the probe table is there. Throws
 * {@link DatabaseUnavailableError} with
 * a one-line, actionable message; any error this check cannot name is rethrown as is.
 */
export async function assertDatabaseReachable(env: Record<string, string | undefined> = process.env): Promise<void> {
  if (!env.DATABASE_URL) throw new DatabaseUnavailableError(describeDatabaseFailure(undefined, env)!);
  const client = new Client({
    connectionString: env.DATABASE_URL,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
    statement_timeout: QUERY_TIMEOUT_MS,
  });
  try {
    await client.connect();
    const probe = await client.query<{ present: boolean }>("SELECT to_regclass($1) IS NOT NULL AS present", [
      PROBE_TABLE,
    ]);
    if (probe.rows[0]?.present !== true) {
      throw new DatabaseUnavailableError(unmigrated(hostAndPort(env.DATABASE_URL)));
    }
  } catch (error) {
    if (error instanceof DatabaseUnavailableError) throw error;
    const message = describeDatabaseFailure(error, env);
    if (message) throw new DatabaseUnavailableError(message);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Nothing answered at that address: the database is missing or stopped. */
function unreachable(where: string): string {
  return `Cannot reach a database at ${where}. Start Postgres (docs/development.md, Ten-minute path, step 1) or point DATABASE_URL at a running database.`;
}

/**
 * The connection worked and the server answered: the database is there, it just
 * carries none of Willder's tables. Says so in those terms, because the reader
 * has to know this is not the unreachable case before the next step makes sense.
 */
function unmigrated(where: string): string {
  return `Reached the database at ${where}, but it has no Willder tables (no "${PROBE_TABLE}" table). Run: npx prisma migrate deploy (docs/development.md, Ten-minute path, step 3).`;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const own = (error as { code?: unknown }).code;
  if (typeof own === "string") return own;
  // pg's AggregateError (one attempt per resolved address) carries the code on its members.
  const errors = (error as { errors?: unknown }).errors;
  if (Array.isArray(errors)) {
    for (const inner of errors) {
      const code = errorCode(inner);
      if (code) return code;
    }
  }
  return undefined;
}

function hostAndPort(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    return `${url.hostname || "localhost"}:${url.port || "5432"}`;
  } catch {
    return "unparseable DATABASE_URL";
  }
}
