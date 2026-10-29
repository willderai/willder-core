// Refuses anything but a database on this machine, outside production.
//
// Kept free of imports so a caller can check it before loading any module that
// creates a database client.

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const DATABASE_URL_VARS = ["DATABASE_URL", "DATABASE_URL_UNPOOLED"] as const;

/**
 * Why a local-only script must not run in this environment, or null when it may.
 * Refuses a production or Vercel environment, a missing DATABASE_URL, and any
 * database URL whose host is not this machine. A `host` query parameter would
 * override the URL's host in node-postgres, so its presence is refused too.
 */
export function localTargetRefusal(env: Record<string, string | undefined>): string | null {
  if (env.NODE_ENV === "production") return "NODE_ENV is production";
  if (env.VERCEL || env.VERCEL_ENV) return "this is a Vercel environment";
  if (!env.DATABASE_URL) return "DATABASE_URL is not set";

  for (const name of DATABASE_URL_VARS) {
    const value = env[name];
    if (!value) continue;
    const refusal = nonLocalUrlRefusal(name, value);
    if (refusal) return refusal;
  }
  return null;
}

/**
 * Why a database URL read from a local `.env` file must not be used, or null when
 * it may. Only a value still in effect is checked: a variable already set in the
 * environment wins over the file (Node's --env-file never overrides one), and a URL
 * set that way is the caller's explicit choice, not a leftover in a local file.
 */
export function envFileDatabaseRefusal(
  fileVars: Record<string, string | undefined>,
  env: Record<string, string | undefined>,
): string | null {
  for (const name of DATABASE_URL_VARS) {
    const value = fileVars[name];
    if (!value || env[name] !== value) continue;
    const refusal = nonLocalUrlRefusal(name, value);
    if (refusal) return refusal;
  }
  return null;
}

/** The flag that lets the self-host scripts use a database on another machine. */
export const SELFHOST_REMOTE_DB_FLAG = "WILLDER_SELFHOST_ALLOW_REMOTE_DB";

/**
 * Why a self-host script (`npm run selfhost:token`, `selfhost:export`, `selfhost:smoke`)
 * must not run in this environment, or null when it may.
 *
 * The same refusals as {@link localTargetRefusal}, with one difference: a database on
 * another machine is allowed when {@link SELFHOST_REMOTE_DB_FLAG} is exactly `1`, for a
 * self-hosted Postgres that does not run beside the scripts. Nothing lifts the rest: a
 * production or Vercel environment, or a live Clerk key (`sk_live_` or `pk_live_`, which
 * only a hosted deployment holds), is refused with the flag set too, and so is a `host` query
 * parameter. Any other value of the flag is refused rather than read as yes or no.
 */
export function selfhostTargetRefusal(env: Record<string, string | undefined>): string | null {
  if (env.NODE_ENV === "production") return "NODE_ENV is production";
  if (env.VERCEL || env.VERCEL_ENV) return "this is a Vercel environment";
  if (env.CLERK_SECRET_KEY?.trim().startsWith("sk_live_")) return "CLERK_SECRET_KEY is a production Clerk key";
  if (env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim().startsWith("pk_live_")) {
    return "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is a production Clerk key";
  }
  if (!env.DATABASE_URL) return "DATABASE_URL is not set";

  const flag = env[SELFHOST_REMOTE_DB_FLAG];
  if (flag !== undefined && flag !== "" && flag !== "1") {
    return `${SELFHOST_REMOTE_DB_FLAG} must be 1 or unset, got "${flag}"`;
  }
  for (const name of DATABASE_URL_VARS) {
    const value = env[name];
    if (!value) continue;
    const anywhere = nonLocalUrlRefusal(name, value, { allowRemote: true });
    if (anywhere) return anywhere;
    const here = nonLocalUrlRefusal(name, value);
    if (here && flag !== "1") return `${here}; set ${SELFHOST_REMOTE_DB_FLAG}=1 to use a database on another machine`;
  }
  return null;
}

/** Why `value` is refused as a database URL; `allowRemote` skips only the this-machine check. */
function nonLocalUrlRefusal(name: string, value: string, { allowRemote = false } = {}): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `${name} is not a valid URL`;
  }
  if (!allowRemote && !LOCAL_HOSTS.has(url.hostname))
    return `${name} points at ${url.hostname || "no host"}, not this machine`;
  if (url.searchParams.has("host")) return `${name} sets a host query parameter`;
  return null;
}
