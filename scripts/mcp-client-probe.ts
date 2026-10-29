// The client matrix check: does each MCP client in docs/connect/ work with Willder.
//
// "This client works" is two claims, and only the first is about Willder:
//
//   1. the server answers this client's transport and authentication shape —
//      its exact endpoint, its exact header or bridge form, and the MCP
//      initialisation sequence. Scriptable for every client, including the
//      graphical ones, because what it exercises is our endpoint, reached from
//      that client's own committed config under `docs/connect/`.
//   2. this client's settings screen accepts that config file. That is about
//      their user interface, and only a person can establish it.
//
// Both are required for a row to pass. Claim 1 runs in
// `scripts/lib/mcp-transport-probe.ts`, driven by the config this repository
// commits for the client, so the config and the check cannot drift. Claim 2 is
// either a scripted end-to-end run of the client itself (this file's `run`
// functions, for the clients that have a command line) or a person's recorded
// run in `docs/connect/manual-runs.json`. Nothing else counts.
//
// An end-to-end probe ends in exactly one of three states, and each is a claim
// a stranger can re-run:
//
//   verified     the client itself connected, listed Willder's tools, and
//                answered one scoped `memory_query`.
//   failed       the client ran and did not. The page or the endpoint is wrong.
//   unavailable  the client is not on this machine, or has no scriptable path
//                (a GUI app, a hosted product). Never a pass, never a failure.
//
// Run:
//   WILLDER_MCP_URL=https://willder.ai/api/mcp WILLDER_TOKEN=... \
//   WILLDER_DEPLOYED_COMMIT=<sha> npx tsx scripts/mcp-client-probe.ts --matrix
//   ... --client=claude-code    one client, both claims
//   ... --all                   every client with an end-to-end probe
//   ... --transport-only        claim 1 for every row, no client needed
//   ... --json                  machine-readable results on stdout
//   ... --list                  what can be probed, and what cannot, and why
//
// The token is read from the environment and never printed, not even on a
// failure: failure details are truncated and scrubbed before they are shown.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { materializeConfig, parseConnectPage, type ConnectConfig, type ConnectPlan } from "./lib/connect-config";
import {
  probeTransport,
  PROBE_QUERY,
  REQUIRED_TOOLS,
  type NoConfigReason,
  type TransportResult,
} from "./lib/mcp-transport-probe";
import { readManualRuns, runFor, type ManualRunLedger } from "./lib/manual-runs";
import { scrub } from "./lib/token-scrub";

export { scrub };

const execFileAsync = promisify(execFile);

// The tool surface and the query both probes hold a client to live with the
// transport probe, so the two claims are measured against the same bar.
export { PROBE_QUERY, REQUIRED_TOOLS } from "./lib/mcp-transport-probe";

/** How long any single client probe may take before it counts as a failure. */
export const PROBE_TIMEOUT_MS = 180_000;

export type ProbeStatus = "verified" | "failed" | "unavailable";

export interface ProbeResult {
  /** The client id, which is also its page name under `docs/connect/`. */
  client: string;
  page: string;
  status: ProbeStatus;
  /** The command a reader runs to reproduce this exact result. */
  command: string;
  detail: string;
  ms: number;
}

export interface ProbeContext {
  url: string;
  token: string;
}

/** What one client's probe knows how to do. */
export interface ClientProbe {
  id: string;
  /** Display name, as the page titles it. */
  label: string;
  /** Why this client has no scriptable probe. Set means the probe never runs. */
  manualReason?: string;
  /** Set only for the two rows whose page commits no connection config at all. */
  noConfigReason?: NoConfigReason;
  /** The executable the probe needs, if it drives a command-line client. */
  requires?: { bin: string; install: string };
  /** The command string printed as the way to reproduce the result. */
  command: string;
  /**
   * Drive the client. `plan` is the config its own page commits, so a probe
   * writes the client's config file from the page rather than from a copy.
   */
  run?: (context: ProbeContext, plan?: ConnectPlan) => Promise<{ ok: boolean; detail: string }>;
}

function missingTools(names: readonly string[]): string[] {
  const present = new Set(names);
  return REQUIRED_TOOLS.filter((name) => !present.has(name));
}

/**
 * Describe a tool surface in one line, or say what is missing from it.
 * Shared by every probe so "verified" means the same thing for all of them.
 */
function describeToolSurface(names: readonly string[]): { ok: boolean; detail: string } {
  const absent = missingTools(names);
  if (absent.length > 0) {
    return { ok: false, detail: `tools/list is missing ${absent.join(", ")}` };
  }
  return { ok: true, detail: `${names.length} tools including ${REQUIRED_TOOLS.join(", ")}` };
}

/** Run a command, returning its output whether it succeeded or not. */
async function run(
  file: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(file, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      output: `${failure.stdout ?? ""}${failure.stderr ?? ""}${failure.message ?? ""}`,
    };
  }
}

async function hasBinary(bin: string): Promise<boolean> {
  const { code } = await run("/usr/bin/env", ["which", bin]);
  return code === 0;
}

/**
 * Probe Claude Code by doing what `docs/connect/claude-code.md` says: add the
 * server with `claude mcp add`, read its status back, then ask the agent
 * itself for the tool count and one `memory_query` result.
 *
 * The probe runs in a throwaway project directory, so the server it adds is
 * scoped to that directory and no other project of the operator's sees it. It
 * deliberately keeps the operator's real config directory, because that is
 * where Claude Code's own credentials live and a probe must not sign in.
 * `${WILLDER_TOKEN}` is passed through unexpanded, so the token is read from
 * the environment at connect time and never written to disk.
 */
async function probeClaudeCode(
  { url, token }: ProbeContext,
  plan?: ConnectPlan,
): Promise<{ ok: boolean; detail: string }> {
  const projectDir = await mkdtemp(join(tmpdir(), "willder-probe-project-"));
  const env = { ...process.env, WILLDER_TOKEN: token };
  // The header comes from the page's own `claude mcp add` line, so editing the
  // page changes what is run.
  const header = plan?.header
    ? `${plan.header.name}: ${plan.header.template}`
    : "Authorization: Bearer ${WILLDER_TOKEN}";
  try {
    const added = await run("claude", ["mcp", "add", "--transport", "http", "willder", url, "--header", header], {
      cwd: projectDir,
      env,
    });
    if (added.code !== 0) {
      return { ok: false, detail: `claude mcp add failed: ${scrub(added.output, token).slice(0, 300)}` };
    }

    const status = await run("claude", ["mcp", "get", "willder"], { cwd: projectDir, env });
    if (!status.output.includes("Connected")) {
      return {
        ok: false,
        detail: `claude mcp get did not report Connected: ${scrub(status.output, token).slice(0, 300)}`,
      };
    }

    const asked = await run(
      "claude",
      [
        "-p",
        `Call the willder MCP tool memory_query with query "${PROBE_QUERY.query}" and limit ${PROBE_QUERY.limit}. ` +
          "Reply with exactly two lines: the number of mcp__willder__ tools you can see, then the first 120 characters of the result. No other text.",
        "--allowedTools",
        "mcp__willder__memory_query",
        // The smallest model that can follow the instruction, so a probe is cheap.
        "--model",
        "sonnet",
      ],
      { cwd: projectDir, env },
    );
    // Claude Code writes operational warnings to stderr; they are not the answer.
    const answer = scrub(asked.output, token)
      .split("\n")
      .filter((line) => !line.startsWith("Warning:"))
      .join("\n")
      .trim();
    const toolCount = Number.parseInt(answer.split("\n")[0] ?? "", 10);
    if (!Number.isFinite(toolCount) || toolCount < REQUIRED_TOOLS.length) {
      return { ok: false, detail: `the agent did not report a tool surface: ${answer.slice(0, 300)}` };
    }
    return {
      ok: true,
      detail: `claude mcp get: Connected; the agent saw ${toolCount} willder tools and memory_query answered: ${answer.split("\n").slice(1).join(" ").slice(0, 160)}`,
    };
  } finally {
    await run("claude", ["mcp", "remove", "willder", "-s", "local"], { cwd: projectDir, env });
    await rm(projectDir, { recursive: true, force: true });
  }
}

/**
 * Probe the Vercel AI SDK in this process, with the exact code
 * `docs/connect/vercel-ai-sdk.md` publishes. No model call: `tools()` and a
 * direct `execute` are what the SDK does for the model anyway, and a probe
 * that needed a model key could not run in CI.
 */
async function probeVercelAiSdk({ url, token }: ProbeContext): Promise<{ ok: boolean; detail: string }> {
  const { experimental_createMCPClient: createMCPClient } = await import("ai");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = await createMCPClient({
    transport: new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  });
  try {
    const tools = (await client.tools()) as unknown as Record<
      string,
      { execute: (args: unknown, options: unknown) => Promise<unknown> }
    >;
    const surface = describeToolSurface(Object.keys(tools));
    if (!surface.ok) return surface;
    const result = await tools.memory_query.execute(PROBE_QUERY, { toolCallId: "probe", messages: [] });
    return { ok: true, detail: `${surface.detail}; memory_query returned ${JSON.stringify(result).length} bytes` };
  } finally {
    await client.close();
  }
}

/**
 * The Python SDK clients, LangChain and the OpenAI Agents SDK, run as a short
 * script in whichever interpreter already has their package. `WILLDER_PYTHON`
 * names that interpreter; the default `python3` is right when the packages are
 * installed globally and wrong when they are in a virtualenv, which is why the
 * unavailable message prints the install command rather than guessing.
 */
async function probePython(
  moduleCheck: string,
  source: string,
  installHint: string,
  { url, token }: ProbeContext,
): Promise<{ ok: boolean; detail: string }> {
  const python = process.env.WILLDER_PYTHON ?? "python3";
  const importable = await run(python, ["-c", `import ${moduleCheck}`]);
  if (importable.code !== 0) {
    return { ok: false, detail: `UNAVAILABLE: ${python} cannot import ${moduleCheck}. ${installHint}` };
  }
  const dir = await mkdtemp(join(tmpdir(), "willder-probe-python-"));
  const file = join(dir, "probe.py");
  try {
    await writeFile(file, source, "utf8");
    const result = await run(python, [file], {
      env: { ...process.env, WILLDER_MCP_URL: url, WILLDER_TOKEN: token },
    });
    const output = scrub(result.output, token).trim();
    if (result.code !== 0) return { ok: false, detail: output.slice(0, 400) };
    const names = (output.match(/^TOOLS (.*)$/m)?.[1] ?? "").split(",").filter(Boolean);
    const surface = describeToolSurface(names);
    if (!surface.ok) return surface;
    const answer = output.match(/^QUERY (.*)$/m)?.[1] ?? "";
    if (answer.length === 0) return { ok: false, detail: `memory_query returned nothing: ${output.slice(0, 300)}` };
    return { ok: true, detail: `${surface.detail}; memory_query answered: ${answer.slice(0, 160)}` };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Run a command with its standard input written and then closed.
 *
 * Two reasons a probe needs this rather than `run`: a secret passed on stdin
 * never reaches the argv, and a client that reads stdin for extra instructions
 * waits for end-of-file before it starts. `run` leaves stdin open, so such a
 * client hangs until the probe's own timeout kills it.
 */
async function runWithInput(
  file: string,
  args: readonly string[],
  input: string,
  options: { env: NodeJS.ProcessEnv; cwd?: string },
): Promise<{ code: number; output: string }> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const child = spawn(file, [...args], { env: options.env, cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      output += chunk;
    });
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
    child.stdin.end(input);
  });
}

/**
 * Probe Codex CLI through its own `config.toml`, written from
 * `docs/connect/codex-cli.md` into a throwaway `CODEX_HOME` so the operator's
 * real Codex configuration and credentials are never touched.
 *
 * Codex will not answer without an OpenAI credential, and a probe must not
 * create one. It uses an `OPENAI_API_KEY` that already exists in the
 * environment, passed to `codex login` on stdin so it never enters a command
 * line, and the throwaway home is deleted at the end.
 */
async function probeCodexCli(context: ProbeContext, plan?: ConnectPlan): Promise<{ ok: boolean; detail: string }> {
  if (!plan) return { ok: false, detail: "no committed config was read for codex-cli" };
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return {
      ok: false,
      detail:
        "UNAVAILABLE: Codex answers only once it is signed in to a ChatGPT account or holds an OpenAI API key, which a probe must not create. Set OPENAI_API_KEY to one that already exists to run this probe.",
    };
  }
  const model = process.env.WILLDER_CODEX_MODEL ?? "gpt-5.1";
  const home = await mkdtemp(join(tmpdir(), "willder-probe-codex-"));
  const workspace = await mkdtemp(join(tmpdir(), "willder-probe-codex-work-"));
  try {
    const materialized = materializeConfig(plan, context.token);
    await writeFile(join(home, "config.toml"), materialized.text, { mode: 0o600 });
    const env = { ...process.env, ...materialized.env, CODEX_HOME: home };
    const login = await runWithInput("codex", ["login", "--with-api-key"], apiKey, { env });
    if (login.code !== 0) {
      return {
        ok: false,
        detail: `codex login with the existing API key failed: ${scrub(login.output, context.token).slice(0, 200)}`,
      };
    }
    // Codex namespaces an MCP tool as `<server>__<tool>`, and reports every call
    // as a JSONL event. The event is the evidence, so the prompt only has to get
    // the call made.
    const exec = await runWithInput(
      "codex",
      [
        "exec",
        "--json",
        "--approve-for-me",
        "--skip-git-repo-check",
        "-m",
        model,
        `Call the tool willder__memory_query with arguments {"query":"${PROBE_QUERY.query}","limit":${PROBE_QUERY.limit}}. ` +
          "Do not run shell commands and do not list resources. Then reply with the first 120 characters of the text it returned.",
      ],
      "",
      { cwd: workspace, env },
    );
    // Codex reports every MCP call as a JSONL event, which is better evidence
    // than its prose: it names the tool, the arguments and the outcome.
    const calls = scrub(exec.output, context.token)
      .split("\n")
      .flatMap((line) => {
        try {
          const event = JSON.parse(line) as {
            item?: { type?: string; tool?: string; status?: string; result?: unknown };
          };
          return event.item?.type === "mcp_tool_call" ? [event.item] : [];
        } catch {
          return [];
        }
      });
    const query = calls.find((call) => call.tool === "memory_query" && call.status === "completed");
    if (!query) {
      const attempted = calls.map((call) => `${call.tool}:${call.status}`).join(", ") || "none";
      // Codex logs an MCP handshake failure as a warning and tells the model
      // nothing, so a probe that only read the transcript would call this a
      // model failure. Say what it actually is.
      return {
        ok: false,
        detail: `Codex made no completed memory_query call (MCP calls: ${attempted}). Codex reports a failed MCP handshake only in its own log, so check the token's validity first.`,
      };
    }
    const answer = JSON.stringify(query.result ?? "");
    return {
      ok: true,
      detail: `codex exec on ${model}: memory_query completed through the willder server and returned ${answer.length} bytes: ${answer.slice(0, 160)}`,
    };
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
}

/**
 * The willder tool call Goose actually made, out of its `--output-format json`
 * transcript. Goose records every tool request and its response, which is
 * better evidence than the model's prose: it names the tool and carries what
 * came back.
 */
function gooseToolCall(output: string): { called: boolean; answer: string; detail: string } {
  const start = output.indexOf("{");
  if (start < 0)
    return { called: false, answer: "", detail: `Goose printed no JSON transcript: ${output.slice(-200)}` };
  let transcript: { messages?: Array<{ content?: Array<Record<string, unknown>> }> };
  try {
    transcript = JSON.parse(output.slice(start)) as typeof transcript;
  } catch {
    return { called: false, answer: "", detail: `Goose's JSON transcript did not parse: ${output.slice(-200)}` };
  }
  const parts = (transcript.messages ?? []).flatMap((message) => message.content ?? []);
  const requested = parts.some(
    (part) => (part.toolCall as { value?: { name?: string } } | undefined)?.value?.name === "willder__memory_query",
  );
  const response = parts
    .map(
      (part) =>
        part.toolResult as
          | { status?: string; value?: { content?: Array<{ type?: string; text?: string }> } }
          | undefined,
    )
    .find((part) => part?.status === "success" && (part.value?.content ?? []).some((item) => item.type === "text"));
  const answer = (response?.value?.content ?? [])
    .map((item) => item.text ?? "")
    .join(" ")
    .trim();
  if (!requested) return { called: false, answer: "", detail: "Goose made no willder__memory_query tool request" };
  if (answer.length === 0) return { called: true, answer: "", detail: "willder__memory_query returned no text" };
  return { called: true, answer, detail: "" };
}

/**
 * Probe Goose through its own `config.yaml`, written from
 * `docs/connect/goose.md` into a throwaway `XDG_CONFIG_HOME` so the operator's
 * real Goose configuration is never touched.
 *
 * Goose will not start a session without a model provider, and a probe must not
 * create one. `GOOSE_PROVIDER` and `GOOSE_MODEL` are used when the operator has
 * set them; otherwise an `ANTHROPIC_API_KEY` that already exists selects the
 * Anthropic provider.
 */
async function probeGoose(context: ProbeContext, plan?: ConnectPlan): Promise<{ ok: boolean; detail: string }> {
  if (!plan) return { ok: false, detail: "no committed config was read for goose" };
  const provider = process.env.GOOSE_PROVIDER ?? (process.env.ANTHROPIC_API_KEY ? "anthropic" : undefined);
  const model = process.env.GOOSE_MODEL ?? (provider === "anthropic" ? "claude-haiku-4-5-20251001" : undefined);
  if (!provider || !model) {
    return {
      ok: false,
      detail:
        "UNAVAILABLE: Goose needs a configured model provider before it will run a session, and a probe must not create one. Set GOOSE_PROVIDER and GOOSE_MODEL, with that provider's existing key in the environment.",
    };
  }
  const configHome = await mkdtemp(join(tmpdir(), "willder-probe-goose-"));
  try {
    const materialized = materializeConfig(plan, context.token);
    const gooseDir = join(configHome, "goose");
    await mkdir(gooseDir, { recursive: true });
    // The committed config carries the token itself here, so the file is
    // written readable only by this user and removed at the end.
    await writeFile(join(gooseDir, "config.yaml"), materialized.text, { mode: 0o600 });
    const prompt =
      `Call the willder MCP tool memory_query with arguments {"query":"${PROBE_QUERY.query}","limit":${PROBE_QUERY.limit}}. ` +
      "Do not run shell commands. Then reply with the first 120 characters the tool returned.";
    const result = await run("goose", ["run", "--no-session", "-q", "--output-format", "json", "-t", prompt], {
      env: {
        ...process.env,
        ...materialized.env,
        XDG_CONFIG_HOME: configHome,
        GOOSE_PROVIDER: provider,
        GOOSE_MODEL: model,
      },
    });
    const call = gooseToolCall(scrub(result.output, context.token));
    if (!call.called || call.answer.length === 0) return { ok: false, detail: call.detail };
    return {
      ok: true,
      detail: `goose run on ${provider}/${model}: willder__memory_query answered ${call.answer.length} characters: ${call.answer.slice(0, 160)}`,
    };
  } finally {
    await rm(configHome, { recursive: true, force: true });
  }
}

const LANGCHAIN_SOURCE = `import asyncio, os
from langchain_mcp_adapters.client import MultiServerMCPClient

async def main():
    client = MultiServerMCPClient({
        "willder": {
            "transport": "http",
            "url": os.environ["WILLDER_MCP_URL"],
            "headers": {"Authorization": f"Bearer {os.environ['WILLDER_TOKEN']}"},
        }
    })
    tools = await client.get_tools()
    print("TOOLS " + ",".join(t.name for t in tools))
    query = next(t for t in tools if t.name == "memory_query")
    result = await query.ainvoke({"query": "${PROBE_QUERY.query}", "limit": ${PROBE_QUERY.limit}})
    print("QUERY " + str(result)[:200].replace("\\n", " "))

asyncio.run(main())
`;

const OPENAI_AGENTS_SOURCE = `import asyncio, os
from agents.mcp import MCPServerStreamableHttp

async def main():
    server = MCPServerStreamableHttp(params={
        "url": os.environ["WILLDER_MCP_URL"],
        "headers": {"Authorization": f"Bearer {os.environ['WILLDER_TOKEN']}"},
    })
    async with server:
        tools = await server.list_tools()
        print("TOOLS " + ",".join(t.name for t in tools))
        result = await server.call_tool("memory_query", {"query": "${PROBE_QUERY.query}", "limit": ${PROBE_QUERY.limit}})
        print("QUERY " + str(result.content[0].text)[:200].replace("\\n", " "))

asyncio.run(main())
`;

/**
 * Every row of the client matrix, in the order `docs/connect/README.md` lists
 * them. A client with no `run` is not a gap in this script: it is a client
 * whose only interface is a window a person clicks, or a hosted product behind
 * a sign-in, and `manualReason` says which.
 */
export const CLIENT_PROBES: readonly ClientProbe[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    requires: { bin: "claude", install: "Install Claude Code: npm i -g @anthropic-ai/claude-code" },
    command: "npx tsx scripts/mcp-client-probe.ts --client=claude-code",
    run: probeClaudeCode,
  },
  {
    id: "vercel-ai-sdk",
    label: "Vercel AI SDK",
    command: "npx tsx scripts/mcp-client-probe.ts --client=vercel-ai-sdk",
    run: probeVercelAiSdk,
  },
  {
    id: "langchain",
    label: "LangChain / LangGraph",
    command: "WILLDER_PYTHON=<interpreter> npx tsx scripts/mcp-client-probe.ts --client=langchain",
    run: (context) =>
      probePython(
        "langchain_mcp_adapters",
        LANGCHAIN_SOURCE,
        "Install it with `pip install langchain-mcp-adapters`, then set WILLDER_PYTHON to that interpreter.",
        context,
      ),
  },
  {
    id: "openai-agents-sdk",
    label: "OpenAI Agents SDK",
    command: "WILLDER_PYTHON=<interpreter> npx tsx scripts/mcp-client-probe.ts --client=openai-agents-sdk",
    run: (context) =>
      probePython(
        "agents.mcp",
        OPENAI_AGENTS_SOURCE,
        "Install it with `pip install openai-agents`, then set WILLDER_PYTHON to that interpreter.",
        context,
      ),
  },
  {
    id: "codex-cli",
    label: "Codex CLI",
    requires: { bin: "codex", install: "Install Codex CLI: npm i -g @openai/codex" },
    command: "OPENAI_API_KEY=<an existing key> npx tsx scripts/mcp-client-probe.ts --client=codex-cli",
    run: probeCodexCli,
  },
  {
    id: "gemini-cli",
    label: "Gemini CLI",
    requires: { bin: "gemini", install: "Install Gemini CLI: npm i -g @google/gemini-cli" },
    command: "npx tsx scripts/mcp-client-probe.ts --client=gemini-cli",
    manualReason:
      "Gemini CLI answers a query only after a Google sign-in or a GEMINI_API_KEY, which a probe must not create.",
  },
  {
    id: "goose",
    label: "Goose",
    requires: {
      bin: "goose",
      install: "Install Goose: https://block.github.io/goose/docs/getting-started/installation",
    },
    command: "GOOSE_PROVIDER=<provider> GOOSE_MODEL=<model> npx tsx scripts/mcp-client-probe.ts --client=goose",
    run: probeGoose,
  },
  {
    id: "hermes",
    label: "Hermes (Nous)",
    requires: { bin: "hermes", install: "Install the Nous hermes-agent CLI." },
    command: "npx tsx scripts/mcp-client-probe.ts --client=hermes",
    manualReason:
      "The `hermes` CLI (`pip install 'hermes-agent[mcp]'`, published to PyPI from NousResearch/hermes-agent) needs a configured model provider, and no run has been recorded.",
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    command: "manual run",
    manualReason: "A desktop app; its connection is only visible in its own window.",
  },
  {
    id: "cursor",
    label: "Cursor",
    command: "manual run",
    manualReason: "A desktop app; its connection is only visible in its own window.",
  },
  {
    id: "windsurf",
    label: "Windsurf",
    command: "manual run",
    manualReason: "A desktop app; its connection is only visible in its own window.",
  },
  {
    id: "continue",
    label: "Continue",
    command: "manual run",
    manualReason: "An IDE extension; its connection is only visible in the IDE.",
  },
  {
    id: "vscode-copilot",
    label: "VS Code (Copilot)",
    command: "manual run",
    manualReason: "An IDE extension; its connection is only visible in the IDE.",
  },
  {
    id: "open-webui",
    label: "Open WebUI",
    command: "manual run",
    manualReason: "A hosted web UI; its connection is configured and shown in a browser.",
  },
  {
    id: "zed",
    label: "Zed",
    command: "manual run",
    manualReason: "A desktop app; its connection is only visible in its own window.",
  },
  {
    id: "cline",
    label: "Cline",
    command: "manual run",
    manualReason: "An IDE extension; its connection is only visible in the IDE.",
  },
  {
    id: "lm-studio",
    label: "LM Studio",
    command: "manual run",
    manualReason: "A desktop app; its connection is only visible in its own window.",
  },
  {
    id: "openclaw",
    label: "OpenClaw",
    command: "manual run",
    manualReason: "A desktop app; its connection is only visible in its own window.",
  },
  {
    id: "claude-ai-web",
    label: "claude.ai (web)",
    command: "not supported",
    noConfigReason: "oauth-only",
    manualReason:
      "claude.ai sends no custom request headers, so it can only connect with OAuth, which Willder does not serve yet.",
  },
  {
    id: "chatgpt",
    label: "ChatGPT",
    command: "not supported",
    noConfigReason: "oauth-only",
    manualReason: "ChatGPT connectors require OAuth, which Willder does not serve yet.",
  },
  {
    id: "ollama",
    label: "Ollama",
    command: "not applicable",
    noConfigReason: "no-mcp-client",
    manualReason: "Ollama has no MCP client; it is reached through a client that uses it as the model provider.",
  },
];

export function findProbe(id: string): ClientProbe | undefined {
  return CLIENT_PROBES.find((probe) => probe.id === id);
}

/** Run one client's probe and turn whatever happens into a result row. */
export async function probeClient(probe: ClientProbe, context: ProbeContext, plan?: ConnectPlan): Promise<ProbeResult> {
  const page = `docs/connect/${probe.id}.md`;
  const started = Date.now();
  const unavailable = (detail: string): ProbeResult => ({
    client: probe.id,
    page,
    status: "unavailable",
    command: probe.command,
    detail,
    ms: Date.now() - started,
  });

  if (probe.requires && !(await hasBinary(probe.requires.bin))) {
    return unavailable(`\`${probe.requires.bin}\` is not on this machine. ${probe.requires.install}`);
  }
  if (probe.manualReason || !probe.run) {
    return unavailable(probe.manualReason ?? "No scriptable probe.");
  }

  try {
    const { ok, detail } = await probe.run(context, plan);
    if (detail.startsWith("UNAVAILABLE: ")) return unavailable(detail.slice("UNAVAILABLE: ".length));
    return {
      client: probe.id,
      page,
      status: ok ? "verified" : "failed",
      command: probe.command,
      detail,
      ms: Date.now() - started,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      client: probe.id,
      page,
      status: "failed",
      command: probe.command,
      detail: scrub(message, context.token).slice(0, 400),
      ms: Date.now() - started,
    };
  }
}

// ── The matrix: both claims, one row per client ──────────────────────────────

/** Where a client-half verdict came from. "none" is not a pass. */
export type ClientEvidence = "scripted probe" | "recorded manual run" | "none";

export interface ClientClaim {
  verified: boolean;
  evidence: ClientEvidence;
  detail: string;
}

/** One client matrix row: the server's half, the client's half, and the verdict. */
export interface MatrixRow {
  client: string;
  label: string;
  page: string;
  /** Claim 1: the server answers this client's transport and authentication shape. */
  transport: TransportResult;
  /** Claim 2: this client's own settings screen accepts the config. */
  client_: ClientClaim;
  /** True only when both claims hold. Neither half passes a row on its own. */
  pass: boolean;
}

export interface MatrixOptions {
  /** Repository root, so the connect pages are read from the tree being checked. */
  root: string;
  ledger: ManualRunLedger;
  /** The commit that was deployed when this run happened. */
  deployedCommit: string;
  /** Run the client's own end-to-end probe too. False checks claim 1 alone. */
  endToEnd: boolean;
}

/** Read one client's committed config from its page under `docs/connect/`. */
export function readConnectConfig(client: string, root: string): ConnectConfig {
  const page = join(root, "docs", "connect", `${client}.md`);
  return parseConnectPage(readFileSync(page, "utf8"), client);
}

/**
 * The client half of one row. A scripted end-to-end probe settles it where the
 * client has a command line; otherwise the only evidence is a person's recorded
 * run on the commit under test.
 */
export function clientClaimFrom(
  probe: ClientProbe,
  endToEnd: ProbeResult | undefined,
  options: MatrixOptions,
): ClientClaim {
  if (endToEnd?.status === "verified") {
    return { verified: true, evidence: "scripted probe", detail: endToEnd.detail };
  }
  const recorded = runFor(options.ledger, probe.id, options.deployedCommit);
  if (recorded) {
    return {
      verified: true,
      evidence: "recorded manual run",
      detail: `${recorded.who} on ${recorded.when}, ${probe.label} ${recorded.clientVersion}, commit ${recorded.deployedCommit}: ${recorded.saw}`,
    };
  }
  if (endToEnd && endToEnd.status !== "unavailable") {
    return { verified: false, evidence: "none", detail: `the end-to-end probe ${endToEnd.status}: ${endToEnd.detail}` };
  }
  const why = endToEnd?.detail ?? probe.manualReason ?? "no scriptable probe";
  return {
    verified: false,
    evidence: "none",
    detail: `no run recorded on ${options.deployedCommit}: ${why}`,
  };
}

/**
 * The row verdict. Both claims are required, and neither half carries the other:
 * a transport check that answers says nothing about the client's settings screen,
 * and a recorded run of the client says nothing about the endpoint.
 */
export function rowPasses(transport: TransportResult, client_: ClientClaim): boolean {
  return transport.status === "verified" && client_.verified;
}

/**
 * The process exit code a set of rows deserves. A row that has not been
 * established yet is not a failure — the matrix is explicitly incomplete while
 * clients await a recorded run — but a transport check that failed, or a client
 * probe that ran and did not connect, is something broken and exits 1.
 */
export function matrixExitCode(rows: readonly MatrixRow[]): number {
  const broke = rows.some(
    (row) =>
      row.transport.status === "failed" ||
      (row.client_.evidence === "none" && row.client_.detail.startsWith("the end-to-end probe failed")),
  );
  return broke ? 1 : 0;
}

/** Run both claims for one client. */
export async function probeMatrixRow(
  probe: ClientProbe,
  context: ProbeContext,
  options: MatrixOptions,
): Promise<MatrixRow> {
  const config = readConnectConfig(probe.id, options.root);
  const transport = await probeTransport(config, { url: context.url, token: context.token }, probe.noConfigReason);
  const endToEnd =
    options.endToEnd && probe.run && !probe.manualReason
      ? await probeClient(probe, context, config.primary)
      : undefined;
  const client_ = clientClaimFrom(probe, endToEnd, options);
  return {
    client: probe.id,
    label: probe.label,
    page: `docs/connect/${probe.id}.md`,
    transport,
    client_,
    pass: rowPasses(transport, client_),
  };
}

/** The counts a reader of the matrix actually wants. */
export function tally(rows: readonly MatrixRow[]): Record<string, number> {
  return {
    rows: rows.length,
    bothClaims: rows.filter((row) => row.pass).length,
    transportVerified: rows.filter((row) => row.transport.status === "verified").length,
    transportFailed: rows.filter((row) => row.transport.status === "failed").length,
    transportUnsupported: rows.filter((row) => row.transport.status === "unsupported").length,
    notApplicable: rows.filter((row) => row.transport.status === "not-applicable").length,
    clientVerified: rows.filter((row) => row.client_.verified).length,
    awaitingManualRun: rows.filter((row) => row.transport.status === "verified" && !row.client_.verified).length,
  };
}

function renderMatrix(rows: readonly MatrixRow[], counts: Record<string, number>): string {
  const lines = rows.map((row) => {
    const verdict = row.pass ? "PASS      " : "INCOMPLETE";
    const head = `${verdict}  ${row.client.padEnd(18)} transport: ${row.transport.status} (${row.transport.path}, ${row.transport.ms}ms)  client: ${row.client_.verified ? row.client_.evidence : "unverified"}`;
    const steps = row.transport.steps.map(
      (step) => `        ${step.ok ? "ok  " : "FAIL"} ${step.name}: ${step.detail}`,
    );
    return [head, ...steps, `        client: ${row.client_.detail}`].join("\n");
  });
  const summary = [
    `${counts.bothClaims} of ${counts.rows} rows pass both claims.`,
    `Transport and authentication shape answered for ${counts.transportVerified}, failed for ${counts.transportFailed}, unsupported for ${counts.transportUnsupported}, not applicable for ${counts.notApplicable}.`,
    `The client half is verified for ${counts.clientVerified}; ${counts.awaitingManualRun} rows answer the transport check and still need a recorded run of the client itself.`,
  ];
  return [...lines, "", ...summary].join("\n");
}

/** The repository root, from this file's own location. */
const REPO_ROOT = join(__dirname, "..");

function listClients(): void {
  for (const probe of CLIENT_PROBES) {
    const endToEnd =
      probe.run && !probe.manualReason ? "scripted end to end" : `needs a person — ${probe.manualReason ?? "no probe"}`;
    console.log(`${probe.id.padEnd(20)} transport: scripted    client: ${endToEnd}`);
  }
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes("--list")) {
    listClients();
    return 0;
  }

  const url = process.env.WILLDER_MCP_URL?.trim();
  const token = process.env.WILLDER_TOKEN?.trim();
  if (!url || !token) {
    console.error(
      "WILLDER_MCP_URL and WILLDER_TOKEN are both required, with no default: a probe must say out loud what it is pointing at.",
    );
    return 2;
  }

  const requested = argv.find((arg) => arg.startsWith("--client="))?.slice("--client=".length);
  const everyClient = argv.includes("--matrix") || argv.includes("--transport-only");
  const all = argv.includes("--all");
  if (!requested && !all && !everyClient) {
    console.error("Pass --matrix, --transport-only, --all, --client=<id>, or --list. `--list` names every client id.");
    return 2;
  }

  const context: ProbeContext = { url, token };
  const chosen = requested ? [findProbe(requested)] : CLIENT_PROBES;
  if (chosen.some((probe) => probe === undefined)) {
    console.error(`Unknown client "${requested}". Run --list for the ids.`);
    return 2;
  }
  const probes = (chosen as ClientProbe[]).filter(
    (probe) => everyClient || requested !== undefined || (probe.run && !probe.manualReason),
  );

  // A matrix run resolves recorded manual runs, which only count on the commit
  // under test, so the commit is required rather than guessed.
  const deployedCommit = process.env.WILLDER_DEPLOYED_COMMIT?.trim();
  if (!deployedCommit) {
    console.error(
      "WILLDER_DEPLOYED_COMMIT is not set. A client matrix result is about one deployed commit, and a recorded manual run on another commit does not carry forward.",
    );
    return 2;
  }
  const ledger = readManualRuns(join(REPO_ROOT, "docs", "connect", "manual-runs.json"));
  for (const { reason } of ledger.rejected) {
    console.error(`manual-runs.json: ignoring an entry — ${reason}`);
  }
  const options: MatrixOptions = {
    root: REPO_ROOT,
    ledger,
    deployedCommit,
    endToEnd: !argv.includes("--transport-only"),
  };

  const rows: MatrixRow[] = [];
  for (const probe of probes) rows.push(await probeMatrixRow(probe, context, options));
  const counts = tally(rows);

  if (argv.includes("--json")) {
    console.log(JSON.stringify({ url, deployedCommit, probedAt: new Date().toISOString(), counts, rows }, null, 2));
  } else {
    console.log(`Client matrix against ${url}, deployed commit ${deployedCommit}\n`);
    console.log(renderMatrix(rows, counts));
  }
  return matrixExitCode(rows);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
