// MCP OAuth discovery behind its flag: with MCP_OAUTH_ENABLED off,
// /api/mcp answers every unauthenticated request exactly as it did before the
// flag existed, both metadata routes are absent, and with the flag on no OAuth
// access token is accepted in place of a capability token.
//
// The expected bodies below were captured from main before this change, so
// a flag-off response that gains or changes a header or a byte fails here.
// Database-gated cases run only when QA_DATABASE_URL names an isolated,
// migrated test Postgres, and are skipped, not failed, without it.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getRootMetadata } from "@/app/.well-known/oauth-protected-resource/route";
import { GET as getMcpMetadata } from "@/app/.well-known/oauth-protected-resource/api/mcp/route";
import { GET as getServerMetadata } from "@/app/.well-known/oauth-authorization-server/route";

const QA_URL = process.env.QA_DATABASE_URL;

const ORIGIN = "https://willder.test";
const MCP_URL = `${ORIGIN}/api/mcp`;
const TOOLS_LIST = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}';

const MISSING_TOKEN_BODY =
  '{"jsonrpc":"2.0","error":{"code":-32000,"message":"Missing bearer capability token. Issue one in Access, then Tokens, and send it as Authorization: Bearer <token>."},"id":null}';
const UNKNOWN_TOKEN_BODY =
  '{"jsonrpc":"2.0","error":{"code":-32000,"message":"Invalid or unknown capability token."},"id":null}';
const JSON_ONLY = [["content-type", "application/json"]];

/** A signed JWT naming an issuer, as another OAuth server would issue: never a Willder token. */
function oauthShapedJwt(): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return [
    part({ alg: "RS256", typ: "JWT" }),
    part({
      iss: "https://clerk.example.test",
      sub: "user_qa",
      aud: MCP_URL,
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
    "c2lnbmF0dXJl",
  ].join(".");
}

let route: typeof import("./route");

// The route's import graph is large; a loaded machine can take longer than the 10 s default.
beforeAll(async () => {
  if (QA_URL) process.env.DATABASE_URL = QA_URL;
  route = await import("./route");
}, 60_000);

afterEach(() => {
  vi.unstubAllEnvs();
});

async function post(headers: Record<string, string>) {
  const res = await route.POST(
    new Request(MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: TOOLS_LIST,
    }),
  );
  return { status: res.status, headers: [...res.headers.entries()], body: await res.text() };
}

// Every value that is not exactly `true`, including ones a person might mean as on.
const OFF_VALUES: (string | undefined)[] = [undefined, "", "false", "0", "1", "TRUE", "True", "yes", " true", "true "];

describe.each(OFF_VALUES.map((value) => [JSON.stringify(value) ?? "unset", value]))(
  "MCP_OAUTH_ENABLED=%s",
  (_label, value) => {
    beforeEach(() => {
      vi.stubEnv("MCP_OAUTH_ENABLED", value);
    });

    it.each([
      ["no authorization header", {}],
      ["a non-bearer scheme", { authorization: "Basic dXNlcjpwYXNz" }],
      ["a bare Bearer", { authorization: "Bearer" }],
      ["Bearer with only spaces", { authorization: "Bearer    " }],
    ])("answers %s with the pre-OAuth 401, byte for byte and no challenge", async (_name, headers) => {
      expect(await post(headers)).toEqual({ status: 401, headers: JSON_ONLY, body: MISSING_TOKEN_BODY });
    });

    it("serves no OAuth metadata document", async () => {
      for (const get of [getRootMetadata, getMcpMetadata, getServerMetadata]) {
        const res = get(new Request(`${ORIGIN}/.well-known/oauth-protected-resource`, { method: "GET" }));
        expect(res.status).toBe(404);
        expect(await res.text()).toBe("");
      }
    });
  },
);

describe.skipIf(!QA_URL)("an OAuth access token on /api/mcp, against a real database", () => {
  it.each([
    ["off", ""],
    ["on", "true"],
  ])("is refused as an unknown capability token with the flag %s", async (_label, value) => {
    vi.stubEnv("MCP_OAUTH_ENABLED", value);

    const res = await post({ authorization: `Bearer ${oauthShapedJwt()}` });

    expect(res.status).toBe(401);
    expect(res.body).toBe(UNKNOWN_TOKEN_BODY);
  });

  it("refuses a Willder OAuth access token as an unknown capability token while off", async () => {
    vi.stubEnv("MCP_OAUTH_ENABLED", "");
    expect(await post({ authorization: "Bearer wat_qa_never_issued" })).toEqual({
      status: 401,
      headers: JSON_ONLY,
      body: UNKNOWN_TOKEN_BODY,
    });
  });

  it("refuses an unknown token with the pre-OAuth 401, byte for byte, while off", async () => {
    vi.stubEnv("MCP_OAUTH_ENABLED", "");
    expect(await post({ authorization: "Bearer wcap_qa_never_minted" })).toEqual({
      status: 401,
      headers: JSON_ONLY,
      body: UNKNOWN_TOKEN_BODY,
    });
  });
});
