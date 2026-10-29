// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Gmail/Outlook OAuth connect and callback, against a real database.
//
// The route unit tests pin the predicates each query carries against a db
// double. This suite runs the same routes against Postgres with two orgs, so a
// predicate that is present but wrong shows here. The flow runs in mock OAuth
// mode (the demo's mode): connect's authorize URL points straight back at the
// callback with a fake code and the signed state. Only the signed-in caller is
// faked.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never the sandbox's
// inherited DATABASE_URL, which points at live Neon. Skips cleanly without it.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/services/integrations/mailbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/integrations/mailbox")>();
  // The real mock-mode exchange unless a test pins the provider-side account id.
  return { ...actual, exchangeCode: vi.fn(actual.exchangeCode) };
});

const QA_URL = process.env.QA_DATABASE_URL;

const ORG_A = "org-qa-mailbox-a";
const ORG_B = "org-qa-mailbox-b";

type Routes = {
  connect: (typeof import("./connect/route"))["POST"];
  callback: (typeof import("./callback/route"))["GET"];
  signState: (typeof import("@/services/integrations/connector-oauth"))["signState"];
  unsealTokens: (typeof import("@/services/integrations/mailbox"))["unsealTokens"];
  exchangeCode: ReturnType<typeof vi.fn>;
  requireAccessContext: ReturnType<typeof vi.fn>;
};

describe.skipIf(!QA_URL)("Gmail/Outlook OAuth routes, against a real database", () => {
  let db: PrismaClient;
  let r: Routes;

  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const as = (orgId: string, role = "owner") =>
    r.requireAccessContext.mockResolvedValue({
      org: { id: orgId },
      user: { id: `u-${orgId}`, role },
      ctx: { orgId, actor: { type: "human", id: `u-${orgId}`, role }, origin: "app" },
    });

  async function startConnect(orgId: string, provider: "gmail" | "outlook" = "gmail") {
    as(orgId);
    const res = await r.connect(new Request("http://test", { method: "POST" }), params(provider));
    expect(res.status).toBe(201);
    const body = await res.json();
    const authUrl = new URL(body.authUrl);
    return {
      id: body.integration.id as string,
      state: authUrl.searchParams.get("state")!,
      code: authUrl.searchParams.get("code")!,
      authUrl,
    };
  }
  const callCallback = (provider: string, query: Record<string, string>) =>
    r.callback(
      new Request(`http://test/api/integrations/${provider}/callback?${new URLSearchParams(query)}`),
      params(provider),
    );
  const row = (id: string) => db.integration.findUniqueOrThrow({ where: { id } });
  const snapshot = async (id: string) => {
    const { updatedAt: _u, ...rest } = await row(id);
    return rest;
  };

  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", QA_URL!);
    vi.stubEnv("APP_ENCRYPTION_KEY", "e".repeat(64));
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://willder.example");
    vi.stubEnv("MAILBOX_OAUTH_MOCK", "true");
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    const access = await import("@/lib/access-context");
    r = {
      connect: (await import("./connect/route")).POST,
      callback: (await import("./callback/route")).GET,
      signState: (await import("@/services/integrations/connector-oauth")).signState,
      unsealTokens: (await import("@/services/integrations/mailbox")).unsealTokens,
      exchangeCode: vi.mocked((await import("@/services/integrations/mailbox")).exchangeCode) as unknown as ReturnType<
        typeof vi.fn
      >,
      requireAccessContext: vi.mocked(access.requireAccessContext) as unknown as ReturnType<typeof vi.fn>,
    };
  });

  beforeEach(async () => {
    await db.integration.deleteMany({ where: { orgId: { in: [ORG_A, ORG_B] } } });
    await db.org.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } });
    await db.org.createMany({
      data: [
        { id: ORG_A, name: "QA A" },
        { id: ORG_B, name: "QA B" },
      ],
    });
  });

  afterEach(() => vi.useRealTimers());
  afterAll(async () => {
    await db.integration.deleteMany({ where: { orgId: { in: [ORG_A, ORG_B] } } });
    await db.org.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } });
    await db.$disconnect();
    vi.unstubAllEnvs();
  });

  it.each(["gmail", "outlook"] as const)(
    "round trips connect to callback for the caller's own %s row",
    async (provider) => {
      const { id, state, code, authUrl } = await startConnect(ORG_A, provider);
      // Mock mode sends the browser straight back to this provider's callback.
      expect(authUrl.pathname).toBe(`/api/integrations/${provider}/callback`);
      expect(state).not.toBe(id);
      as(ORG_A);
      const res = await callCallback(provider, { state, code, mock: "1" });
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe("https://willder.example/inbox?connected=1");
      const got = await row(id);
      expect(got).toMatchObject({ orgId: ORG_A, provider, status: "connected" });
      expect(got.externalAccountId).toMatch(new RegExp(`^mock_${provider}_`));
      expect(r.unsealTokens(got.encryptedTokens!)).toMatchObject({ mock: true, code });
    },
  );

  it("leaves another org's pending row untouched when its own state is replayed by a different org's session", async () => {
    const b = await startConnect(ORG_B);
    const before = await snapshot(b.id);
    as(ORG_A);
    const ok = await callCallback("gmail", { state: b.state, code: "attacker" });
    const declined = await callCallback("gmail", { state: b.state, error: "access_denied" });
    expect(ok.status).toBe(400);
    expect(declined.status).toBe(400);
    expect(await snapshot(b.id)).toEqual(before);
  });

  it("refuses a state the attacker signs for their own org naming another org's row, with the same answer as a missing row", async () => {
    const b = await startConnect(ORG_B);
    const before = await snapshot(b.id);
    as(ORG_A);
    const foreign = await callCallback("gmail", {
      state: r.signState({ integrationId: b.id, orgId: ORG_A, provider: "gmail" }).state,
      code: "attacker",
    });
    const missing = await callCallback("gmail", {
      state: r.signState({ integrationId: "int-does-not-exist", orgId: ORG_A, provider: "gmail" }).state,
      code: "attacker",
    });
    expect(foreign.status).toBe(400);
    expect(missing.status).toBe(400);
    expect(await foreign.json()).toEqual(await missing.json());
    expect(await snapshot(b.id)).toEqual(before);
  });

  it("refuses the bare integration id the callback used to trust, for a code and for a decline", async () => {
    const { id } = await startConnect(ORG_A);
    const before = await snapshot(id);
    as(ORG_A);
    expect((await callCallback("gmail", { state: id, code: "c" })).status).toBe(400);
    expect((await callCallback("gmail", { state: id, error: "access_denied" })).status).toBe(400);
    expect((await callCallback("gmail", { code: "c" })).status).toBe(400);
    expect(await snapshot(id)).toEqual(before);
  });

  it("refuses a forged MAC and a pushed-out expiry on the caller's own row", async () => {
    const { id, state } = await startConnect(ORG_A);
    const before = await snapshot(id);
    const [rowId, expiresAt, mac] = state.split(".");
    // Flip the first character: the last one of a 32-byte MAC carries two padding
    // bits, so swapping A for B there decodes to the same bytes about one run in 16.
    const flipped = (mac.startsWith("A") ? "B" : "A") + mac.slice(1);
    as(ORG_A);
    expect((await callCallback("gmail", { state: `${rowId}.${expiresAt}.${flipped}`, code: "c" })).status).toBe(400);
    expect(
      (await callCallback("gmail", { state: `${rowId}.${Number(expiresAt) + 3_600_000}.${mac}`, code: "c" })).status,
    ).toBe(400);
    expect(await snapshot(id)).toEqual(before);
  });

  it("refuses an expired state, then still accepts a fresh one for a new attempt", async () => {
    const { id, state, code } = await startConnect(ORG_A);
    const before = await snapshot(id);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    as(ORG_A);
    expect((await callCallback("gmail", { state, code })).status).toBe(400);
    expect((await callCallback("gmail", { state, error: "access_denied" })).status).toBe(400);
    expect(await snapshot(id)).toEqual(before);
  });

  it("refuses a gmail state on the outlook callback", async () => {
    const { id, state, code } = await startConnect(ORG_A, "gmail");
    const before = await snapshot(id);
    as(ORG_A);
    expect((await callCallback("outlook", { state, code })).status).toBe(400);
    expect(await snapshot(id)).toEqual(before);
  });

  it("refuses a member and a caller with no session before reading the row", async () => {
    const { id, state, code } = await startConnect(ORG_A);
    const before = await snapshot(id);
    as(ORG_A, "member");
    expect((await callCallback("gmail", { state, code })).status).toBe(403);
    const refusals = await db.auditLog.findMany({ where: { orgId: ORG_A, decision: "deny" } });
    expect(refusals.map((x) => [x.actorId, x.action, x.target])).toEqual([
      [`u-${ORG_A}`, "access.refused", `org_${ORG_A}/integrations:mailbox-callback`],
    ]);
    r.requireAccessContext.mockResolvedValue(null);
    expect((await callCallback("gmail", { state, code })).status).toBe(401);
    expect(await snapshot(id)).toEqual(before);
  });

  it("refuses a replay of a completed callback without changing the stored account", async () => {
    const { id, state, code } = await startConnect(ORG_A);
    as(ORG_A);
    expect((await callCallback("gmail", { state, code })).status).toBe(307);
    const connected = await snapshot(id);
    expect((await callCallback("gmail", { state, code: "second" })).status).toBe(400);
    expect((await callCallback("gmail", { state, error: "access_denied" })).status).toBe(400);
    expect(await snapshot(id)).toEqual(connected);
  });

  it("marks only the caller's own row errored on a signed decline", async () => {
    const a = await startConnect(ORG_A);
    const b = await startConnect(ORG_B);
    const beforeB = await snapshot(b.id);
    as(ORG_A);
    const res = await callCallback("gmail", { state: a.state, error: "access_denied" });
    expect(res.headers.get("location")).toBe("https://willder.example/inbox?connected=0");
    expect(await row(a.id)).toMatchObject({ status: "error", meta: { error: "access_denied" }, encryptedTokens: null });
    expect(await snapshot(b.id)).toEqual(beforeB);
  });

  it("keeps an org's first Gmail account connected when a second, different one connects", async () => {
    const firstA = await db.integration.create({
      data: { orgId: ORG_A, provider: "gmail", status: "connected", externalAccountId: "first-a" },
    });
    const { id, state, code } = await startConnect(ORG_A);
    as(ORG_A);
    expect((await callCallback("gmail", { state, code })).status).toBe(307);
    expect(await row(firstA.id)).toMatchObject({ status: "connected", externalAccountId: "first-a" });
    expect(await row(id)).toMatchObject({ status: "connected" });
    expect((await row(id)).externalAccountId).not.toBe("first-a");
  });

  it("replaces only the caller's own earlier row for the same account on a reconnect", async () => {
    const olderA = await db.integration.create({
      data: { orgId: ORG_A, provider: "gmail", status: "connected", externalAccountId: "same-acct" },
    });
    const connectedB = await db.integration.create({
      data: { orgId: ORG_B, provider: "gmail", status: "connected", externalAccountId: "same-acct" },
    });
    const outlookA = await db.integration.create({
      data: { orgId: ORG_A, provider: "outlook", status: "connected", externalAccountId: "same-acct" },
    });
    const { id, state, code } = await startConnect(ORG_A);
    r.exchangeCode.mockResolvedValueOnce({ accountId: "same-acct", email: "a@example.test", tokens: { mock: true } });
    as(ORG_A);
    expect((await callCallback("gmail", { state, code })).status).toBe(307);
    expect(await db.integration.findUnique({ where: { id: olderA.id } })).toBeNull();
    expect(await row(connectedB.id)).toMatchObject({ status: "connected", externalAccountId: "same-acct" });
    expect(await row(outlookA.id)).toMatchObject({ status: "connected", externalAccountId: "same-acct" });
    expect(await row(id)).toMatchObject({ status: "connected", externalAccountId: "same-acct" });
  });

  it("refuses a valid state for a row that is no longer pending, keeping the org's other rows", async () => {
    const olderA = await db.integration.create({
      data: { orgId: ORG_A, provider: "gmail", status: "connected", externalAccountId: "old-a" },
    });
    const { id, state, code } = await startConnect(ORG_A);
    await db.integration.update({ where: { id }, data: { status: "error" } });
    as(ORG_A);
    expect((await callCallback("gmail", { state, code })).status).toBe(400);
    expect(await row(olderA.id)).toMatchObject({ status: "connected", externalAccountId: "old-a" });
    expect(await row(id)).toMatchObject({ status: "error", encryptedTokens: null });
  });
});
