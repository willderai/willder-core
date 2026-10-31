// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Slack/Figma OAuth connect, callback and disconnect, against a real database.
//
// The route unit tests pin the predicates each query carries against a db
// double. This suite runs the same routes against Postgres with two orgs, so a
// predicate that is present but wrong (or a unique index that does not free up)
// shows here. Only the signed-in caller and the providers' HTTP APIs are faked.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never the sandbox's
// inherited DATABASE_URL, which points at live Neon. Skips cleanly without it.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG_A = "org-qa-oauth-a";
const ORG_B = "org-qa-oauth-b";
const TEAM = "T_QA_TEAM";

type Routes = {
  connect: (typeof import("./connect/route"))["POST"];
  callback: (typeof import("./callback/route"))["GET"];
  disconnect: (typeof import("./route"))["DELETE"];
  signState: (typeof import("@/services/integrations/connector-oauth"))["signState"];
  unsealSecret: (typeof import("@/lib/crypto"))["unsealSecret"];
  requireAccessContext: ReturnType<typeof vi.fn>;
};

describe.skipIf(!QA_URL)("Slack/Figma OAuth routes, against a real database", () => {
  let db: PrismaClient;
  let r: Routes;
  const fetchMock = vi.fn();
  let slackExchangeCalls = 0;
  let revokeOk = true;

  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const as = (orgId: string, role = "owner") =>
    r.requireAccessContext.mockResolvedValue({
      org: { id: orgId },
      user: { id: `u-${orgId}`, role },
      ctx: { orgId, actor: { type: "human", id: `u-${orgId}`, role }, origin: "app" },
    });

  async function startConnect(orgId: string, provider = "slack") {
    as(orgId);
    const res = await r.connect(new Request("http://test", { method: "POST" }), params(provider));
    expect(res.status).toBe(201);
    const body = await res.json();
    const state = new URL(body.authUrl).searchParams.get("state")!;
    return { id: body.integration.id as string, state };
  }
  const callCallback = (provider: string, query: Record<string, string>) =>
    r.callback(
      new Request(`http://test/api/integrations/${provider}/callback?${new URLSearchParams(query)}`),
      params(provider),
    );
  const row = (id: string) => db.integration.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", QA_URL!);
    vi.stubEnv("APP_ENCRYPTION_KEY", "d".repeat(64));
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://willder.example");
    vi.stubEnv("SLACK_MOCK", "false");
    vi.stubEnv("FIGMA_MOCK", "false");
    vi.stubEnv("SLACK_CLIENT_ID", "slack-client");
    vi.stubEnv("SLACK_CLIENT_SECRET", "slack-secret");
    vi.stubEnv("FIGMA_CLIENT_ID", "figma-client");
    vi.stubEnv("FIGMA_CLIENT_SECRET", "figma-secret");
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    const access = await import("@/lib/access-context");
    r = {
      connect: (await import("./connect/route")).POST,
      callback: (await import("./callback/route")).GET,
      disconnect: (await import("./route")).DELETE,
      signState: (await import("@/services/integrations/connector-oauth")).signState,
      unsealSecret: (await import("@/lib/crypto")).unsealSecret,
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
    slackExchangeCalls = 0;
    revokeOk = true;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/oauth.v2.access")) {
        slackExchangeCalls++;
        return Response.json({
          ok: true,
          access_token: `xoxb-qa-${slackExchangeCalls}`,
          scope: "channels:history,channels:read",
          team: { id: TEAM, name: "QA Team" },
        });
      }
      if (url.endsWith("/auth.revoke")) {
        expect((init?.headers as Record<string, string>).Authorization).toMatch(/^Bearer xoxb-qa-/);
        return revokeOk
          ? Response.json({ ok: true, revoked: true })
          : Response.json({ ok: false, error: "ratelimited" });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
  });

  afterEach(() => vi.useRealTimers());
  afterAll(async () => {
    await db.integration.deleteMany({ where: { orgId: { in: [ORG_A, ORG_B] } } });
    await deleteOrgsWithRetry(db, { where: { id: { in: [ORG_A, ORG_B] } } });
    await db.$disconnect();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("connects the caller's own pending row, sealing the token and keeping it out of meta", async () => {
    const { id, state } = await startConnect(ORG_A);
    as(ORG_A);
    const res = await callCallback("slack", { state, code: "c1" });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("connected=1");
    const got = await row(id);
    expect(got).toMatchObject({ orgId: ORG_A, status: "connected", externalAccountId: TEAM });
    expect(r.unsealSecret(got.encryptedTokens!)).toEqual({ access_token: "xoxb-qa-1" });
    expect(JSON.stringify(got.meta)).not.toContain("xoxb");
  });

  it("refuses a replay of a completed callback without a second exchange", async () => {
    const { id, state } = await startConnect(ORG_A);
    as(ORG_A);
    await callCallback("slack", { state, code: "c1" });
    const before = await row(id);
    const res = await callCallback("slack", { state, code: "c2" });
    expect(res.status).toBe(400);
    expect(slackExchangeCalls).toBe(1);
    expect(await row(id)).toEqual(before);
  });

  it("refuses another org's state, success or error, and leaves that row pending", async () => {
    const { id, state } = await startConnect(ORG_A);
    as(ORG_B);
    expect((await callCallback("slack", { state, code: "c1" })).status).toBe(400);
    expect((await callCallback("slack", { state, error: "access_denied" })).status).toBe(400);
    expect(slackExchangeCalls).toBe(0);
    expect(await row(id)).toMatchObject({ status: "pending", encryptedTokens: null, externalAccountId: null });
  });

  it("answers another org's row and a missing row identically", async () => {
    const { state } = await startConnect(ORG_A);
    const missing = state.replace(/^[^.]+/, "cmissingqa0000000000000000");
    as(ORG_B);
    const a = await callCallback("slack", { state, code: "c" });
    const b = await callCallback("slack", { state: missing, code: "c" });
    expect([a.status, await a.json()]).toEqual([b.status, await b.json()]);
  });

  it("refuses a forged MAC and a pushed-out expiry on the caller's own pending row", async () => {
    const { id, state } = await startConnect(ORG_A);
    const [iid, exp, mac] = state.split(".");
    const flipped = mac.slice(0, -2) + (mac.at(-2) === "A" ? "B" : "A") + mac.at(-1);
    as(ORG_A);
    expect((await callCallback("slack", { state: `${iid}.${exp}.${flipped}`, code: "c" })).status).toBe(400);
    expect((await callCallback("slack", { state: `${iid}.${Number(exp) + 3_600_000}.${mac}`, code: "c" })).status).toBe(
      400,
    );
    expect(slackExchangeCalls).toBe(0);
    expect((await row(id)).status).toBe("pending");
  });

  it("refuses an expired state", async () => {
    const { id, state } = await startConnect(ORG_A);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 10 * 60 * 1000 + 1000);
    as(ORG_A);
    expect((await callCallback("slack", { state, code: "c" })).status).toBe(400);
    expect((await row(id)).status).toBe("pending");
  });

  it("refuses a Slack state at the Figma callback, even for a Figma row signed with the same id", async () => {
    const { id, state } = await startConnect(ORG_A, "slack");
    // Same integration id retyped as figma: only the MAC's provider binding stops it.
    await db.integration.update({ where: { id }, data: { provider: "figma" } });
    as(ORG_A);
    expect((await callCallback("figma", { state, code: "c" })).status).toBe(400);
    expect((await row(id)).status).toBe("pending");
  });

  it("refuses a member at callback", async () => {
    const { id, state } = await startConnect(ORG_A);
    as(ORG_A, "member");
    expect((await callCallback("slack", { state, code: "c" })).status).toBe(403);
    expect((await row(id)).status).toBe("pending");
    const refusals = await db.auditLog.findMany({ where: { orgId: ORG_A, decision: "deny" } });
    expect(refusals.map((x) => [x.actorId, x.action, x.target])).toEqual([
      [`u-${ORG_A}`, "access.refused", `org_${ORG_A}/integrations:connector-callback`],
    ]);
  });

  it("reconnecting the same workspace replaces only this org's earlier row", async () => {
    await db.integration.create({
      data: {
        orgId: ORG_B,
        provider: "slack",
        status: "connected",
        externalAccountId: TEAM,
        encryptedTokens: "b-sealed",
      },
    });
    const first = await startConnect(ORG_A);
    as(ORG_A);
    await callCallback("slack", first);
    const second = await startConnect(ORG_A);
    as(ORG_A);
    expect((await callCallback("slack", { state: second.state, code: "c2" })).headers.get("location")).toContain(
      "connected=1",
    );
    const rows = await db.integration.findMany({
      where: { provider: "slack", externalAccountId: TEAM },
      orderBy: { orgId: "asc" },
    });
    expect(rows.map((x) => [x.orgId, x.id === second.id || x.orgId === ORG_B])).toEqual([
      [ORG_A, true],
      [ORG_B, true],
    ]);
    expect(rows.find((x) => x.orgId === ORG_B)!.encryptedTokens).toBe("b-sealed");
  });

  it("disconnect revokes upstream, clears the token and account, and frees reconnect", async () => {
    const { id, state } = await startConnect(ORG_A);
    as(ORG_A);
    await callCallback("slack", { state, code: "c1" });
    const res = await r.disconnect(new Request("http://test", { method: "DELETE" }), params(id));
    expect(await res.json()).toEqual({ disconnected: id, providerRevoked: true });
    expect(fetchMock.mock.calls.map(([u]) => u)).toContain("https://slack.com/api/auth.revoke");
    expect(await row(id)).toMatchObject({ status: "disconnected", encryptedTokens: null, externalAccountId: null });
    const again = await startConnect(ORG_A);
    as(ORG_A);
    expect((await callCallback("slack", { state: again.state, code: "c2" })).headers.get("location")).toContain(
      "connected=1",
    );
  });

  it("disconnect still clears our token when Slack refuses the revoke", async () => {
    const { id, state } = await startConnect(ORG_A);
    as(ORG_A);
    await callCallback("slack", { state, code: "c1" });
    revokeOk = false;
    const res = await r.disconnect(new Request("http://test", { method: "DELETE" }), params(id));
    expect(await res.json()).toEqual({
      disconnected: id,
      providerRevoked: false,
      providerRevokeError: "Slack auth.revoke failed: ratelimited",
    });
    expect((await row(id)).encryptedTokens).toBeNull();
  });

  it("disconnect of another org's row is a 404 that changes nothing and calls no provider", async () => {
    const { id, state } = await startConnect(ORG_A);
    as(ORG_A);
    await callCallback("slack", { state, code: "c1" });
    const before = await row(id);
    fetchMock.mockClear();
    as(ORG_B);
    const res = await r.disconnect(new Request("http://test", { method: "DELETE" }), params(id));
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await row(id)).toEqual(before);
  });
});
