import { beforeEach, describe, expect, it, vi } from "vitest";

// mcp-session-expiry-gate-gap-20260918. Mirrors route.revoked.test.ts's shape,
// for the specific case that test's own fixture doesn't isolate: a token that
// is EXPIRED but NEVER revoked. Two different columns, two different customer
// stories (a grant that lapsed on its own vs. one someone actively pulled), and
// The founder's planned external-contractor onboarding leans on expiry specifically —
// it fires without anyone remembering to act, so it has to be the reliably
// tested one, not just the one that happens to also be revoked in the fixture
// next to it.
//
// Before this item, this exact case had NO test at all:
// app/api/mcp/route.revoked.test.ts covered revoked-mid-session, nothing
// covered expired-mid-session (confirmed by file listing, see
// claude-expiry-gap-20260918). `resolveCapability()` (services/access/check.ts)
// now rejects an expired-but-unrevoked token at session establishment, the same
// shape as an unknown or revoked one — this proves that, at the layer that
// actually wins (the door, not per-operation-only).
//
// Ground truth the route never sees: the fixture row below is expired and
// nothing else — revokedAt is null. Only db.capability.findUnique is faked
// (honestly — it applies the tokenHash predicate and the caller's own select);
// resolveCapability, the McpServer, the transport and tool registration are all
// real.

const EXPIRED_ONLY_CAPABILITY = {
  id: "cap_2",
  orgId: "org_1",
  agentId: "agent_1",
  scopePath: "org_org_1",
  permission: "read",
  // Ground truth: never revoked, just past its own expiresAt.
  revokedAt: null,
  expiresAt: new Date("2026-08-02T00:00:00Z"),
};

vi.mock("@/lib/db", () => ({
  db: {
    capability: {
      findUnique: vi.fn(async (args: { where: { tokenHash?: string }; select?: Record<string, boolean> }) => {
        // Honest fake: a row exists for this token hash. Apply whatever the
        // caller selected, so the test observes exactly what the real query
        // asks for.
        if (!args.where?.tokenHash) return null;
        const row = EXPIRED_ONLY_CAPABILITY as Record<string, unknown>;
        if (!args.select) return row;
        return Object.fromEntries(
          Object.keys(args.select)
            .filter((k) => args.select![k])
            .map((k) => [k, row[k]]),
        );
      }),
    },
    auditLog: { create: vi.fn(async () => ({ id: "al_1" })) },
  },
}));

import { POST } from "./route";

function post(body: string): Promise<Response> {
  return POST(
    new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer an-expired-but-never-revoked-token",
      },
      body,
    }),
  );
}

async function readBody(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  const line = text.startsWith("data:")
    ? text
        .split("\n")
        .find((l) => l.startsWith("data:"))!
        .slice(5)
        .trim()
    : text;
  return JSON.parse(line);
}

describe("mcp-session-expiry-gate-gap-20260918 — an expired-but-unrevoked token is denied at the door", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refuses tools/list to an expired, never-revoked capability token", async () => {
    const res = await post('{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}');
    const body = await readBody(res);

    // Denied at session establishment (resolveCapability), the same shape as
    // an unknown token — never reaches the McpServer, so no tool list comes
    // back and no audit row is written either (consistent with how an unknown
    // token behaves today: there is no ctx yet to audit against).
    expect(res.status).toBe(401);
    expect(body.error).toBeDefined();
    expect(body.result).toBeUndefined();
  });

  it("refuses a real tool call the same way, before check(), with one deny row naming the token", async () => {
    const res = await post(
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"memory_query","arguments":{"query":"anything"}}}',
    );
    const body = await readBody(res);

    expect(res.status).toBe(401);
    expect(body.error).toBeDefined();
    // The retry after a revoke is the read an org most needs to see, so it is
    // recorded even though no tool ran: one row, against the token's own agent.
    const { db } = await import("@/lib/db");
    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
    expect(vi.mocked(db.auditLog.create).mock.calls[0][0]).toMatchObject({
      data: {
        orgId: "org_1",
        actorType: "agent",
        actorId: "agent_1",
        action: "capability.refused",
        decision: "deny",
        reason: expect.stringMatching(/^capability expired:/),
        metadata: { capabilityId: EXPIRED_ONLY_CAPABILITY.id },
      },
    });
  });
});
