// Does the server answer this client's transport and authentication shape?
//
// This is the first of the client matrix's two claims, and the only one that is
// about Willder. It is checkable for every client, including the ones whose
// only interface is a window a person clicks, because what it exercises is the
// endpoint — reached exactly the way that client's committed config under
// `docs/connect/` says the client reaches it:
//
//   direct-header   Streamable HTTP, the page's own header, the page's own URL.
//   bridge          the pinned `mcp-remote` argv and `env` block, over stdio.
//
// Both paths run the same five requirements: the committed config is followable,
// the initialisation sequence completes, `tools/list` carries Willder's tools,
// one scoped `memory_query` answers, and an absent or wrong token is refused.
// A direct client is additionally held to the endpoint's legacy-SSE disposition,
// because a client that falls back to the deprecated HTTP+SSE handshake must not
// appear to connect.
//
// What this does NOT establish is the second claim: that the client's own
// settings screen accepts the file. Nothing scripted can establish that, and
// `scripts/lib/manual-runs.ts` is where a person's recorded run lives instead.
import { spawn } from "node:child_process";
import type { ConnectConfig, ConnectPlan } from "./connect-config";
import { scrub } from "./token-scrub";

/**
 * The protocol version every probe offers in `initialize`. It is the version
 * this repository's own server speaks, not a value read from a client's config:
 * no client commits its protocol version, so this one field is the probe's,
 * not the client's.
 */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** Tools a transport probe must see before the shape counts as answered. */
export const REQUIRED_TOOLS = ["memory_query", "memory_entity", "memory_ingest"] as const;

/** The query every probe runs, so one client's result is comparable to another's. */
export const PROBE_QUERY = { query: "release", limit: 2 } as const;

/** How long one transport probe may take before it counts as a failure. */
export const TRANSPORT_TIMEOUT_MS = 60_000;

/** How much of the end of a failed bridge's standard error a step keeps. */
const BRIDGE_ERROR_CHARS = 300;

export type TransportStatus = "verified" | "failed" | "unsupported" | "not-applicable";

export interface TransportStep {
  name: string;
  ok: boolean;
  detail: string;
}

export interface TransportResult {
  client: string;
  page: string;
  /** Which committed path was exercised, as the page configures it. */
  path: string;
  status: TransportStatus;
  steps: TransportStep[];
  ms: number;
}

export interface TransportContext {
  /** The endpoint under test. A config that points somewhere else fails. */
  url: string;
  token: string;
  fetch?: typeof fetch;
}

/** A JSON-RPC exchange, as a probe sees it. */
interface RpcOutcome {
  httpStatus: number;
  contentType: string;
  body: string;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

function parseRpc(body: string): Pick<RpcOutcome, "result" | "error"> {
  // A Streamable HTTP server may answer either JSON or one SSE `data:` frame.
  const payload =
    body.startsWith("event:") || body.startsWith("data:")
      ? body
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("")
      : body;
  try {
    const parsed = JSON.parse(payload) as { result?: Record<string, unknown>; error?: { message?: string } };
    return { result: parsed.result, error: parsed.error };
  } catch {
    return {};
  }
}

/** Substitute the real token for the page's interpolation placeholder. */
export function fillPlaceholder(template: string, placeholder: string, token: string): string {
  return template.split(placeholder).join(token);
}

/** One line a step can show without leaking anything. */
function short(text: string, token: string): string {
  return scrub(text, token).replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Check the committed config itself, before any request: it must point at the
 * endpoint under test, it must send `Authorization: Bearer`, and the value must
 * be an interpolation rather than a token somebody pasted into a file.
 */
function checkCommittedConfig(plan: ConnectPlan, context: TransportContext): TransportStep {
  const problems: string[] = [];
  if (plan.url !== context.url) {
    problems.push(`the config points at ${plan.url}, not the endpoint under test ${context.url}`);
  }
  const form =
    plan.shape === "bridge"
      ? { template: plan.bridge?.envTemplate ?? "", placeholder: plan.bridge?.placeholder ?? "" }
      : { template: plan.header?.template ?? "", placeholder: plan.header?.placeholder ?? "" };
  if (!form.template.startsWith("Bearer ")) {
    problems.push(`the committed credential is not a bearer value: "${form.template}"`);
  }
  if (!form.template.includes(form.placeholder)) {
    problems.push("the committed credential has no interpolation placeholder");
  }
  if (plan.shape === "bridge" && plan.bridge) {
    const headerArg = plan.bridge.args.find((arg) => arg.startsWith("Authorization"));
    if (!headerArg) problems.push("the bridge argv sets no Authorization header");
    else if (/^Authorization:\s/.test(headerArg)) {
      problems.push(
        `the bridge header argument has a space after the colon: "${headerArg}" — the pages document no space, because several clients do not escape it`,
      );
    }
  }
  const where = `${plan.source.kind} config`;
  return problems.length === 0
    ? {
        name: "committed config",
        ok: true,
        detail: `${where}: ${plan.url}, ${form.template} (${plan.declaredTransport ?? "no transport field"})`,
      }
    : { name: "committed config", ok: false, detail: `${where}: ${problems.join("; ")}` };
}

/** One HTTP request to the endpoint with the client's own header. */
async function rpc(context: TransportContext, headers: Record<string, string>, payload: unknown): Promise<RpcOutcome> {
  const impl = context.fetch ?? fetch;
  const response = await impl(context.url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TRANSPORT_TIMEOUT_MS),
  });
  const body = await response.text();
  return {
    httpStatus: response.status,
    contentType: response.headers.get("content-type") ?? "",
    body,
    ...parseRpc(body),
  };
}

/** The tools a `tools/list` result names. */
function toolNames(result: Record<string, unknown> | undefined): string[] {
  const tools = (result?.tools as Array<{ name?: string }> | undefined) ?? [];
  return tools.map((tool) => tool.name ?? "").filter(Boolean);
}

function toolSurfaceStep(names: string[]): TransportStep {
  const absent = REQUIRED_TOOLS.filter((name) => !names.includes(name));
  return absent.length === 0
    ? { name: "tools/list", ok: true, detail: `${names.length} tools including ${REQUIRED_TOOLS.join(", ")}` }
    : { name: "tools/list", ok: false, detail: `missing ${absent.join(", ")}` };
}

/** The text a `memory_query` answered with, or "" when it answered nothing. */
function answerText(result: Record<string, unknown> | undefined): string {
  const content = (result?.content as Array<{ type?: string; text?: string }> | undefined) ?? [];
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join(" ")
    .trim();
}

async function runDirect(plan: ConnectPlan, context: TransportContext): Promise<TransportStep[]> {
  const steps: TransportStep[] = [checkCommittedConfig(plan, context)];
  if (!steps[0].ok) return steps;
  const header = plan.header!;
  const value = fillPlaceholder(header.template, header.placeholder, context.token);
  const auth = { [header.name]: value };

  const initialize = await rpc(context, auth, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: `willder-transport-probe/${plan.source.kind}`, version: "1" },
    },
  });
  const serverInfo = initialize.result?.serverInfo as { name?: string } | undefined;
  steps.push({
    name: "initialize",
    ok: initialize.httpStatus === 200 && Boolean(initialize.result?.protocolVersion),
    detail:
      initialize.httpStatus === 200 && initialize.result
        ? `HTTP 200, protocol ${String(initialize.result.protocolVersion)}, server ${serverInfo?.name ?? "unnamed"}`
        : `HTTP ${initialize.httpStatus}: ${short(initialize.body, context.token)}`,
  });

  const notified = await rpc(context, auth, { jsonrpc: "2.0", method: "notifications/initialized" });
  steps.push({
    name: "notifications/initialized",
    ok: notified.httpStatus < 300,
    detail: `HTTP ${notified.httpStatus}`,
  });

  const list = await rpc(context, auth, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  steps.push(
    list.httpStatus === 200
      ? toolSurfaceStep(toolNames(list.result))
      : { name: "tools/list", ok: false, detail: `HTTP ${list.httpStatus}: ${short(list.body, context.token)}` },
  );

  const called = await rpc(context, auth, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "memory_query", arguments: PROBE_QUERY },
  });
  const answer = answerText(called.result);
  steps.push({
    name: "memory_query",
    ok: called.httpStatus === 200 && called.result?.isError !== true && answer.length > 0,
    detail:
      called.httpStatus === 200 && answer.length > 0
        ? `answered ${answer.length} characters: ${short(answer, context.token).slice(0, 120)}`
        : `HTTP ${called.httpStatus}: ${short(called.body, context.token)}`,
  });

  const anonymous = await rpc(context, {}, { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} });
  const wrong = await rpc(
    context,
    { [header.name]: "Bearer wcap_" + "not_a_real_capability_token" },
    { jsonrpc: "2.0", id: 5, method: "tools/list", params: {} },
  );
  steps.push({
    name: "refuses an absent or wrong token",
    ok: anonymous.httpStatus === 401 && wrong.httpStatus === 401,
    detail: `no header HTTP ${anonymous.httpStatus}, wrong token HTTP ${wrong.httpStatus}`,
  });

  steps.push(await legacySseStep(context));
  return steps;
}

/**
 * What a client that opens the deprecated HTTP+SSE handshake gets. A 405 is the
 * clean refusal; a 200 `text/event-stream` is the Streamable HTTP
 * server-to-client stream, on which no `endpoint` event ever arrives, so a
 * legacy client cannot finish its handshake there either. Anything else would
 * let a client appear to connect and then hang.
 */
async function legacySseStep(context: TransportContext): Promise<TransportStep> {
  const impl = context.fetch ?? fetch;
  try {
    const response = await impl(context.url, {
      method: "GET",
      headers: { accept: "text/event-stream", authorization: `Bearer ${context.token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const contentType = response.headers.get("content-type") ?? "";
    const streamOpened = response.status === 200 && contentType.includes("text/event-stream");
    await response.body?.cancel();
    return {
      name: "no legacy SSE handshake",
      ok: response.status === 405 || streamOpened,
      detail:
        response.status === 405
          ? "GET is 405: the deprecated transport is not served"
          : streamOpened
            ? "GET is 200 text/event-stream with no endpoint event: the Streamable HTTP stream, not a legacy handshake"
            : `GET is ${response.status} ${contentType}, which is neither a refusal nor the Streamable HTTP stream`,
    };
  } catch (error) {
    // A stream that never settles is the failure this step exists to catch.
    return { name: "no legacy SSE handshake", ok: false, detail: short(String(error), context.token) };
  }
}

/** One line of newline-delimited JSON-RPC from the bridge's stdout. */
interface BridgeResponse {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

/** The ids of the bridge requests that expect a reply. */
const BRIDGE_REQUEST_IDS = [1, 2, 3] as const;

interface BridgeExchange {
  responses: BridgeResponse[];
  stderr: string;
  code: number | null;
  /** True when the probe killed the bridge at `TRANSPORT_TIMEOUT_MS`. */
  timedOut: boolean;
}

/**
 * Run the bridge exactly as the page's config runs it — same command, same argv,
 * same `env` block — and speak the initialisation sequence down its stdin. The
 * token reaches the bridge only through the environment, which is the property
 * the bridge configs exist for, so the argv is checked for it first.
 */
async function runBridgeProcess(plan: ConnectPlan, context: TransportContext): Promise<BridgeExchange> {
  const bridge = plan.bridge!;
  const requests = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "willder-transport-probe/bridge", version: "1" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory_query", arguments: PROBE_QUERY } },
  ];
  const child = spawn(bridge.command, bridge.args, {
    env: {
      ...process.env,
      [bridge.envName]: fillPlaceholder(bridge.envTemplate, bridge.placeholder, context.token),
      // `npx -y` revalidates its cached copy of the pinned package against the
      // npm registry on every launch. That round trip is not Willder's endpoint,
      // and when it stalls or fails the bridge never starts, which reads as an
      // initialize failure on whichever bridge row it hit. Preferring the cache
      // runs the same pinned argv; the registry is still reached when nothing
      // is cached yet.
      npm_config_prefer_offline: "true",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const responses: BridgeResponse[] = [];
  let pending = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const done = new Promise<{ code: number | null; timedOut: boolean }>((resolve) => {
    const finish = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, timedOut: true });
    }, TRANSPORT_TIMEOUT_MS);
    // mcp-remote forwards the requests upstream concurrently, so replies arrive
    // in any order. The exchange is complete once every id has a result or an
    // error, not when any particular one shows up.
    child.stdout.on("data", (chunk: string) => {
      const lines = (pending + chunk).split("\n");
      pending = lines.pop() ?? "";
      responses.push(...lines.flatMap(parseBridgeLine));
      const answered = new Set(responses.map((response) => response.id));
      if (BRIDGE_REQUEST_IDS.every((id) => answered.has(id))) {
        clearTimeout(finish);
        child.kill("SIGTERM");
        resolve({ code: 0, timedOut: false });
      }
    });
    child.on("exit", (code) => {
      clearTimeout(finish);
      resolve({ code, timedOut: false });
    });
  });

  // mcp-remote connects upstream before it will answer, so the requests are
  // written together and the replies read as they arrive.
  for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
  const { code, timedOut } = await done;
  responses.push(...parseBridgeLine(pending));
  return { responses, stderr, code, timedOut };
}

/** A stdout line as a JSON-RPC message, or nothing when it is log text. */
function parseBridgeLine(line: string): BridgeResponse[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return [];
  try {
    return [JSON.parse(trimmed) as BridgeResponse];
  } catch {
    return [];
  }
}

/**
 * Why the bridge gave no result for one request, in one line: the JSON-RPC
 * error it returned, or else how the process ended and the end of its standard
 * error. The end, because mcp-remote opens with several lines of startup log
 * and the reason it stopped comes last. The token is scrubbed before the cut,
 * so a cut can never leave part of it behind.
 */
function bridgeFailure(exchange: BridgeExchange, id: number, token: string): string {
  const error = exchange.responses.find((response) => response.id === id)?.error;
  if (error) return `JSON-RPC error: ${short(error.message ?? "no message", token)}`;
  const ended = exchange.timedOut
    ? `no reply within ${TRANSPORT_TIMEOUT_MS / 1000} s, killed`
    : `exit ${String(exchange.code)}`;
  const stderr = scrub(exchange.stderr, token).replace(/\s+/g, " ").trim().slice(-BRIDGE_ERROR_CHARS);
  return `${ended}: ${stderr || "nothing on stderr"}`;
}

async function runBridge(plan: ConnectPlan, context: TransportContext): Promise<TransportStep[]> {
  const steps: TransportStep[] = [checkCommittedConfig(plan, context)];
  if (!steps[0].ok) return steps;
  const bridge = plan.bridge!;
  const argv = [bridge.command, ...bridge.args].join(" ");
  steps.push({
    name: "token stays out of the command line",
    ok: !argv.includes(context.token),
    detail: `${bridge.pinnedPackage}, header through $${bridge.envName}`,
  });

  const exchange = await runBridgeProcess(plan, context);
  const byId = (id: number) => exchange.responses.find((response) => response.id === id);
  const initialize = byId(1);
  steps.push({
    name: "initialize through the bridge",
    ok: Boolean(initialize?.result?.protocolVersion),
    detail: initialize?.result
      ? `protocol ${String(initialize.result.protocolVersion)}`
      : bridgeFailure(exchange, 1, context.token),
  });
  steps.push(
    byId(2)?.result
      ? toolSurfaceStep(toolNames(byId(2)?.result))
      : { name: "tools/list", ok: false, detail: bridgeFailure(exchange, 2, context.token) },
  );
  const answer = answerText(byId(3)?.result);
  steps.push({
    name: "memory_query",
    ok: answer.length > 0 && byId(3)?.result?.isError !== true,
    detail:
      answer.length > 0
        ? `answered ${answer.length} characters: ${short(answer, context.token).slice(0, 120)}`
        : byId(3)?.result
          ? "answered no text"
          : bridgeFailure(exchange, 3, context.token),
  });
  return steps;
}

/**
 * The endpoint's answer to a client that can only do OAuth: it serves no
 * authorization-server metadata and refuses an unauthenticated call. Recorded
 * as `unsupported`, which is not a pass — the row stays red until OAuth ships.
 */
async function runOauthOnly(context: TransportContext): Promise<TransportStep[]> {
  const impl = context.fetch ?? fetch;
  const origin = new URL(context.url).origin;
  const steps: TransportStep[] = [];
  for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource"]) {
    const response = await impl(`${origin}${path}`, { signal: AbortSignal.timeout(20_000) });
    steps.push({
      name: `no ${path}`,
      ok: response.status !== 200,
      detail: `HTTP ${response.status}`,
    });
    await response.body?.cancel();
  }
  const anonymous = await rpc(context, {}, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  steps.push({
    name: "unauthenticated call refused",
    ok: anonymous.httpStatus === 401,
    detail: `HTTP ${anonymous.httpStatus}`,
  });
  return steps;
}

/** Whether a config with no connection block is an expected absence. */
export type NoConfigReason = "oauth-only" | "no-mcp-client";

/**
 * Run the first claim for one client. `noConfigReason` is required for the two
 * rows whose pages commit no config, so a page that silently lost its config
 * block fails here instead of being read as a client that needs none.
 */
export async function probeTransport(
  config: ConnectConfig,
  context: TransportContext,
  noConfigReason?: NoConfigReason,
): Promise<TransportResult> {
  const started = Date.now();
  const finish = (path: string, status: TransportStatus, steps: TransportStep[]): TransportResult => ({
    client: config.client,
    page: config.page,
    path,
    status,
    steps,
    ms: Date.now() - started,
  });

  if (config.shape === "none") {
    if (noConfigReason === "oauth-only") {
      return finish("oauth", "unsupported", await runOauthOnly(context));
    }
    if (noConfigReason === "no-mcp-client") {
      return finish("none", "not-applicable", [
        { name: "no MCP client", ok: true, detail: "nothing to connect: this product has no MCP client of its own" },
      ]);
    }
    return finish("none", "failed", [
      {
        name: "committed config",
        ok: false,
        detail: `${config.page} commits no connection config and no reason it has none`,
      },
    ]);
  }
  if (noConfigReason) {
    return finish(config.primary!.shape, "failed", [
      {
        name: "committed config",
        ok: false,
        detail: `${config.page} is recorded as ${noConfigReason} but now commits a ${config.primary!.shape} config`,
      },
    ]);
  }

  const plan = config.primary!;
  const steps = await runPlan(plan, context);
  // A page that commits a second path commits it to readers too, so it is held
  // to the same bar, reported as one line rather than a second step list.
  for (const alternative of config.alternatives) {
    const substeps = await runPlan(alternative, context);
    const failed = substeps.find((step) => !step.ok);
    steps.push({
      name: `alternative ${alternative.shape} path (${alternative.source.kind} config)`,
      ok: failed === undefined,
      detail: failed ? `${failed.name}: ${failed.detail}` : "initialize, tools/list and memory_query all answered",
    });
  }
  return finish(plan.shape, steps.every((step) => step.ok) ? "verified" : "failed", steps);
}

function runPlan(plan: ConnectPlan, context: TransportContext): Promise<TransportStep[]> {
  return plan.shape === "bridge" ? runBridge(plan, context) : runDirect(plan, context);
}
