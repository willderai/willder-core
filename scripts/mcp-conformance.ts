// MCP client conformance check, server half.
//
// Proves that the hosted endpoint answers the way every client class below needs it to, so a connect page under
// `docs/connect/` can claim "verified by script" instead of "probably works":
//
//   1. header clients   — Streamable HTTP with `Authorization: Bearer <token>`:
//                         `tools/list` carries the real tool names, and one
//                         scoped `memory_query` returns without an error.
//   2. any client       — a missing token and a wrong token are both 401.
//   3. legacy SSE       — a GET is answered 200 `text/event-stream` (the
//                         Streamable HTTP stream) with no `endpoint` event, so
//                         clients that default to SSE cannot finish a
//                         handshake and must set their transport explicitly.
//                         A 405 passes too; both mean "no legacy SSE here".
//   4. bridge clients   — the same HTTP checks again through the pinned
//                         `mcp-remote` stdio bridge, which is how Zed, Cline,
//                         LM Studio and OpenClaw reach the endpoint.
//
// Every failure names the client class it breaks, because that is the thing a
// reader has to act on. Exit code is 0 only when every required step passed.
//
// Run:
//   WILLDER_MCP_URL=https://willder.ai/api/mcp WILLDER_TOKEN=... \
//     npx tsx scripts/mcp-conformance.ts
//
// Flags:
//   --expect-sse=unsupported   (default) a 405 or a handshake-less event stream passes
//   --expect-sse=supported     legacy SSE must connect and list tools
//   --skip-bridge              skip the stdio bridge step (reported as skipped)
//
// The URL and the token come from the environment only. There is no default
// endpoint: a conformance run must say out loud what it is pointing at.
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/** The `mcp-remote` release the bridge configs under `docs/connect/` pin. */
export const BRIDGE_PACKAGE = "mcp-remote@0.14.3";

/** Tool names every client must see in `tools/list`. */
/** How long a legacy SSE connect attempt may hang before it counts as a failure. */
export const SSE_CONNECT_TIMEOUT_MS = 15_000;

export const REQUIRED_TOOLS = ["memory_query", "memory_entity", "memory_ingest"] as const;

/** Client classes, named so a failure message tells a reader who just broke. */
export const CLIENT_CLASSES = {
  header:
    "header clients (Claude Code, Codex CLI, Cursor, Windsurf, Continue, Hermes, Open WebUI, Goose, Gemini CLI, VS Code Copilot, LangChain, OpenAI Agents SDK, Vercel AI SDK)",
  anyClient: "every client (authentication)",
  legacySse: "clients that default to legacy SSE (Cline, OpenClaw)",
  bridge: "bridge clients (Zed, Cline, LM Studio, OpenClaw, Claude Desktop local config)",
} as const;

export type ClientClass = (typeof CLIENT_CLASSES)[keyof typeof CLIENT_CLASSES];

/** The subset of the MCP SDK client this check uses, so tests can substitute one. */
export interface ConformanceClient {
  listTools(): Promise<{ tools: Array<{ name: string }> }>;
  callTool(request: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<{ isError?: boolean; content?: unknown }>;
  close(): Promise<void>;
}

/** Everything that touches the network, injected so the unit tests need none of it. */
export interface ConformanceDeps {
  connectHttp(url: string, token: string): Promise<ConformanceClient>;
  connectSse(url: string, token: string): Promise<ConformanceClient>;
  connectBridge(url: string, token: string): Promise<ConformanceClient>;
  /** Used for the unauthenticated probes and for reading the GET status code. */
  fetch: typeof fetch;
  now(): number;
}

export interface ConformanceOptions {
  url: string;
  token: string;
  expectSse: "unsupported" | "supported";
  skipBridge: boolean;
}

export type StepStatus = "pass" | "fail" | "skip";

export interface StepResult {
  step: string;
  clientClass: ClientClass;
  status: StepStatus;
  detail: string;
  ms: number;
}

export interface ConformanceReport {
  url: string;
  steps: StepResult[];
  ok: boolean;
}

/** Thrown for a missing or malformed environment, so main() can exit cleanly. */
export class ConformanceConfigError extends Error {}

/**
 * Read the endpoint and token from the environment. Neither has a default: a
 * run that silently pointed at localhost would be worse than no run at all.
 */
export function readOptions(
  env: Readonly<Record<string, string | undefined>>,
  argv: readonly string[],
): ConformanceOptions {
  const url = env.WILLDER_MCP_URL?.trim();
  if (!url) {
    throw new ConformanceConfigError(
      "WILLDER_MCP_URL is not set. Set it to the MCP endpoint to check, for example https://willder.ai/api/mcp. There is no default.",
    );
  }
  try {
    new URL(url);
  } catch {
    throw new ConformanceConfigError(`WILLDER_MCP_URL is not a valid URL: ${url}`);
  }
  const token = env.WILLDER_TOKEN?.trim();
  if (!token) {
    throw new ConformanceConfigError(
      "WILLDER_TOKEN is not set. Set it to a capability token for the scope you are checking. There is no default.",
    );
  }

  let expectSse: ConformanceOptions["expectSse"] = "unsupported";
  for (const arg of argv) {
    if (arg.startsWith("--expect-sse=")) {
      const value = arg.slice("--expect-sse=".length);
      if (value !== "unsupported" && value !== "supported") {
        throw new ConformanceConfigError(`--expect-sse must be "unsupported" or "supported", got "${value}"`);
      }
      expectSse = value;
    }
  }
  return { url, token, expectSse, skipBridge: argv.includes("--skip-bridge") };
}

/**
 * What the endpoint does with the GET a legacy SSE client opens.
 *
 * `not-served` is a 405: the clean "this transport does not exist here".
 * `stream-opened` is the Streamable HTTP server-to-client stream, which answers
 * 200 with `text/event-stream` but never sends the `endpoint` event the
 * deprecated HTTP+SSE protocol begins with, so a legacy SSE client still cannot
 * complete a handshake. Anything else is a real problem worth failing on.
 */
export type LegacySseDisposition = "not-served" | "stream-opened" | "unexpected";

export function classifyLegacySse(status: number, contentType: string | null): LegacySseDisposition {
  if (status === 405) return "not-served";
  if (status === 200 && (contentType ?? "").includes("text/event-stream")) return "stream-opened";
  return "unexpected";
}

/** Reject rather than hang if a probe opens a stream and then says nothing. */
async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function missingTools(tools: Array<{ name: string }>): string[] {
  const present = new Set(tools.map((tool) => tool.name));
  return REQUIRED_TOOLS.filter((name) => !present.has(name));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run `tools/list` and one scoped `memory_query` against an already-connected
 * client. Shared by the direct HTTP path and the stdio bridge path, so the
 * bridge is held to the same bar rather than merely being reachable.
 */
async function checkToolSurface(client: ConformanceClient): Promise<{ ok: boolean; detail: string }> {
  const { tools } = await client.listTools();
  const absent = missingTools(tools);
  if (absent.length > 0) {
    return { ok: false, detail: `tools/list is missing ${absent.join(", ")}` };
  }
  const result = await client.callTool({
    name: "memory_query",
    arguments: { query: "mcp conformance probe", limit: 1 },
  });
  if (result.isError === true) {
    return { ok: false, detail: `memory_query returned an error: ${JSON.stringify(result.content)}` };
  }
  return {
    ok: true,
    detail: `tools/list has ${tools.length} tools including ${REQUIRED_TOOLS.join(", ")}; memory_query returned without an error`,
  };
}

async function initializeStatus(deps: ConformanceDeps, url: string, authorization?: string): Promise<number> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (authorization) headers.authorization = authorization;
  const response = await deps.fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "willder-mcp-conformance", version: "1.0.0" },
      },
    }),
  });
  return response.status;
}

/** The GET a legacy SSE client opens first, with the bearer header attached. */
async function legacySseGet(
  deps: ConformanceDeps,
  url: string,
  token: string,
): Promise<{ status: number; contentType: string | null }> {
  const response = await deps.fetch(url, {
    method: "GET",
    headers: { accept: "text/event-stream", authorization: `Bearer ${token}` },
  });
  const contentType = response.headers.get("content-type");
  await response.body?.cancel().catch(() => {});
  return { status: response.status, contentType };
}

/** Run one step, timing it and turning a thrown error into a failed result. */
async function step(
  deps: ConformanceDeps,
  name: string,
  clientClass: ClientClass,
  body: () => Promise<{ ok: boolean; detail: string }>,
): Promise<StepResult> {
  const started = deps.now();
  try {
    const { ok, detail } = await body();
    return { step: name, clientClass, status: ok ? "pass" : "fail", detail, ms: deps.now() - started };
  } catch (error) {
    return { step: name, clientClass, status: "fail", detail: describe(error), ms: deps.now() - started };
  }
}

/** Run the whole matrix check. Never throws for a conformance failure; see `report.ok`. */
export async function runConformance(options: ConformanceOptions, deps: ConformanceDeps): Promise<ConformanceReport> {
  const { url, token } = options;
  const steps: StepResult[] = [];

  steps.push(
    await step(deps, "streamable-http tool surface", CLIENT_CLASSES.header, async () => {
      const client = await deps.connectHttp(url, token);
      try {
        return await checkToolSurface(client);
      } finally {
        await client.close().catch(() => {});
      }
    }),
  );

  steps.push(
    await step(deps, "missing token is 401", CLIENT_CLASSES.anyClient, async () => {
      const status = await initializeStatus(deps, url);
      return { ok: status === 401, detail: `no Authorization header → HTTP ${status} (want 401)` };
    }),
  );

  steps.push(
    await step(deps, "wrong token is 401", CLIENT_CLASSES.anyClient, async () => {
      const status = await initializeStatus(deps, url, "Bearer wcap_not_a_real_token");
      return { ok: status === 401, detail: `unknown bearer token → HTTP ${status} (want 401)` };
    }),
  );

  steps.push(
    await step(deps, "legacy SSE probe", CLIENT_CLASSES.legacySse, async () => {
      const { status, contentType } = await legacySseGet(deps, url, token);
      const disposition = classifyLegacySse(status, contentType);
      if (disposition === "unexpected") {
        return {
          ok: false,
          detail: `GET answered HTTP ${status} (${contentType ?? "no content-type"}), which is neither 405 nor a Streamable HTTP event stream`,
        };
      }
      if (disposition === "not-served") {
        return {
          ok: options.expectSse === "unsupported",
          detail:
            options.expectSse === "unsupported"
              ? "GET answered 405, so legacy SSE is not served; clients that default to SSE must set their transport explicitly"
              : "legacy SSE was expected to work, but GET answered 405",
        };
      }

      // 200 + text/event-stream: the Streamable HTTP stream. A legacy SSE
      // client should still be unable to finish its handshake on it.
      let client: ConformanceClient | undefined;
      try {
        client = await withTimeout(deps.connectSse(url, token), SSE_CONNECT_TIMEOUT_MS, "legacy SSE connect");
      } catch (error) {
        return {
          ok: options.expectSse === "unsupported",
          detail: `GET answered 200 text/event-stream (the Streamable HTTP stream), but a legacy SSE client cannot complete its handshake on it: ${describe(error)}`,
        };
      }
      try {
        if (options.expectSse === "unsupported") {
          return {
            ok: false,
            detail:
              "legacy SSE connected and this run expected it to be unserved; pass --expect-sse=supported if that is now intended",
          };
        }
        return await checkToolSurface(client);
      } finally {
        await client.close().catch(() => {});
      }
    }),
  );

  if (options.skipBridge) {
    steps.push({
      step: `stdio bridge (${BRIDGE_PACKAGE})`,
      clientClass: CLIENT_CLASSES.bridge,
      status: "skip",
      detail: "--skip-bridge was passed; bridge clients are not covered by this run",
      ms: 0,
    });
  } else {
    steps.push(
      await step(deps, `stdio bridge (${BRIDGE_PACKAGE})`, CLIENT_CLASSES.bridge, async () => {
        const client = await deps.connectBridge(url, token);
        try {
          return await checkToolSurface(client);
        } finally {
          await client.close().catch(() => {});
        }
      }),
    );
  }

  return { url, steps, ok: steps.every((result) => result.status !== "fail") };
}

/** One line per step, plus a named verdict for each failure. */
export function formatReport(report: ConformanceReport): string {
  const lines = [`MCP client conformance against ${report.url}`, ""];
  for (const result of report.steps) {
    const mark = result.status === "pass" ? "PASS" : result.status === "fail" ? "FAIL" : "SKIP";
    lines.push(`${mark}  ${result.step} (${result.ms}ms)`);
    lines.push(`      ${result.detail}`);
  }
  lines.push("");
  const failures = report.steps.filter((result) => result.status === "fail");
  if (failures.length === 0) {
    lines.push("All required steps passed.");
  } else {
    for (const failure of failures) {
      lines.push(`BROKEN: ${failure.clientClass} — ${failure.step}: ${failure.detail}`);
    }
  }
  return lines.join("\n");
}

// ── Real transports ─────────────────────────────────────────────────────────

async function connectWith(transport: Transport): Promise<ConformanceClient> {
  const client = new Client({ name: "willder-mcp-conformance", version: "1.0.0" });
  await client.connect(transport);
  return client as unknown as ConformanceClient;
}

export const liveDeps: ConformanceDeps = {
  connectHttp: (url, token) =>
    connectWith(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    ),
  connectSse: (url, token) =>
    connectWith(
      new SSEClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    ),
  connectBridge: (url, token) =>
    connectWith(
      new StdioClientTransport({
        command: "npx",
        // No space after the colon: mcp-remote's README notes that several
        // clients do not escape spaces inside `args`, and it expands ${VAR}
        // itself, so the token never appears in the process arguments.
        args: ["-y", BRIDGE_PACKAGE, url, "--header", "Authorization:${AUTH_HEADER}"],
        env: { ...getDefaultEnvironment(), AUTH_HEADER: `Bearer ${token}` },
        stderr: "ignore",
      }),
    ),
  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
  now: () => Date.now(),
};

async function main(): Promise<void> {
  let options: ConformanceOptions;
  try {
    options = readOptions(process.env, process.argv.slice(2));
  } catch (error) {
    console.error(`mcp-conformance: ${describe(error)}`);
    process.exit(2);
  }
  const report = await runConformance(options, liveDeps);
  console.log(formatReport(report));
  process.exit(report.ok ? 0 : 1);
}

// Only run when invoked directly, so the unit tests can import this module.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
