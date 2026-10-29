import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Gmail/Outlook OAuth routes: connect creates a pending row and a signed state;
// the callback exchanges the code and attaches tokens only for the signed-in
// owner/admin's own pending row named by a valid, unexpired state. Before the
// state was signed, the callback resolved the row from a bare integration id, so
// anyone holding that id could attach their own mailbox to, or mark errored,
// another org's pending row. The db is a double, so these pin the predicates each
// query carries and the checks that run before any write, not Postgres behaviour.

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/db", () => {
  const integration = {
    create: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
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
vi.mock("@/services/integrations/mailbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/integrations/mailbox")>();
  // The real mock-mode exchange by default, so the connect → callback round trip runs as the demo does.
  return { ...actual, exchangeCode: vi.fn(actual.exchangeCode) };
});

import { requireAccessContext } from "@/lib/access-context";
import { db } from "@/lib/db";
import { signState } from "@/services/integrations/connector-oauth";
import { exchangeCode, unsealTokens } from "@/services/integrations/mailbox";
import { POST as connect } from "./connect/route";
import { GET as callback } from "./callback/route";

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
const validState = (orgId = ORG, provider: "gmail" | "outlook" = "gmail") =>
  signState({ integrationId: "int_1", orgId, provider }).state;

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

describe("POST /api/integrations/:provider/connect (gmail, outlook)", () => {
  it("returns an authorize URL whose state is signed for the new row and the caller's org", async () => {
    integration.create.mockResolvedValue({ id: "int_1", provider: "gmail", status: "pending" } as never);
    const res = await connect(new Request("http://test", { method: "POST" }), params("gmail"));
    expect(res.status).toBe(201);
    expect(integration.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: { orgId: ORG, provider: "gmail", status: "pending" } }),
    );
    const body = await res.json();
    const state = new URL(body.authUrl).searchParams.get("state")!;
    // Not the bare integration id the callback used to trust.
    expect(state).not.toBe("int_1");
    expect(state.startsWith("int_1.")).toBe(true);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("marks the row errored when no state can be signed, naming the missing key", async () => {
    vi.stubEnv("APP_ENCRYPTION_KEY", "");
    integration.create.mockResolvedValue({ id: "int_1", provider: "outlook", status: "pending" } as never);
    const res = await connect(new Request("http://test", { method: "POST" }), params("outlook"));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/APP_ENCRYPTION_KEY/);
    expect(integration.update).toHaveBeenCalledWith({ where: { id: "int_1" }, data: { status: "error" } });
  });
});

describe("mock-mode connect → callback round trip", () => {
  it("connects the mailbox through the signed state the connect route issued", async () => {
    integration.create.mockResolvedValue({ id: "int_1", provider: "outlook", status: "pending" } as never);
    const connected = await connect(new Request("http://test", { method: "POST" }), params("outlook"));
    const authUrl = new URL((await connected.json()).authUrl);
    expect(authUrl.pathname).toBe("/api/integrations/outlook/callback");

    integration.findFirst.mockResolvedValue({ id: "int_1" } as never);
    const res = await callback(new Request(authUrl), params("outlook"));

    expect(res.headers.get("location")).toBe("https://willder.example/inbox?connected=1");
    const update = integration.updateMany.mock.calls[0][0] as {
      where: unknown;
      data: { status: string; externalAccountId: string; encryptedTokens: string };
    };
    expect(update.where).toEqual({ id: "int_1", orgId: ORG, status: "pending" });
    expect(update.data.status).toBe("connected");
    expect(update.data.externalAccountId).toMatch(/^mock_outlook_/);
    expect(unsealTokens(update.data.encryptedTokens)).toMatchObject({ mock: true });
  });
});

describe("GET /api/integrations/:provider/callback (gmail, outlook)", () => {
  it("attaches the exchanged account to the caller's own pending row", async () => {
    integration.findFirst.mockResolvedValue({ id: "int_1" } as never);
    vi.mocked(exchangeCode).mockResolvedValueOnce({
      accountId: "acct_1",
      email: "owner@acme.test",
      tokens: { access_token: "ya29-secret" },
    });

    const res = await callCallback("gmail", { state: validState(), code: "c1" });

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://willder.example/inbox?connected=1");
    expect(integration.findFirst).toHaveBeenCalledWith({
      where: { id: "int_1", orgId: ORG, provider: "gmail", status: "pending" },
      select: { id: true },
    });
    expect(exchangeCode).toHaveBeenCalledWith({ provider: "gmail", code: "c1" });
    // Only an earlier row for this same account, inside the caller's own org, is replaced.
    expect(integration.deleteMany).toHaveBeenCalledWith({
      where: { orgId: ORG, provider: "gmail", externalAccountId: "acct_1", id: { not: "int_1" } },
    });
    expect(integration.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "int_1", orgId: ORG, status: "pending" },
        data: expect.objectContaining({ status: "connected", externalAccountId: "acct_1" }),
      }),
    );
  });

  it("rejects a bare integration id, the unsigned state the callback used to accept", async () => {
    const res = await callCallback("gmail", { state: "int_1", code: "attacker-code" });
    expect(res.status).toBe(400);
    expect(integration.findFirst).not.toHaveBeenCalled();
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(integration.updateMany).not.toHaveBeenCalled();
    expect(integration.deleteMany).not.toHaveBeenCalled();
  });

  it("rejects a bare integration id on the error path too, leaving the row pending", async () => {
    const res = await callCallback("outlook", { state: "int_1", error: "access_denied" });
    expect(res.status).toBe(400);
    expect(integration.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a forged state for a real pending row in the caller's org", async () => {
    integration.findFirst.mockResolvedValue({ id: "int_1" } as never);
    const forged = `int_1.${Date.now() + 60_000}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    const res = await callCallback("gmail", { state: forged, code: "c1" });
    expect(res.status).toBe(400);
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(integration.updateMany).not.toHaveBeenCalled();
    expect(integration.deleteMany).not.toHaveBeenCalled();
  });

  it("rejects an expired state", async () => {
    integration.findFirst.mockResolvedValue({ id: "int_1" } as never);
    const expired = signState({
      integrationId: "int_1",
      orgId: ORG,
      provider: "gmail",
      now: Date.now() - 11 * 60_000,
    }).state;
    const res = await callCallback("gmail", { state: expired, code: "c1" });
    expect(res.status).toBe(400);
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(integration.updateMany).not.toHaveBeenCalled();
  });

  it("looks the pending row up only inside the caller's org", async () => {
    // The attacker's pending row lives in org_2; the victim (org_1) completes the redirect.
    integration.findFirst.mockResolvedValue(null);
    const res = await callCallback("gmail", { state: validState("org_2"), code: "attacker-code" });
    expect(res.status).toBe(400);
    expect(integration.findFirst.mock.calls[0][0]).toMatchObject({ where: { orgId: ORG } });
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(integration.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a state signed for another org even if the row lookup matched", async () => {
    // The second, independent check: the MAC binds the org, so the state alone refuses.
    integration.findFirst.mockResolvedValue({ id: "int_1" } as never);
    const res = await callCallback("gmail", { state: validState("org_2"), error: "access_denied" });
    expect(res.status).toBe(400);
    expect(integration.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a Gmail state replayed against the Outlook callback", async () => {
    integration.findFirst.mockResolvedValue({ id: "int_1" } as never);
    const res = await callCallback("outlook", { state: validState(ORG, "gmail"), code: "c1" });
    expect(res.status).toBe(400);
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("requires a signed-in owner or admin", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(null as never);
    expect((await callCallback("gmail", { state: validState(), code: "c1" })).status).toBe(401);
    asRole("member");
    expect((await callCallback("gmail", { state: validState(), code: "c1" })).status).toBe(403);
    expect(integration.findFirst).not.toHaveBeenCalled();
    expectOneRoleRefusal("integrations:mailbox-callback");
  });

  it("marks only the caller's own attempt errored when the user declines", async () => {
    integration.findFirst.mockResolvedValue({ id: "int_1" } as never);
    const res = await callCallback("outlook", { state: validState(ORG, "outlook"), error: "access_denied" });
    expect(res.headers.get("location")).toContain("connected=0");
    expect(integration.updateMany).toHaveBeenCalledWith({
      where: { id: "int_1", orgId: ORG, status: "pending" },
      data: { status: "error", meta: { error: "access_denied" } },
    });
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("marks the attempt errored when the exchange fails", async () => {
    integration.findFirst.mockResolvedValue({ id: "int_1" } as never);
    vi.mocked(exchangeCode).mockRejectedValueOnce(new Error("Gmail token exchange failed: 400"));
    const res = await callCallback("gmail", { state: validState(), code: "bad" });
    expect(res.headers.get("location")).toContain("connected=0");
    expect(integration.updateMany).toHaveBeenCalledWith({
      where: { id: "int_1", orgId: ORG, status: "pending" },
      data: { status: "error", meta: { error: "Gmail token exchange failed: 400" } },
    });
  });

  it("does not report success when a concurrent callback already completed the attempt", async () => {
    integration.findFirst.mockResolvedValue({ id: "int_1" } as never);
    integration.updateMany.mockResolvedValue({ count: 0 } as never);
    const res = await callCallback("gmail", { state: validState(), code: "c1" });
    expect(res.headers.get("location")).toContain("connected=0");
  });
});
