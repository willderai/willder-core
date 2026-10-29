// The environment variables a Willder process cannot start without, and the one
// check every entry point runs before doing anything else.
//
// The one rule: a missing required variable stops the process with a single line
// that names the variable and how to set it. It never surfaces later as a stack
// trace from whichever library first reads the empty value (node-postgres quietly
// falling back to a database named after the OS user, a memory-service call with
// an empty bearer, an MCP client handshake that just closes).
//
// docs/environment.md's Boot table is the classified list; lib/required-env.test.ts
// reads that table and fails if it and this file disagree.

/** A variable a process needs at startup, and the one line telling a reader how to set it. */
export interface RequiredEnvVar {
  name: string;
  /** The whole message printed when the variable is missing: what is unset and what to do. */
  fix: string;
  /** Required only when NODE_ENV is "production" (local development has a working fallback). */
  productionOnly?: boolean;
}

const DATABASE_URL: RequiredEnvVar = {
  name: "DATABASE_URL",
  fix: "DATABASE_URL is not set. Copy .env.example to .env and fill it in (docs/development.md, Ten-minute path).",
};

const GRAPHITI_SERVICE_URL: RequiredEnvVar = {
  name: "GRAPHITI_SERVICE_URL",
  fix: "GRAPHITI_SERVICE_URL is not set. Set it to the memory service's address, http://localhost:8000 locally, as .env.example does.",
};

const GRAPHITI_SERVICE_API_KEY: RequiredEnvVar = {
  name: "GRAPHITI_SERVICE_API_KEY",
  fix: "GRAPHITI_SERVICE_API_KEY is not set. Set it to any string, the same value as in memory-service/.env (docs/development.md, Ten-minute path, step 2).",
};

const WILLDER_CAPABILITY_TOKEN: RequiredEnvVar = {
  name: "WILLDER_CAPABILITY_TOKEN",
  fix: "WILLDER_CAPABILITY_TOKEN is not set. Mint a local token with: bash scripts/run-check.sh scripts/dev-token.ts (docs/development.md, Ten-minute path, step 4).",
};

// Clerk runs in keyless mode under `next dev`, so only a production server needs these.
const CLERK_PUBLISHABLE_KEY: RequiredEnvVar = {
  name: "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  fix: "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is not set. Copy it from your Clerk instance's API keys page (docs/environment.md, Boot).",
  productionOnly: true,
};

const CLERK_SECRET_KEY: RequiredEnvVar = {
  name: "CLERK_SECRET_KEY",
  fix: "CLERK_SECRET_KEY is not set. Copy it from your Clerk instance's API keys page (docs/environment.md, Boot).",
  productionOnly: true,
};

/** What the stdio MCP server (`npm run mcp`) needs before it can answer a call. */
export const STDIO_MCP_ENV: readonly RequiredEnvVar[] = [
  DATABASE_URL,
  GRAPHITI_SERVICE_URL,
  GRAPHITI_SERVICE_API_KEY,
  WILLDER_CAPABILITY_TOKEN,
];

/** What the web server (`npm run dev`, `next start`, the hosted `/api/mcp`) needs. */
export const WEB_SERVER_ENV: readonly RequiredEnvVar[] = [
  DATABASE_URL,
  GRAPHITI_SERVICE_URL,
  GRAPHITI_SERVICE_API_KEY,
  CLERK_PUBLISHABLE_KEY,
  CLERK_SECRET_KEY,
];

/** Every variable some entry point requires; one entry per name. */
export const REQUIRED_ENV: readonly RequiredEnvVar[] = [...new Set([...STDIO_MCP_ENV, ...WEB_SERVER_ENV])];

/**
 * The one line to print when any of `vars` is missing from `env`, or null when all are
 * set. A blank or whitespace-only value counts as missing, because .env.example ships
 * blanks. One missing variable gets its own fix; several are named together, so a reader
 * fixes them in one pass instead of one restart per variable.
 */
export function missingEnvMessage(
  vars: readonly RequiredEnvVar[],
  env: Record<string, string | undefined> = process.env,
): string | null {
  const production = env.NODE_ENV === "production";
  const missing = vars.filter((v) => (production || !v.productionOnly) && !env[v.name]?.trim());
  if (missing.length === 0) return null;
  if (missing.length === 1) return missing[0].fix;
  const names = missing.map((v) => v.name).join(", ");
  return `${names} are not set. Copy .env.example to .env and fill them in; docs/environment.md says what each one is.`;
}

/** Thrown by {@link assertRequiredEnv}; `message` is the one line to print. */
export class MissingEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingEnvError";
  }
}

/** Throw {@link MissingEnvError} when any of `vars` is missing from `env`. */
export function assertRequiredEnv(
  vars: readonly RequiredEnvVar[],
  env: Record<string, string | undefined> = process.env,
): void {
  const message = missingEnvMessage(vars, env);
  if (message) throw new MissingEnvError(message);
}

/**
 * The web server's startup check, for a hook with no caller to throw to. When any of
 * `vars` is missing it prints one line to stderr, then:
 *
 * - on a server you started yourself (`next dev`, `next start`, a container), exits 1,
 *   so the reader sees the line instead of a "Ready" server failing every request;
 * - on Vercel (the platform sets `VERCEL=1` at build and run time), returns. There a
 *   startup hook runs inside each function instance, so exiting does not stop a
 *   deployment: it fails every request routed to that instance, pages that never read
 *   the missing variable included. The deployment stays up, degraded, and the line is
 *   in its runtime logs.
 */
export function checkServerStartupEnv(
  vars: readonly RequiredEnvVar[],
  label: string,
  env: Record<string, string | undefined> = process.env,
): void {
  const message = missingEnvMessage(vars, env);
  if (!message) return;
  if (env.VERCEL) {
    console.error(`${label} is running without required environment: ${message}`);
    return;
  }
  console.error(`${label} failed: ${message}`);
  process.exit(1);
}
