// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The Streamable HTTP transport's security rule: a server MUST validate the
// Origin header and answer 403 when one is present and invalid, so a DNS
// rebinding page cannot drive the endpoint. A request with no Origin is a native
// client and is unaffected by the rule and by its configuration; a hosted client
// that sends its own Origin is served only on a request addressed to the app's
// public https origin, and a refusal caused by a missing or wrong
// NEXT_PUBLIC_APP_URL names that variable.
//
// Each case goes through the real route handler, the real SDK transport and a
// capability token minted into the real database.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
// Leaf module, not the `@/services/access` barrel: the barrel builds the
// `@/lib/db` singleton at import time, before beforeAll can point DATABASE_URL
// at the QA database.
import { generateCapabilityToken, hashCapabilityToken } from "@/services/access/capabilities";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-mcp-origin";
const AGENT = "agent-mcp-origin";

describe.skipIf(!QA_URL)("Origin validation on /api/mcp, against a real database", () => {
  let db: PrismaClient;
  let route: typeof import("./route");
  const token = generateCapabilityToken();

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    route = await import("./route");
    await db.capability.deleteMany({ where: { orgId: ORG } });
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId: AGENT,
        tokenHash: hashCapabilityToken(token),
        scopePath: "org_mcp_origin",
        permission: "read",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
  });

  afterAll(async () => {
    await db.capability.deleteMany({ where: { orgId: ORG } });
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.$disconnect();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function initialize(url: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
    return route.POST(
      new Request(url, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          ...extraHeaders,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "origin-test", version: "0" },
          },
        }),
      }),
    );
  }

  /** Asserts a 403 JSON-RPC error and returns its message. */
  async function forbiddenMessage(res: Response): Promise<string> {
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBeNull();
    expect(body.error.message).toMatch(/Origin/);
    return body.error.message as string;
  }

  async function expectInitialized(res: Response) {
    expect(res.status).toBe(200);
    expect((await res.json()).result.serverInfo.name).toBe("willder");
  }

  describe("POST", () => {
    it("serves a native client that sends no Origin", async () => {
      await expectInitialized(await initialize("http://localhost:3000/api/mcp"));
    });

    it("refuses a foreign Origin with 403 even when the bearer token is valid", async () => {
      await forbiddenMessage(await initialize("http://localhost:3000/api/mcp", { origin: "http://evil.example.com" }));
    });

    it("refuses a rebound request: foreign Host and the matching foreign Origin", async () => {
      // A rebinding page is same-origin with itself, so comparing Origin to the
      // request's own host alone would let this through.
      await forbiddenMessage(
        await initialize("http://evil.example.com:3000/api/mcp", { origin: "http://evil.example.com:3000" }),
      );
    });

    it("refuses the opaque Origin a sandboxed page or file sends", async () => {
      await forbiddenMessage(await initialize("http://localhost:3000/api/mcp", { origin: "null" }));
    });

    it("serves a loopback page calling a loopback server", async () => {
      await expectInitialized(await initialize("http://localhost:3917/api/mcp", { origin: "http://localhost:3917" }));
      await expectInitialized(await initialize("http://127.0.0.1:3917/api/mcp", { origin: "http://localhost:5173" }));
    });

    it("serves the app's own origin on its public host", async () => {
      vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example/");
      await expectInitialized(await initialize("https://app.example/api/mcp", { origin: "https://app.example" }));
    });

    it("serves a hosted client's Origin on a request addressed to the app's public origin", async () => {
      // claude.ai custom connectors call from Anthropic's servers with
      // `Origin: https://claude.ai`. The request names the app's real host, so it
      // is not a rebinding, and the endpoint takes no cookie, so a page cannot
      // borrow a credential either.
      vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example/");
      await expectInitialized(await initialize("https://app.example/api/mcp", { origin: "https://claude.ai" }));
      await expectInitialized(await initialize("https://app.example/api/mcp", { origin: "https://chatgpt.com" }));
    });

    it("refuses the opaque Origin even on the app's public origin", async () => {
      vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example/");
      await forbiddenMessage(await initialize("https://app.example/api/mcp", { origin: "null" }));
      await forbiddenMessage(await initialize("https://app.example/api/mcp", { origin: "file://" }));
    });

    it("refuses a foreign Origin on any host other than the app's public origin", async () => {
      vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example/");
      await forbiddenMessage(await initialize("https://preview.example/api/mcp", { origin: "https://claude.ai" }));
      await forbiddenMessage(await initialize("http://app.example/api/mcp", { origin: "https://claude.ai" }));
      await forbiddenMessage(await initialize("https://app.example:8443/api/mcp", { origin: "https://claude.ai" }));
    });

    it("refuses a rebound request even when the app's public origin is configured", async () => {
      vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example/");
      await forbiddenMessage(
        await initialize("http://evil.example.com/api/mcp", { origin: "http://evil.example.com" }),
      );
    });

    it("keeps the strict rule when the configured app origin is loopback or plain http", async () => {
      vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
      await forbiddenMessage(await initialize("http://localhost:3000/api/mcp", { origin: "http://evil.example.com" }));
      vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://localhost:3000");
      await forbiddenMessage(
        await initialize("https://localhost:3000/api/mcp", { origin: "https://evil.example.com" }),
      );
      vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://app.example");
      await forbiddenMessage(await initialize("http://app.example/api/mcp", { origin: "https://claude.ai" }));
    });

    it("takes no cookie as a credential, so a foreign Origin without a bearer token gets 401", async () => {
      vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example/");
      const res = await route.POST(
        new Request("https://app.example/api/mcp", {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            origin: "https://attacker.example",
            cookie: "__session=a-signed-in-browser-session; __client_uat=1",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
        }),
      );
      expect(res.status).toBe(401);
    });

    it("checks Origin before authentication, so a page learns nothing about a token", async () => {
      const res = await route.POST(
        new Request("http://localhost:3000/api/mcp", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://evil.example.com" },
          body: "{}",
        }),
      );
      await forbiddenMessage(res);
    });
  });

  describe("a missing or wrong NEXT_PUBLIC_APP_URL", () => {
    const BAD_VALUES: [string, string | undefined][] = [
      ["unset", undefined],
      ["blank", "  "],
      ["not a URL", "willder.example"],
      ["plain http", "http://app.example"],
      ["the wrong host", "https://old-name.example"],
    ];

    it.each(BAD_VALUES)("never affects a client that sends no Origin (%s)", async (_label, value) => {
      vi.stubEnv("NEXT_PUBLIC_APP_URL", value);
      await expectInitialized(await initialize("https://app.example/api/mcp"));
    });

    it.each(BAD_VALUES)(
      "refuses a hosted client's Origin with a 403 naming the variable to set (%s)",
      async (_label, value) => {
        vi.stubEnv("NEXT_PUBLIC_APP_URL", value);
        const message = await forbiddenMessage(
          await initialize("https://app.example/api/mcp", { origin: "https://claude.ai" }),
        );
        expect(message).toContain("NEXT_PUBLIC_APP_URL");
        expect(message).toContain("docs/environment.md");
      },
    );

    it("names the configured origin and the one the request reached when they differ", async () => {
      vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://old-name.example");
      const message = await forbiddenMessage(
        await initialize("https://app.example/api/mcp", { origin: "https://claude.ai" }),
      );
      expect(message).toContain("https://old-name.example");
      expect(message).toContain("https://app.example");
    });

    it("gives a rebinding attempt on plain http no configuration hint", async () => {
      vi.stubEnv("NEXT_PUBLIC_APP_URL", undefined);
      const message = await forbiddenMessage(
        await initialize("http://evil.example.com/api/mcp", { origin: "http://evil.example.com" }),
      );
      expect(message).not.toContain("NEXT_PUBLIC_APP_URL");
    });
  });

  describe("GET and DELETE", () => {
    it("answers a foreign-Origin GET with 403, not the 405 a native client gets", async () => {
      const headers = { accept: "text/event-stream", authorization: `Bearer ${token}` };
      await forbiddenMessage(
        await route.GET(
          new Request("http://localhost:3000/api/mcp", { headers: { ...headers, origin: "http://evil.example.com" } }),
        ),
      );
      expect((await route.GET(new Request("http://localhost:3000/api/mcp", { headers }))).status).toBe(405);
    });

    it("answers a foreign-Origin DELETE with 403", async () => {
      await forbiddenMessage(
        await route.DELETE(
          new Request("http://localhost:3000/api/mcp", {
            method: "DELETE",
            headers: { authorization: `Bearer ${token}`, origin: "http://evil.example.com" },
          }),
        ),
      );
    });
  });
});
