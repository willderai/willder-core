// QA-agent execution tools. Unlike the shared memory tools in `tools.ts`, these DRIVE
// a running product black-box. Kept in their own module (not in TOOL_REGISTRY) so:
//   (1) they don't pollute the tool picker for every other agent, and
//   (2) heavy/lazy deps (the browser driver) never enter the runner↔tools↔inngest cycle.
// The target host allow-list + auth ride the Mastra RuntimeContext (set by runQaAgent),
// never as LLM-visible inputs — so the model can't be talked into hitting a new host.
import { createTool } from "@mastra/core";
import type { AgentRuntimeContext } from "./runtime-context";
import { lookup } from "node:dns/promises";
import { z } from "zod";

/** Normalize a URL hostname for comparison: lowercase, strip IPv6 brackets and a single
 *  trailing dot (both are SSRF bypass vectors — `[::1]` and `metadata.google.internal.`). */
function normalizeHost(hostname: string): string {
  let h = hostname.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

function isPrivateIPv4(ip: string): boolean {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 127 || a === 10 || a === 0) return true; // loopback / private / this-host
  if (a === 192 && b === 168) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 169 && b === 254) return true; // link-local + AWS/GCP metadata (169.254.169.254)
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const h = ip.toLowerCase();
  if (h === "::1" || h === "::") return true; // loopback / unspecified
  // IPv4-mapped (::ffff:127.0.0.1 or hex ::ffff:7f00:1) — unwrap to the v4 and reuse v4 rules.
  const mapped = h.match(/^::ffff:(.+)$/i);
  if (mapped) {
    const rest = mapped[1];
    if (rest.includes(".")) return isPrivateIPv4(rest);
    const parts = rest.split(":");
    if (parts.length === 2) {
      const hi = parseInt(parts[0], 16);
      const lo = parseInt(parts[1], 16);
      if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
        return isPrivateIPv4(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`);
      }
    }
  }
  const firstHextet = parseInt(h.split(":")[0] || "", 16);
  if (!Number.isNaN(firstHextet)) {
    const hiByte = (firstHextet >> 8) & 0xff;
    if (hiByte >= 0xfc && hiByte <= 0xfd) return true; // fc00::/7 unique-local
    if (firstHextet >= 0xfe80 && firstHextet <= 0xfebf) return true; // fe80::/10 link-local
  }
  return false;
}

/** Hosts/IPs we never allow a black-box test to reach, even if the model asks — blocks the
 *  classic SSRF pivots (loopback, link-local, cloud metadata, private ranges), IPv4 + IPv6. */
function isBlockedHost(hostname: string): boolean {
  const h = normalizeHost(hostname);
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "metadata.google.internal") return true;
  if (h.includes(":")) return isPrivateIPv6(h); // IPv6 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return isPrivateIPv4(h); // IPv4 literal
  return false;
}

/**
 * Defense against DNS-based SSRF: resolve a hostname and reject if ANY resolved address is
 * private/internal (catches names like localtest.me→127.0.0.1 that a literal-string filter
 * misses). IP literals are already covered by isBlockedHost, so they short-circuit. This
 * runs at request time, not in the pure guard, so the guard stays synchronous + unit-testable.
 * Residual: a rebinding attacker can still flip the record between this check and connect —
 * acceptable under the self-serve/own-product trust model; a pinning egress proxy is the
 * hardening step if that changes.
 */
export async function assertHostResolvesPublic(hostname: string): Promise<void> {
  const h = normalizeHost(hostname);
  if (h.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return; // literal IP — already guarded
  let addrs: { address: string }[];
  try {
    addrs = await lookup(h, { all: true });
  } catch {
    throw new Error(`blocked: could not resolve ${h}`);
  }
  for (const { address } of addrs) {
    if (isBlockedHost(address)) {
      throw new Error(`blocked: ${h} resolves to a private/internal address (${address})`);
    }
  }
}

/**
 * Resolve `pathOrUrl` against the run's target base URL and assert it stays on an
 * allow-listed host. Relative paths ("/health") resolve against baseUrl; absolute URLs
 * must match the allow-list exactly. Throws on any violation — the tool turns that into
 * a structured error the model sees, it does NOT make the request.
 */
export function resolveAndAssertAllowed(pathOrUrl: string, baseUrl: string, allowedHosts: string[]): string {
  const url = new URL(pathOrUrl, baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`blocked: only http/https are allowed (got ${url.protocol})`);
  }
  if (isBlockedHost(url.hostname)) {
    throw new Error(`blocked: ${url.hostname} is a private/loopback/metadata host`);
  }
  // Compare on normalized host (strip trailing dot) so `api.acme.com.` can't dodge the list.
  const stripTrailingDot = (s: string) => s.toLowerCase().replace(/\.(?=(:\d+)?$)/, "");
  const reqHost = stripTrailingDot(url.host);
  const allowed = allowedHosts.map(stripTrailingDot);
  if (!allowed.includes(reqHost)) {
    throw new Error(`blocked: ${url.host} is not in the allow-list for this run (${allowed.join(", ") || "none"})`);
  }
  return url.toString();
}

const MAX_BODY_CHARS = 20_000;

// ---------------------------------------------------------------------------
// Tool: http_request — the core Phase-1 primitive. Sends one request to the target
// under test and returns status + latency + size + (truncated) body/headers. Latency
// is captured on every call, so performance data is a free byproduct of testing.
// ---------------------------------------------------------------------------
export const httpRequestTool = createTool({
  id: "http_request",
  description:
    "Send a single HTTP request to the product under test and observe the response. " +
    "Use this to exercise endpoints: probe happy paths, bad input, auth, and boundaries. " +
    "Returns status code, latencyMs, response size, headers, and a (truncated) body. " +
    "Only the target's own host(s) are reachable; other hosts are rejected.",
  inputSchema: z.object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
    path: z.string().describe("Path (e.g. /api/users/1) or full URL under the target host"),
    headers: z.record(z.string()).optional().describe("Extra request headers"),
    body: z.string().optional().describe("Request body (JSON string or raw text)"),
  }),
  execute: async ({
    context,
    runtimeContext,
  }: {
    context: { method: string; path: string; headers?: Record<string, string>; body?: string };
    runtimeContext: AgentRuntimeContext;
  }) => {
    const baseUrl = runtimeContext.get("qaTargetBaseUrl");
    const allowedHosts = runtimeContext.get("qaAllowedHosts") ?? [];
    const authHeader = runtimeContext.get("qaAuthHeader");
    if (!baseUrl) {
      return { error: "http_request requires a target base URL in runtime context" };
    }

    let url: string;
    try {
      url = resolveAndAssertAllowed(context.path, baseUrl, allowedHosts);
      await assertHostResolvesPublic(new URL(url).hostname);
    } catch (e) {
      return { error: String(e instanceof Error ? e.message : e) };
    }

    const headers: Record<string, string> = { ...(context.headers ?? {}) };
    if (authHeader && !headers["Authorization"] && !headers["authorization"]) {
      headers["Authorization"] = authHeader;
    }

    const start = performance.now();
    try {
      const res = await fetch(url, {
        method: context.method,
        headers,
        body: context.method === "GET" || context.method === "HEAD" ? undefined : context.body,
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
      const latencyMs = Math.round(performance.now() - start);
      const text = await res.text();
      return {
        status: res.status,
        ok: res.ok,
        latencyMs,
        sizeBytes: Buffer.byteLength(text),
        headers: Object.fromEntries(res.headers.entries()),
        body: text.length > MAX_BODY_CHARS ? text.slice(0, MAX_BODY_CHARS) + "\n…[truncated]" : text,
      };
    } catch (e) {
      const latencyMs = Math.round(performance.now() - start);
      // A thrown fetch (timeout, connection refused, DNS) IS a finding — surface it,
      // don't swallow it, so the agent can report the endpoint as broken/unreachable.
      return { error: String(e instanceof Error ? e.message : e), latencyMs, unreachable: true };
    }
  },
});
