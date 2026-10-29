import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAILBOX_OAUTH_MOCK,
  MAILBOX_PROVIDERS,
  MAILBOX_SCOPES,
  createAuthLink,
  exchangeCode,
  isMailboxProvider,
  revokeMailboxGrant,
  sealTokens,
  unsealTokens,
} from "./mailbox";

// The mailbox client is mocked for the build (MAILBOX_OAUTH_MOCK on by default). These
// pin the mock-flow shapes the routes depend on, the exact permissions a real
// connection requests, and the upstream revoke on disconnect (against a stubbed
// fetch). Real token endpoints and encryption are not exercised here.

describe("isMailboxProvider", () => {
  it("accepts the supported providers and rejects others", () => {
    expect(MAILBOX_PROVIDERS).toEqual(["gmail", "outlook"]);
    expect(isMailboxProvider("gmail")).toBe(true);
    expect(isMailboxProvider("outlook")).toBe(true);
    expect(isMailboxProvider("slack")).toBe(false);
    expect(isMailboxProvider("")).toBe(false);
  });
});

describe("createAuthLink (mock mode)", () => {
  it("is in mock mode under test (no real creds)", () => {
    expect(MAILBOX_OAUTH_MOCK).toBe(true);
  });

  it("points back at our own callback carrying the given state and a fake code", () => {
    const url = new URL(createAuthLink({ provider: "gmail", state: "int_123.1790000000000.mac" }));
    expect(url.pathname).toBe("/api/integrations/gmail/callback");
    expect(url.searchParams.get("mock")).toBe("1");
    expect(url.searchParams.get("state")).toBe("int_123.1790000000000.mac");
    expect(url.searchParams.get("code")).toMatch(/^mock_code_/);
  });
});

describe("createAuthLink (real mode)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("sends the browser to the provider with the given state, unchanged", async () => {
    vi.stubEnv("MAILBOX_OAUTH_MOCK", "false");
    vi.stubEnv("GOOGLE_CLIENT_ID", "google-client");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://willder.example");
    vi.resetModules();
    const real = await import("./mailbox");
    const url = new URL(real.createAuthLink({ provider: "gmail", state: "int_123.1790000000000.mac" }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("state")).toBe("int_123.1790000000000.mac");
    expect(url.searchParams.get("client_id")).toBe("google-client");
    expect(url.searchParams.get("redirect_uri")).toBe("https://willder.example/api/integrations/gmail/callback");
  });

  // Written out by hand, not read from MAILBOX_SCOPES, so adding a mail permission
  // back fails here until someone decides a feature needs it.
  it.each([
    ["gmail", "openid email"],
    ["outlook", "openid email User.Read"],
  ] as const)("asks %s for the account's identity and no mail permission", async (provider, scope) => {
    vi.stubEnv("MAILBOX_OAUTH_MOCK", "false");
    vi.resetModules();
    const real = await import("./mailbox");
    const url = new URL(real.createAuthLink({ provider, state: "s" }));
    expect(url.searchParams.get("scope")).toBe(scope);
    expect(url.searchParams.get("scope")).not.toMatch(/mail\.|Mail\.|offline_access/);
  });
});

describe("MAILBOX_SCOPES", () => {
  it("is exactly the identity scopes", () => {
    expect(MAILBOX_SCOPES).toEqual({
      gmail: ["openid", "email"],
      outlook: ["openid", "email", "User.Read"],
    });
  });
});

describe("exchangeCode (mock mode)", () => {
  it("returns a provider-shaped account id, email, and a token blob", async () => {
    const acct = await exchangeCode({ provider: "outlook", code: "mock_code_abc" });
    expect(acct.accountId).toMatch(/^mock_outlook_/);
    expect(acct.email).toBe("demo-outlook@example.com");
    expect(acct.tokens).toMatchObject({ mock: true, code: "mock_code_abc" });
  });
});

describe("sealTokens / unsealTokens", () => {
  it("tags the (mock) token blob and never returns a bare secret", () => {
    const sealed = sealTokens({ mock: true, code: "x" });
    expect(sealed.startsWith("mock:")).toBe(true);
    expect(JSON.parse(sealed.slice("mock:".length))).toMatchObject({ mock: true, code: "x" });
  });

  it("round-trips through unsealTokens", () => {
    expect(unsealTokens(sealTokens({ mock: true, a: 1 }))).toMatchObject({ mock: true, a: 1 });
  });
});

describe("revokeMailboxGrant (mock mode)", () => {
  it("makes no network call for a mock connection", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(revokeMailboxGrant("gmail", { mock: true })).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("revokeMailboxGrant (real mode)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function realRevoke(response: Response) {
    vi.stubEnv("MAILBOX_OAUTH_MOCK", "false");
    vi.resetModules();
    const fetchMock = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetchMock);
    const { revokeMailboxGrant: revoke } = await import("./mailbox");
    return { revoke, fetchMock };
  }

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  it("revokes the Gmail refresh token at Google", async () => {
    const { revoke, fetchMock } = await realRevoke(new Response("", { status: 200 }));
    await revoke("gmail", { access_token: "ya29.access", refresh_token: "1//refresh" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://oauth2.googleapis.com/revoke");
    expect(init.method).toBe("POST");
    expect(new URLSearchParams(init.body as URLSearchParams).get("token")).toBe("1//refresh");
  });

  it("treats an already-revoked refresh token as revoked", async () => {
    const { revoke } = await realRevoke(json(400, { error: "invalid_token" }));
    await expect(revoke("gmail", { refresh_token: "1//gone" })).resolves.toBeUndefined();
  });

  it("does not treat an expired access token as a revoked grant", async () => {
    const { revoke } = await realRevoke(json(400, { error: "invalid_token" }));
    await expect(revoke("gmail", { access_token: "ya29.expired" })).rejects.toThrow(
      "Google revoke failed: HTTP 400 invalid_token",
    );
  });

  it("surfaces a Google failure instead of swallowing it", async () => {
    const { revoke } = await realRevoke(new Response("unavailable", { status: 503 }));
    await expect(revoke("gmail", { refresh_token: "1//r" })).rejects.toThrow("Google revoke failed: HTTP 503");
  });

  it("refuses to report a Gmail revoke when no token is stored", async () => {
    const { revoke, fetchMock } = await realRevoke(new Response("", { status: 200 }));
    await expect(revoke("gmail", {})).rejects.toThrow(/holds no token/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still revokes a real grant when mock mode is on now", async () => {
    vi.stubEnv("MAILBOX_OAUTH_MOCK", "true");
    vi.resetModules();
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { revokeMailboxGrant: revoke, MAILBOX_OAUTH_MOCK: mockOn } = await import("./mailbox");
    expect(mockOn).toBe(true);
    await revoke("gmail", { refresh_token: "1//real" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("says Outlook cannot be revoked by the app and where the user removes it", async () => {
    const { revoke, fetchMock } = await realRevoke(new Response("", { status: 200 }));
    await expect(revoke("outlook", { access_token: "eyJ" })).rejects.toThrow(/myapps\.microsoft\.com/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
