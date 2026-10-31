// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// With RETRIEVAL_AGGREGATE_DIGEST off, memory_query serves what it served before the digest
// existed, with RETRIEVAL_QUERY_SHAPES off and on: the digest's own stemmer
// (query-shapes.ts, inflectionStem) must not move the RETRIEVAL_QUERY_SHAPES page. The expected
// pages, ids and versions masked, are in aggregate-digest-flag-off.base.json; they were written
// by this file run on the commit before the digest, with AGGREGATE_DIGEST_PARITY_WRITE naming that file.
//
// Real: Postgres, the MCP route, check(), memory_ingest's write, the pgvector store. Doubles:
// the memory service (one embedding per text, every graph write accepted, no graph facts) and the model.
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { hashCapabilityToken } from "@/services/access/capabilities";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

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
const WRITE = process.env.AGGREGATE_DIGEST_PARITY_WRITE;
const EXPECTED = join(__dirname, "aggregate-digest-flag-off.base.json");
const ORG = "aggparity";
const SCOPE = `org_${ORG}.garden`;
const DIMENSIONS = 384;
// Not imported: the file must run unchanged on the base commit, where neither name exists.
const FLAGS = ["RETRIEVAL_AGGREGATE_DIGEST", "RETRIEVAL_QUERY_SHAPES"] as const;

const turn = (date: string, user: string, assistant: string) =>
  `Session date: ${date}\n\nuser: ${user}\n\nassistant: ${assistant}`;
// Words the digest's stemmer treats differently from the shapes page's: notes / not, plane / plan,
// speed, replaced / replace, dated / date, biked / bike, and numbers that differ within one day.
const RECORDS = [
  turn(
    "2024/03/02 (Sat) 08:00",
    "I replaced the tomato stakes in the raised bed. The old ones were not straight.",
    "Straight stakes help the vines climb. Keep notes on which variety does best.",
  ),
  turn(
    "2024/03/02 (Sat) 08:40",
    "I planted seed tray number 3 by the window. I replace the soil every spring.",
    "Window light works well for seedlings early in the season.",
  ),
  turn(
    "2024/03/02 (Sat) 09:10",
    "I planted seed tray number 4 by the window.",
    "That makes a good row of trays for the spring.",
  ),
  turn(
    "2024/04/13 (Sat) 10:00",
    "I biked to the garden centre and bought two bags of compost. My notes say the plan is to dig a new bed.",
    "Compost is a great start for a new bed.",
  ),
  turn(
    "2024/04/20 (Sat) 07:30",
    "A plane flew low over the allotment while I dated the seed packets. Here is her list of bulbs.",
    "Labelling packets with dates saves guessing later.",
  ),
  turn(
    "2024/05/11 (Sat) 11:00",
    "I bike there most weekends now; the speed of the new path is great. I planted three rows of beans.",
    "Beans grow fast once the soil warms up.",
  ),
];
const QUESTIONS = [
  "How many seed trays have I planted?",
  "How many times did I replace things in the garden?",
  "How many notes and plans did I make for the beds?",
  "What did I buy at the garden centre?",
];

/**
 * A distinct embedding for each text, the same on every run, so records rank in one order: with
 * one embedding for all, records tie and the page's order is the database's.
 */
function embeddingOf(text: string): number[] {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619) >>> 0;
  return Array.from({ length: DIMENSIONS }, (_, i) => 0.01 + (((hash >>> i % 24) + i * 7919) % 97) / 970);
}

/** A memory service on a real socket: one embedding per text, every graph write accepted, no graph facts. */
class EmptyGraphMemoryService {
  private server: Server | null = null;

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      req.on("end", () => {
        const path = new URL(req.url ?? "/", "http://memory").pathname;
        const send = (status: number, payload: unknown) =>
          res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
        if (path === "/embed") return send(200, { embedding: embeddingOf(body) });
        if (path === "/ingest") return send(200, { episode_id: `ep-${Math.random().toString(36).slice(2)}` });
        if (path === "/search") return send(200, { facts: [] });
        if (path === "/graph") return send(200, { nodes: [], edges: [] });
        return send(404, { detail: `no route ${path}` });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("memory service did not bind");
    return `http://127.0.0.1:${address.port}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}

interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
}

describe.skipIf(!QA_URL)(
  "memory_query with the aggregate digest off, against the base commit's pages",
  { timeout: 60_000 },
  () => {
    const service = new EmptyGraphMemoryService();
    let db: PrismaClient;
    let mcpUrl: string;
    let closeMcp: () => Promise<void>;
    let reader = "";
    let writer = "";
    const ids: string[] = [];

    async function mint(agentId: string, permission: "read" | "write"): Promise<string> {
      const token = `wcap_test_${agentId}_${Math.random().toString(36).slice(2)}`;
      await db.capability.create({
        data: {
          orgId: ORG,
          agentId,
          tokenHash: hashCapabilityToken(token),
          scopePath: SCOPE,
          permission,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });
      return token;
    }

    async function call(token: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
      const client = new Client({ name: "willder-test", version: "0.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(mcpUrl), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      );
      try {
        return (await client.callTool({ name, arguments: args })) as ToolResult;
      } finally {
        await client.close();
      }
    }

    /** memory_query's own answer up to its revision, each record's id and every version or revision stamp masked. */
    async function served(query: string): Promise<string> {
      const result = await call(reader, "memory_query", { query, scopePath: SCOPE, limit: 10 });
      expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
      const end = result.content.findIndex((c) => c.text?.startsWith("revision: "));
      let text = result.content
        .slice(0, end < 0 ? undefined : end + 1)
        .map((c) => c.text ?? "")
        .join("\n");
      ids.forEach((id, i) => (text = text.split(id).join(`<record ${i}>`)));
      return text
        .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<uuid>")
        .replace(/\b(version|revision):? (?!<record)\S+/g, "$1 <stamp>")
        .replace(/\b20\d\d-\d\d-\d\dT[\d:.]+Z\b/g, "<time>");
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
      const { startMcpTestServer } = await import("./http-test-server");
      const mcp = await startMcpTestServer();
      mcpUrl = mcp.url;
      closeMcp = mcp.close;

      await deleteOrgsWithRetry(db, { where: { id: ORG } });
      await db.org.create({ data: { id: ORG, name: ORG } });
      for (const path of [`org_${ORG}`, SCOPE])
        await db.scope.create({ data: { orgId: ORG, path, name: path.split(".").at(-1)! } });
      reader = await mint("garden-reader", "read");
      writer = await mint("garden-writer", "write");
      for (const [i, content] of RECORDS.entries()) {
        const written = await call(writer, "memory_ingest", { content, scopePath: SCOPE, name: `turn ${i}` });
        expect(written.isError, JSON.stringify(written.content)).toBeFalsy();
        const row = await db.memoryChunk.findFirstOrThrow({
          where: { orgId: ORG, scopePath: SCOPE, content },
          select: { id: true },
        });
        ids.push(row.id);
      }
    });

    afterEach(() => {
      for (const flag of FLAGS) delete process.env[flag];
    });

    afterAll(async () => {
      if (QA_URL === undefined) return;
      await closeMcp?.();
      await service.stop();
      await deleteOrgsWithRetry(db, { where: { id: ORG } });
      await db.$disconnect();
    });

    it("serves the base commit's page for every question, with RETRIEVAL_QUERY_SHAPES off and on", async () => {
      const pages: Record<string, string> = {};
      for (const shapes of [false, true]) {
        for (const query of QUESTIONS) {
          if (shapes) process.env.RETRIEVAL_QUERY_SHAPES = "1";
          else delete process.env.RETRIEVAL_QUERY_SHAPES;
          pages[`${shapes ? "shapes on" : "shapes off"}: ${query}`] = await served(query);
        }
      }
      if (WRITE) {
        writeFileSync(WRITE, `${JSON.stringify(pages, null, 2)}\n`);
        return;
      }
      const expected = JSON.parse(readFileSync(EXPECTED, "utf8")) as Record<string, string>;
      expect(Object.keys(pages)).toEqual(Object.keys(expected));
      for (const [key, page] of Object.entries(pages)) expect(page, key).toBe(expected[key]);
    });
  },
);
