// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// memory_query's first line, served below later records that state a new value of its thing. Real:
// Postgres, the memory_query tool handler, check() against live capabilities, the hybrid
// store and pgvector's scoped SQL, and the lines formatCitedFacts renders. Doubles: the
// embedding service (one fixed vector) and the graph service (finds nothing).
//
// The rules under test: a later record of the same scope that states a new value is served
// above the first line, which stays and is marked; a record in a sibling scope is never linked
// to it, even for a reader of both; a question that asks for no value keeps the ranked
// order. That a record the reader cannot read never reaches the page is pgvector's scope
// SQL, checked here only as the boundary the link runs inside: the link compares nothing
// but the lines a read already served.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the `@/lib/db`
// singleton at import time, before beforeAll points DATABASE_URL at the test database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";

vi.mock("@/services/memory/store", async () => {
  const { HybridMemoryStore } = await import("@/services/memory/hybrid-store");
  const { PgvectorMemoryStore } = await import("@/services/memory/pgvector-store");
  const graph = { retrieve: async () => ({ facts: [], storesRead: [{ store: "graph" }] }) };
  return { graphitiStore: graph, memory: new HybridMemoryStore(graph as never, new PgvectorMemoryStore()) };
});

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "updatelink";
const ROOT = `org_${ORG}`;
const HOME = `${ROOT}.home`;
const OFFICE = `${ROOT}.office`;
const DIMENSIONS = 384;
const QUERY_VECTOR = `[${[1, ...Array(DIMENSIONS - 1).fill(0)].join(",")}]`;
const QUERY = "What is the monthly grocery budget Alexis and I agreed on?";

const AGREED = "USER: I've agreed with Alexis on a $500 monthly budget for groceries.";
const RAISED = "USER: Our grocery budget was increased to $550 monthly starting September 15.";
const AGREED_AT = "2026-09-01T08:00:00.000Z";
const RAISED_AT = "2026-09-08T08:00:00.000Z";

type ToolReply = { content: { type: "text"; text: string }[]; isError?: boolean };

describe.skipIf(!QA_URL)(
  "a later record that states a new value of the first line's thing, on a real memory_query read",
  () => {
    let db: PrismaClient;
    let registerWillderTools: (typeof import("./tools"))["registerWillderTools"];

    // Every row has the same embedding, so pgvector ranks by id: "c-a-*" leads the page.
    const insertChunk = (id: string, content: string, scopePath: string, occurredAt: string) =>
      db.$executeRawUnsafe(
        `INSERT INTO memory_chunks ("id","orgId","content","source","actorType","actorName","scopePath","embedding","occurredAt","createdAt")
       VALUES ($1, $2, $3, 'text', 'agent', 'recorder', $4, $5::vector, $6::timestamp, (NOW() AT TIME ZONE 'UTC'))`,
        id,
        ORG,
        content,
        scopePath,
        QUERY_VECTOR,
        occurredAt.replace("Z", ""),
      );

    /** The bullets memory_query answers a reader of `scopePath` with. */
    async function servedLines(scopePath: string, query = QUERY): Promise<string[]> {
      const agentId = `budget-reader-${Math.random().toString(36).slice(2)}`;
      const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
      await db.capability.create({
        data: {
          orgId: ORG,
          agentId,
          tokenHash: hashCapabilityToken(token),
          scopePath,
          permission: "read",
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });
      const ctx: AccessContext = {
        orgId: ORG,
        actor: { type: "agent", id: agentId, capabilityToken: token },
        origin: "mcp",
      };
      const tools = new Map<string, (args: Record<string, unknown>) => Promise<ToolReply>>();
      const server = {
        registerTool: (name: string, _c: unknown, handler: (args: Record<string, unknown>) => Promise<ToolReply>) =>
          tools.set(name, handler),
      };
      registerWillderTools(server as never, ctx, { orgId: ORG, agentId, scopePath });
      const reply = await tools.get("memory_query")!({ query, limit: 20, scopePath });
      expect(reply.isError).not.toBe(true);
      return reply.content
        .map((block) => block.text)
        .join("\n")
        .split("\n")
        .filter((line) => line.startsWith("•"));
    }

    async function clear() {
      await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
      await db.auditLog.deleteMany({ where: { orgId: ORG } });
      await db.capability.deleteMany({ where: { orgId: ORG } });
      await db.scope.deleteMany({ where: { orgId: ORG } });
    }

    beforeAll(async () => {
      if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
      process.env.DATABASE_URL = QA_URL;
      db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
      ({ registerWillderTools } = await import("./tools"));
    });

    afterAll(async () => {
      vi.unstubAllGlobals();
      await clear();
      await db.$disconnect();
    });

    beforeEach(async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify({ embedding: [1, ...Array(DIMENSIONS - 1).fill(0)] }), { status: 200 }),
        ),
      );
      await clear();
      await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
      for (const path of [ROOT, HOME, OFFICE]) await db.scope.create({ data: { orgId: ORG, path, name: path } });
      await insertChunk("c-a-agreed", AGREED, HOME, AGREED_AT);
    });

    it("serves the later record of the same scope first and keeps the earlier one, marked", async () => {
      await insertChunk("c-b-raised", RAISED, HOME, RAISED_AT);

      expect(await servedLines(HOME)).toEqual([
        `• ${RAISED} (as of ${RAISED_AT}) — from: recorder (agent) · version c-b-raised`,
        `• ${AGREED} (as of ${AGREED_AT}) — from: recorder (agent) · a later record on this is shown above · version c-a-agreed`,
      ]);
    });

    it("keeps the ranked order for a question that asks for no value", async () => {
      await insertChunk("c-b-raised", RAISED, HOME, RAISED_AT);

      const lines = await servedLines(HOME, "Did Alexis and I agree on a monthly grocery budget?");
      expect(lines[0]).toMatch(/ · version c-a-agreed$/);
      expect(lines[1]).toMatch(/ · version c-b-raised$/);
      expect(lines.join("\n")).not.toContain("later record");
    });

    it("never links a record in a sibling scope, even for a reader of both", async () => {
      await insertChunk("c-b-raised", RAISED, OFFICE, RAISED_AT);

      const lines = await servedLines(ROOT);
      expect(lines[0]).toContain("version c-a-agreed");
      expect(lines.join("\n")).not.toContain("later record");
    });

    it("serves a reader of one scope only that scope's lines: the link compares nothing else", async () => {
      const absent = await servedLines(HOME);
      await insertChunk("c-b-raised", RAISED, OFFICE, RAISED_AT);
      const hidden = await servedLines(HOME);

      expect(hidden).toEqual(absent);
      expect(hidden).toEqual([`• ${AGREED} (as of ${AGREED_AT}) — from: recorder (agent) · version c-a-agreed`]);
    });
  },
);
