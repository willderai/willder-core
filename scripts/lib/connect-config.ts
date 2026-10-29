// Read a client's committed connection config out of its page under `docs/connect/`.
//
// The client matrix makes two separate claims about every row, and only the
// first is about Willder:
//
//   1. the server answers this client's transport and authentication shape;
//   2. this client's own settings screen accepts the config file.
//
// Claim 1 is checkable for every row, including the graphical clients, because
// the shape is written down: each page commits the exact config a reader pastes
// in. This module turns that committed config into a `ConnectConfig` — endpoint,
// header form, bridge argv — so the check runs against what the page actually
// says. Edit a page and the check follows it; the config and the check cannot
// drift apart.
//
// Nothing here touches the network. `scripts/lib/mcp-transport-probe.ts` runs
// what this module returns.

/** How a client reaches the endpoint, as its own page configures it. */
export type ConnectShape =
  /** Streamable HTTP straight from the client, with a request header. */
  | "direct-header"
  /** Streamable HTTP through the pinned `mcp-remote` stdio bridge. */
  | "bridge"
  /** The page commits no connection config at all (OAuth-only, or no MCP client). */
  | "none";

/** Where on the page a config came from, so a result can cite it. */
export interface ConfigSource {
  /** The fenced block's language (`json`, `toml`, `yaml`, `sh`, `python`, `ts`), or `table`. */
  kind: string;
  /** The first line of the config, for a one-line citation. */
  firstLine: string;
  /** The config exactly as committed, so a probe can write the client's own file. */
  body: string;
}

/** A header the client sends, with the page's interpolation placeholder intact. */
export interface HeaderForm {
  name: string;
  /** The value as committed, e.g. `Bearer ${env:WILLDER_TOKEN}`. */
  template: string;
  /** The substring the client replaces with the real token. */
  placeholder: string;
}

/** The pinned stdio bridge a client runs instead of connecting itself. */
export interface BridgeForm {
  command: string;
  args: string[];
  /** The `mcp-remote` release the config pins. */
  pinnedPackage: string;
  /** The environment variable the bridge reads the header from. */
  envName: string;
  /** That variable's committed value, placeholder intact. */
  envTemplate: string;
  placeholder: string;
}

/** One connection path a page commits. A page may commit a second as an alternative. */
export interface ConnectPlan {
  shape: Exclude<ConnectShape, "none">;
  url: string;
  source: ConfigSource;
  header?: HeaderForm;
  bridge?: BridgeForm;
  /** The transport the config names explicitly, if it names one. */
  declaredTransport: string | null;
}

export interface ConnectConfig {
  client: string;
  page: string;
  shape: ConnectShape;
  /** The path the page recommends first. Absent only when `shape` is `none`. */
  primary?: ConnectPlan;
  /** Further paths the same page commits, in document order. */
  alternatives: ConnectPlan[];
}

/** A page whose committed config cannot be read as a connection. */
export class ConnectConfigError extends Error {}

/**
 * The interpolation forms the pages use, longest first so `${env:X}` is read
 * whole rather than as `$`. The last form is a Python f-string or JavaScript
 * template expression, which the two SDK pages use.
 */
const PLACEHOLDER = /\$\{\{[^}]*\}\}|\$\{[^}]*\}|<[^>\n]+>|\$[A-Z_][A-Z0-9_]*|\{[^}\n]*\}/;

/**
 * `## Config` or `## Config file` through to the next heading. Only this section
 * is read: a page's "get a token" and "verify" sections also contain URLs and
 * shell lines, and neither is the config a reader pastes into the client.
 */
export function configSection(markdown: string): string {
  const start = markdown.search(/^## Config\b.*$/m);
  if (start < 0) return "";
  const rest = markdown.slice(start);
  const end = rest.slice(1).search(/^## /m);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

interface FencedBlock {
  language: string;
  body: string;
}

function fencedBlocks(section: string): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  const fence = /^```([a-z]*)\n([\s\S]*?)^```$/gm;
  for (let match = fence.exec(section); match; match = fence.exec(section)) {
    blocks.push({ language: match[1] || "text", body: match[2] });
  }
  return blocks;
}

/**
 * Collapse the shell-concatenation artifacts in a `sh` block, so a config
 * spliced into a quoted argument reads as the JSON the client receives.
 * `"Bearer '"$WILLDER_TOKEN"'"` is one shell string; the client sees
 * `Bearer <value>`.
 */
function unsplice(body: string): string {
  return body.split(`'"`).join("").split(`"'`).join("");
}

/** Every distinct `https://` URL in a config body. */
function urlsIn(body: string): string[] {
  const found = body.match(/https:\/\/[^\s"'`,)\\]+/g) ?? [];
  return [...new Set(found.map((url) => url.replace(/[.,]$/, "")))];
}

/**
 * The `Authorization` header a config sets, in any of the forms the pages use:
 * a JSON or YAML map value, a Python f-string, a `--header` argument, or a
 * markdown field table cell.
 */
function headerIn(body: string): HeaderForm | undefined {
  // Group 1 is the quote the value opens with, if any; the value then runs to
  // the matching quote, or to the end of the line or table cell when it is bare.
  const match = /Authorization["'`]?\s*[:=]\s*f?(["'`])?/.exec(body);
  if (!match) return undefined;
  const rest = body.slice(match.index + match[0].length);
  const quote = match[1];
  // An unquoted value is a bare YAML scalar, a table cell, or the tail of a
  // shell argument whose own closing quote is still ahead of it.
  const raw = quote ? rest.split(quote)[0] : (rest.split("\n")[0] ?? "").split(/["'`|]/)[0];
  const template = raw.trim().replace(/[,;]$/, "");
  const placeholder = PLACEHOLDER.exec(template)?.[0];
  if (!placeholder) return undefined;
  return { name: "Authorization", template, placeholder };
}

/**
 * Codex CLI names the environment variable instead of writing a header: it
 * builds `Authorization: Bearer <value>` itself from `bearer_token_env_var`.
 */
function bearerEnvVarIn(body: string): HeaderForm | undefined {
  const match = /bearer_token_env_var\s*=\s*"([A-Za-z_][A-Za-z0-9_]*)"/.exec(body);
  if (!match) return undefined;
  const placeholder = `\${${match[1]}}`;
  return { name: "Authorization", template: `Bearer ${placeholder}`, placeholder };
}

/** The transport a config names, where it names one. */
function declaredTransportIn(body: string): string | null {
  const named = /"?(?:type|transport)"?\s*[:=]\s*["']([a-z-_]+)["']/.exec(body);
  if (named) return named[1];
  if (/streamable_http|streamable-http|StreamableHTTP/.test(body)) return "streamable-http";
  if (/\bhttpUrl\b/.test(body)) return "httpUrl";
  if (/\bserverUrl\b/.test(body)) return "serverUrl";
  return null;
}

/**
 * The pinned bridge a config commits, or `undefined` when the config does not
 * run the bridge at all. A config that runs `mcp-remote` without a version pin
 * is an error rather than a non-bridge config: the pages exist so a reader gets
 * the release this repository checked, and an unpinned `npx` fetches whatever is
 * newest at the moment they paste it.
 */
function bridgeIn(body: string, language: string): BridgeForm | undefined {
  if (!/mcp-remote/.test(body)) return undefined;
  const pinned = /mcp-remote@[0-9][0-9A-Za-z.\-]*/.exec(body)?.[0];
  if (!pinned) {
    throw new ConnectConfigError(`a ${language} block runs mcp-remote with no @version pin`);
  }
  const argsText = /"args"\s*:\s*(\[[\s\S]*?\])/.exec(body)?.[1];
  if (!argsText) {
    throw new ConnectConfigError(`a ${language} block pins ${pinned} but commits no "args" array`);
  }
  let args: unknown;
  try {
    args = JSON.parse(argsText);
  } catch {
    throw new ConnectConfigError(`the "args" array next to ${pinned} is not valid JSON: ${argsText}`);
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new ConnectConfigError(`the "args" array next to ${pinned} is not an array of strings`);
  }
  const command = /"command"\s*:\s*"([^"]+)"/.exec(body)?.[1];
  if (!command) throw new ConnectConfigError(`a ${language} block pins ${pinned} but commits no "command"`);
  const envName = /\$\{([A-Z_][A-Z0-9_]*)\}/.exec(args.join(" "))?.[1];
  if (!envName) {
    throw new ConnectConfigError(
      `the ${pinned} args interpolate no \${VARIABLE}, so the token would be on the command line`,
    );
  }
  const envTemplate = new RegExp(`"${envName}"\\s*:\\s*"([^"]*)"`).exec(body)?.[1];
  if (envTemplate === undefined) {
    throw new ConnectConfigError(`the ${pinned} args read \${${envName}} but no "env" entry sets it`);
  }
  const placeholder = PLACEHOLDER.exec(envTemplate)?.[0];
  if (!placeholder) {
    throw new ConnectConfigError(`"${envName}" commits no token placeholder: ${envTemplate}`);
  }
  return { command, args: args as string[], pinnedPackage: pinned, envName, envTemplate, placeholder };
}

function firstLineOf(body: string): string {
  return (
    body
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim()
      .slice(0, 100) ?? ""
  );
}

/**
 * A graphical client has no file: its page commits a field table instead. The
 * rows carry the same two values a file would — the endpoint and the header.
 */
function tablePlan(section: string): ConnectPlan | undefined {
  const rows = section.split("\n").filter((line) => line.trimStart().startsWith("|"));
  if (rows.length === 0) return undefined;
  const table = rows.join("\n");
  const url = urlsIn(table)[0];
  const header = headerIn(table);
  if (!url || !header) return undefined;
  return {
    shape: "direct-header",
    url,
    header,
    declaredTransport: declaredTransportIn(table),
    source: { kind: "table", firstLine: firstLineOf(table), body: table },
  };
}

/**
 * Read one client's page into the connection paths it commits.
 *
 * Throws `ConnectConfigError` when the page commits a config that could not be
 * followed — including a literal capability token, which must never reach a
 * committed file.
 */
export function parseConnectPage(markdown: string, client: string): ConnectConfig {
  const page = `docs/connect/${client}.md`;
  if (/\bwcap_[A-Za-z0-9_-]{8,}/.test(markdown)) {
    throw new ConnectConfigError(`${page} contains a literal capability token`);
  }
  const section = configSection(markdown);
  const plans: ConnectPlan[] = [];
  for (const block of fencedBlocks(section)) {
    const body = block.language === "sh" ? unsplice(block.body) : block.body;
    const source = { kind: block.language, firstLine: firstLineOf(body), body };
    const bridge = bridgeIn(body, block.language);
    const urls = urlsIn(body);
    if (bridge) {
      plans.push({ shape: "bridge", url: urls[0] ?? "", bridge, declaredTransport: "stdio-bridge", source });
      continue;
    }
    if (urls.length === 0) continue;
    const header = headerIn(body) ?? bearerEnvVarIn(body);
    if (!header) continue;
    plans.push({ shape: "direct-header", url: urls[0], header, declaredTransport: declaredTransportIn(body), source });
  }
  const fromTable = tablePlan(section);
  if (fromTable) plans.unshift(fromTable);
  if (plans.length === 0) return { client, page, shape: "none", alternatives: [] };
  return { client, page, shape: plans[0].shape, primary: plans[0], alternatives: plans.slice(1) };
}

/** The client's config file as a probe should write it, and the environment it needs. */
export interface MaterializedConfig {
  /** The config text, with a literal `<placeholder>` replaced by the real token. */
  text: string;
  /** Variables the client interpolates from its environment, with the token as the value. */
  env: Record<string, string>;
}

/**
 * Turn a committed config into a file a probe can actually write.
 *
 * The page's placeholder says where the token belongs and how the client reads
 * it. `<angle brackets>` mean the client has no interpolation and the value goes
 * in the file; a `${VARIABLE}` form means the file stays as committed and the
 * variable is exported instead. Codex's `bearer_token_env_var` reduces to the
 * same `${VARIABLE}` case, because the header form it builds names the variable.
 */
export function materializeConfig(plan: ConnectPlan, token: string): MaterializedConfig {
  const placeholder = plan.shape === "bridge" ? plan.bridge!.placeholder : plan.header!.placeholder;
  if (placeholder.startsWith("<")) {
    return { text: plan.source.body.split(placeholder).join(token), env: {} };
  }
  const name = placeholder
    .replace(/^\$\{?/, "")
    .replace(/\}$/, "")
    .replace(/^env:/, "")
    .replace(/^input:/, "");
  return { text: plan.source.body, env: { [name]: token } };
}
