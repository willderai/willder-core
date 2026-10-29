// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Ask's model-driven save names the audit row its own check wrote.
//
// POST /api/memory/chat saves through two sites: the confirmed fast path (body carries
// `pendingContent`) and the `save_memory` tool call the model makes in write mode.
// write-paths-name-their-authorization.realdb.test.ts drives only the fast path. This
// file drives the tool call: the model double streams one `save_memory` call, the route
// runs its own `memory.write` check with target `<scope>/chat:<subject>`, and the stored fact's
// change event must name exactly that row, which GET /api/audit lists the change under.
//
// Real: Postgres, the route, check(), ingestMemory with its write-through to pgvector,
// GET /api/audit. Doubles: the signed-in session, the embedding service, the graph
// service, and the model.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { IngestInput } from "@/types/memory";

/** Work queued by `after()`, in queue order. */
const queuedJobs = vi.hoisted(() => [] as (() => Promise<unknown>)[]);
/** The signed-in person the routes see. */
const session = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => Promise<unknown>) => {
    queuedJobs.push(task);
  },
}));
vi.mock("@/lib/access-context", () => ({ requireAccessContext: async () => session.current }));
vi.mock("@/services/memory/store", async () => {
  const { HybridMemoryStore } = await import("@/services/memory/hybrid-store");
  const { PgvectorMemoryStore } = await import("@/services/memory/pgvector-store");
  let episodes = 0;
  const graph = {
    ingest: async () => ({ episodeId: `graph-episode-${(episodes += 1)}` }),
    ingestBulk: async (inputs: IngestInput[]) => inputs.map(() => `graph-episode-${(episodes += 1)}`),
    dedupeNodes: async () => 0,
    retrieve: async () => ({ facts: [], storesRead: [{ store: "graph" }] }),
  };
  return { graphitiStore: graph, memory: new HybridMemoryStore(graph as never, new PgvectorMemoryStore()) };
});
// The model: the first streamed turn calls save_memory, later streamed turns say nothing,
// and the non-streamed extraction call finds nothing to extract.
vi.mock("@/lib/llm", () => {
  let streamedTurns = 0;
  async function* stream(chunks: unknown[]) {
    for (const chunk of chunks) yield chunk;
  }
  return {
    LLM_MODEL_EXTRACT: "test-model",
    LLM_MODEL_ORCHESTRATOR: "test-model",
    createLLMClient: () => ({
      chat: {
        completions: {
          create: async (params: { stream?: boolean }) => {
            if (!params.stream) {
              return {
                choices: [
                  { message: { content: JSON.stringify({ facts: [], entities: [], attributes: [], decisions: [] }) } },
                ],
              };
            }
            streamedTurns += 1;
            if (streamedTurns > 1) return stream([]);
            const args = JSON.stringify({ content: "Renewal is due in March.", subject: "renewal" });
            return stream([
              {
                choices: [
                  {
                    delta: {
                      tool_calls: [{ index: 0, id: "call_save", function: { name: "save_memory", arguments: args } }],
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
vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
}));

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "chattoolorg";
const ROOT = `org_${ORG}`;
const SCOPE = `${ROOT}.planning`;
const DIMENSIONS = 384;

describe.skipIf(!QA_URL)("Ask's save_memory tool call names the audit row its own check wrote", () => {
  let db: PrismaClient;
  let chatRoute: (typeof import("@/app/api/memory/chat/route"))["POST"];
  let auditRoute: (typeof import("@/app/api/audit/route"))["GET"];

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    vi.stubEnv("INNGEST_BYPASS", "1");
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL! }) });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ embedding: new Array(DIMENSIONS).fill(0.01) }))),
    );
    ({ POST: chatRoute } = await import("@/app/api/memory/chat/route"));
    ({ GET: auditRoute } = await import("@/app/api/audit/route"));
  });

  afterAll(async () => {
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.org.deleteMany({ where: { id: ORG } });
    await db.$disconnect();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  beforeEach(async () => {
    queuedJobs.length = 0;
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.org.deleteMany({ where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: "Chat tool org" } });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: ROOT } });
    await db.scope.create({ data: { orgId: ORG, path: SCOPE, name: "planning" } });
    const person = await db.user.create({
      data: { orgId: ORG, clerkId: "clerk_chattoolorg", email: "owner@chattoolorg.test", name: "Owner", role: "admin" },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: person.id, permission: "admin" },
    });
    const ctx = { orgId: ORG, actor: { type: "human", id: person.id, role: "admin", name: "Owner" }, origin: "app" };
    session.current = { org: { id: ORG, name: "Chat tool org" }, user: person, ctx };
  });

  it("stamps the fact with the allow row whose target is <scope>/chat:<subject>", async () => {
    const res = await chatRoute(
      new Request("http://t/api/memory/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "remember the renewal date", mode: "write", confirmed: true, scope: SCOPE }),
      }),
    );
    expect(await res.text()).not.toContain('"type":"error"');
    await runQueuedJobs();

    const toolCheck = await db.auditLog.findFirstOrThrow({
      where: { orgId: ORG, action: "memory.write", decision: "allow", target: `${SCOPE}/chat:renewal` },
    });
    const facts = await db.changeEvent.findMany({ where: { orgId: ORG, recordType: "fact" } });
    expect(facts).toHaveLength(1);
    expect(facts[0]!.authorizedById).toBe(toolCheck.id);

    const listing = await auditRoute(new Request(`http://t/api/audit?ids=${toolCheck.id}`));
    const entries = ((await listing.json()) as { entries: { id: string; changeIds?: string[] }[] }).entries;
    expect(entries.find((e) => e.id === toolCheck.id)?.changeIds).toContain(facts[0]!.id);
  });

  /** Run queued work until none is left: a queued ingest queues its own graph step. */
  async function runQueuedJobs(): Promise<void> {
    while (queuedJobs.length > 0) await queuedJobs.shift()!();
  }
});
