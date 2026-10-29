import { describe, expect, it, vi } from "vitest";

// A tools/list 200 must prove the token is live. The MCP settings panel's
// copy-paste snippet is a `tools/list`, and the prose under it says the call
// "doubles as proof the endpoint and token work", so a dead token must not
// get a tool list back.
//
// `resolveCapability()` (services/access/check.ts) rejects a revoked or
// expired token at session establishment, the same shape as an unknown one,
// so `tools/list` on a dead token gets a 401 before it ever reaches the
// McpServer. `check()` remains the only place scope + permission are
// evaluated, per call.
//
// Ground truth the route never sees: the fixture row below is BOTH revoked and
// long expired. Only db.capability.findUnique is faked (honestly: it applies
// the tokenHash predicate and the caller's own select); resolveCapability, the
// McpServer, the transport and tool registration are all real.
//
// The second case below is UI-copy correctness, kept as a guard either way.

const REVOKED_CAPABILITY = {
  id: "cap_1",
  orgId: "org_1",
  agentId: "agent_1",
  scopePath: "org_org_1",
  permission: "read",
  // Ground truth: this token is dead twice over.
  revokedAt: new Date("2026-08-01T00:00:00Z"),
  expiresAt: new Date("2026-08-02T00:00:00Z"),
};

vi.mock("@/lib/db", () => ({
  db: {
    capability: {
      findUnique: vi.fn(async (args: { where: { tokenHash?: string }; select?: Record<string, boolean> }) => {
        // Honest fake: a row exists for this token hash. Apply whatever the
        // caller selected, so the test observes exactly what the real query
        // asks for (now includes revokedAt/expiresAt — that's the fix).
        if (!args.where?.tokenHash) return null;
        const row = REVOKED_CAPABILITY as Record<string, unknown>;
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
        Authorization: "Bearer a-revoked-and-expired-token",
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

describe("what a tools/list 200 actually proves about a token", () => {
  it("refuses tools/list to a revoked AND expired capability token", async () => {
    const res = await post('{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}');
    const body = await readBody(res);

    // Denied at the door, same shape as an unknown token — never reaches the
    // McpServer, so no tool list is returned either way.
    expect(res.status).toBe(401);
    expect(body.error).toBeDefined();
    expect(body.result).toBeUndefined();
  });

  it("the panel must not tell a customer this proves their token works", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const src = readFileSync(path.join(process.cwd(), "components/settings/mcp-panel.tsx"), "utf8");

    // Normalize JSX entities and whitespace so the assertion is about the claim,
    // not about line wrapping.
    const prose = src.replace(/&apos;/g, "'").replace(/\s+/g, " ");

    // Given the case above, a claim that the call proves the TOKEN works is
    // false for any revoked or expired token. Claiming it proves the ENDPOINT
    // is reachable, or that the token is recognized, is accurate and fine.
    // Asserted as a boolean so a failure prints the claim, not the whole file.
    const claimsTheTokenWorks = /proof the endpoint and token work/i.test(prose);
    expect({ claimsTheTokenWorks }).toEqual({ claimsTheTokenWorks: false });
  });
});
