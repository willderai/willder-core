import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONNECTOR_OAUTH_PROVIDERS,
  STATE_TTL_MS,
  buildAuthorizeUrl,
  exchangeConnectorCode,
  isConnectorOAuthProvider,
  signState,
  stateIntegrationId,
  verifyState,
} from "./connector-oauth";

// The seam is the signed `state` a connect hands the browser and the callback
// checks: it must bind integration, org, provider and expiry, and nothing else
// may verify.

const KEY = "a".repeat(64);
const NOW = 1_790_000_000_000;
const bound = { integrationId: "int_1", orgId: "org_1", provider: "slack" as const };

beforeEach(() => {
  vi.stubEnv("APP_ENCRYPTION_KEY", KEY);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isConnectorOAuthProvider", () => {
  it("accepts slack and figma only", () => {
    expect(CONNECTOR_OAUTH_PROVIDERS).toEqual(["slack", "figma"]);
    expect(isConnectorOAuthProvider("slack")).toBe(true);
    expect(isConnectorOAuthProvider("figma")).toBe(true);
    expect(isConnectorOAuthProvider("gmail")).toBe(false);
    expect(isConnectorOAuthProvider("")).toBe(false);
  });
});

describe("signState / verifyState", () => {
  it("verifies for the integration, org and provider it was signed for", () => {
    const { state, expiresAt } = signState({ ...bound, now: NOW });
    expect(expiresAt.getTime()).toBe(NOW + STATE_TTL_MS);
    expect(stateIntegrationId(state)).toBe("int_1");
    expect(verifyState(state, { ...bound, now: NOW + 1 })).toBe(true);
  });

  it("rejects the same state presented for another org", () => {
    const { state } = signState({ ...bound, now: NOW });
    expect(verifyState(state, { ...bound, orgId: "org_2", now: NOW + 1 })).toBe(false);
  });

  it("rejects the same state presented for another provider or integration", () => {
    const { state } = signState({ ...bound, now: NOW });
    expect(verifyState(state, { ...bound, provider: "figma", now: NOW + 1 })).toBe(false);
    expect(verifyState(state, { ...bound, integrationId: "int_2", now: NOW + 1 })).toBe(false);
  });

  it("rejects an expired state", () => {
    const { state } = signState({ ...bound, now: NOW });
    expect(verifyState(state, { ...bound, now: NOW + STATE_TTL_MS })).toBe(false);
  });

  it("rejects a state with a pushed-out expiry or a tampered MAC", () => {
    const { state } = signState({ ...bound, now: NOW });
    const [id, exp, mac] = state.split(".");
    const later = `${id}.${Number(exp) + 60_000}.${mac}`;
    expect(verifyState(later, { ...bound, now: NOW + 1 })).toBe(false);
    const flipped = `${id}.${exp}.${mac.slice(0, -2)}${mac.endsWith("AA") ? "BB" : "AA"}`;
    expect(verifyState(flipped, { ...bound, now: NOW + 1 })).toBe(false);
  });

  it("rejects a state signed under a different key", () => {
    const { state } = signState({ ...bound, now: NOW });
    vi.stubEnv("APP_ENCRYPTION_KEY", "b".repeat(64));
    expect(verifyState(state, { ...bound, now: NOW + 1 })).toBe(false);
  });

  it("parses no integration id out of malformed input", () => {
    expect(stateIntegrationId("")).toBeNull();
    expect(stateIntegrationId("int_1")).toBeNull();
    expect(stateIntegrationId("a.b.c.d")).toBeNull();
    expect(stateIntegrationId("bad id.1.mac")).toBeNull();
    expect(verifyState("int_1.notanumber.mac", { ...bound, now: NOW })).toBe(false);
  });

  it("refuses to sign without a usable APP_ENCRYPTION_KEY, naming it", () => {
    vi.stubEnv("APP_ENCRYPTION_KEY", "");
    expect(() => signState({ ...bound, now: NOW })).toThrow(/APP_ENCRYPTION_KEY/);
  });
});

describe("fixture mode (SLACK_MOCK / FIGMA_MOCK default on under test)", () => {
  it("sends the browser straight back to our own callback with the state", () => {
    const url = new URL(buildAuthorizeUrl("slack", "int_1.123.mac"));
    expect(url.pathname).toBe("/api/integrations/slack/callback");
    expect(url.searchParams.get("state")).toBe("int_1.123.mac");
    expect(url.searchParams.get("code")).toMatch(/^mock_code_/);
  });

  it("stores no token and marks the connection as a fixture", async () => {
    const account = await exchangeConnectorCode("figma", "mock_code_x");
    expect(account.tokens).toBeNull();
    expect(account.meta).toEqual({ mock: true });
    expect(account.accountId).toMatch(/^mock_figma_/);
  });
});

describe("real mode (SLACK_MOCK=false, FIGMA_MOCK=false)", () => {
  async function loadReal() {
    vi.stubEnv("SLACK_MOCK", "false");
    vi.stubEnv("FIGMA_MOCK", "false");
    vi.stubEnv("SLACK_CLIENT_ID", "slack-client");
    vi.stubEnv("SLACK_CLIENT_SECRET", "slack-secret");
    vi.stubEnv("FIGMA_CLIENT_ID", "figma-client");
    vi.stubEnv("FIGMA_CLIENT_SECRET", "figma-secret");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://willder.example");
    vi.resetModules();
    return import("./connector-oauth");
  }
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it("builds provider authorize URLs with read-only scopes and our registered redirect", async () => {
    const m = await loadReal();
    const slack = new URL(m.buildAuthorizeUrl("slack", "s"));
    expect(slack.origin + slack.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(slack.searchParams.get("client_id")).toBe("slack-client");
    expect(slack.searchParams.get("scope")).toBe("channels:history,channels:read");
    expect(slack.searchParams.get("redirect_uri")).toBe("https://willder.example/api/integrations/slack/callback");
    expect(slack.searchParams.get("state")).toBe("s");
    const figma = new URL(m.buildAuthorizeUrl("figma", "s"));
    expect(figma.origin + figma.pathname).toBe("https://www.figma.com/oauth");
    expect(figma.searchParams.get("scope")).toBe("file_comments:read");
    expect(figma.toString()).not.toContain("secret");
  });

  it("refuses to start without the provider's client credentials, naming the env vars", async () => {
    const m = await loadReal();
    vi.stubEnv("FIGMA_CLIENT_SECRET", "");
    expect(() => m.assertConnectorOAuthConfigured("figma")).toThrow(/FIGMA_CLIENT_ID and FIGMA_CLIENT_SECRET/);
    expect(() => m.assertConnectorOAuthConfigured("slack")).not.toThrow();
  });

  it("exchanges a Slack code, keyed by team id, with the token only in `tokens`", async () => {
    const m = await loadReal();
    fetchMock.mockResolvedValueOnce(
      json({
        ok: true,
        access_token: "xoxb-1",
        scope: "channels:history,channels:read",
        team: { id: "T1", name: "Acme" },
      }),
    );
    const account = await m.exchangeConnectorCode("slack", "c1");
    expect(account).toEqual({
      accountId: "T1",
      tokens: { access_token: "xoxb-1" },
      meta: { teamName: "Acme", scopes: "channels:history,channels:read" },
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://slack.com/api/oauth.v2.access");
    expect(String(init.body)).toContain("code=c1");
  });

  it("treats Slack's HTTP-200 ok:false as a failed exchange", async () => {
    const m = await loadReal();
    fetchMock.mockResolvedValueOnce(json({ ok: false, error: "invalid_code" }));
    await expect(m.exchangeConnectorCode("slack", "bad")).rejects.toThrow(/invalid_code/);
  });

  it("exchanges a Figma code with Basic client auth, keyed by user id", async () => {
    const m = await loadReal();
    fetchMock.mockResolvedValueOnce(
      json({ user_id_string: "U9", access_token: "figd-1", refresh_token: "r-1", expires_in: 3600 }),
    );
    const account = await m.exchangeConnectorCode("figma", "c2");
    expect(account.accountId).toBe("U9");
    expect(account.tokens).toMatchObject({ access_token: "figd-1", refresh_token: "r-1" });
    expect(JSON.stringify(account.meta)).not.toContain("figd-1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.figma.com/v1/oauth/token");
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from("figma-client:figma-secret").toString("base64")}`);
  });

  it("fails a Figma exchange the provider refused", async () => {
    const m = await loadReal();
    fetchMock.mockResolvedValueOnce(json({ error: true }, 400));
    await expect(m.exchangeConnectorCode("figma", "bad")).rejects.toThrow(/Figma token exchange failed: 400/);
  });

  it("revokes a Slack token upstream and accepts an already-dead token", async () => {
    const m = await loadReal();
    fetchMock.mockResolvedValueOnce(json({ ok: true, revoked: true }));
    await m.revokeConnectorToken("slack", { access_token: "xoxb-1" });
    expect(fetchMock.mock.calls[0][0]).toBe("https://slack.com/api/auth.revoke");
    fetchMock.mockResolvedValueOnce(json({ ok: false, error: "invalid_auth" }));
    await expect(m.revokeConnectorToken("slack", { access_token: "xoxb-1" })).resolves.toBeUndefined();
    fetchMock.mockResolvedValueOnce(json({ ok: false, error: "ratelimited" }));
    await expect(m.revokeConnectorToken("slack", { access_token: "xoxb-1" })).rejects.toThrow(/ratelimited/);
  });

  it("makes no upstream call to revoke a Figma token (no revocation endpoint)", async () => {
    const m = await loadReal();
    await m.revokeConnectorToken("figma", { access_token: "figd-1" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
