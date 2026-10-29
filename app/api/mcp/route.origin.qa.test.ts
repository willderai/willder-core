import { afterEach, describe, expect, it, vi } from "vitest";

// QA edge cases for the Origin check on /api/mcp (app/api/mcp/origin.ts), written by the
// reviewer, not the author. Two layers:
//
// - The route: a foreign Origin with no bearer token must get the Origin 403, not the 401 a
//   missing token gets. Removing the check from POST, GET or DELETE turns that 403 into a 401,
//   so each method's guard has its own failing case without needing a database.
// - checkOrigin itself: the spellings a rebinding page or a sloppy comparison could slip
//   through (opaque and empty origins, scheme and port variants of the allowed origin, case,
//   look-alike host names), and the native clients that send no Origin at all.
//
// Only db.capability.findUnique is faked, as in route.get.test.ts: it returns a live row for
// the one issued token's hash and nothing for any other.

vi.mock("@/lib/db", () => ({
  db: {
    capability: { findUnique: vi.fn() },
    agent: { count: vi.fn().mockResolvedValue(0) },
    auditLog: { create: vi.fn(async () => ({ id: "al_1" })) },
  },
}));

import { db } from "@/lib/db";
import { generateCapabilityToken, hashCapabilityToken } from "@/services/access";
import { checkOrigin } from "./origin";
import * as route from "./route";

const token = generateCapabilityToken();
const tokenHash = hashCapabilityToken(token);

vi.mocked(db.capability.findUnique).mockImplementation((async (args: { where: { tokenHash: string } }) =>
  args.where.tokenHash === tokenHash
    ? {
        id: "cap_origin_qa",
        orgId: "org_origin_qa",
        agentId: "agent_origin_qa",
        scopePath: "org_origin_qa",
        revokedAt: null,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }
    : null) as unknown as typeof db.capability.findUnique);

const APP = "https://willder.ai";
const PUBLIC = "https://willder.ai/api/mcp";
const PREVIEW = "https://willder-git-branch.vercel.app/api/mcp";
const LOOPBACK = "http://localhost:3000/api/mcp";

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "origin-qa", version: "0" } },
});

function request(url: string, method: string, headers: Record<string, string>): Request {
  return new Request(url, {
    method,
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json", ...headers },
    body: method === "POST" ? INITIALIZE : undefined,
  });
}

/** Whether checkOrigin serves `origin` on `url`; the configuration is APP unless one is passed, `undefined` included. */
function allowed(url: string, origin: string | null, ...config: [appUrl: string | undefined] | []): boolean {
  const headers: Record<string, string> = origin === null ? {} : { origin };
  return checkOrigin(new Request(url, { headers }), config.length === 0 ? APP : config[0]).allowed;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the route refuses a foreign Origin before it asks for a token", () => {
  // A rebinding page: its own name in Host and in Origin, reaching a loopback server.
  const REBOUND = "http://evil.example.com/api/mcp";
  const handlers = { POST: route.POST, GET: route.GET, DELETE: route.DELETE } as const;

  it.each(Object.keys(handlers) as (keyof typeof handlers)[])(
    "%s with a foreign Origin and no bearer token gets 403, not 401",
    async (method) => {
      vi.stubEnv("NEXT_PUBLIC_APP_URL", APP);
      const res = await handlers[method](request(REBOUND, method, { origin: "http://evil.example.com" }));

      expect(res.status).toBe(403);
      expect((await res.json()).error.message).toMatch(/does not accept requests from the Origin/);
    },
  );

  it.each(Object.keys(handlers) as (keyof typeof handlers)[])(
    "%s with no Origin and no bearer token still gets the 401 a native client gets",
    async (method) => {
      vi.stubEnv("NEXT_PUBLIC_APP_URL", APP);
      const res = await handlers[method](request(LOOPBACK, method, {}));

      expect(res.status).toBe(401);
    },
  );

  it.each([
    ["Claude Code", "claude-code/2.1.290"],
    ["the mcp-remote bridge", "node"],
    ["the willder CLI", "willder-cli/0.1.0"],
  ])("serves %s, which sends no Origin, whatever NEXT_PUBLIC_APP_URL holds", async (_client, userAgent) => {
    for (const appUrl of [APP, "", "http://localhost:3000", "not a url"]) {
      vi.stubEnv("NEXT_PUBLIC_APP_URL", appUrl);
      for (const url of [PUBLIC, PREVIEW, LOOPBACK]) {
        const res = await route.POST(
          request(url, "POST", { authorization: `Bearer ${token}`, "user-agent": userAgent }),
        );
        expect(res.status, `${url} with NEXT_PUBLIC_APP_URL=${JSON.stringify(appUrl)}`).toBe(200);
      }
    }
  });

  it("exports no OPTIONS handler and sets no CORS header, so a browser preflight cannot succeed", async () => {
    // Next answers OPTIONS for a route without one with 204 and an Allow header only; a
    // cross-origin page whose bearer-carrying request needs a preflight is stopped there.
    expect("OPTIONS" in route).toBe(false);
    vi.stubEnv("NEXT_PUBLIC_APP_URL", APP);
    const served = await route.POST(
      request(PUBLIC, "POST", { authorization: `Bearer ${token}`, origin: "https://claude.ai" }),
    );
    expect(served.status).toBe(200);
    const corsHeaders = [...served.headers.keys()].filter((name) => name.startsWith("access-control-"));
    expect(corsHeaders).toEqual([]);
  });
});

describe("checkOrigin edge cases", () => {
  it("lets a request with no Origin through on every host and every configuration", () => {
    for (const appUrl of [APP, undefined, "", "   ", "http://willder.ai", "localhost:3000", "https://localhost"]) {
      for (const url of [PUBLIC, PREVIEW, LOOPBACK, "http://evil.example.com/api/mcp"]) {
        expect(allowed(url, null, appUrl), `${url} ${String(appUrl)}`).toBe(true);
      }
    }
  });

  it.each(["null", "NULL", "", " ", "file://", "file:///etc/passwd", "about:blank", "data:text/html,x", "*"])(
    "refuses the opaque or unparsable Origin %j everywhere, the public origin and loopback included",
    (origin) => {
      for (const url of [PUBLIC, PREVIEW, LOOPBACK]) expect(allowed(url, origin), url).toBe(false);
    },
  );

  it("treats the allowed origin with another scheme or port as a different origin off its public host", () => {
    expect(allowed(PREVIEW, "https://willder.ai")).toBe(true);
    expect(allowed(PREVIEW, "https://willder.ai:443")).toBe(true); // the default port is the same origin
    expect(allowed(PREVIEW, "http://willder.ai")).toBe(false);
    expect(allowed(PREVIEW, "https://willder.ai:8443")).toBe(false);
    expect(allowed(PREVIEW, "https://www.willder.ai")).toBe(false);
    // The request must reach the public origin itself: same host on plain http or another port is not it.
    expect(allowed("http://willder.ai/api/mcp", "https://claude.ai")).toBe(false);
    expect(allowed("https://willder.ai:8443/api/mcp", "https://claude.ai")).toBe(false);
  });

  it("compares host names without regard to case, in Origin, the request URL and the configuration", () => {
    expect(allowed(PREVIEW, "HTTPS://WILLDER.AI")).toBe(true);
    expect(allowed(PREVIEW, "https://willder.ai", "HTTPS://Willder.AI/")).toBe(true);
    expect(allowed("https://WILLDER.ai/api/mcp", "https://claude.ai")).toBe(true);
    expect(allowed("http://LOCALHOST:3000/api/mcp", "http://LocalHost:5173")).toBe(true);
    expect(allowed("http://EVIL.example.com/api/mcp", "http://EVIL.example.com")).toBe(false);
  });

  it("refuses look-alike names of the public origin and of loopback", () => {
    for (const origin of ["https://willder.ai.evil.com", "https://evilwillder.ai", "https://willder.ai@evil.com"]) {
      // `https://willder.ai@evil.com` parses to host evil.com: userinfo is not the host.
      expect(allowed(PREVIEW, origin), origin).toBe(false);
    }
    // Rebinding names that resolve to loopback but are not loopback literals.
    for (const host of ["localhost.evil.com", "127.0.0.1.nip.io", "localtest.me"]) {
      expect(allowed(`http://${host}:3000/api/mcp`, `http://${host}:3000`), host).toBe(false);
      expect(allowed(LOOPBACK, `http://${host}:3000`), `${host} against loopback`).toBe(false);
    }
  });

  it("serves a loopback page on any loopback port or scheme, and only on a loopback request", () => {
    expect(allowed(LOOPBACK, "http://localhost:5173")).toBe(true);
    expect(allowed(LOOPBACK, "https://127.0.0.1")).toBe(true);
    expect(allowed(LOOPBACK, "http://[::1]:8080")).toBe(true);
    expect(allowed(PREVIEW, "http://localhost:3000")).toBe(false);
  });

  it("refuses every foreign Origin when the configuration cannot name a public https origin", () => {
    for (const appUrl of [undefined, "", "http://willder.ai", "https://localhost:3000", "willder.ai"]) {
      expect(allowed(PUBLIC, "https://claude.ai", appUrl), String(appUrl)).toBe(false);
    }
  });
});
