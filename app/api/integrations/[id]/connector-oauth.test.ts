import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Slack/Figma OAuth routes: connect creates a
// pending row and a signed state; the callback attaches a token only for the
// signed-in owner/admin's own pending row named by a valid state; disconnect
// deletes the stored token and revokes it upstream where the provider allows
// (Slack, and the Gmail/Outlook mailbox grant).
// The db is a double, so these pin the predicates each query carries, not
// Postgres behaviour.

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/db", () => {
  const integration = {
    create: vi.fn(),
    findFirst: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  };
  return {
    db: {
      integration,
      auditLog: { create: vi.fn() },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ integration })),
    },
  };
});
vi.mock("@/services/integrations/connector-oauth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/integrations/connector-oauth")>();
  return { ...actual, exchangeConnectorCode: vi.fn(), revokeConnectorToken: vi.fn() };
});
vi.mock("@/services/integrations/mailbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/integrations/mailbox")>();
  return { ...actual, revokeMailboxGrant: vi.fn() };
});

import { requireAccessContext } from "@/lib/access-context";
import { db } from "@/lib/db";
import { sealSecret, unsealSecret } from "@/lib/crypto";
import { exchangeConnectorCode, revokeConnectorToken, signState } from "@/services/integrations/connector-oauth";
import { revokeMailboxGrant, sealTokens } from "@/services/integrations/mailbox";
import { POST as connect } from "./connect/route";
import { GET as callback } from "./callback/route";
import { DELETE as disconnect } from "./route";

const integration = vi.mocked(db.integration);
const ORG = "org_1";
const asRole = (role: string, orgId = ORG) =>
  vi.mocked(requireAccessContext).mockResolvedValue({
    org: { id: orgId },
    user: { id: "u1", role },
    ctx: { orgId, actor: { type: "human", id: "u1", role }, origin: "app" },
  } as never);

/** A member's refusal leaves exactly one deny row, naming them and the org root. */
const expectOneRoleRefusal = (operation: string) => {
  expect(db.auditLog.create).toHaveBeenCalledTimes(1);
  expect(vi.mocked(db.auditLog.create).mock.calls[0][0].data).toMatchObject({
    orgId: ORG,
    actorType: "human",
    actorId: "u1",
    action: "access.refused",
    target: `org_${ORG}/${operation}`,
    decision: "deny",
  });
};

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const callCallback = (provider: string, query: Record<string, string>) =>
  callback(
    new Request(`http://test/api/integrations/${provider}/callback?${new URLSearchParams(query)}`),
    params(provider),
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("APP_ENCRYPTION_KEY", "c".repeat(64));
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://willder.example");
  asRole("owner");
  integration.updateMany.mockResolvedValue({ count: 1 } as never);
  integration.deleteMany.mockResolvedValue({ count: 0 } as never);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/integrations/:provider/connect (slack, figma)", () => {
  it("creates a pending row in the caller's org and returns a state bound to it", async () => {
    integration.create.mockResolvedValue({ id: "int_1", provider: "slack", status: "pending" } as never);
    const res = await connect(new Request("http://test", { method: "POST" }), params("slack"));
    expect(res.status).toBe(201);
    expect(integration.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: { orgId: ORG, provider: "slack", status: "pending" } }),
    );
    const body = await res.json();
    const state = new URL(body.authUrl).searchParams.get("state")!;
    expect(state.startsWith("int_1.")).toBe(true);
  });

  it("refuses a member, before any row exists", async () => {
    asRole("member");
    const res = await connect(new Request("http://test", { method: "POST" }), params("figma"));
    expect(res.status).toBe(403);
    expect(integration.create).not.toHaveBeenCalled();
    expectOneRoleRefusal("integrations:connect");
  });

  it("refuses an unknown provider", async () => {
    const res = await connect(new Request("http://test", { method: "POST" }), params("notion"));
    expect(res.status).toBe(400);
    expect(integration.create).not.toHaveBeenCalled();
  });

  it("refuses with 503, before any row exists, when the state key is missing", async () => {
    vi.stubEnv("APP_ENCRYPTION_KEY", "");
    const res = await connect(new Request("http://test", { method: "POST" }), params("slack"));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/APP_ENCRYPTION_KEY/);
    expect(integration.create).not.toHaveBeenCalled();
  });
});

describe("GET /api/integrations/:provider/callback (slack, figma)", () => {
  const validState = (orgId = ORG, provider: "slack" | "figma" = "slack") =>
    signState({ integrationId: "int_1", orgId, provider }).state;

  it("attaches the sealed token to the caller's own pending row", async () => {
    integration.findFirst.mockResolvedValue({ id: "int_1" } as never);
    vi.mocked(exchangeConnectorCode).mockResolvedValue({
      accountId: "T1",
      tokens: { access_token: "xoxb-secret" },
      meta: { teamName: "Acme", scopes: "channels:history" },
    });

    const res = await callCallback("slack", { state: validState(), code: "c1" });

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://willder.example/integrations?integration=slack&connected=1");
    expect(integration.findFirst).toHaveBeenCalledWith({
      where: { id: "int_1", orgId: ORG, provider: "slack", status: "pending" },
      select: { id: true },
    });
    // Reconnecting the same Slack team replaces only that account's earlier row in this org.
    expect(integration.deleteMany).toHaveBeenCalledWith({
      where: { orgId: ORG, provider: "slack", externalAccountId: "T1", id: { not: "int_1" } },
    });
    const update = integration.updateMany.mock.calls[0][0] as {
      where: unknown;
      data: { encryptedTokens: string; meta: unknown; status: string };
    };
    expect(update.where).toEqual({ id: "int_1", orgId: ORG, status: "pending" });
    expect(update.data.status).toBe("connected");
    expect(update.data.encryptedTokens).not.toContain("xoxb-secret");
    expect(unsealSecret(update.data.encryptedTokens)).toEqual({ access_token: "xoxb-secret" });
    expect(JSON.stringify(update.data.meta)).not.toContain("xoxb-secret");
  });

  it("stores no token for a fixture connection", async () => {
    integration.findFirst.mockResolvedValue({ id: "int_1" } as never);
    vi.mocked(exchangeConnectorCode).mockResolvedValue({
      accountId: "mock_slack_1",
      tokens: null,
      meta: { mock: true },
    });
    await callCallback("slack", { state: validState(), code: "c1" });
    const update = integration.updateMany.mock.calls[0][0] as { data: { encryptedTokens: unknown } };
    expect(update.data.encryptedTokens).toBeNull();
  });

  it("rejects a state signed for another org, without touching any row", async () => {
    // The attacker's pending row lives in org_2; the victim (org_1) completes the redirect.
    integration.findFirst.mockResolvedValue(null);
    const res = await callCallback("slack", { state: validState("org_2"), code: "attacker-code" });
    expect(res.status).toBe(400);
    expect(integration.findFirst.mock.calls[0][0]).toMatchObject({ where: { orgId: ORG } });
    expect(exchangeConnectorCode).not.toHaveBeenCalled();
    expect(integration.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a forged state for a real pending row in the caller's org", async () => {
    integration.findFirst.mockResolvedValue({ id: "int_1" } as never);
    const forged = `int_1.${Date.now() + 60_000}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    const res = await callCallback("slack", { state: forged, code: "c1" });
    expect(res.status).toBe(400);
    expect(exchangeConnectorCode).not.toHaveBeenCalled();
    expect(integration.updateMany).not.toHaveBeenCalled();
  });

  it("rejects an expired state", async () => {
    integration.findFirst.mockResolvedValue({ id: "int_1" } as never);
    const expired = signState({
      integrationId: "int_1",
      orgId: ORG,
      provider: "slack",
      now: Date.now() - 11 * 60_000,
    }).state;
    const res = await callCallback("slack", { state: expired, code: "c1" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid or expired connect attempt; start again from Integrations" });
    expect(exchangeConnectorCode).not.toHaveBeenCalled();
  });

  it("rejects a Slack state replayed against the Figma callback", async () => {
    integration.findFirst.mockResolvedValue({ id: "int_1" } as never);
    const res = await callCallback("figma", { state: validState(ORG, "slack"), code: "c1" });
    expect(res.status).toBe(400);
    expect(exchangeConnectorCode).not.toHaveBeenCalled();
  });

  it("rejects a malformed state without querying", async () => {
    const res = await callCallback("slack", { state: "int_1", code: "c1" });
    expect(res.status).toBe(400);
    expect(integration.findFirst).not.toHaveBeenCalled();
  });

  it("requires a signed-in owner or admin", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(null as never);
    expect((await callCallback("slack", { state: validState(), code: "c1" })).status).toBe(401);
    asRole("member");
    expect((await callCallback("slack", { state: validState(), code: "c1" })).status).toBe(403);
    expect(integration.findFirst).not.toHaveBeenCalled();
    expectOneRoleRefusal("integrations:connector-callback");
  });

  it("marks only the caller's own attempt errored when the user declines", async () => {
    integration.findFirst.mockResolvedValue({ id: "int_1" } as never);
    const res = await callCallback("slack", { state: validState(), error: "access_denied" });
    expect(res.headers.get("location")).toContain("connected=0");
    expect(integration.updateMany).toHaveBeenCalledWith({
      where: { id: "int_1", orgId: ORG, status: "pending" },
      data: { status: "error", meta: { error: "access_denied" } },
    });
    expect(exchangeConnectorCode).not.toHaveBeenCalled();
  });

  it("marks the attempt errored when the exchange fails", async () => {
    integration.findFirst.mockResolvedValue({ id: "int_1" } as never);
    vi.mocked(exchangeConnectorCode).mockRejectedValue(new Error("Slack token exchange failed: invalid_code"));
    const res = await callCallback("slack", { state: validState(), code: "bad" });
    expect(res.headers.get("location")).toContain("connected=0");
    expect(integration.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "error" }) }),
    );
  });

  it("does not report success when a concurrent callback already completed the attempt", async () => {
    integration.findFirst.mockResolvedValue({ id: "int_1" } as never);
    vi.mocked(exchangeConnectorCode).mockResolvedValue({ accountId: "T1", tokens: { access_token: "x" }, meta: {} });
    integration.updateMany.mockResolvedValue({ count: 0 } as never);
    const res = await callCallback("slack", { state: validState(), code: "c1" });
    expect(res.headers.get("location")).toContain("connected=0");
  });
});

describe("DELETE /api/integrations/:id", () => {
  const callDelete = (id = "int_1") => disconnect(new Request("http://test", { method: "DELETE" }), params(id));

  it("revokes a Slack token upstream, then deletes it and the account reference", async () => {
    const sealed = sealSecret({ access_token: "xoxb-secret" });
    integration.findFirst.mockResolvedValue({ provider: "slack", encryptedTokens: sealed } as never);
    const res = await callDelete();
    expect(await res.json()).toEqual({ disconnected: "int_1", providerRevoked: true });
    expect(revokeConnectorToken).toHaveBeenCalledWith("slack", { access_token: "xoxb-secret" });
    expect(integration.findFirst.mock.calls[0][0]).toMatchObject({ where: { id: "int_1", orgId: ORG } });
    expect(integration.updateMany).toHaveBeenCalledWith({
      where: { id: "int_1", orgId: ORG },
      data: { status: "disconnected", externalAccountId: null, encryptedTokens: null },
    });
  });

  it("still deletes our copy of the token when the upstream revoke fails", async () => {
    integration.findFirst.mockResolvedValue({
      provider: "slack",
      encryptedTokens: sealSecret({ access_token: "x" }),
    } as never);
    vi.mocked(revokeConnectorToken).mockRejectedValue(new Error("Slack auth.revoke failed: ratelimited"));
    const res = await callDelete();
    expect(await res.json()).toEqual({
      disconnected: "int_1",
      providerRevoked: false,
      providerRevokeError: "Slack auth.revoke failed: ratelimited",
    });
    expect(integration.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ encryptedTokens: null }) }),
    );
  });

  it("revokes a mailbox grant upstream, then deletes its tokens", async () => {
    const sealed = sealTokens({ access_token: "ya29.a", refresh_token: "1//r" });
    integration.findFirst.mockResolvedValue({ provider: "gmail", encryptedTokens: sealed } as never);
    const res = await callDelete();
    expect(await res.json()).toEqual({ disconnected: "int_1", providerRevoked: true });
    expect(revokeMailboxGrant).toHaveBeenCalledWith("gmail", { access_token: "ya29.a", refresh_token: "1//r" });
    expect(revokeConnectorToken).not.toHaveBeenCalled();
    expect(integration.updateMany).toHaveBeenCalledWith({
      where: { id: "int_1", orgId: ORG },
      data: { status: "disconnected", externalAccountId: null, encryptedTokens: null },
    });
  });

  it("reports a mailbox revoke the provider did not confirm, and still deletes the tokens", async () => {
    integration.findFirst.mockResolvedValue({
      provider: "outlook",
      encryptedTokens: sealTokens({ access_token: "eyJ" }),
    } as never);
    vi.mocked(revokeMailboxGrant).mockRejectedValue(new Error("Microsoft has no revoke endpoint for a user's grant"));
    const res = await callDelete();
    expect(await res.json()).toEqual({
      disconnected: "int_1",
      providerRevoked: false,
      providerRevokeError: "Microsoft has no revoke endpoint for a user's grant",
    });
    expect(integration.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ encryptedTokens: null }) }),
    );
  });

  it("makes no upstream call for a row that never held a token", async () => {
    integration.findFirst.mockResolvedValue({ provider: "gmail", encryptedTokens: null } as never);
    const res = await callDelete();
    expect(await res.json()).toEqual({ disconnected: "int_1", providerRevoked: null });
    expect(revokeMailboxGrant).not.toHaveBeenCalled();
  });

  it("returns 404 for another org's integration and changes nothing", async () => {
    integration.findFirst.mockResolvedValue(null);
    const res = await callDelete("int_other");
    expect(res.status).toBe(404);
    expect(revokeConnectorToken).not.toHaveBeenCalled();
    expect(revokeMailboxGrant).not.toHaveBeenCalled();
    expect(integration.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a member", async () => {
    asRole("member");
    expect((await callDelete()).status).toBe(403);
    expect(integration.findFirst).not.toHaveBeenCalled();
    expectOneRoleRefusal("integrations:disconnect");
  });
});
