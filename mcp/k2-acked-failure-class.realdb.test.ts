// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Why an acknowledged-writes measure mints agents
// per class: run with the same agent ids in sibling scopes, its failure-class writes get no
// acknowledgement while a lone two-copy write is acknowledged on both copies. A
// concurrent-class writer's memory_ingest reply carries a change notice of the other writers' facts, and a fact
// shown in a notice is content of the concurrent scope in that agent's derived-write
// session (services/access/derived-writes.ts). The same agent's next write, into the
// failure scope, is then a write carrying a sibling's content without declaring it: both
// copies are refused with `derived_write`, at HTTP 200, on every attempt.
//
// That is the rule working, so each class mints agents of its own (runAgentId). This file
// pins both halves at the product boundary:
// the reused agent is refused, the class's own agent is acknowledged on both copies with one
// fact stored.
//
// Real: the MCP endpoint over a socket, check() against live capabilities, Postgres. A
// fake memory service answers embeddings with one fixed vector.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the `@/lib/db`
// singleton at import time, before beforeAll points DATABASE_URL at the test database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import { NoRelationMemoryService } from "./no-relation-memory-service.testsupport";
import { mcpSession, type ToolAnswer } from "./mcp-session.testsupport";

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
const ORG = "ackedfailure";
const RUN_SCOPE = `org_${ORG}.demo.acked`;
const CONCURRENT = `${RUN_SCOPE}.concurrent`;
const FAILURE = `${RUN_SCOPE}.failure`;

describe.skipIf(!QA_URL)(
  "acknowledged-writes failure class: a writer reused from the concurrent class",
  { timeout: 30_000 },
  () => {
    const service = new NoRelationMemoryService();
    let db: PrismaClient;
    let mcpUrl: string;
    let closeMcp: () => Promise<void>;

    async function mint(agentId: string, scopePath: string): Promise<string> {
      const token = `wcap_test_${agentId}_${Math.random().toString(36).slice(2)}`;
      await db.capability.create({
        data: {
          orgId: ORG,
          agentId,
          tokenHash: hashCapabilityToken(token),
          scopePath,
          permission: "write",
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });
      return token;
    }

    const ingest = async (
      token: string,
      scopePath: string,
      content: string,
      idempotencyKey: string,
    ): Promise<ToolAnswer> =>
      (
        await mcpSession(mcpUrl, token, [
          ["memory_ingest", { content, name: idempotencyKey, scopePath, idempotencyKey }],
        ])
      )[0]!;

    /** One failure-class write as the suite sends it: two copies at once under one key. */
    const doubled = (token: string, content: string, key: string) =>
      Promise.all([ingest(token, FAILURE, content, key), ingest(token, FAILURE, content, key)]);

    beforeAll(async () => {
      if (QA_URL === undefined) return;
      if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
      process.env.DATABASE_URL = QA_URL;
      process.env.GRAPHITI_SERVICE_URL = await service.start();
      process.env.GRAPHITI_SERVICE_API_KEY = "test-key";
      db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
      const inngestModule = await import("@/lib/inngest");
      vi.spyOn(inngestModule.inngest, "send").mockImplementation((async () => ({ ids: ["job"] })) as never);
      const { startMcpTestServer } = await import("./http-test-server");
      const mcp = await startMcpTestServer();
      mcpUrl = mcp.url;
      closeMcp = mcp.close;

      await db.org.deleteMany({ where: { id: ORG } });
      await db.org.create({ data: { id: ORG, name: ORG } });
      for (const path of [`org_${ORG}`, `org_${ORG}.demo`, RUN_SCOPE, CONCURRENT, FAILURE]) {
        await db.scope.create({ data: { orgId: ORG, path, name: path.split(".").at(-1)! } });
      }

      // The concurrent class: two writers, each shown the other's fact in its next reply.
      const one = await mint("writer-1", CONCURRENT);
      const two = await mint("writer-2", CONCURRENT);
      for (const [token, index] of [
        [one, 0],
        [two, 1],
        [one, 2],
      ] as const) {
        const written = await ingest(token, CONCURRENT, `concurrent write ${index}: kept`, `concurrent-${index}`);
        expect(written.isError, written.answer).toBe(false);
      }
    }, 120_000);

    afterAll(async () => {
      if (QA_URL === undefined) return;
      await closeMcp?.();
      await service.stop();
      await db.org.deleteMany({ where: { id: ORG } });
      await db.$disconnect();
    }, 60_000);

    // Two copies sent at once race for the key: the one that loses is either answered once the
    // first finishes or told the key is still in progress (app/api/memory/ingest idempotency).
    const IN_PROGRESS = /^A write with this idempotencyKey is still in progress/;

    it("refuses the reused concurrent-class agent on both copies, naming the scope its write reply showed it", async () => {
      const content = "failure write 0: acknowledged write 0 of the failure class is kept";
      const copies = await doubled(await mint("writer-1", FAILURE), content, "failure-0");
      for (const copy of copies) expect(copy.isError, copy.answer).toBe(true);
      const refusal = copies.find((c) => !IN_PROGRESS.test(c.answer));
      expect(refusal?.answer).toMatch(/^derived_write: this agent id was shown content stored in/);
      expect(refusal?.answer).toContain(`"${CONCURRENT}"`);
      expect(await db.memoryChunk.count({ where: { orgId: ORG, content } })).toBe(0);
    });

    it("acknowledges the failure class's own agent and stores one fact, as the measure counts a doubled write", async () => {
      const content = "failure write 1: acknowledged write 1 of the failure class is kept";
      const copies = await doubled(await mint("writer-1-failure", FAILURE), content, "failure-1");
      expect(
        copies.some((c) => !c.isError),
        copies.map((c) => c.answer).join(" | "),
      ).toBe(true);
      for (const copy of copies.filter((c) => c.isError)) expect(copy.answer).toMatch(IN_PROGRESS);
      expect(await db.memoryChunk.count({ where: { orgId: ORG, content } })).toBe(1);
    });
  },
);
