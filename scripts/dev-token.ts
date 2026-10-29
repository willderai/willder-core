// Mint a first capability token on a fresh local install, with no Clerk.
//
// Run: bash scripts/run-check.sh scripts/dev-token.ts
// Env: DEV_TOKEN_AGENT       agent id the token is for (default local-agent)
//      DEV_TOKEN_PERMISSION  read | write (default write, so memory_ingest works)
//      DEV_TOKEN_TTL_HOURS   lifetime in hours (default 168, from 1 to 2160)
//
// Refuses to run unless DATABASE_URL points at this machine and the environment
// is not production (scripts/lib/local-database-guard.ts). The token is printed once.
import { localTargetRefusal } from "./lib/local-database-guard";
import type { LocalDevTokenOptions } from "./lib/local-dev-token";

const MAX_TTL_HOURS = 24 * 90;

function options(env: NodeJS.ProcessEnv): LocalDevTokenOptions {
  const permission = env.DEV_TOKEN_PERMISSION || "write";
  if (permission !== "read" && permission !== "write") {
    throw new Error(`DEV_TOKEN_PERMISSION must be read or write, got "${permission}"`);
  }
  const ttlHours = Number(env.DEV_TOKEN_TTL_HOURS || 168);
  if (!Number.isFinite(ttlHours) || ttlHours < 1 || ttlHours > MAX_TTL_HOURS) {
    throw new Error(`DEV_TOKEN_TTL_HOURS must be between 1 and ${MAX_TTL_HOURS}`);
  }
  return { agentId: env.DEV_TOKEN_AGENT || "local-agent", permission, ttlHours };
}

async function main() {
  const refusal = localTargetRefusal(process.env);
  if (refusal) {
    console.error(`dev-token: refusing to mint: ${refusal}. This script is for a local database only.`);
    process.exit(1);
  }
  const opts = options(process.env);
  // Imported only after the guard passes, so no connection is opened to a refused target.
  const { assertDatabaseReachable } = await import("@/lib/db-startup");
  await assertDatabaseReachable();
  const { db } = await import("@/lib/db");
  const { mintLocalDevToken } = await import("./lib/local-dev-token");
  try {
    const minted = await mintLocalDevToken(db, opts);
    console.log(
      `org ${minted.orgId}, scope ${minted.scopePath}, agent ${minted.agentId}, ${minted.permission}, expires ${minted.expiresAt.toISOString()}`,
    );
    console.log("Token (shown once, copy it now):");
    console.log(minted.token);
  } finally {
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
