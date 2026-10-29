import { beforeEach, describe, expect, it, vi } from "vitest";

// The active-agent read that decides a token is fail-closed.
// When the database cannot answer whether the token's agent is still active,
// the token must not be treated as live. resolveCapability, check() and the
// hosted MCP route are real; only the database is faked, and only to fail.

vi.mock("@/lib/db", () => ({
  db: {
    capability: { findUnique: vi.fn() },
    agent: { count: vi.fn() },
    $queryRaw: vi.fn(),
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit_qa" }), update: vi.fn() },
  },
}));

import { db } from "@/lib/db";
import { check, generateCapabilityToken, hashCapabilityToken, resolveCapability } from "@/services/access";
import { POST } from "@/app/api/mcp/route";

const token = generateCapabilityToken();
const tokenHash = hashCapabilityToken(token);
const outage = new Error("connection terminated unexpectedly");

describe("the active-agent read fails closed", () => {
  beforeEach(() => {
    vi.mocked(db.capability.findUnique).mockImplementation((async (args: { where: { tokenHash: string } }) =>
      args.where.tokenHash === tokenHash
        ? {
            id: "cap_qa",
            orgId: "org_qa",
            agentId: "custom-qa",
            scopePath: "org_qa.sales",
            revokedAt: null,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          }
        : null) as unknown as typeof db.capability.findUnique);
    vi.mocked(db.agent.count).mockRejectedValue(outage);
    vi.mocked(db.$queryRaw).mockRejectedValue(outage);
  });

  it("resolveCapability throws rather than returning a live capability", async () => {
    await expect(resolveCapability(token, "mcp")).rejects.toThrow(outage.message);
  });

  it("the hosted MCP route never answers 2xx, so no tool runs", async () => {
    const answer = POST(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        },
        body: '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}',
      }),
    ).then(
      (res) => res.status,
      () => "threw",
    );
    const outcome = await answer;
    expect(outcome === "threw" || (typeof outcome === "number" && outcome >= 500)).toBe(true);
  });

  it("check() throws rather than allowing when its capability query fails", async () => {
    await expect(
      check(
        { orgId: "org_qa", actor: { type: "agent", id: "custom-qa", capabilityToken: token }, origin: "mcp" },
        { action: "memory.read", scope: "org_qa.sales" },
      ),
    ).rejects.toThrow(outage.message);
  });
});
