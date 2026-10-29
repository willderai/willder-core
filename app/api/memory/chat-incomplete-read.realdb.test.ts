// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Ask's search_memory tool hands the model a read that is not the whole answer.
//
// When the graph store does not answer, a read still returns what the vector store
// found, marked degraded. The tool result the model reads must say so: told only "No
// facts found", the model answers as if nothing were stored.
//
// Real: Postgres, the route, check(), the guarded and hybrid stores, pgvector's SQL.
// Doubles: the signed-in session, the embedding service, the model, and the graph
// service, which answers every search with the 503 an overloaded memory service sends.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

/** The signed-in person the route sees. */
const session = vi.hoisted(() => ({ current: null as unknown }));
/** The messages the model was sent on each streamed turn. */
const turns = vi.hoisted(() => [] as { role: string; content?: unknown }[][]);

vi.mock("@/lib/access-context", () => ({ requireAccessContext: async () => session.current }));
vi.mock("@/services/memory/store", async () => {
  const { HybridMemoryStore } = await import("@/services/memory/hybrid-store");
  const { PgvectorMemoryStore } = await import("@/services/memory/pgvector-store");
  const { MemoryServiceError } = await import("@/services/memory/graphiti-store");
  const graph = {
    retrieve: async () => {
      throw new MemoryServiceError("memory service /search failed: memory graph overloaded", 503);
    },
  };
  return { graphitiStore: graph, memory: new HybridMemoryStore(graph as never, new PgvectorMemoryStore()) };
});
// The model: the first streamed turn calls search_memory, later turns say nothing.
vi.mock("@/lib/llm", () => {
  async function* stream(chunks: unknown[]) {
    for (const chunk of chunks) yield chunk;
  }
  return {
    LLM_MODEL_EXTRACT: "test-model",
    LLM_MODEL_ORCHESTRATOR: "test-model",
    createLLMClient: () => ({
      chat: {
        completions: {
          create: async (params: { stream?: boolean; messages: { role: string; content?: unknown }[] }) => {
            if (!params.stream) return { choices: [{ message: { content: "{}" } }] };
            turns.push(structuredClone(params.messages));
            if (turns.length > 1) return stream([]);
            const args = JSON.stringify({ query: "when is the renewal due" });
            return stream([
              {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        { index: 0, id: "call_search", function: { name: "search_memory", arguments: args } },
                      ],
                    },
                  },
                ],
              },
            ]);
          },
        },
      },
    }),
  };
});

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "chatincompleteread";
const ROOT = `org_${ORG}`;
const DIMENSIONS = 384;

describe.skipIf(!QA_URL)("Ask tells the model when its search was incomplete", () => {
  let db: PrismaClient;
  let chatRoute: (typeof import("@/app/api/memory/chat/route"))["POST"];

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL! }) });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ embedding: new Array(DIMENSIONS).fill(0.01) }))),
    );
    ({ POST: chatRoute } = await import("@/app/api/memory/chat/route"));
  });

  afterAll(async () => {
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
    await db.org.deleteMany({ where: { id: ORG } });
    await db.$disconnect();
    vi.unstubAllGlobals();
  });

  beforeEach(async () => {
    turns.length = 0;
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
    await db.org.deleteMany({ where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: "Chat incomplete read" } });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: ROOT } });
    const person = await db.user.create({
      data: {
        orgId: ORG,
        clerkId: "clerk_chatincompleteread",
        email: "owner@chatincompleteread.test",
        name: "Owner",
        role: "admin",
      },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: person.id, permission: "admin" },
    });
    const ctx = { orgId: ORG, actor: { type: "human", id: person.id, role: "admin", name: "Owner" }, origin: "app" };
    session.current = { org: { id: ORG, name: "Chat incomplete read" }, user: person, ctx };
  });

  it("the tool result says the graph store did not answer, not only that nothing was found", async () => {
    const res = await chatRoute(
      new Request("http://t/api/memory/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "when is the renewal due", mode: "ask" }),
      }),
    );
    expect(await res.text()).not.toContain('"type":"error"');

    const toolResult = turns[1]?.find((m) => m.role === "tool");
    expect(toolResult?.content).toMatch(/^No facts found in memory/);
    expect(toolResult?.content).toMatch(/Note: search was incomplete: the graph store did not answer/);
  });

  // The case the model is likeliest to over-trust. The vector store found a
  // fact, so the answer is not empty, but the graph store still did not answer; the
  // note must ride along with the facts, not only with "No facts found".
  it("the tool result carries the note beside the facts the vector store did find", async () => {
    const vector = `[${new Array(DIMENSIONS).fill(0.01).join(",")}]`;
    await db.$executeRaw`
      INSERT INTO memory_chunks ("id","orgId","content","source","actorType","scopePath","embedding","createdAt")
      VALUES ('chatincompleteread-renewal', ${ORG}, 'The Acme renewal is due on 1 November.', 'text', 'human', ${ROOT}, ${vector}::vector, NOW())`;

    const res = await chatRoute(
      new Request("http://t/api/memory/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "when is the renewal due", mode: "ask" }),
      }),
    );
    expect(await res.text()).not.toContain('"type":"error"');

    const toolResult = turns[1]?.find((m) => m.role === "tool");
    expect(toolResult?.content).toMatch(/^\[1\] The Acme renewal is due on 1 November\./);
    expect(toolResult?.content).toMatch(/\n\nNote: search was incomplete: the graph store did not answer/);
  });
});
