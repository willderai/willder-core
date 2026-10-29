// ingestMemory refuses a NUL in any of its three text fields before anything is stored
// or queued. Postgres `text` cannot hold U+0000; before this guard, a NUL that reached the
// read-now row write failed there while the job was still queued, so the caller was told
// the write was accepted. Each field is checked on its own, so dropping any one of them
// from the guard fails exactly that case; a clean write in the same harness is stored and
// queued, so a refusal here is the guard, not a harness that refuses everything.
//
// Real: Postgres (QA_DATABASE_URL, an ISOLATED, migrated test database; skips when unset)
// and a stand-in memory service on a socket. The queue is a spy. An agent write, so the
// request path stores the read-now row itself (a human write resolves entities first and
// is only queued).
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { IngestInput } from "@/types/memory";

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
const ORG = "qa_ingest_nul";
const ROOT = `org_${ORG}`;
const NUL = "\u0000";

const clean: IngestInput = {
  groupId: ORG,
  content: "Refunds are owned by payments.",
  name: "Refund owner",
  source: "api",
  actorType: "agent",
  actorId: "agent-qa",
  origin: "mcp",
  scopePath: ROOT,
};

describe.skipIf(!QA_URL)("ingestMemory refuses a NUL in content, name or source before storing or queueing", () => {
  let db: PrismaClient;
  let server: Server;
  let ingestMemory: typeof import("@/lib/inngest").ingestMemory;
  let send: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    if (QA_URL === undefined) return;
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    server = createServer((req, res) => {
      req.resume();
      const path = new URL(req.url ?? "/", "http://memory").pathname;
      const body =
        path === "/embed"
          ? { embedding: new Array(384).fill(0.01) }
          : path === "/search"
            ? { facts: [] }
            : { episode_id: "ep-1" };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("memory service did not bind");
    process.env.GRAPHITI_SERVICE_URL = `http://127.0.0.1:${address.port}`;
    process.env.GRAPHITI_SERVICE_API_KEY = "test-key";
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    const inngestModule = await import("@/lib/inngest");
    send = vi
      .spyOn(inngestModule.inngest, "send")
      .mockImplementation((async () => ({ ids: ["job"] })) as never) as never;
    ingestMemory = inngestModule.ingestMemory;
    await db.org.deleteMany({ where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.scope.create({ data: { orgId: ORG, path: ROOT, name: ROOT } });
  }, 60_000);

  afterAll(async () => {
    if (QA_URL === undefined) return;
    await db.memoryChunk.deleteMany({ where: { orgId: ORG } });
    await db.org.deleteMany({ where: { id: ORG } });
    await db.$disconnect();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(async () => {
    send.mockClear();
    await db.memoryChunk.deleteMany({ where: { orgId: ORG } });
  });

  it.each([
    ["content", { content: `Refunds are owned${NUL} by payments.` }],
    ["name", { name: `Refund${NUL} owner` }],
    ["source", { source: `api${NUL}` }],
  ])("a NUL in %s alone is refused naming that field, with nothing stored or queued", async (field, override) => {
    const { UnstorableTextError } = await import("@/lib/unstorable-text");
    const error = await ingestMemory({ ...clean, ...override }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(UnstorableTextError);
    expect((error as Error).message).toBe(
      `${field} contains a NUL (\\u0000) character, which cannot be stored. Remove it and retry.`,
    );
    expect(send).not.toHaveBeenCalled();
    expect(await db.memoryChunk.count({ where: { orgId: ORG } })).toBe(0);
  });

  it("control: the same write without a NUL is stored and queued", async () => {
    const ack = await ingestMemory({ ...clean });
    expect(ack.readableNow).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await db.memoryChunk.count({ where: { orgId: ORG } })).toBe(1);
  });
});
