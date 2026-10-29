// A measurement, not a check: how many tool calls, and how many notice tokens, a reader
// spends to hear a whole burst of changes. Skipped unless MEASURE_NOTICE_BURST is set, so
// it never runs in the suite; it prints one JSON line and asserts only that every burst
// was heard to the end.
//
//   MEASURE_NOTICE_BURST=1 QA_DATABASE_URL=<isolated test database> \
//     npx vitest run --maxWorkers=1 mcp/notice-burst.measure.realdb.test.ts
//
// To measure an earlier rule on the same bursts, check out that revision's
// mcp/change-notices.ts and services/memory/change-feed.ts over these and run it again.
//
// The bursts:
//  - a review pass: three agents write 40 notes through memory_ingest over the MCP tools,
//    filed under six pull requests' names (scripts/realdata/github-history.ts files a pull
//    request's facts the same way), one pull request at a time, then interleaved;
//  - a connector sync: 20 new items, then an upstream edit to 10 of them. It is written
//    through `recordSourceItemChange`, the call a sync makes for each item, without a
//    connector or `SourceFile` rows, since only its change events reach a notice.
// memory_ingest's embedding and graph calls go to the stand-in memory service. How many
// supersedes the conflict rule adds depends on timing inside its one-second window, so
// event counts can differ a little from run to run.
import { expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel, which builds the `@/lib/db`
// singleton at import time, before beforeAll points DATABASE_URL at the test database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import { EmptyGraphMemoryService } from "./memory-service-stub.testsupport";

vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
}));

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "org-measure-notice-burst";
const NOTES_PER_PULL_REQUEST: Record<string, number> = {
  "acme/web#101": 12,
  "acme/web#102": 9,
  "acme/web#103": 7,
  "acme/web#104": 5,
  "acme/web#105": 4,
  "acme/web#106": 3,
};

interface ToolResult {
  content: { text: string }[];
}

it.skipIf(!QA_URL || !process.env.MEASURE_NOTICE_BURST)(
  "measures the calls and notice tokens a burst costs a reader",
  { timeout: 300_000 },
  async () => {
    const memoryService = new EmptyGraphMemoryService();
    process.env.DATABASE_URL = QA_URL;
    process.env.GRAPHITI_SERVICE_URL = await memoryService.start();
    process.env.GRAPHITI_SERVICE_API_KEY = "test-key";
    const inngestModule = await import("@/lib/inngest");
    vi.spyOn(inngestModule.inngest, "send").mockImplementation((async () => ({ ids: ["job"] })) as never);
    const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL! }) });
    const { registerWillderTools } = await import("./tools");
    const { recordSourceItemChange } = await import("@/services/memory/content-change-event");
    const { estimateTokens } = await import("./task-start-notice");

    async function connectAs(agentId: string, scopePath: string, permission: "read" | "write"): Promise<Client> {
      const token = `wcap_measure_${Math.random().toString(36).slice(2)}`;
      await db.capability.create({
        data: {
          orgId: ORG,
          agentId,
          tokenHash: hashCapabilityToken(token),
          scopePath,
          permission,
          expiresAt: new Date(Date.now() + 3600_000),
        },
      });
      const server = new McpServer({ name: "measure", version: "0.0.0" });
      registerWillderTools(
        server,
        { orgId: ORG, actor: { type: "agent", id: agentId, capabilityToken: token }, origin: "mcp" },
        { orgId: ORG, agentId, scopePath },
      );
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: "measure", version: "0.0.0" });
      await client.connect(clientTransport);
      return client;
    }

    const unrelatedCall = async (client: Client) =>
      (await client.callTool({
        name: "get_my_brief",
        arguments: { briefId: "none" },
        _meta: { "willder/session": "s" },
      })) as ToolResult;

    async function reviewPass(scopePath: string, order: "one pull request at a time" | "interleaved"): Promise<void> {
      const writers = await Promise.all(
        ["review", "build", "qa"].map((agent) => connectAs(`${agent}-${scopePath}`, scopePath, "write")),
      );
      const owed = new Map(Object.entries(NOTES_PER_PULL_REQUEST));
      let n = 0;
      const write = async (name: string) => {
        const note = NOTES_PER_PULL_REQUEST[name]! - owed.get(name)! + 1;
        const writer = writers[n++ % writers.length]!;
        const args = { name, content: `Review note ${note} on ${name}: comment thread ${note} resolved.`, scopePath };
        let reply = (await writer.callTool({ name: "memory_ingest", arguments: args })) as ToolResult;
        // A write refused as stale is retried as the refusal says, until it is accepted:
        // read the version it names, then write again with the base it advises, or, when it
        // advises none, the version just read, since every note under a name is about that
        // one pull request (services/memory/fact-reads.ts).
        for (let attempt = 0; attempt < 5; attempt++) {
          const refusal = reply.content[0]!.text;
          const named = /^stale_version: .* Read (\S+) with memory_version/.exec(refusal)?.[1];
          if (named === undefined) break;
          await writer.callTool({ name: "memory_version", arguments: { versionId: named } });
          const baseVersion = /pass baseVersion (\S+)\.$/.exec(refusal)?.[1] ?? named;
          reply = (await writer.callTool({ name: "memory_ingest", arguments: { ...args, baseVersion } })) as ToolResult;
        }
        if (owed.get(name) === 1) owed.delete(name);
        else owed.set(name, owed.get(name)! - 1);
      };
      if (order === "interleaved") {
        while (owed.size > 0) for (const name of [...owed.keys()]) await write(name);
      } else {
        for (const name of Object.keys(NOTES_PER_PULL_REQUEST)) while (owed.has(name)) await write(name);
      }
    }

    async function connectorSync(scopePath: string): Promise<void> {
      const item = (episodeId: string, change: { op: "create"; title: string } | { op: "supersede" }) => ({
        orgId: ORG,
        scopePath,
        episodeId,
        actorId: "slack-sync:measure",
        authorizedById: null,
        ...change,
      });
      for (let i = 0; i < 20; i++) {
        await db.$transaction((tx) =>
          recordSourceItemChange(tx, item(`ep-${i}`, { op: "create", title: `message ${i}` })),
        );
      }
      for (let i = 0; i < 10; i++) {
        await db.$transaction(async (tx) => {
          await recordSourceItemChange(tx, item(`ep-${i}`, { op: "supersede" }));
          await recordSourceItemChange(tx, item(`ep-${i}-edited`, { op: "create", title: `message ${i} edited` }));
        });
      }
    }

    try {
      await db.org.deleteMany({ where: { id: ORG } });
      await db.org.create({ data: { id: ORG, name: ORG } });
      const results: Record<string, { changes: number; calls: number; noticeTokens: number }> = {};
      for (const [label, scopePath, write] of [
        [
          "review pass, one pull request at a time",
          "org_measure.by_pull_request",
          (s: string) => reviewPass(s, "one pull request at a time"),
        ],
        ["review pass, interleaved", "org_measure.interleaved", (s: string) => reviewPass(s, "interleaved")],
        ["connector sync", "org_measure.sync", connectorSync],
      ] as const) {
        const reader = await connectAs(`reader-${scopePath}`, scopePath, "read");
        await unrelatedCall(reader);
        await write(scopePath);
        let calls = 0;
        let noticeTokens = 0;
        for (
          let notice = (await unrelatedCall(reader)).content[1]?.text;
          notice;
          notice = (await unrelatedCall(reader)).content[1]?.text
        ) {
          calls++;
          noticeTokens += estimateTokens(notice);
        }
        const changes = await db.changeEvent.count({ where: { orgId: ORG, scopePath } });
        results[label] = { changes, calls, noticeTokens };
        expect(calls).toBeGreaterThan(0);
      }
      process.stdout.write(`notice-burst ${JSON.stringify(results)}\n`);
    } finally {
      await db.memoryChunk.deleteMany({ where: { orgId: ORG } });
      await db.org.deleteMany({ where: { id: ORG } });
      await memoryService.stop();
      await db.$disconnect();
    }
  },
);
