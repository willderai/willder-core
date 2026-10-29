// Prove a self-hosted install works end to end, against whatever stack the environment
// names: `docker compose up` (docker-compose.yml) or your own Postgres, Neo4j and memory
// service. It prints one line per step and exits 1 when any step fails.
//
// Run: npm run selfhost:smoke
//
// The steps, each through the product's real entry points:
//   1. the database is reachable and migrated, and the memory service answers healthy;
//   2. two agent tokens are issued (scripts/lib/selfhost.ts), one per sibling scope;
//   3. write: the stdio MCP server (mcp/server.ts) stores a fact through memory_ingest;
//   4. scoped read: memory_query in that scope returns it;
//   5. out-of-scope refusal: the same token's read and write in the sibling scope are refused;
//   6. export: selfhost:export of the first scope holds its fact and not the sibling's;
//   7. external connections: none, besides the database, the memory service and the model
//      endpoint OPENAI_BASE_URL names. Every Node process the smoke starts preloads
//      scripts/lib/egress-guard.mjs, which refuses and records any other connection.
//
// It writes to its own org ("Self-host smoke test"), never the one selfhost:token made,
// and revokes its tokens when it ends. Graph extraction needs the model endpoint; without
// one the fact is still stored and readable, and the last line says how extraction went.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { selfhostTargetRefusal } from "./lib/local-database-guard";
import type { SelfhostPerson } from "./lib/selfhost";

/** Where the model endpoint is when OPENAI_BASE_URL is unset: the OpenAI SDK's own default. */
const DEFAULT_MODEL_HOST = "api.openai.com";
const MEMORY_HEALTH_TIMEOUT_MS = 10_000;

type Step = { name: string; ok: boolean; detail: string };
const steps: Step[] = [];

function report(name: string, ok: boolean, detail: string): boolean {
  steps.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}: ${detail}`);
  return ok;
}

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase() || null;
  } catch {
    return null;
  }
}

/** The hosts a self-hosted install may reach: its database, its memory service, its model endpoint. */
function allowedHosts(env: NodeJS.ProcessEnv): { hosts: string[]; modelHost: string } {
  const modelHost = hostOf(env.OPENAI_BASE_URL) ?? DEFAULT_MODEL_HOST;
  const hosts = [env.DATABASE_URL, env.DATABASE_URL_UNPOOLED, env.GRAPHITI_SERVICE_URL].map(hostOf);
  return { hosts: [...new Set([...hosts.filter((h): h is string => h !== null), modelHost])], modelHost };
}

async function memoryServiceHealth(url: string): Promise<{ ok: boolean; detail: string; extraction?: string }> {
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/health`, {
      signal: AbortSignal.timeout(MEMORY_HEALTH_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => null)) as {
      neo4j?: boolean;
      extraction?: { status?: string; reason?: string | null };
    } | null;
    if (!res.ok || !body) return { ok: false, detail: `${url}/health answered ${res.status}` };
    if (body.neo4j !== true) return { ok: false, detail: `${url} is up but cannot reach Neo4j` };
    const extraction = body.extraction?.status
      ? `${body.extraction.status}${body.extraction.reason ? ` (${body.extraction.reason})` : ""}`
      : "unknown";
    return { ok: true, detail: `${url} healthy, Neo4j reachable`, extraction };
  } catch (e) {
    return {
      ok: false,
      detail: `cannot reach the memory service at ${url} (${e instanceof Error ? e.message : e}). Start it (docker compose up -d) or set GRAPHITI_SERVICE_URL`,
    };
  }
}

type ToolResult = { isError?: boolean; content?: { type: string; text?: string }[] };
const textOf = (result: ToolResult): string => (result.content ?? []).map((c) => c.text ?? "").join("\n");

/** How the smoke starts the product's own processes: tsx from the repository root, the egress guard preloaded. */
type Launch = { tsxCli: string; repoRoot: string; childEnv: NodeJS.ProcessEnv };

/** One smoke run's two sibling scopes, their tokens and the fact each will hold. */
type SmokeScopes = {
  run: string;
  alpha: string;
  beta: string;
  alphaRel: string;
  betaRel: string;
  alphaToken: string;
  betaToken: string;
  alphaFact: string;
  betaFact: string;
};

/**
 * Exit 1 before anything is touched when the environment is not a self-hosted install the smoke
 * may write to: a production target, a missing variable, or Inngest not bypassed.
 */
async function refuseUnsafeTarget(): Promise<void> {
  const refusal = selfhostTargetRefusal(process.env);
  if (refusal) {
    console.error(`selfhost:smoke: refusing to run: ${refusal}.`);
    process.exit(1);
  }
  const { STDIO_MCP_ENV, missingEnvMessage } = await import("@/lib/required-env");
  const missing = missingEnvMessage(STDIO_MCP_ENV.filter((v) => v.name !== "WILLDER_CAPABILITY_TOKEN"));
  if (missing) {
    console.error(`selfhost:smoke: ${missing}`);
    process.exit(1);
  }
  if (process.env.INNGEST_BYPASS !== "1") {
    console.error(
      "selfhost:smoke: INNGEST_BYPASS is not 1. A self-hosted install writes memory inline, without Inngest; set INNGEST_BYPASS=1 in .env (docs/self-host.md).",
    );
    process.exit(1);
  }
}

/**
 * Load the egress guard into this process and into every process it starts (`childEnv`), allowing
 * only the install's own hosts. Refused connections are recorded in `egressLog`, inside `scratch`.
 */
async function startEgressGuard(): Promise<{
  scratch: string;
  egressLog: string;
  hosts: string[];
  modelHost: string;
  launch: Launch;
}> {
  const scratch = await mkdtemp(path.join(tmpdir(), "willder-selfhost-smoke-"));
  const egressLog = path.join(scratch, "egress.jsonl");
  const { hosts, modelHost } = allowedHosts(process.env);
  process.env.SELFHOST_EGRESS_ALLOW = hosts.join(",");
  process.env.SELFHOST_EGRESS_LOG = egressLog;
  const guard = pathToFileURL(path.join(__dirname, "lib", "egress-guard.mjs")).href;
  await import(guard);
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${guard}`.trim(),
  };
  const launch = {
    tsxCli: createRequire(__filename).resolve("tsx/cli"),
    repoRoot: path.resolve(__dirname, ".."),
    childEnv,
  };
  return { scratch, egressLog, hosts, modelHost, launch };
}

/** Step 1: the database is reachable and migrated, and the memory service is healthy. */
async function checkStack(assertDatabaseReachable: () => Promise<void>): Promise<boolean> {
  try {
    await assertDatabaseReachable();
    report("database", true, `reachable and migrated (${hostOf(process.env.DATABASE_URL)})`);
  } catch (e) {
    report("database", false, e instanceof Error ? e.message : String(e));
    return false;
  }
  const health = await memoryServiceHealth(process.env.GRAPHITI_SERVICE_URL!);
  return report("memory service", health.ok, health.detail);
}

/**
 * Step 2: two sibling scopes of a fresh run in the smoke's own org, and a write token for each.
 * Every token issued is pushed onto `issued.ids`, and `issued.by` records the operator that
 * issued them, so they are revoked however the smoke ends.
 */
async function issueScopedTokens(issued: { ids: string[]; by: SelfhostPerson | null }): Promise<SmokeScopes> {
  const { ensureScope, ensureSelfhostOperator, issueSelfhostToken, scopePathIn } = await import("./lib/selfhost");
  const operator = await ensureSelfhostOperator("smoke");
  issued.by = operator;
  const run = `run_${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}_${randomBytes(3).toString("hex")}`;
  const alphaRel = `${run}.alpha`;
  const betaRel = `${run}.beta`;
  const alpha = scopePathIn(operator.orgId, alphaRel);
  const beta = scopePathIn(operator.orgId, betaRel);
  await ensureScope(operator, alpha);
  await ensureScope(operator, beta);
  const tokenFor = async (agent: string, scopePath: string) => {
    const token = await issueSelfhostToken(operator, { agent, scopePath, permission: "write", ttlHours: 1 });
    issued.ids.push(token.id);
    return token.token;
  };
  // Agent ids are per run too: an agent that read the last run's fact may not write it
  // into this run's scope (derived_write), so a fixed id fails every run after the first.
  const alphaToken = await tokenFor(`smoke-alpha-${run}`, alpha);
  const betaToken = await tokenFor(`smoke-beta-${run}`, beta);
  report("tokens", true, `issued write tokens for ${alphaRel} and ${betaRel} as ${operator.email}`);
  return {
    run,
    alpha,
    beta,
    alphaRel,
    betaRel,
    alphaToken,
    betaToken,
    alphaFact: `Self-host smoke ${run}: the alpha team ships on Thursdays.`,
    betaFact: `Self-host smoke ${run}: the beta team ships on Mondays.`,
  };
}

/** Connects to the stdio MCP server (mcp/server.ts) as a token; the server's stderr is collected in `serverLog`. */
async function mcpClientAs(
  token: string,
  { tsxCli, repoRoot, childEnv }: Launch,
  serverLog: string[],
): Promise<Client> {
  const { Client: McpClient } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsxCli, "mcp/server.ts"],
    cwd: repoRoot,
    env: { ...childEnv, WILLDER_CAPABILITY_TOKEN: token } as Record<string, string>,
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk: Buffer) => serverLog.push(chunk.toString()));
  const client = new McpClient({ name: "selfhost-smoke", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

/**
 * Steps 3 to 5, and the sibling write the export must leave out: the alpha token writes and reads
 * its fact and is refused in the beta scope; the beta token writes the beta fact.
 */
async function runWriteReadRefuseChecks(scopes: SmokeScopes, launch: Launch, serverLog: string[]): Promise<void> {
  const { run, alpha, beta, alphaRel, betaRel, alphaFact, betaFact } = scopes;
  const alphaClient = await mcpClientAs(scopes.alphaToken, launch, serverLog);
  try {
    const write = (await alphaClient.callTool({
      name: "memory_ingest",
      arguments: { content: alphaFact, name: "Alpha team", scopePath: alpha },
    })) as ToolResult;
    const writeText = textOf(write);
    const stored = !write.isError && /Version: \S+/.test(writeText);
    report(
      "write",
      stored,
      stored
        ? `memory_ingest stored the fact in ${alphaRel} (${writeText.match(/Version: \S+?(?=\.|$)/)?.[0]})`
        : writeText,
    );

    const read = (await alphaClient.callTool({
      name: "memory_query",
      arguments: { query: alphaFact, scopePath: alpha },
    })) as ToolResult;
    const found = !read.isError && textOf(read).includes(alphaFact);
    report(
      "scoped read",
      found,
      found
        ? `memory_query in ${alphaRel} returned the fact`
        : `memory_query in ${alphaRel} did not return it: ${textOf(read).slice(0, 300)}`,
    );

    const outRead = (await alphaClient.callTool({
      name: "memory_query",
      arguments: { query: betaFact, scopePath: beta },
    })) as ToolResult;
    const outWrite = (await alphaClient.callTool({
      name: "memory_ingest",
      arguments: {
        content: `Self-host smoke ${run}: written where it may not be.`,
        name: "Beta team",
        scopePath: beta,
      },
    })) as ToolResult;
    const refused = (r: ToolResult) => r.isError === true && textOf(r).startsWith("Access denied");
    report(
      "out-of-scope refusal",
      refused(outRead) && refused(outWrite),
      refused(outRead) && refused(outWrite)
        ? `the ${alphaRel} token's read and write in ${betaRel} were refused`
        : `expected Access denied in ${betaRel}; read: ${textOf(outRead).slice(0, 200)}; write: ${textOf(outWrite).slice(0, 200)}`,
    );
  } finally {
    await alphaClient.close();
  }

  const betaClient = await mcpClientAs(scopes.betaToken, launch, serverLog);
  try {
    const write = (await betaClient.callTool({
      name: "memory_ingest",
      arguments: { content: betaFact, name: "Beta team", scopePath: beta },
    })) as ToolResult;
    report(
      "sibling write",
      !write.isError,
      write.isError ? textOf(write) : `memory_ingest stored a second fact in ${betaRel}, for the export to leave out`,
    );
  } finally {
    await betaClient.close();
  }
}

/** Run selfhost:export as its own process; its exit code and stderr. */
function runExport(
  { tsxCli, repoRoot, childEnv }: Launch,
  scopeRel: string,
  exportFile: string,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [tsxCli, "scripts/selfhost-export.ts", "--org", "smoke", "--scope", scopeRel, "--out", exportFile],
      {
        cwd: repoRoot,
        env: childEnv,
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

/** Step 6: selfhost:export of the alpha scope holds the alpha fact, not the beta one, in the export format. */
async function runExportCheck(
  { alphaRel, alphaFact, betaFact }: SmokeScopes,
  launch: Launch,
  scratch: string,
): Promise<void> {
  const exportFile = path.join(scratch, "export.jsonl");
  const exported = await runExport(launch, alphaRel, exportFile);
  if (exported.code !== 0) {
    report("export", false, `selfhost:export exited ${exported.code}: ${exported.stderr.trim()}`);
    return;
  }
  const records = (await readFile(exportFile, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const manifest = records[0];
  const end = records.at(-1) as { type?: string; counts?: { fact?: number } };
  const facts = records.filter((r) => r.type === "fact");
  const problems = [
    manifest?.type === "manifest" && manifest.format === "willder-export" ? null : "no willder-export manifest first",
    JSON.stringify(manifest?.scopes) === JSON.stringify([alphaRel])
      ? null
      : `manifest scopes ${JSON.stringify(manifest?.scopes)}`,
    facts.some((f) => f.content === alphaFact) ? null : "the fact is missing",
    facts.some((f) => f.content === betaFact) ? `the sibling scope's fact leaked into it` : null,
    end?.type === "end" && end.counts?.fact === facts.length ? null : "the end record's counts do not match",
  ].filter((p): p is string => p !== null);
  report(
    "export",
    problems.length === 0,
    problems.length === 0
      ? `selfhost:export of ${alphaRel}: ${facts.length} fact(s), its own only, in the docs/export-format.md format`
      : problems.join("; "),
  );
}

/** Step 7: the egress guard refused no connection, in this process or any it started. */
async function reportExternalConnections(egressLog: string, hosts: string[], modelHost: string): Promise<void> {
  const refusedHosts = await readFile(egressLog, "utf8").catch(() => "");
  const reached = [
    ...new Set(
      refusedHosts
        .split("\n")
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { host: string }).host),
    ),
  ];
  report(
    "external connections",
    reached.length === 0,
    reached.length === 0
      ? `none besides ${hosts.join(", ")} (model endpoint: ${modelHost}${process.env.OPENAI_BASE_URL ? "" : ", OPENAI_BASE_URL unset"})`
      : `refused connections to ${reached.join(", ")}`,
  );
}

async function main() {
  await refuseUnsafeTarget();

  // From here on, this process and every process it starts refuse any other host.
  const { scratch, egressLog, hosts, modelHost, launch } = await startEgressGuard();
  const { assertDatabaseReachable } = await import("@/lib/db-startup");
  const { db } = await import("@/lib/db");
  /** The tokens this run issued, and who issued them and so revokes them at the end. */
  const issued: { ids: string[]; by: SelfhostPerson | null } = { ids: [], by: null };
  try {
    if (!(await checkStack(assertDatabaseReachable))) return;
    const scopes = await issueScopedTokens(issued);
    const serverLog: string[] = [];
    await runWriteReadRefuseChecks(scopes, launch, serverLog);
    await runExportCheck(scopes, launch, scratch);
    await reportExternalConnections(egressLog, hosts, modelHost);
    const after = await memoryServiceHealth(process.env.GRAPHITI_SERVICE_URL!);
    console.log(
      `note  graph extraction: ${after.extraction ?? "unknown"}; it needs the model endpoint at ${modelHost}, and a stored fact is readable either way`,
    );
    if (steps.some((s) => !s.ok) && serverLog.length > 0) {
      console.log("\nMCP server log:\n" + serverLog.join("").trim());
    }
  } catch (e) {
    report("smoke", false, `stopped: ${e instanceof Error ? e.message : e}`);
  } finally {
    if (issued.by && issued.ids.length > 0) {
      const { revokeSelfhostTokens } = await import("./lib/selfhost");
      await revokeSelfhostTokens(issued.by, issued.ids);
    }
    await db.$disconnect();
    await rm(scratch, { recursive: true, force: true });
    const failed = steps.filter((s) => !s.ok).length;
    console.log(
      failed === 0
        ? `\n${steps.length} of ${steps.length} steps passed`
        : `\n${failed} of ${steps.length} steps failed`,
    );
    process.exitCode = failed === 0 && steps.length > 0 ? 0 : 1;
  }
}

main().catch((e) => {
  console.error(`selfhost:smoke failed: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
