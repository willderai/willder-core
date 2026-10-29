import { beforeEach, describe, expect, it, vi } from "vitest";

// A revoked but unexpired token must be refused at the /api/mcp door.
//
// resolveCapability()'s door check has two legs, `row.revokedAt` and
// `row.expiresAt <= new Date()`. route.revoked.test.ts's row is revoked AND
// long expired ("dead twice over", as its own header says), so the expiry leg
// alone already denies it and the revocation leg never has to hold anything
// up. This file covers revoked-but-still-within-its-TTL, so that deleting the
// `row.revokedAt` leg cannot leave the suite green.
//
// That is the case revocation actually produces. Revoking a token is precisely
// the act of killing it BEFORE its expiry: a token revoked today typically has
// weeks of TTL left (90 days at mint, services/access/capabilities.ts). Drop
// that leg in a refactor and a revoked agent reconnects and gets the full
// tools/list back, the exact defect route.revoked.test.ts characterizes.
//
// Ground truth the route never sees: the row below is revoked and NOT expired.
const REVOKED_BUT_UNEXPIRED_CAPABILITY = {
  id: "cap_3",
  orgId: "org_1",
  agentId: "agent_1",
  scopePath: "org_org_1",
  permission: "read",
  // Revoked an hour ago, but minted with a normal 90-day TTL, so it is still
  // comfortably inside its own expiry window. Relative to now on purpose: a
  // fixed future date would silently turn into an expired token later and start
  // passing for the wrong reason.
  revokedAt: new Date(Date.now() - 60 * 60 * 1000),
  expiresAt: new Date(Date.now() + 89 * 24 * 60 * 60 * 1000),
};

vi.mock("@/lib/db", () => ({
  db: {
    capability: {
      findUnique: vi.fn(async (args: { where: { tokenHash?: string }; select?: Record<string, boolean> }) => {
        // Honest fake, same shape as route.revoked.test.ts / route.expired.test.ts:
        // a row exists for this token hash, and the caller's own select is applied
        // so the test observes exactly what the real query asks for.
        if (!args.where?.tokenHash) return null;
        const row = REVOKED_BUT_UNEXPIRED_CAPABILITY as Record<string, unknown>;
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
        Authorization: "Bearer a-revoked-but-not-yet-expired-token",
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

describe("mcp-session-expiry-gate-gap-20260918 — a revoked token still inside its TTL is denied at the door", () => {
  beforeEach(() => vi.clearAllMocks());

  it("proves the fixture is revoked on its own, not merely expired", () => {
    // If this ever stops holding, the two cases below would pass via the expiry
    // leg and silently stop covering revocation — the exact gap this file closes.
    expect(REVOKED_BUT_UNEXPIRED_CAPABILITY.revokedAt).not.toBeNull();
    expect(REVOKED_BUT_UNEXPIRED_CAPABILITY.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("refuses tools/list to a revoked, not-yet-expired capability token", async () => {
    const res = await post('{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}');
    const body = await readBody(res);

    // Denied at session establishment, same shape as an unknown token: no tool
    // list comes back, so a revoked agent can't read a 200 as "still connected".
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
        reason: expect.stringMatching(/^capability revoked:/),
        metadata: { capabilityId: REVOKED_BUT_UNEXPIRED_CAPABILITY.id },
      },
    });
  });
});
