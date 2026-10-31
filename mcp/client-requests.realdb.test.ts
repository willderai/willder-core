// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The client-request relay (mcp/client-requests.ts): a request the server sends a client in
// the middle of a tool call is answered on a later HTTP request, which reaches a fresh server.
// The rules under test:
//  - the whole round trip through the real route: an elicitation and a sampling request reach
//    the client, its replies arrive as separate POSTs, and the calls return them;
//  - the fixtures are served only to an agent MCP_CONFORMANCE_AGENTS lists: another token that
//    sends the header gets a plain connection, with no fixture and no streamed reply;
//  - a reply is taken only from the token that asked (its agent, in its org), once, also through
//    the real route, where another token of the same agent posting the reply is ignored; an oversized reply, or one
//    under an id nobody was sent, changes nothing, and a body is read for its first few only;
//  - a client's error and a malformed result fail the call with the reason; no reply at all
//    fails it with a timeout; every outcome leaves no row behind;
//  - a row a dead call left is swept after ten minutes, in the asking org only.
//
// Real: the hosted MCP endpoint over a socket (mcp/http-test-server.ts), capability tokens,
// and the relay's rows on Postgres. The client is the SDK's own Streamable HTTP client.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  ElicitResultSchema,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { Asker } from "./client-requests";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "mcpclientrequests";
const OTHER_ORG = "mcpclientrequestsother";
const AGENT = "relay-agent";
/** The agent the fixtures are served to; the one that is not listed. */
const UNLISTED_AGENT = "relay-agent-unlisted";
const CREDENTIAL = "hash:asking-token";
const ASKER: Asker = { orgId: ORG, agentId: AGENT, credential: CREDENTIAL };

describe.skipIf(!QA_URL)("the client-request relay", { timeout: 30_000 }, () => {
  let db: PrismaClient;
  let mcpUrl: string;
  let closeMcp: () => Promise<void>;
  let relay: typeof import("./client-requests");
  let token = "";
  let unlistedToken = "";
  /** A second token of AGENT's: same org, same agent, a different credential. */
  let siblingToken = "";

  /** A pending request as askClient stores it, for the delivery rules alone. */
  const pending = (id: string, createdAt = new Date()) =>
    db.mcpClientRequest.create({ data: { id, orgId: ORG, agentId: AGENT, credential: CREDENTIAL, createdAt } });
  const reply = (id: string, result: Record<string, unknown> = { action: "accept", content: { name: "x" } }) => ({
    jsonrpc: "2.0",
    id,
    result,
  });

  beforeAll(async () => {
    if (QA_URL === undefined) return;
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    process.env.GRAPHITI_SERVICE_URL = "http://127.0.0.1:9";
    process.env.GRAPHITI_SERVICE_API_KEY = "test-key";
    vi.stubEnv("MCP_CONFORMANCE_AGENTS", `${ORG}/${AGENT}`);
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    relay = await import("./client-requests");
    const { startMcpTestServer } = await import("./http-test-server");
    const mcp = await startMcpTestServer();
    mcpUrl = mcp.url;
    closeMcp = mcp.close;
    await deleteOrgsWithRetry(db, { where: { id: { in: [ORG, OTHER_ORG] } } });
    for (const id of [ORG, OTHER_ORG]) {
      await db.org.create({ data: { id, name: id } });
      await db.scope.create({ data: { orgId: id, path: `org_${id}`, name: id } });
    }
    token = `wcap_test_${AGENT}_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId: AGENT,
        tokenHash: hashCapabilityToken(token),
        scopePath: `org_${ORG}`,
        permission: "read",
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    siblingToken = `wcap_test_${AGENT}_sibling_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId: AGENT,
        tokenHash: hashCapabilityToken(siblingToken),
        scopePath: `org_${ORG}`,
        permission: "read",
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    unlistedToken = `wcap_test_${UNLISTED_AGENT}_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId: UNLISTED_AGENT,
        tokenHash: hashCapabilityToken(unlistedToken),
        scopePath: `org_${ORG}`,
        permission: "read",
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
  }, 120_000);

  afterEach(async () => {
    if (QA_URL === undefined) return;
    await db.mcpClientRequest.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
  });

  afterAll(async () => {
    if (QA_URL === undefined) return;
    vi.unstubAllEnvs();
    await closeMcp?.();
    await deleteOrgsWithRetry(db, { where: { id: { in: [ORG, OTHER_ORG] } } });
    await db.$disconnect();
  });

  it("carries an elicitation and a sampling request to the client and its replies back, through the real route", async () => {
    const client = new Client(
      { name: "willder-test", version: "0.0.0" },
      { capabilities: { elicitation: {}, sampling: {} } },
    );
    const asked: string[] = [];
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      asked.push(request.params.message);
      return { action: "accept", content: { username: "dana", email: "dana@example.com" } };
    });
    client.setRequestHandler(CreateMessageRequestSchema, async () => ({
      role: "assistant",
      content: { type: "text", text: "four" },
      model: "m",
      stopReason: "endTurn",
    }));
    await client.connect(
      new StreamableHTTPClientTransport(new URL(mcpUrl), {
        requestInit: { headers: { Authorization: `Bearer ${token}`, "X-Willder-Conformance": "fixtures" } },
      }),
    );
    try {
      const elicited = await client.callTool({ name: "test_elicitation", arguments: { message: "Who are you?" } });
      expect(asked).toEqual(["Who are you?"]);
      // The reply is stored as JSONB, which keeps no key order, so the content is compared as an object.
      const [answer] = elicited.content as { type: string; text: string }[];
      const lead = "User response: action=accept, content=";
      expect(answer!.text.startsWith(lead)).toBe(true);
      expect(JSON.parse(answer!.text.slice(lead.length))).toEqual({ username: "dana", email: "dana@example.com" });
      const sampled = await client.callTool({ name: "test_sampling", arguments: { prompt: "2+2?" } });
      expect(sampled.content).toEqual([{ type: "text", text: "LLM response: four" }]);
    } finally {
      await client.close();
    }
    expect(await db.mcpClientRequest.count({ where: { orgId: ORG } })).toBe(0);
  });

  it("serves no fixture to a token whose agent MCP_CONFORMANCE_AGENTS does not list, though it sends the header", async () => {
    const headers = { Authorization: `Bearer ${unlistedToken}`, "X-Willder-Conformance": "fixtures" };
    // A streamed reply is what holds a fixture call open; this one answers as plain JSON.
    const raw = await fetch(mcpUrl, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-type")).toMatch(/^application\/json/);
    await raw.text();

    const client = new Client(
      { name: "willder-test", version: "0.0.0" },
      { capabilities: { elicitation: {}, sampling: {} } },
    );
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers } }));
    try {
      expect((await client.listTools()).tools.map((t) => t.name).filter((name) => name.startsWith("test_"))).toEqual(
        [],
      );
      expect(client.getServerCapabilities()?.logging).toBeUndefined();
      const sampled = await client.callTool({ name: "test_sampling", arguments: { prompt: "2+2?" } });
      expect(sampled.isError).toBe(true);
      expect(JSON.stringify(sampled.content)).toMatch(/not found/i);
    } finally {
      await client.close();
    }
    expect(await db.mcpClientRequest.count({ where: { orgId: ORG } })).toBe(0);
  });

  it.each([
    ["another agent in the org", { orgId: ORG, agentId: "someone-else", credential: CREDENTIAL }],
    ["the same agent id in another org", { orgId: OTHER_ORG, agentId: AGENT, credential: CREDENTIAL }],
    ["the same agent through another of its tokens", { orgId: ORG, agentId: AGENT, credential: "hash:another-token" }],
  ])("ignores a reply from %s", async (_, from) => {
    await pending("11111111-1111-4111-8111-111111111111");
    expect(await relay.deliverClientReplies(from, reply("11111111-1111-4111-8111-111111111111"))).toBe(0);
    expect(
      (await db.mcpClientRequest.findUniqueOrThrow({ where: { id: "11111111-1111-4111-8111-111111111111" } })).reply,
    ).toBeNull();
  });

  it("takes a reply through the real route only from the token that asked, not another token of its agent", async () => {
    const id = "88888888-8888-4888-8888-888888888888";
    // The row as the route stores it for a call made with `token` (route.ts askerOf).
    await db.mcpClientRequest.create({
      data: { id, orgId: ORG, agentId: AGENT, credential: relay.credentialKeyOf({ capabilityToken: token }) },
    });
    const post = async (bearer: string, body: unknown) => {
      const res = await fetch(mcpUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(body),
      });
      await res.text();
    };
    await post(siblingToken, reply(id, { action: "accept", content: { from: "sibling" } }));
    expect((await db.mcpClientRequest.findUniqueOrThrow({ where: { id } })).reply).toBeNull();
    const own = reply(id, { action: "accept", content: { from: "asker" } });
    await post(token, own);
    expect((await db.mcpClientRequest.findUniqueOrThrow({ where: { id } })).reply).toEqual(own);
  });

  it("takes the asking agent's first reply only, from a single message or a batch", async () => {
    await pending("22222222-2222-4222-8222-222222222222");
    const first = reply("22222222-2222-4222-8222-222222222222", { action: "accept", content: { n: 1 } });
    expect(
      await relay.deliverClientReplies(ASKER, [first, { jsonrpc: "2.0", method: "notifications/initialized" }]),
    ).toBe(1);
    expect(
      await relay.deliverClientReplies(ASKER, reply("22222222-2222-4222-8222-222222222222", { action: "decline" })),
    ).toBe(0);
    expect(
      (await db.mcpClientRequest.findUniqueOrThrow({ where: { id: "22222222-2222-4222-8222-222222222222" } })).reply,
    ).toEqual(first);
  });

  it("reads only the first replies of a body that carries many", async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `77777777-7777-4777-8777-${String(i).padStart(12, "0")}`);
    for (const id of ids) await pending(id);
    expect(
      await relay.deliverClientReplies(
        ASKER,
        ids.map((id) => reply(id)),
      ),
    ).toBe(relay.MAX_REPLIES_PER_BODY);
    const answered = await db.mcpClientRequest.findMany({
      where: { id: { in: ids } },
      select: { id: true, reply: true },
      orderBy: { id: "asc" },
    });
    expect(answered.map((r) => r.reply !== null)).toEqual(ids.map((_, i) => i < relay.MAX_REPLIES_PER_BODY));
  });

  it.each([
    [
      "an oversized reply",
      () => reply("33333333-3333-4333-8333-333333333333", { action: "accept", content: { blob: "x".repeat(300_000) } }),
    ],
    ["a reply under a numeric id", () => ({ jsonrpc: "2.0", id: 7, result: {} })],
    ["a request, not a reply", () => ({ jsonrpc: "2.0", id: "33333333-3333-4333-8333-333333333333", method: "ping" })],
  ])("stores nothing for %s", async (_, message) => {
    await pending("33333333-3333-4333-8333-333333333333");
    expect(await relay.deliverClientReplies(ASKER, message())).toBe(0);
    expect(
      (await db.mcpClientRequest.findUniqueOrThrow({ where: { id: "33333333-3333-4333-8333-333333333333" } })).reply,
    ).toBeNull();
  });

  /**
   * askClient on a real server whose client answers through deliverClientReplies, as the route
   * hands it a POST, with `answer` deciding the reply (or none).
   */
  async function askThroughRelay(answer: (id: string) => JSONRPCMessage | null, timeoutMs = 5_000): Promise<unknown> {
    const server = new McpServer({ name: "test", version: "0" });
    let settle: (asked: Promise<unknown>) => void = () => undefined;
    // Resolved with askClient's own promise, so it settles as that call does.
    const outcome = new Promise<unknown>((resolve) => (settle = resolve));
    server.registerTool("ask", {}, async (extra) => {
      const asked = relay.askClient(
        server,
        extra,
        ASKER,
        { method: "elicitation/create", params: { message: "m", requestedSchema: { type: "object", properties: {} } } },
        ElicitResultSchema,
        {
          timeoutMs,
          pollIntervalMs: 20,
        },
      );
      settle(asked);
      await asked.catch(() => undefined);
      return { content: [] };
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    clientSide.onmessage = (message) => {
      if (!("method" in message) || message.method !== "elicitation/create" || !("id" in message)) return;
      const sent = answer(String(message.id));
      if (sent) void relay.deliverClientReplies(ASKER, sent);
    };
    await clientSide.start();
    await clientSide.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ask", arguments: {} } });
    try {
      return await outcome;
    } finally {
      await server.close();
    }
  }

  it.each([
    [
      "the client's error",
      (id: string) => ({ jsonrpc: "2.0" as const, id, error: { code: -32601, message: "Method not found" } }),
      /The client refused the request: Method not found/,
    ],
    [
      "a result of the wrong shape",
      (id: string) => ({ jsonrpc: "2.0" as const, id, result: { action: "maybe" } }),
      /did not have the shape/,
    ],
    ["no reply at all", () => null, /did not answer elicitation\/create within 0\.3 s/],
  ])("fails the call with the reason on %s, and leaves no row", async (_, answer, reason) => {
    await expect(askThroughRelay(answer, 300)).rejects.toThrow(reason);
    expect(await db.mcpClientRequest.count({ where: { orgId: ORG } })).toBe(0);
  });

  it("sweeps a row a dead call left after ten minutes, in the asking org only", async () => {
    const old = new Date(Date.now() - 11 * 60_000);
    await pending("44444444-4444-4444-8444-444444444444", old);
    await pending("55555555-5555-4555-8555-555555555555", new Date(Date.now() - 5 * 60_000));
    await db.mcpClientRequest.create({
      data: {
        id: "66666666-6666-4666-8666-666666666666",
        orgId: OTHER_ORG,
        agentId: AGENT,
        credential: CREDENTIAL,
        createdAt: old,
      },
    });
    await askThroughRelay((id) => reply(id) as JSONRPCMessage);
    const left = await db.mcpClientRequest.findMany({
      where: { orgId: { in: [ORG, OTHER_ORG] } },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    expect(left.map((r) => r.id)).toEqual([
      "55555555-5555-4555-8555-555555555555",
      "66666666-6666-4666-8666-666666666666",
    ]);
  });
});
