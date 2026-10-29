// What /api/mcp answers a client without a usable token, with MCP OAuth
// discovery off and on, and that a capability token is served the same either
// way. Calls go through the real route handlers. The first block needs no
// database: a request with no token is refused before any lookup. The second
// block is database-gated: it runs only when QA_DATABASE_URL names an
// isolated, migrated test Postgres, and is skipped, not failed, without it.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
// Leaf module, not the `@/services/access` barrel: the barrel builds the
// `@/lib/db` singleton at import time, before beforeAll can point DATABASE_URL
// at the QA database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import { GET as getProtectedResourceMetadata } from "@/app/.well-known/oauth-protected-resource/api/mcp/route";

const QA_URL = process.env.QA_DATABASE_URL;

const ORIGIN = "https://willder.test";
const MCP_URL = `${ORIGIN}/api/mcp`;

const TOOLS_LIST = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}';

// The 401 bodies exactly as /api/mcp sent them before OAuth discovery existed.
const MISSING_TOKEN_BODY =
  '{"jsonrpc":"2.0","error":{"code":-32000,"message":"Missing bearer capability token. Issue one in Access, then Tokens, and send it as Authorization: Bearer <token>."},"id":null}';
const UNKNOWN_TOKEN_BODY =
  '{"jsonrpc":"2.0","error":{"code":-32000,"message":"Invalid or unknown capability token."},"id":null}';
const CHALLENGE = `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/mcp", scope="memory:read memory:write"`;

let route: typeof import("./route");

// The route's import graph is large; a loaded machine can take longer than the 10 s default.
beforeAll(async () => {
  if (QA_URL) process.env.DATABASE_URL = QA_URL;
  route = await import("./route");
}, 60_000);

beforeEach(() => {
  vi.stubEnv("MCP_OAUTH_RESOURCES", MCP_URL);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function post(headers: Record<string, string>, body = TOOLS_LIST): Promise<Response> {
  return route.POST(
    new Request(MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body,
    }),
  );
}

/** A response's status, headers and body; Server-Timing is left out, since its durations differ on every request. */
async function readResponse(res: Response) {
  const headers = [...res.headers.entries()].filter(([name]) => name !== "server-timing");
  return { status: res.status, headers, body: await res.text() };
}

describe("a request without a bearer token on /api/mcp", () => {
  it("gets the same 401 as before, with no challenge header, while MCP_OAUTH_ENABLED is off", async () => {
    vi.stubEnv("MCP_OAUTH_ENABLED", "");

    expect(await readResponse(await post({}))).toEqual({
      status: 401,
      headers: [["content-type", "application/json"]],
      body: MISSING_TOKEN_BODY,
    });
    expect(await readResponse(await route.GET(new Request(MCP_URL, { method: "GET" })))).toEqual({
      status: 401,
      headers: [["content-type", "application/json"]],
      body: MISSING_TOKEN_BODY,
    });
  });

  it("gets the same 401 plus a challenge naming the protected-resource metadata while MCP_OAUTH_ENABLED is on", async () => {
    vi.stubEnv("MCP_OAUTH_ENABLED", "true");

    expect(await readResponse(await post({}))).toEqual({
      status: 401,
      headers: [
        ["content-type", "application/json"],
        ["www-authenticate", CHALLENGE],
      ],
      body: MISSING_TOKEN_BODY,
    });
    expect((await route.GET(new Request(MCP_URL, { method: "GET" }))).headers.get("www-authenticate")).toBe(CHALLENGE);
  });

  it("is pointed at metadata that names the very URL it called as the resource", async () => {
    vi.stubEnv("MCP_OAUTH_ENABLED", "true");

    const challenge = (await post({})).headers.get("www-authenticate") ?? "";
    const metadataUrl = /^Bearer resource_metadata="([^"]+)"/.exec(challenge)?.[1] ?? "";
    expect(metadataUrl).not.toBe("");

    const metadata = await getProtectedResourceMetadata(new Request(metadataUrl, { method: "GET" })).json();
    expect(metadata.resource).toBe(MCP_URL);
  });
});

describe.skipIf(!QA_URL)("a capability token on /api/mcp, against a real database", () => {
  const ORG = "org-qa-mcp-oauth-challenge";
  let db: PrismaClient;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  beforeEach(async () => {
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.capability.deleteMany({ where: { orgId: ORG } });
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
  });

  async function mintReadToken(): Promise<string> {
    const raw = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId: "agent-oauth-challenge",
        tokenHash: hashCapabilityToken(raw),
        scopePath: "org_qa.sales",
        permission: "read",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return raw;
  }

  it("serves a live token the same response whether MCP_OAUTH_ENABLED is off or on", async () => {
    const token = await mintReadToken();

    vi.stubEnv("MCP_OAUTH_ENABLED", "");
    const off = await readResponse(await post({ authorization: `Bearer ${token}` }));
    vi.stubEnv("MCP_OAUTH_ENABLED", "true");
    const on = await readResponse(await post({ authorization: `Bearer ${token}` }));

    expect(off.status).toBe(200);
    expect(JSON.parse(off.body).result.tools.length).toBeGreaterThan(0);
    expect(on).toEqual(off);
  });

  it("refuses an unknown token with the same 401 as before, adding only the challenge when on", async () => {
    vi.stubEnv("MCP_OAUTH_ENABLED", "");
    expect(await readResponse(await post({ authorization: "Bearer wcap_test_never_minted" }))).toEqual({
      status: 401,
      headers: [["content-type", "application/json"]],
      body: UNKNOWN_TOKEN_BODY,
    });

    vi.stubEnv("MCP_OAUTH_ENABLED", "true");
    expect(await readResponse(await post({ authorization: "Bearer wcap_test_never_minted" }))).toEqual({
      status: 401,
      headers: [
        ["content-type", "application/json"],
        ["www-authenticate", CHALLENGE],
      ],
      body: UNKNOWN_TOKEN_BODY,
    });
  });

  it("refuses a revoked token with the challenge when on, and records the refusal as before", async () => {
    const token = await mintReadToken();
    await db.capability.updateMany({ where: { orgId: ORG }, data: { revokedAt: new Date() } });
    vi.stubEnv("MCP_OAUTH_ENABLED", "true");

    const res = await post({ authorization: `Bearer ${token}` });

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(CHALLENGE);
    expect(await db.auditLog.count({ where: { orgId: ORG, action: "capability.refused" } })).toBe(1);
  });
});
