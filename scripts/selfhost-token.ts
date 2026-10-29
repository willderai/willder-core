// Bootstrap a self-hosted install and mint an agent token, with no Clerk and no willder.ai
// account: the self-host org, its operator, the scope you name, and one capability token
// for one agent on that scope, issued by the operator through the product's own rules.
// Or take an agent's tokens back: --revoke refuses each one on its next call.
//
// Run: npm run selfhost:token -- [--agent <name>] [--scope <path>] [--permission read|write] [--ttl-hours <hours>]
//   --agent       the agent the token is for (default local-agent)
//   --scope       a scope below the org root, like team or team.alpha, created if missing
//                 (default: the org root)
//   --permission  read or write (default write, so memory_ingest works)
//   --ttl-hours   lifetime, 1 to 2160 (default 168)
//
// Run: npm run selfhost:token -- --revoke <agent> [--scope <path>]
//   --revoke      revoke every live token of this agent in the self-host org, audited as the
//                 web app's revoke is; give it once
//   --scope       only its tokens for exactly this scope
//
// Refuses a production or Vercel environment, a live Clerk key, and a database on another
// machine unless WILLDER_SELFHOST_ALLOW_REMOTE_DB=1 (scripts/lib/local-database-guard.ts).
// The token is printed once; --revoke prints what it revoked, never a token. docs/self-host.md
// is the walkthrough.
import { parseArgs } from "node:util";
import { selfhostTargetRefusal } from "./lib/local-database-guard";

const USAGE = [
  "usage: npm run selfhost:token -- [--agent <name>] [--scope <path>] [--permission read|write] [--ttl-hours <hours>]",
  "       npm run selfhost:token -- --revoke <agent> [--scope <path>]",
].join("\n");
const MAX_TTL_HOURS = 24 * 90;

interface IssueArgs {
  mode: "issue";
  agent: string;
  scope: string;
  permission: "read" | "write";
  ttlHours: number;
}

interface RevokeArgs {
  mode: "revoke";
  agent: string;
  /** Relative to the org root, like the issue mode's; undefined revokes at every scope. */
  scope: string | undefined;
}

function tokenArgs(argv: string[]): IssueArgs | RevokeArgs {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      agent: { type: "string" },
      scope: { type: "string" },
      permission: { type: "string" },
      "ttl-hours": { type: "string" },
      revoke: { type: "string", multiple: true },
    },
  });
  if (values.revoke !== undefined) return revokeArgs(values);
  const agent = (values.agent ?? "local-agent").trim();
  if (!agent) throw new Error("--agent must name an agent");
  const permission = values.permission ?? "write";
  if (permission !== "read" && permission !== "write") {
    throw new Error(`--permission must be read or write, got "${permission}"`);
  }
  const ttl = values["ttl-hours"] ?? "168";
  const ttlHours = /^\d+$/.test(ttl) ? Number(ttl) : NaN;
  if (!(ttlHours >= 1 && ttlHours <= MAX_TTL_HOURS)) {
    throw new Error(`--ttl-hours must be a whole number from 1 to ${MAX_TTL_HOURS}, got "${ttl}"`);
  }
  return { mode: "issue", agent, scope: (values.scope ?? "").trim(), permission, ttlHours };
}

function revokeArgs(values: {
  revoke?: string[];
  agent?: string;
  scope?: string;
  permission?: string;
  "ttl-hours"?: string;
}): RevokeArgs {
  if ((values.revoke ?? []).length > 1) throw new Error("--revoke names one agent; run it once per agent");
  const agent = (values.revoke?.[0] ?? "").trim();
  if (!agent) throw new Error("--revoke must name an agent");
  const extra = (["agent", "permission", "ttl-hours"] as const).filter((name) => values[name] !== undefined);
  if (extra.length > 0)
    throw new Error(`--revoke takes only --scope, not ${extra.map((name) => `--${name}`).join(", ")}`);
  return { mode: "revoke", agent, scope: values.scope?.trim() };
}

async function issue(args: IssueArgs): Promise<void> {
  const { ensureScope, ensureSelfhostOperator, issueSelfhostToken, scopePathIn } = await import("./lib/selfhost");
  const operator = await ensureSelfhostOperator("default");
  const scopePath = scopePathIn(operator.orgId, args.scope);
  await ensureScope(operator, scopePath);
  const token = await issueSelfhostToken(operator, {
    agent: args.agent,
    scopePath,
    permission: args.permission,
    ttlHours: args.ttlHours,
  });
  console.log(
    `self-host org ${operator.orgId}, scope ${token.scopePath}, agent ${token.agentId}, ${token.permission}, expires ${token.expiresAt.toISOString()}`,
  );
  console.log("Token (shown once, copy it now):");
  console.log(token.token);
}

/** Revokes the agent's live tokens as the operator, and prints each one it revoked. Throws when there are none. */
async function revoke(args: RevokeArgs): Promise<void> {
  const { liveSelfhostTokens, revokeSelfhostTokens, scopePathIn, selfhostPerson } = await import("./lib/selfhost");
  const operator = await selfhostPerson("default");
  const scopePath = args.scope === undefined ? undefined : scopePathIn(operator.orgId, args.scope);
  const live = await liveSelfhostTokens(operator, args.agent, scopePath);
  if (live.length === 0) {
    throw new Error(
      `no live token for agent "${args.agent}"${scopePath ? ` in scope ${scopePath}` : ""} in self-host org ${operator.orgId}; nothing was revoked`,
    );
  }
  // What the revoke changed, not what was read before it: a token revoked meanwhile is not claimed.
  const revoked = await revokeSelfhostTokens(
    operator,
    live.map((token) => token.id),
  );
  console.log(`self-host org ${operator.orgId}: revoked ${revoked.length} token(s) of agent ${args.agent}`);
  for (const token of revoked) {
    console.log(
      `  ${token.id}  scope ${token.scopePath}, ${token.permission}, was to expire ${token.expiresAt.toISOString()}`,
    );
  }
  console.log("Each one is refused on its next call, and the refusal is in the audit log (npm run selfhost:export).");
}

async function main() {
  const refusal = selfhostTargetRefusal(process.env);
  if (refusal) {
    console.error(`selfhost:token: refusing to run: ${refusal}.`);
    process.exit(1);
  }
  let args: IssueArgs | RevokeArgs;
  try {
    args = tokenArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`selfhost:token: ${e instanceof Error ? e.message : e}\n${USAGE}`);
    process.exit(1);
  }
  // Imported only after the guard passes, so no connection is opened to a refused target.
  const { assertDatabaseReachable } = await import("@/lib/db-startup");
  await assertDatabaseReachable();
  const { db } = await import("@/lib/db");
  try {
    await (args.mode === "revoke" ? revoke(args) : issue(args));
  } finally {
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(`selfhost:token failed: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
