import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The http tool now runs a DNS-resolution SSRF check before fetching (blocks names that
// resolve to private/internal IPs). Default the resolver to a public IP so the fetch-path
// tests exercise the happy path; the DNS-block test overrides it per-call.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));
import { lookup } from "node:dns/promises";

// Tests for the QA-agent execution tools. These live in their own module
// (qa-tools.ts) precisely so the browser/http deps stay out of the runner↔tools↔inngest
// cycle — so, unlike tools.test.ts, we can import them directly with no circular-import
// hazard. Two things under test:
//   (1) resolveAndAssertAllowed — the pure SSRF/allow-list guard (throws on any violation)
//   (2) httpRequestTool.execute — fetches the target and returns status/latency/size, or a
//       structured {error} (never throws), pulling base URL + allow-list + auth from the
//       Mastra RuntimeContext (never from LLM-visible inputs).
import { resolveAndAssertAllowed, httpRequestTool } from "./qa-tools";

// `execute` is typed as possibly-undefined on a Mastra tool; grab it once with a non-null
// assertion so every call site stays terse (mirrors how tools.test.ts calls `.execute`).
const execute = httpRequestTool.execute!;

// A minimal stand-in for the Mastra RuntimeContext: the tool only ever calls `.get(key)`.
// Using a plain object (rather than a real RuntimeContext) lets us hand back arrays for
// qaAllowedHosts without ceremony.
function makeRc(vals: Record<string, unknown> = {}) {
  return { get: (k: string) => vals[k] } as never;
}

const BASE = "https://api.acme.com";
const HOSTS = ["api.acme.com"];

// ---------------------------------------------------------------------------
// resolveAndAssertAllowed — the pure allow-list / SSRF guard
// ---------------------------------------------------------------------------

describe("resolveAndAssertAllowed", () => {
  it("allows a relative path resolved against the target base URL", () => {
    expect(resolveAndAssertAllowed("/health", BASE, HOSTS)).toBe("https://api.acme.com/health");
  });

  it("allows an absolute URL on an allow-listed host", () => {
    expect(resolveAndAssertAllowed("https://api.acme.com/users/1", BASE, HOSTS)).toBe("https://api.acme.com/users/1");
  });

  it("preserves query strings on relative paths", () => {
    expect(resolveAndAssertAllowed("/search?q=hi&n=2", BASE, HOSTS)).toBe("https://api.acme.com/search?q=hi&n=2");
  });

  it("honors multiple allowed hosts", () => {
    const hosts = ["api.acme.com", "cdn.acme.com"];
    expect(resolveAndAssertAllowed("https://cdn.acme.com/img.png", BASE, hosts)).toBe("https://cdn.acme.com/img.png");
  });

  it("is case-insensitive on the host", () => {
    expect(resolveAndAssertAllowed("https://API.Acme.Com/x", BASE, ["api.acme.com"])).toBe("https://api.acme.com/x");
    // and the other direction: mixed-case allow-list entry, lowercase URL
    expect(resolveAndAssertAllowed("https://api.acme.com/x", BASE, ["API.ACME.COM"])).toBe("https://api.acme.com/x");
  });

  it("blocks an off-target host not in the allow-list", () => {
    expect(() => resolveAndAssertAllowed("https://evil.com/steal", BASE, HOSTS)).toThrow(/not in the allow-list/);
  });

  it("blocks a host that matches only a suffix of an allowed host", () => {
    // notacme.com must NOT satisfy an allow-list of acme.com — exact host match only.
    expect(() => resolveAndAssertAllowed("https://notapi.acme.com.evil.com/x", BASE, HOSTS)).toThrow(
      /not in the allow-list/,
    );
  });

  it("blocks loopback 127.0.0.1", () => {
    expect(() => resolveAndAssertAllowed("http://127.0.0.1:3000/x", BASE, ["127.0.0.1:3000"])).toThrow(
      /private\/loopback\/metadata/,
    );
  });

  it("blocks localhost (and *.localhost)", () => {
    expect(() => resolveAndAssertAllowed("http://localhost:8080/x", BASE, ["localhost:8080"])).toThrow(
      /private\/loopback\/metadata/,
    );
    expect(() => resolveAndAssertAllowed("http://app.localhost/x", BASE, ["app.localhost"])).toThrow(
      /private\/loopback\/metadata/,
    );
  });

  it("blocks the 10.0.0.0/8 private range", () => {
    expect(() => resolveAndAssertAllowed("http://10.1.2.3/x", BASE, ["10.1.2.3"])).toThrow(
      /private\/loopback\/metadata/,
    );
  });

  it("blocks the 192.168.0.0/16 private range", () => {
    expect(() => resolveAndAssertAllowed("http://192.168.1.10/x", BASE, ["192.168.1.10"])).toThrow(
      /private\/loopback\/metadata/,
    );
  });

  it("blocks the 172.16.0.0/12 private range (16 and 31), allows 172.15 / 172.32 shape", () => {
    expect(() => resolveAndAssertAllowed("http://172.16.0.1/x", BASE, ["172.16.0.1"])).toThrow(
      /private\/loopback\/metadata/,
    );
    expect(() => resolveAndAssertAllowed("http://172.31.255.1/x", BASE, ["172.31.255.1"])).toThrow(
      /private\/loopback\/metadata/,
    );
    // 172.15 and 172.32 are NOT in the private block; they fail the allow-list instead,
    // proving the guard didn't over-block outside 16-31.
    expect(() => resolveAndAssertAllowed("http://172.15.0.1/x", BASE, HOSTS)).toThrow(/not in the allow-list/);
    expect(() => resolveAndAssertAllowed("http://172.32.0.1/x", BASE, HOSTS)).toThrow(/not in the allow-list/);
  });

  it("blocks link-local / cloud metadata 169.254.169.254", () => {
    expect(() =>
      resolveAndAssertAllowed("http://169.254.169.254/latest/meta-data/", BASE, ["169.254.169.254"]),
    ).toThrow(/private\/loopback\/metadata/);
  });

  it("blocks 0.0.0.0 and the GCP metadata hostname", () => {
    expect(() => resolveAndAssertAllowed("http://0.0.0.0/x", BASE, ["0.0.0.0"])).toThrow(/private\/loopback\/metadata/);
    expect(() =>
      resolveAndAssertAllowed("http://metadata.google.internal/x", BASE, ["metadata.google.internal"]),
    ).toThrow(/private\/loopback\/metadata/);
  });

  it("blocks non-http(s) schemes before the allow-list is even consulted", () => {
    expect(() => resolveAndAssertAllowed("file:///etc/passwd", BASE, HOSTS)).toThrow(/only http\/https/);
    expect(() => resolveAndAssertAllowed("ftp://api.acme.com/x", BASE, HOSTS)).toThrow(/only http\/https/);
  });

  it("reports 'none' when the allow-list is empty", () => {
    expect(() => resolveAndAssertAllowed("https://api.acme.com/x", BASE, [])).toThrow(
      /allow-list for this run \(none\)/,
    );
  });
});

// ---------------------------------------------------------------------------
// httpRequestTool.execute — the http_request tool
// ---------------------------------------------------------------------------

// Build a fake Response the tool can read via .status/.ok/.text()/.headers.entries().
function fakeResponse(opts: { status?: number; ok?: boolean; body?: string; headers?: Record<string, string> }) {
  const status = opts.status ?? 200;
  return {
    status,
    ok: opts.ok ?? (status >= 200 && status < 300),
    text: async () => opts.body ?? "",
    headers: { entries: () => Object.entries(opts.headers ?? {}) },
  };
}

describe("httpRequestTool.execute", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns status, latencyMs, sizeBytes, headers and body on success", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      fakeResponse({ status: 200, body: '{"ok":true}', headers: { "content-type": "application/json" } }) as never,
    );
    const res = (await execute({
      context: { method: "GET", path: "/health" },
      runtimeContext: makeRc({ qaTargetBaseUrl: BASE, qaAllowedHosts: HOSTS }),
    } as never)) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(typeof res.latencyMs).toBe("number");
    expect(res.sizeBytes).toBe(Buffer.byteLength('{"ok":true}'));
    expect(res.headers).toMatchObject({ "content-type": "application/json" });
    expect(res.body).toBe('{"ok":true}');
    expect(res.error).toBeUndefined();
    expect(global.fetch).toHaveBeenCalledOnce();
    // The resolved absolute URL is what gets fetched.
    expect(vi.mocked(global.fetch).mock.calls[0][0]).toBe("https://api.acme.com/health");
  });

  it("returns {error} and does NOT call fetch when the host is blocked", async () => {
    const res = (await execute({
      context: { method: "GET", path: "https://evil.com/pwn" },
      runtimeContext: makeRc({ qaTargetBaseUrl: BASE, qaAllowedHosts: HOSTS }),
    } as never)) as Record<string, unknown>;

    expect(res.error).toMatch(/not in the allow-list/);
    expect(res.status).toBeUndefined();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns {error} and does NOT call fetch when no base URL is in runtime context", async () => {
    const res = (await execute({
      context: { method: "GET", path: "/health" },
      runtimeContext: makeRc({ qaAllowedHosts: HOSTS }),
    } as never)) as Record<string, unknown>;

    expect(res.error).toMatch(/requires a target base URL/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("injects the Authorization header from runtime context when provided", async () => {
    vi.mocked(global.fetch).mockResolvedValue(fakeResponse({ status: 200, body: "ok" }) as never);
    await execute({
      context: { method: "GET", path: "/me" },
      runtimeContext: makeRc({
        qaTargetBaseUrl: BASE,
        qaAllowedHosts: HOSTS,
        qaAuthHeader: "Bearer secret-token",
      }),
    } as never);

    const init = vi.mocked(global.fetch).mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret-token");
  });

  it("does not overwrite an Authorization header the model already supplied", async () => {
    vi.mocked(global.fetch).mockResolvedValue(fakeResponse({ status: 200, body: "ok" }) as never);
    await execute({
      context: { method: "GET", path: "/me", headers: { Authorization: "Bearer model-chosen" } },
      runtimeContext: makeRc({
        qaTargetBaseUrl: BASE,
        qaAllowedHosts: HOSTS,
        qaAuthHeader: "Bearer context-token",
      }),
    } as never);

    const init = vi.mocked(global.fetch).mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer model-chosen");
  });

  it("does not send a body on GET/HEAD requests", async () => {
    vi.mocked(global.fetch).mockResolvedValue(fakeResponse({ status: 200, body: "ok" }) as never);
    await execute({
      context: { method: "GET", path: "/x", body: "should-be-ignored" },
      runtimeContext: makeRc({ qaTargetBaseUrl: BASE, qaAllowedHosts: HOSTS }),
    } as never);
    const init = vi.mocked(global.fetch).mock.calls[0][1] as RequestInit;
    expect(init.body).toBeUndefined();
  });

  it("sends the body on non-GET requests (e.g. POST)", async () => {
    vi.mocked(global.fetch).mockResolvedValue(fakeResponse({ status: 201, body: "" }) as never);
    await execute({
      context: { method: "POST", path: "/users", body: '{"name":"x"}' },
      runtimeContext: makeRc({ qaTargetBaseUrl: BASE, qaAllowedHosts: HOSTS }),
    } as never);
    const init = vi.mocked(global.fetch).mock.calls[0][1] as RequestInit;
    expect(init.body).toBe('{"name":"x"}');
    expect(init.method).toBe("POST");
  });

  it("returns {error, unreachable:true} with a latencyMs when fetch throws — never propagates", async () => {
    vi.mocked(global.fetch).mockRejectedValue(new Error("ECONNREFUSED"));
    const res = (await execute({
      context: { method: "GET", path: "/down" },
      runtimeContext: makeRc({ qaTargetBaseUrl: BASE, qaAllowedHosts: HOSTS }),
    } as never)) as Record<string, unknown>;

    expect(res.error).toMatch(/ECONNREFUSED/);
    expect(res.unreachable).toBe(true);
    expect(typeof res.latencyMs).toBe("number");
    expect(res.status).toBeUndefined();
  });

  it("truncates very large response bodies", async () => {
    const big = "x".repeat(30_000);
    vi.mocked(global.fetch).mockResolvedValue(fakeResponse({ status: 200, body: big }) as never);
    const res = (await execute({
      context: { method: "GET", path: "/big" },
      runtimeContext: makeRc({ qaTargetBaseUrl: BASE, qaAllowedHosts: HOSTS }),
    } as never)) as Record<string, unknown>;
    expect(String(res.body)).toContain("…[truncated]");
    expect(String(res.body).length).toBeLessThan(big.length);
  });

  it("defaults the allow-list to the empty list when none is in context (blocks all)", async () => {
    const res = (await execute({
      context: { method: "GET", path: "/health" },
      runtimeContext: makeRc({ qaTargetBaseUrl: BASE }),
    } as never)) as Record<string, unknown>;
    // baseUrl host isn't in an (empty) allow-list, so it's blocked before any fetch.
    expect(res.error).toMatch(/not in the allow-list/);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// SSRF hardening: IPv6, trailing-dot, and DNS-resolution bypasses
// ---------------------------------------------------------------------------
describe("resolveAndAssertAllowed — IPv6 + trailing-dot bypasses", () => {
  const B = "https://api.acme.com";
  const block = (url: string, hosts: string[] = ["api.acme.com"]) =>
    expect(() => resolveAndAssertAllowed(url, B, hosts)).toThrow();

  it("blocks IPv6 loopback [::1] even if allow-listed", () => block("http://[::1]/", ["[::1]"]));
  it("blocks IPv4-mapped IPv6 loopback", () => block("http://[::ffff:127.0.0.1]/", ["[::ffff:127.0.0.1]"]));
  it("blocks IPv4-mapped IPv6 metadata", () => block("http://[::ffff:169.254.169.254]/", ["[::ffff:169.254.169.254]"]));
  it("blocks unique-local fc00::/7", () => block("http://[fc00::1]/", ["[fc00::1]"]));
  it("blocks link-local fe80::/10", () => block("http://[fe80::1]/", ["[fe80::1]"]));
  it("blocks trailing-dot GCP metadata", () =>
    block("http://metadata.google.internal./", ["metadata.google.internal."]));
  it("blocks trailing-dot localhost", () => block("http://localhost./", ["localhost."]));
  it("still allows the normal target host", () =>
    expect(resolveAndAssertAllowed("/x", B, ["api.acme.com"])).toBe("https://api.acme.com/x"));
});

describe("httpRequestTool.execute — DNS-resolution SSRF guard", () => {
  const execute = httpRequestTool.execute!;
  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("blocks a name that resolves to a private IP, without fetching", async () => {
    vi.mocked(lookup).mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }] as never);
    const res = (await execute({
      context: { method: "GET", path: "/x" },
      runtimeContext: makeRc({ qaTargetBaseUrl: "https://api.acme.com", qaAllowedHosts: ["api.acme.com"] }),
    } as never)) as Record<string, unknown>;
    expect(res.error).toMatch(/private\/internal address/);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
