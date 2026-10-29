// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// QA companion to mcp/graph-read-your-writes.realdb.test.ts. That file
// reads an entity in a scoped partition, where the `"scopePath" = <partition>` filter
// alone already keeps out another org's rows (another org's scopes never share a path).
// An entity in the bare-org partition matches untagged rows (`"scopePath" IS NULL`),
// which every org has, so there the overlay's own org and actor-type filters are the
// only thing between one org's reader and another org's writes. These tests pin them:
//
// - an agent id is chosen per org, so two orgs can both run an agent called the same
//   thing; the other org's untagged write about the entity must not be served;
// - a person whose id equals the agent's id is not the agent;
// - the bare-org partition holds untagged rows only, so a scoped row is not served there.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the `@/lib/db`
// singleton at import time, before beforeAll points DATABASE_URL at the test database.
import { hashCapabilityToken } from "@/services/access/capabilities";

vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
}));
vi.mock("@/lib/llm", () => ({
  createLLMClient: () => ({
    chat: {
      completions: {
        create: async () => {
          throw new Error("no llm in this test");
        },
      },
    },
  }),
  LLM_MODEL_EXTRACT: "test-model",
  LLM_MODEL_ORCHESTRATOR: "test-model",
}));

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "graphrywqa";
const OTHER_ORG = "graphrywqaother";
const ROOT = `org_${ORG}`;
const SCOPE = `${ROOT}.ops`;
/** The same agent id in both orgs. */
const AGENT = "shared-bot";
const ENTITY_ID = "ent-heron";
const ENTITY_NAME = "Heron Shipping";
const SEED_FACT = "Heron Shipping operates from Bodo.";

/** A memory service holding one entity in ORG's bare-org (untagged) partition. */
class BareOrgEntityService {
  private server: Server | null = null;

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      void this.handle(req).then(
        ([status, body]) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body)),
        (e: unknown) => res.writeHead(500).end(String(e)),
      );
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("memory service did not bind");
    return `http://127.0.0.1:${address.port}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private async handle(req: IncomingMessage): Promise<[number, unknown]> {
    req.resume();
    const url = new URL(req.url ?? "/", "http://memory");
    if (url.pathname === "/embed") return [200, { embedding: new Array(384).fill(0.01) }];
    if (url.pathname === "/search") return [200, { facts: [] }];
    if (url.pathname === `/entities/${ENTITY_ID}`) {
      if (url.searchParams.get("group_id") !== ORG) return [404, { detail: "entity not found" }];
      const facts = [
        { uuid: "edge-seed", fact: SEED_FACT, valid_at: null, invalid_at: null, expired_at: null, chunk_ids: [] },
      ];
      return [200, { uuid: ENTITY_ID, name: ENTITY_NAME, type: "Organization", summary: "", facts }];
    }
    return [404, { detail: `no route ${url.pathname}` }];
  }
}

describe.skipIf(!QA_URL)("the own-write overlay on a bare-org entity", () => {
  const service = new BareOrgEntityService();
  let db: PrismaClient;
  let mcpUrl: string;
  let closeMcp: () => Promise<void>;
  let ClientClass: (typeof import("@modelcontextprotocol/sdk/client/index.js"))["Client"];
  let Transport: (typeof import("@modelcontextprotocol/sdk/client/streamableHttp.js"))["StreamableHTTPClientTransport"];
  let readerToken = "";

  /** A stored version, as if its writer had just written it. */
  async function stored(orgId: string, content: string, actor: { type: string; id: string }, scopePath: string | null) {
    await db.memoryChunk.create({
      data: { orgId, content, actorType: actor.type, actorId: actor.id, entityName: ENTITY_NAME, scopePath },
    });
  }

  async function readEntity(): Promise<string> {
    const client: Client = new ClientClass({ name: "graph-ryw-qa", version: "0.0.0" });
    await client.connect(
      new Transport(new URL(mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${readerToken}` } } }),
    );
    try {
      const result = await client.callTool({ name: "memory_entity", arguments: { entityId: ENTITY_ID } });
      const answer = (result.content as { type: string; text?: string }[])[0]?.text ?? "";
      expect(result.isError, answer).toBeFalsy();
      return answer;
    } finally {
      await client.close();
    }
  }

  beforeAll(async () => {
    if (QA_URL === undefined) return;
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    process.env.GRAPHITI_SERVICE_URL = await service.start();
    process.env.GRAPHITI_SERVICE_API_KEY = "test-key";
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });

    const inngestModule = await import("@/lib/inngest");
    vi.spyOn(inngestModule.inngest, "send").mockImplementation((async () => ({ ids: ["job"] })) as never);
    ({ Client: ClientClass } = await import("@modelcontextprotocol/sdk/client/index.js"));
    ({ StreamableHTTPClientTransport: Transport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js"));
    const { startMcpTestServer } = await import("./http-test-server");
    const mcp = await startMcpTestServer();
    mcpUrl = mcp.url;
    closeMcp = mcp.close;

    await db.org.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
    for (const id of [ORG, OTHER_ORG]) {
      await db.org.create({ data: { id, name: id } });
      await db.scope.create({ data: { orgId: id, path: `org_${id}`, name: `org_${id}` } });
    }
    await db.scope.create({ data: { orgId: ORG, path: SCOPE, name: "ops" } });
    // The bare-org entity's seed fact was a direct write stored before episodes carried a chunk stamp,
    // which the graph holds verbatim. A graph fact is served only while a stored source stands
    // behind it (services/memory/graph-fact-sources.ts), so it is stored, with no embedding.
    await db.$executeRaw`INSERT INTO memory_chunks ("id","orgId","content","source","actorType","scopePath","createdAt") VALUES ('seed-row', ${ORG}, ${SEED_FACT}, 'text', 'human', NULL, now())`;
    readerToken = `wcap_test_${AGENT}_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId: AGENT,
        tokenHash: hashCapabilityToken(readerToken),
        scopePath: ROOT,
        permission: "read",
        grantGoverned: false,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
  });

  afterAll(async () => {
    if (QA_URL === undefined) return;
    await closeMcp?.();
    await service.stop();
    await db.org.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
    await db.$disconnect();
  });

  it("serves the agent its own untagged write on the bare-org entity", async () => {
    const own = "Heron Shipping added a ferry route to Svolvaer.";
    await stored(ORG, own, { type: "agent", id: AGENT }, null);

    const answer = await readEntity();

    expect(answer).toContain(SEED_FACT);
    expect(answer).toContain(own);
  });

  it("does not serve another org's write by an agent with the same id", async () => {
    const foreign = "Heron Shipping is being acquired, says the other org's bot.";
    await stored(OTHER_ORG, foreign, { type: "agent", id: AGENT }, null);

    expect(await readEntity()).not.toContain(foreign);
  });

  it("does not serve a person's write whose id equals the agent's id", async () => {
    const human = "Heron Shipping's CFO resigned, typed in by a person.";
    await stored(ORG, human, { type: "human", id: AGENT }, null);

    expect(await readEntity()).not.toContain(human);
  });

  it("does not serve the agent's scoped write on the bare-org entity", async () => {
    const scoped = "Heron Shipping leased a berth in Harstad.";
    await stored(ORG, scoped, { type: "agent", id: AGENT }, SCOPE);

    expect(await readEntity()).not.toContain(scoped);
  });
});
