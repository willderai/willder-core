import { beforeEach, describe, expect, it, vi } from "vitest";

// GET /api/mcp answering 405. route.get.test.ts covers a
// missing and an unknown token; this file covers the two dead-token shapes
// that also reach the 401 path (revoked, expired), a GET with no Accept header,
// and the claim the Allow header makes: every method it names is one the
// route actually serves, and GET is not among them.
//
// Only the database is faked, keyed on the token hash, so resolveCapability,
// the route and the SDK transport behind POST and DELETE are real.

vi.mock("@/lib/db", () => ({
  db: {
    capability: { findUnique: vi.fn() },
    // resolveCapability asks whether the token's agent is deactivated; no Agent row means it is not.
    agent: { count: vi.fn().mockResolvedValue(0) },
    auditLog: { create: vi.fn(async () => ({ id: "al_qa" })) },
  },
}));

import { db } from "@/lib/db";
import { generateCapabilityToken, hashCapabilityToken } from "@/services/access";
import { DELETE, GET, POST } from "./route";

const DAY_MS = 24 * 60 * 60 * 1000;
const live = generateCapabilityToken();
const revoked = generateCapabilityToken();
const expired = generateCapabilityToken();

function row(id: string, revokedAt: Date | null, expiresAt: Date) {
  return { id, orgId: "org_qa", agentId: "agent_qa", scopePath: "org_org_qa", revokedAt, expiresAt };
}

const rows: Record<string, ReturnType<typeof row>> = {
  [hashCapabilityToken(live)]: row("cap_live", null, new Date(Date.now() + DAY_MS)),
  [hashCapabilityToken(revoked)]: row("cap_revoked", new Date(Date.now() - 1000), new Date(Date.now() + DAY_MS)),
  [hashCapabilityToken(expired)]: row("cap_expired", null, new Date(Date.now() - 1000)),
};

beforeEach(() => {
  vi.mocked(db.capability.findUnique).mockImplementation(
    (async (args: { where: { tokenHash: string } }) =>
      rows[args.where.tokenHash] ?? null) as unknown as typeof db.capability.findUnique,
  );
  vi.mocked(db.auditLog.create).mockClear();
});

const URL_ = "http://localhost/api/mcp";
const handlers: Record<string, (req: Request) => Promise<Response>> = { GET, POST, DELETE };

function call(method: string, token: string | null, headers: Record<string, string> = {}, body?: string) {
  return handlers[method](
    new Request(URL_, {
      method,
      headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body,
    }),
  );
}

describe("GET /api/mcp with a dead token", () => {
  it.each([
    ["revoked", revoked],
    ["expired", expired],
  ])("answers 401, not 405, for a %s token and records the refusal", async (_label, token) => {
    const res = await call("GET", token, { accept: "text/event-stream" });

    expect(res.status).toBe(401);
    expect((await res.json()).error.message).toMatch(/Invalid or unknown capability token/);
    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/mcp with a live token", () => {
  it("answers 405, not the transport's 406, when the client sends no Accept header", async () => {
    const res = await call("GET", live);

    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST, DELETE");
  });

  it("returns at once with no body, so a legacy SSE client is never left on an open stream", async () => {
    const res = await call("GET", live, { accept: "text/event-stream" });

    expect(res.status).toBe(405);
    expect(res.body).toBeNull();
  });
});

describe("the Allow header on the 405", () => {
  it("names only methods the route serves for a live token", async () => {
    const res = await call("GET", live, { accept: "text/event-stream" });
    const allowed = (res.headers.get("allow") ?? "").split(",").map((m) => m.trim());

    expect(allowed).not.toContain("GET");
    expect(allowed.length).toBeGreaterThan(0);
    for (const method of allowed) {
      const served =
        method === "POST"
          ? await call(
              "POST",
              live,
              { accept: "application/json, text/event-stream", "content-type": "application/json" },
              JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "qa", version: "0" } },
              }),
            )
          : await call(method, live);
      expect(served.status, `${method} named in Allow`).toBe(200);
    }
  });
});

describe("POST and DELETE beside the GET change", () => {
  it.each(["POST", "DELETE"])("%s still answers 401 without a token", async (method) => {
    const res = await call(method, null);

    expect(res.status).toBe(401);
  });

  it.each(["POST", "DELETE"])("%s still answers 401 for a revoked token", async (method) => {
    const res = await call(method, revoked);

    expect(res.status).toBe(401);
  });
});
