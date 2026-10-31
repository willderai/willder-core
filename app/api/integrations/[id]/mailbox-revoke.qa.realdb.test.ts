// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A real-mode mailbox connection, end to end against a real database: connect asks
// only for identity scopes, the callback stores a sealed grant and registers no
// inbox watch, and disconnect revokes the Gmail grant at Google (or reports that
// Outlook cannot be revoked) while always deleting our copy of the token.
//
// mailbox-oauth.qa.realdb.test.ts covers the same routes in mock mode; this file
// runs with MAILBOX_OAUTH_MOCK=false so the provider calls are the real request
// shapes. Only the signed-in caller and the providers' HTTP APIs are faked.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never the sandbox's
// inherited DATABASE_URL, which points at live Neon. Skips cleanly without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG_A = "org-qa-mailrevoke-a";
const ORG_B = "org-qa-mailrevoke-b";

type Routes = {
  connect: (typeof import("./connect/route"))["POST"];
  callback: (typeof import("./callback/route"))["GET"];
  disconnect: (typeof import("./route"))["DELETE"];
  unsealTokens: (typeof import("@/services/integrations/mailbox"))["unsealTokens"];
  requireAccessContext: ReturnType<typeof vi.fn>;
};

describe.skipIf(!QA_URL)("mailbox revoke on disconnect, real mode, against a real database", () => {
  let db: PrismaClient;
  let r: Routes;
  const fetchMock = vi.fn();
  let googleRevoke: () => Response = () => new Response("", { status: 200 });

  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const as = (orgId: string) =>
    r.requireAccessContext.mockResolvedValue({
      org: { id: orgId },
      user: { id: `u-${orgId}`, role: "owner" },
      ctx: { orgId, actor: { type: "human", id: `u-${orgId}`, role: "owner" }, origin: "app" },
    });
  const row = (id: string) => db.integration.findUniqueOrThrow({ where: { id } });
  const calledUrls = () => fetchMock.mock.calls.map(([url]) => String(url));

  /** Connect and complete the callback for `provider` in `orgId`; returns the row id and the requested scope. */
  async function connected(orgId: string, provider: "gmail" | "outlook") {
    as(orgId);
    const res = await r.connect(new Request("http://test", { method: "POST" }), params(provider));
    expect(res.status).toBe(201);
    const body = await res.json();
    const authUrl = new URL(body.authUrl);
    const cb = await r.callback(
      new Request(
        `http://test/api/integrations/${provider}/callback?${new URLSearchParams({ state: authUrl.searchParams.get("state")!, code: "c1" })}`,
      ),
      params(provider),
    );
    expect(cb.headers.get("location")).toContain("connected=1");
    return { id: body.integration.id as string, scope: authUrl.searchParams.get("scope") };
  }

  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", QA_URL!);
    vi.stubEnv("APP_ENCRYPTION_KEY", "f".repeat(64));
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://willder.example");
    vi.stubEnv("MAILBOX_OAUTH_MOCK", "false");
    vi.stubEnv("GOOGLE_CLIENT_ID", "google-client");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "google-secret");
    vi.stubEnv("MICROSOFT_CLIENT_ID", "ms-client");
    vi.stubEnv("MICROSOFT_CLIENT_SECRET", "ms-secret");
    // Set so a reintroduced watch registration would have somewhere to go.
    vi.stubEnv("GMAIL_PUBSUB_TOPIC", "projects/qa/topics/gmail-push");
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    const access = await import("@/lib/access-context");
    r = {
      connect: (await import("./connect/route")).POST,
      callback: (await import("./callback/route")).GET,
      disconnect: (await import("./route")).DELETE,
      unsealTokens: (await import("@/services/integrations/mailbox")).unsealTokens,
      requireAccessContext: vi.mocked(access.requireAccessContext) as unknown as ReturnType<typeof vi.fn>,
    };
    vi.stubGlobal("fetch", fetchMock);
  });

  beforeEach(async () => {
    await db.integration.deleteMany({ where: { orgId: { in: [ORG_A, ORG_B] } } });
    await deleteOrgsWithRetry(db, { where: { id: { in: [ORG_A, ORG_B] } } });
    await db.org.createMany({
      data: [
        { id: ORG_A, name: "QA A" },
        { id: ORG_B, name: "QA B" },
      ],
    });
    googleRevoke = () => new Response("", { status: 200 });
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "https://oauth2.googleapis.com/token") {
        return Response.json({
          access_token: "ya29.qa",
          refresh_token: "1//qa-refresh",
          expires_in: 3600,
          token_type: "Bearer",
        });
      }
      if (url === "https://www.googleapis.com/oauth2/v3/userinfo")
        return Response.json({ sub: "g-sub-1", email: "a@acme.example" });
      if (url === "https://login.microsoftonline.com/common/oauth2/v2.0/token") {
        return Response.json({ access_token: "eyJ.qa", expires_in: 3600 });
      }
      if (url === "https://graph.microsoft.com/v1.0/me") return Response.json({ id: "ms-1", mail: "a@acme.example" });
      if (url === "https://oauth2.googleapis.com/revoke") return googleRevoke();
      throw new Error(`unexpected fetch ${url}`);
    });
  });

  afterAll(async () => {
    await db.integration.deleteMany({ where: { orgId: { in: [ORG_A, ORG_B] } } });
    await deleteOrgsWithRetry(db, { where: { id: { in: [ORG_A, ORG_B] } } });
    await db.$disconnect();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each([
    ["gmail", "openid email"],
    ["outlook", "openid email User.Read"],
  ] as const)("connects %s with identity scopes only and registers no inbox watch", async (provider, scope) => {
    const { id, scope: requested } = await connected(ORG_A, provider);
    expect(requested).toBe(scope);
    // Let any fire-and-forget work the callback started settle before reading calls.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      calledUrls().filter((u) => /gmail\.googleapis\.com|graph\.microsoft\.com\/v1\.0\/subscriptions/.test(u)),
    ).toEqual([]);
    const got = await row(id);
    expect(got.status).toBe("connected");
    expect(got.meta).toEqual({ email: "a@acme.example" });
  });

  it("revokes the stored Gmail refresh token at Google and deletes our copy", async () => {
    const { id } = await connected(ORG_A, "gmail");
    expect(r.unsealTokens((await row(id)).encryptedTokens!)).toMatchObject({ refresh_token: "1//qa-refresh" });
    fetchMock.mockClear();
    as(ORG_A);
    const res = await r.disconnect(new Request("http://test", { method: "DELETE" }), params(id));
    expect(await res.json()).toEqual({ disconnected: id, providerRevoked: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://oauth2.googleapis.com/revoke");
    expect(new URLSearchParams(init.body as URLSearchParams).get("token")).toBe("1//qa-refresh");
    expect(await row(id)).toMatchObject({ status: "disconnected", encryptedTokens: null, externalAccountId: null });
  });

  it("surfaces a Google failure and still deletes our copy of the token", async () => {
    const { id } = await connected(ORG_A, "gmail");
    googleRevoke = () => new Response("unavailable", { status: 503 });
    as(ORG_A);
    const res = await r.disconnect(new Request("http://test", { method: "DELETE" }), params(id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      disconnected: id,
      providerRevoked: false,
      providerRevokeError: "Google revoke failed: HTTP 503",
    });
    expect(await row(id)).toMatchObject({ status: "disconnected", encryptedTokens: null });
  });

  it("treats a Google invalid_token on the refresh token as already revoked", async () => {
    const { id } = await connected(ORG_A, "gmail");
    googleRevoke = () => Response.json({ error: "invalid_token" }, { status: 400 });
    as(ORG_A);
    const res = await r.disconnect(new Request("http://test", { method: "DELETE" }), params(id));
    expect(await res.json()).toEqual({ disconnected: id, providerRevoked: true });
  });

  it("reports Outlook as not revoked, naming where the user removes it, with no provider call", async () => {
    const { id } = await connected(ORG_A, "outlook");
    fetchMock.mockClear();
    as(ORG_A);
    const res = await r.disconnect(new Request("http://test", { method: "DELETE" }), params(id));
    const body = await res.json();
    expect(body).toMatchObject({ disconnected: id, providerRevoked: false });
    expect(body.providerRevokeError).toMatch(/myapps\.microsoft\.com/);
    expect(body.providerRevokeError).toMatch(/account\.live\.com\/consent\/Manage/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await row(id)).toMatchObject({ status: "disconnected", encryptedTokens: null });
  });

  it("refuses another org's mailbox with a 404, revoking nothing and leaving its grant", async () => {
    const { id } = await connected(ORG_B, "gmail");
    const before = await row(id);
    fetchMock.mockClear();
    as(ORG_A);
    const res = await r.disconnect(new Request("http://test", { method: "DELETE" }), params(id));
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await row(id)).toEqual(before);
  });
});
