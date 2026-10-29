import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The keep-warm cron ping on GET /api/mcp (./keep-warm.ts). vercel.json schedules a Vercel cron
// GET of this route every minute; with CRON_SECRET set, Vercel sends `Authorization: Bearer
// <CRON_SECRET>` and the route answers 204 before authentication, touching no database.
// Everything else on the route must answer as it did before: a wrong or missing secret gets
// the same 401, a live token the same 405, a foreign Origin the same 403, and POST never
// looks at the cron secret.
//
// The database is faked as in route.get.test.ts (a live row for the one issued token's hash,
// nothing for any other), and every model the route reaches is recorded, so "touches no
// database" is asserted on what the handler did, not assumed.

const touched: string[] = [];

vi.mock("@/lib/db", () => {
  const models = {
    capability: { findUnique: vi.fn() },
    agent: { count: vi.fn().mockResolvedValue(0) },
    auditLog: { create: vi.fn(async () => ({ id: "al_1" })) },
  };
  const db = new Proxy(models, {
    get(target, property, receiver) {
      if (typeof property === "string") touched.push(property);
      return Reflect.get(target, property, receiver);
    },
  });
  return { db };
});

import { db } from "@/lib/db";
import { generateCapabilityToken, hashCapabilityToken } from "@/services/access";
import { GET, POST, DELETE } from "./route";

const token = generateCapabilityToken();
const tokenHash = hashCapabilityToken(token);

vi.mocked(db.capability.findUnique).mockImplementation((async (args: { where: { tokenHash: string } }) =>
  args.where.tokenHash === tokenHash
    ? {
        id: "cap_keep_warm",
        orgId: "org_keep_warm",
        agentId: "agent_keep_warm",
        scopePath: "org_org_keep_warm",
        revokedAt: null,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }
    : null) as unknown as typeof db.capability.findUnique);

const SECRET = "c0ffee-keep-warm-secret-0123456789abcdef";
const PUBLIC = "https://willder.ai/api/mcp";

function get(headers: Record<string, string>, url = PUBLIC): Promise<Response> {
  return GET(new Request(url, { method: "GET", headers }));
}

beforeEach(() => {
  touched.length = 0;
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://willder.ai");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/mcp with CRON_SECRET set", () => {
  beforeEach(() => vi.stubEnv("CRON_SECRET", SECRET));

  it("answers Vercel's cron request 204 with no body, before authentication and without touching the database", async () => {
    const res = await get({ authorization: `Bearer ${SECRET}`, "user-agent": "vercel-cron/1.0" });

    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(res.headers.get("www-authenticate")).toBeNull();
    expect(res.headers.get("allow")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(touched).toEqual([]);
  });

  it("answers a HEAD with the secret 204 too, since Next serves HEAD through GET", async () => {
    const res = await GET(new Request(PUBLIC, { method: "HEAD", headers: { authorization: `Bearer ${SECRET}` } }));

    expect(res.status).toBe(204);
    expect(touched).toEqual([]);
  });

  it("matches a CRON_SECRET stored with a trailing newline", async () => {
    vi.stubEnv("CRON_SECRET", `${SECRET}\n`);

    const res = await get({ authorization: `Bearer ${SECRET}` });

    expect(res.status).toBe(204);
  });

  it("answers a wrong secret the 401 an unknown token gets", async () => {
    const res = await get({ authorization: `Bearer ${SECRET}x` });

    expect(res.status).toBe(401);
    expect((await res.json()).error.message).toMatch(/Invalid or unknown capability token/);
  });

  it.each([
    ["lower-case scheme", `bearer ${SECRET}`],
    ["two spaces", `Bearer  ${SECRET}`],
    ["the secret twice", `Bearer ${SECRET}${SECRET}`],
    ["no scheme", SECRET],
    ["a prefix of the secret", `Bearer ${SECRET.slice(0, -1)}`],
  ])("does not take a near miss (%s) for the cron secret", async (_label, authorization) => {
    const res = await get({ authorization });

    expect(res.status).toBe(401);
  });

  it("answers a request with no Authorization the same 401 as before, without touching the database", async () => {
    const res = await get({ "user-agent": "vercel-cron/1.0" });

    expect(res.status).toBe(401);
    expect((await res.json()).error.message).toMatch(/Missing bearer capability token/);
    expect(touched).toEqual([]);
  });

  it("still answers a live capability token 405", async () => {
    const res = await get({ accept: "text/event-stream", authorization: `Bearer ${token}` });

    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST, DELETE");
  });

  it("refuses a DNS-rebinding Origin with the 403 even when it carries the cron secret", async () => {
    const res = await get(
      { origin: "http://evil.example.com", authorization: `Bearer ${SECRET}` },
      "http://evil.example.com/api/mcp",
    );

    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toMatch(/Forbidden/);
    expect(touched).toEqual([]);
  });

  it("answers the cron secret 204 with the app's own Origin", async () => {
    const res = await get({ origin: "https://willder.ai", authorization: `Bearer ${SECRET}` });

    expect(res.status).toBe(204);
  });

  it.each([
    ["POST", POST],
    ["DELETE", DELETE],
  ] as const)("does not let %s run as the cron secret: it is not a capability token", async (method, handler) => {
    const res = await handler(
      new Request(PUBLIC, {
        method,
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          authorization: `Bearer ${SECRET}`,
        },
        body:
          method === "POST" ? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) : undefined,
      }),
    );

    expect(res.status).toBe(401);
    expect((await res.json()).error.message).toMatch(/Invalid or unknown capability token/);
  });
});

describe("GET /api/mcp with the cron branch off", () => {
  it.each([
    ["unset", undefined],
    ["blank", "   "],
    ["shorter than 16 characters", "short-secret"],
  ])("answers `Bearer <CRON_SECRET>` as an unknown token when CRON_SECRET is %s", async (_label, value) => {
    if (value !== undefined) vi.stubEnv("CRON_SECRET", value);
    else vi.stubEnv("CRON_SECRET", undefined as unknown as string);

    const res = await get({ authorization: `Bearer ${value ?? "undefined"}` });

    expect(res.status).toBe(401);
  });

  it("answers Vercel's cron request (no Authorization when CRON_SECRET is unset) the existing 401, without touching the database", async () => {
    vi.stubEnv("CRON_SECRET", undefined as unknown as string);

    const res = await get({ "user-agent": "vercel-cron/1.0" });

    expect(res.status).toBe(401);
    expect((await res.json()).error.message).toMatch(/Missing bearer capability token/);
    expect(touched).toEqual([]);
  });
});

describe("the vercel.json cron", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
  const config = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8")) as {
    crons?: { path: string; schedule: string }[];
  };

  it("pings /api/mcp every minute, the route real MCP calls are served by, with no query string", () => {
    expect(config.crons).toContainEqual({ path: "/api/mcp", schedule: "* * * * *" });
    expect(readFileSync(join(root, "app/api/mcp/route.ts"), "utf8")).toMatch(/export async function GET\(/);
  });
});
