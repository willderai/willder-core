// The live-API helpers a test uses to drive the app the way an agent and an admin do: an
// MCP tool call with a bearer capability token, an admin call over a signed-in browser
// session, minting a capability token, and the vault that keeps every token out of what a
// test prints.
//
// The one rule this file enforces: no secret value reaches stdout or stderr. Every minted
// token goes into the vault, and a credential-shaped string is redacted even when it was
// never registered.
import type { BrowserContext } from "playwright";
import {
  SECRET_SHAPES,
  exposesRequestHeaders,
  printableError,
  redactRequestHeaders,
  stripAnsi,
} from "@/scripts/lib/request-headers";

export type Json = Record<string, unknown>;
export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

// ── Secrets ─────────────────────────────────────────────────────────────────

/** Known secret values, and the redaction every printed line goes through. */
export class SecretVault {
  private readonly values = new Set<string>();

  /** Register a value; short strings are ignored so a redaction never eats a common word. */
  add(value: string | undefined): void {
    if (value && value.length >= 8) this.values.add(value);
  }

  /** Every registered value, for a redaction that also looks for their encoded spellings. */
  registered(): string[] {
    return [...this.values];
  }

  /** True when `text` still carries a registered value or a credential-shaped string. */
  exposes(text: string): boolean {
    const plain = stripAnsi(text);
    for (const value of this.values) if (plain.includes(value)) return true;
    return new RegExp(SECRET_SHAPES.source).test(plain) || exposesRequestHeaders(plain);
  }

  /** `text` without ANSI codes, registered values, credential-shaped strings or credential header values. */
  redact(text: string): string {
    let out = stripAnsi(text);
    for (const value of this.values) out = out.split(value).join("<redacted>");
    return redactRequestHeaders(out.replace(SECRET_SHAPES, "<redacted>"));
  }
}

// ── HTTP callers ────────────────────────────────────────────────────────────

export interface AdminResponse {
  status: number;
  json: Json | null;
  /** The body as text when it is not JSON, such as an event stream; absent for a JSON body. */
  text?: string;
}
/** A call as the signed-in admin (cookie session), e.g. `api("GET", "/api/sources")`. */
export type AdminApi = (method: HttpMethod, path: string, body?: unknown) => Promise<AdminResponse>;

/** One file in a multipart body: its name, its type and its bytes. */
export interface FilePart {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

/**
 * A request body sent as `multipart/form-data` rather than JSON, for a route that reads
 * `req.formData()`. Passed as the `body` of an `AdminApi` call.
 */
export interface MultipartBody {
  multipart: Record<string, string | FilePart>;
}

export function isMultipartBody(body: unknown): body is MultipartBody {
  return (
    body !== null &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    "multipart" in body &&
    Object.keys(body).length === 1
  );
}

export interface McpResult {
  status: number;
  /** HTTP 200 and the tool did not return an error result. */
  ok: boolean;
  /** Refused at the door (401/403) or by check() inside the tool. */
  denied: boolean;
  text: string;
  /** Answer lines that are facts: memory_query renders each as `• <fact> ... — <citation>`. */
  factLines: string[];
  ms: number;
  /** The reply's Server-Timing header (mcp/server-timing.ts); absent from a fake that sets none. */
  serverTiming?: string | null;
  /** The tool result's own `_meta`; absent when it set none, or from a fake that sets none. */
  meta?: Record<string, unknown>;
  /** The body was a JSON-RPC `error` (a protocol failure, `-32603` say), not a tool result. */
  rpcError?: { code: number | null };
  /** The body was empty, cut short, not JSON, or held neither a result nor an error. */
  unparseable?: true;
}
/** One MCP tool call with a bearer capability token over the stateless /api/mcp transport. */
export type McpCall = (token: string, tool: string, args: Json) => Promise<McpResult>;

/** What `parseMcpBody` read from one /api/mcp response body. */
export interface McpBody {
  text: string;
  /** A tool error result, a JSON-RPC error or a body that could not be read. */
  isError: boolean;
  meta?: Record<string, unknown>;
  /** Set when the body was a JSON-RPC `error` rather than a tool result. */
  rpcError?: { code: number | null };
  /** Set when the body was empty, not JSON, or held neither a result nor an error. */
  unparseable?: true;
}

/**
 * The text of one MCP tool result, from either the JSON or the SSE framing of the response.
 * A tool error result, a JSON-RPC error and an unreadable body all set `isError`; the last two
 * are also marked, so a caller can tell a tool that refused from a call that never reached one.
 */
export function parseMcpBody(rawText: string): McpBody {
  const jsonText =
    rawText.startsWith("event:") || rawText.startsWith("data:")
      ? (rawText
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .pop() ?? "")
      : rawText;
  type Body = {
    result?: { content?: { text?: string }[]; isError?: boolean; _meta?: Record<string, unknown> };
    error?: { code?: number; message?: string };
  };
  let body: Body;
  try {
    body = JSON.parse(jsonText) as Body;
  } catch {
    return { text: rawText, isError: true, unparseable: true };
  }
  if (body === null || typeof body !== "object") return { text: rawText, isError: true, unparseable: true };
  if (body.error)
    return {
      text: body.error.message ?? "error",
      isError: true,
      rpcError: { code: typeof body.error.code === "number" ? body.error.code : null },
    };
  if (!body.result) return { text: rawText, isError: true, unparseable: true };
  const text = (body.result.content ?? []).map((c) => c.text ?? "").join("\n");
  const meta = body.result._meta;
  return { text, isError: Boolean(body.result.isError), ...(meta && typeof meta === "object" ? { meta } : {}) };
}

const DENIAL = /access denied|denied|revoked|forbidden|unauthori[sz]ed/i;

/** The fact lines of a memory_query answer: memory_query renders each served fact on one line starting `•`. */
export function servedFactLines(text: string): string[] {
  return text.split("\n").filter((line) => line.startsWith("•"));
}

/**
 * The real McpCall: a bearer token against `${baseUrl}/api/mcp`. `headers` ride on every call,
 * the way a client's MCP configuration sends them (an `X-Willder-Task` naming the task), and
 * `meta` rides as each call's `_meta` (a `willder/session` naming the session, say). With
 * `timeoutMs`, a call not answered in full by then is abandoned and throws.
 */
export function mcpCallWith(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  headers: Record<string, string> = {},
  meta?: Json,
  timeoutMs?: number,
): McpCall {
  return async (token, tool, args) => {
    const started = performance.now();
    const params = meta ? { name: tool, arguments: args, _meta: meta } : { name: tool, arguments: args };
    const res = await fetchImpl(`${baseUrl}/api/mcp`, {
      method: "POST",
      headers: {
        ...headers,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params }),
      ...(timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(timeoutMs) }),
    });
    const ms = Math.round(performance.now() - started);
    const { text, isError, meta: resultMeta, rpcError, unparseable } = parseMcpBody(await res.text());
    const denied = res.status === 401 || res.status === 403 || (isError && DENIAL.test(text));
    return {
      status: res.status,
      ok: res.status === 200 && !isError,
      denied,
      text,
      factLines: servedFactLines(text),
      ms,
      serverTiming: res.headers.get("server-timing"),
      ...(resultMeta ? { meta: resultMeta } : {}),
      ...(rpcError ? { rpcError } : {}),
      ...(unparseable ? { unparseable } : {}),
    };
  };
}

/**
 * A failed admin request as an Error safe to print anywhere: Playwright's message keeps
 * only its first line, since the call log after it lists the session's cookie header.
 */
export function requestFailure(method: HttpMethod, path: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${method} ${path} failed: ${printableError(message.split("\n")[0] ?? "")}`);
}

/** The real AdminApi: the Playwright context's cookie jar against `${baseUrl}`. */
export function adminApiWith(ctx: BrowserContext, baseUrl: string): AdminApi {
  return async (method, path, body) => {
    const url = `${baseUrl}${path}`;
    const timeout = 120_000;
    const send = () =>
      method === "GET"
        ? ctx.request.get(url, { timeout })
        : method === "DELETE"
          ? ctx.request.delete(url, { timeout })
          : method === "PATCH"
            ? ctx.request.patch(url, { data: body ?? {}, timeout })
            : method === "PUT"
              ? ctx.request.put(url, { data: body ?? {}, timeout })
              : isMultipartBody(body)
                ? ctx.request.post(url, { multipart: body.multipart, timeout })
                : ctx.request.post(url, { data: body ?? {}, timeout });
    const res = await send().catch((error: unknown) => {
      throw requestFailure(method, path, error);
    });
    let json: Json | null = null;
    let text: string | undefined;
    try {
      json = (await res.json()) as Json;
    } catch {
      // Not JSON: keep the body as text, for a caller reading an event stream.
      try {
        text = await res.text();
      } catch {
        /* no body to read */
      }
    }
    return { status: res.status(), json, ...(text === undefined ? {} : { text }) };
  };
}

export interface MintedToken {
  id: string;
  /** The raw bearer value. Held in memory, registered with the vault, never printed. */
  raw: string;
  expiresAt: string | null;
}

/** Mint a capability token through POST /api/access/capabilities and register it with the vault. */
export async function mintToken(
  api: AdminApi,
  vault: SecretVault,
  input: { agentId: string; scopePath: string; permission: "read" | "write"; ttlHours?: number },
): Promise<MintedToken> {
  const r = await api("POST", "/api/access/capabilities", { ...input, ttlHours: input.ttlHours ?? 1 });
  const j = r.json ?? {};
  const raw = str(j.token) ?? "";
  const id = str(j.id) ?? "";
  vault.add(raw);
  if (r.status >= 300 || !raw || !id) {
    throw new Error(
      `mint ${input.permission} for ${input.agentId} on ${input.scopePath} failed: HTTP ${r.status} (keys: ${Object.keys(j).join(",") || "none"})`,
    );
  }
  return { id, raw, expiresAt: str(j.expiresAt) ?? null };
}
