// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Change notices riding on MCP tool results, against a real database.
//
// The scenario: agent A writes, agent B is busy with some
// other tool, and B's very next tool result tells it what A changed — without B
// asking. Everything below runs for real: a real MCP client and server over an
// in-memory transport, the real tool registrations, check(), the ltree filter,
// and Brief writes that commit their change event in the same transaction.
//
// Set QA_DATABASE_URL to an ISOLATED test database, never the inherited
// DATABASE_URL, which may point at a live database. Skips cleanly without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the
// `@/lib/db` singleton at import time, before beforeAll points DATABASE_URL at
// the QA database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import { EmptyGraphMemoryService } from "./memory-service-stub.testsupport";

// Lets one test make the notice's count of waiting changes fail, to prove nothing the
// notice consumed is lost with it. Every other test runs the real function.
const waitingCount = vi.hoisted(() => ({ failNext: false }));
// Lets one test make the lookup of fact names fail, to prove the notice then describes
// each version on its own line and still loses nothing.
const factNames = vi.hoisted(() => ({ failNext: false }));
vi.mock("@/services/memory/change-feed", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/memory/change-feed")>();
  return {
    ...actual,
    countWaitingChanges: async (...args: Parameters<typeof actual.countWaitingChanges>) => {
      if (waitingCount.failNext) {
        waitingCount.failNext = false;
        throw new Error("change_events unreachable");
      }
      return actual.countWaitingChanges(...args);
    },
    factNamesOf: async (...args: Parameters<typeof actual.factNamesOf>) => {
      if (factNames.failNext) {
        factNames.failNext = false;
        throw new Error("memory_chunks unreachable");
      }
      return actual.factNamesOf(...args);
    },
  };
});
// Lets one test make marking superseded writes fail once, the last read before a notice
// is built. Every other test runs the real function.
const supersededMarking = vi.hoisted(() => ({ failNext: false }));
vi.mock("@/services/memory/superseded-facts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/memory/superseded-facts")>();
  return {
    ...actual,
    markSupersededWrites: async (...args: Parameters<typeof actual.markSupersededWrites>) => {
      if (supersededMarking.failNext) {
        supersededMarking.failNext = false;
        throw new Error("fact_edges unreachable");
      }
      return actual.markSupersededWrites(...args);
    },
  };
});
vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
}));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-change-notices";
const SALES = "org_1.sales";
const ENGINEERING = "org_1.engineering";

const WRITER = "agent-writer";
const READER = "agent-reader";

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

describe.skipIf(!QA_URL)("change notices on MCP tool results, against a real database", () => {
  let db: PrismaClient;
  let createBrief: (typeof import("@/services/memory/create-brief"))["createBrief"];
  let registerWillderTools: (typeof import("./tools"))["registerWillderTools"];
  let toolCallNotice: (typeof import("./change-notices"))["toolCallNotice"];
  let MAX_NOTICES_PER_CALL: number;

  const openClients: Client[] = [];

  /** Mint a read capability for `agentId` on `scopePath`; return its raw token. */
  async function mintCapability(
    agentId: string,
    scopePath: string,
    grantGoverned = false,
    permission: "read" | "write" = "read",
  ): Promise<string> {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath,
        permission,
        grantGoverned,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return token;
  }

  /** A connected MCP client acting as `agentId`, served by the real tool set. */
  async function connectAs(agentId: string, token: string, scopePath: string): Promise<Client> {
    const server = new McpServer({ name: "willder-test", version: "0.0.0" });
    registerWillderTools(
      server,
      { orgId: ORG, actor: { type: "agent", id: agentId, capabilityToken: token }, origin: "mcp" as const },
      { orgId: ORG, agentId, scopePath },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);
    openClients.push(client);
    return client;
  }

  /** Write a Brief as `actorId` the way every production write path does. */
  async function writeBrief(scopePath: string, title: string, actorId = WRITER): Promise<string> {
    const brief = await createBrief(
      { orgId: ORG, type: "handoff", scopePath, title, summary: "s", sections: [] },
      { actorType: "agent", actorId, origin: "agent-run" },
    );
    return brief.id;
  }

  /** Call a tool that does unrelated work: look up a brief that does not exist. */
  async function unrelatedCall(client: Client): Promise<ToolResult> {
    return (await client.callTool({ name: "get_my_brief", arguments: { briefId: "no-such-brief" } })) as ToolResult;
  }

  const memoryService = new EmptyGraphMemoryService();

  // The hooks' own ceiling: a describe's timeout covers its tests, not its hooks, which kept
  // vitest's 10 s hookTimeout. beforeEach's thirteen cleanup deletes took most of that at 3%
  // free memory on a local CI run, and a cleanup cut off mid-way keeps running into
  // the next test, which then starts from rows an earlier test left.
  const HOOK_TIMEOUT_MS = 60_000;

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    // memory_ingest's real write path asks the memory service for an embedding.
    process.env.GRAPHITI_SERVICE_URL = await memoryService.start();
    process.env.GRAPHITI_SERVICE_API_KEY = "test-key";
    const inngestModule = await import("@/lib/inngest");
    vi.spyOn(inngestModule.inngest, "send").mockImplementation((async () => ({ ids: ["job"] })) as never);
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ createBrief } = await import("@/services/memory/create-brief"));
    ({ registerWillderTools } = await import("./tools"));
    ({ MAX_NOTICES_PER_CALL, toolCallNotice } = await import("./change-notices"));
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await memoryService.stop();
    await db.$disconnect();
  }, HOOK_TIMEOUT_MS);

  beforeEach(async () => {
    await Promise.all(openClients.splice(0).map((client) => client.close()));
    waitingCount.failNext = false;
    // What memory_ingest writes besides change events and audit rows.
    await db.factEdge.deleteMany({ where: { orgId: ORG } });
    await db.factVersionRead.deleteMany({ where: { orgId: ORG } });
    await db.memoryIngestKey.deleteMany({ where: { orgId: ORG } });
    await db.memoryChunk.deleteMany({ where: { orgId: ORG } });
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.agentCursor.deleteMany({ where: { orgId: ORG } });
    await db.capability.deleteMany({ where: { orgId: ORG } });
    await db.brief.deleteMany({ where: { orgId: ORG } });
    await db.grant.deleteMany({ where: { orgId: ORG } });
    await db.scope.deleteMany({ where: { orgId: ORG } });
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
  }, HOOK_TIMEOUT_MS);

  it("tells a busy agent what another agent changed, on its next unrelated tool call", async () => {
    const reader = await connectAs(READER, await mintCapability(READER, SALES), SALES);
    const briefId = await writeBrief(SALES, "Switched the API from REST to gRPC");

    const result = await unrelatedCall(reader);

    // The tool's own answer is untouched and comes first.
    expect(result.content[0]!.text).toBe("Brief no-such-brief not found.");
    expect(result.content).toHaveLength(2);
    expect(result.content[1]!.text).toBe(
      "Changed in your scope since your last call:\n" +
        `- create brief ${briefId} by ${WRITER}: Switched the API from REST to gRPC`,
    );
  });

  it("adds no audit row to a call when nothing is new", async () => {
    const reader = await connectAs(READER, await mintCapability(READER, SALES), SALES);

    await unrelatedCall(reader);

    // Exactly the one row get_my_brief's own check() writes for its miss path.
    expect(await db.auditLog.count({ where: { orgId: ORG } })).toBe(1);
  });

  it("attaches each change to one result only", async () => {
    const reader = await connectAs(READER, await mintCapability(READER, SALES), SALES);
    await writeBrief(SALES, "once");

    await unrelatedCall(reader);
    const second = await unrelatedCall(reader);

    expect(second.content).toHaveLength(1);
  });

  it("says nothing about a change outside the agent's scope", async () => {
    const reader = await connectAs(READER, await mintCapability(READER, SALES), SALES);
    await writeBrief(ENGINEERING, "engineering only");

    const result = await unrelatedCall(reader);

    expect(result.content).toHaveLength(1);
  });

  it("does not echo the agent's own writes back to it", async () => {
    const reader = await connectAs(READER, await mintCapability(READER, SALES), SALES);
    await writeBrief(SALES, "my own change", READER);

    const result = await unrelatedCall(reader);

    expect(result.content).toHaveLength(1);
  });

  it("adds no audit row to a call when every new change is the agent's own", async () => {
    const reader = await connectAs(READER, await mintCapability(READER, SALES), SALES);
    await writeBrief(SALES, "my own change", READER);
    const before = await db.auditLog.count({ where: { orgId: ORG } });

    await unrelatedCall(reader);

    // Only get_my_brief's own row: nothing was disclosed, so nothing is audited.
    expect(await db.auditLog.count({ where: { orgId: ORG } })).toBe(before + 1);
  });

  it("adds no audit row to a call when every other agent's new change is outside the agent's scope", async () => {
    const reader = await connectAs(READER, await mintCapability(READER, SALES), SALES);
    await writeBrief(ENGINEERING, "engineering only");
    await writeBrief(SALES, "my own change", READER);
    await writeBrief(ENGINEERING, "engineering again");
    const before = await db.auditLog.count({ where: { orgId: ORG } });

    const result = await unrelatedCall(reader);

    // Only get_my_brief's own row: the notice showed nothing, so it audited nothing.
    expect(result.content).toHaveLength(1);
    expect(await db.auditLog.count({ where: { orgId: ORG } })).toBe(before + 1);
  });

  it("still shows another agent's change in scope that comes after one outside it, audited once", async () => {
    const reader = await connectAs(READER, await mintCapability(READER, SALES), SALES);
    await writeBrief(ENGINEERING, "engineering only");
    const briefId = await writeBrief(SALES, "sales change");
    const before = await db.auditLog.count({ where: { orgId: ORG } });

    const result = await unrelatedCall(reader);

    expect(result.content[1]!.text).toBe(
      "Changed in your scope since your last call:\n" + `- create brief ${briefId} by ${WRITER}: sales change`,
    );
    // get_my_brief's own row and the one disclosure.
    expect(await db.auditLog.count({ where: { orgId: ORG } })).toBe(before + 2);
  });

  it("still shows another agent's change in a scope below the agent's, after one outside it", async () => {
    const reader = await connectAs(READER, await mintCapability(READER, SALES), SALES);
    await writeBrief(ENGINEERING, "engineering only");
    const briefId = await writeBrief(`${SALES}.deals`, "deal desk change");
    const before = await db.auditLog.count({ where: { orgId: ORG } });

    const result = await unrelatedCall(reader);

    // A child scope is inside the agent's scope: skipping it before the read would
    // lose it for good, since the skip moves the cursor.
    expect(result.content[1]!.text).toBe(
      "Changed in your scope since your last call:\n" + `- create brief ${briefId} by ${WRITER}: deal desk change`,
    );
    expect(await db.auditLog.count({ where: { orgId: ORG } })).toBe(before + 2);
  });

  it("adds no audit row to a call whose only other change is in a scope above the agent's", async () => {
    const reader = await connectAs(READER, await mintCapability(READER, SALES), SALES);
    await writeBrief("org_1", "org wide change");
    await writeBrief(`${SALES}force`, "a sibling whose name starts with sales");
    const before = await db.auditLog.count({ where: { orgId: ORG } });

    const result = await unrelatedCall(reader);

    expect(result.content).toHaveLength(1);
    expect(await db.auditLog.count({ where: { orgId: ORG } })).toBe(before + 1);
  });

  it("does not let the agent's own writes crowd another agent's change out of a notice", async () => {
    const reader = await connectAs(READER, await mintCapability(READER, SALES), SALES);
    for (let i = 0; i <= MAX_NOTICES_PER_CALL; i++) await writeBrief(SALES, `mine ${i}`, READER);
    const briefId = await writeBrief(SALES, "someone else's change");

    const result = await unrelatedCall(reader);

    expect(result.content[1]!.text).toBe(
      "Changed in your scope since your last call:\n" + `- create brief ${briefId} by ${WRITER}: someone else's change`,
    );
  });

  it("still shows another agent's change that came before the agent's own", async () => {
    const reader = await connectAs(READER, await mintCapability(READER, SALES), SALES);
    const briefId = await writeBrief(SALES, "written first, by someone else");
    await writeBrief(SALES, "written after, by me", READER);

    const result = await unrelatedCall(reader);

    expect(result.content[1]!.text).toBe(
      "Changed in your scope since your last call:\n" +
        `- create brief ${briefId} by ${WRITER}: written first, by someone else`,
    );
  });

  it("caps a notice at its line count and leaves the rest waiting for the next call", async () => {
    const reader = await connectAs(READER, await mintCapability(READER, SALES), SALES);
    for (let i = 0; i <= MAX_NOTICES_PER_CALL; i++) await writeBrief(SALES, `change ${i}`);

    const first = await unrelatedCall(reader);
    const second = await unrelatedCall(reader);

    const firstLines = first.content[1]!.text.split("\n");
    expect(firstLines.filter((line) => line.startsWith("- "))).toHaveLength(MAX_NOTICES_PER_CALL);
    expect(firstLines.at(-1)).toBe("1 more change is waiting: call memory_changes.");
    expect(second.content[1]!.text).toContain(`: change ${MAX_NOTICES_PER_CALL}`);
  });

  // Every test here writes its burst one call at a time, since a fact's versions must land in
  // order: 40 sequential MCP writes, 80 for the test that writes two scopes. Measured on
  // 2026-10-08 against PG16: 1.3 to 2.0 s for one burst and 2.7 s for two, locally; the
  // two-scope test took about 3.5 s on CI and once passed vitest's 5 s default (shard 4/4,
  // run 37748292735). 20 s leaves room for a CI runner several times slower than that.
  const BURST_TIMEOUT_MS = 20_000;

  describe("a burst of facts written through memory_ingest by several agents", { timeout: BURST_TIMEOUT_MS }, () => {
    // The shape of a pull request's review history (scripts/realdata/github-history.ts):
    // every fact about one pull request is filed under that pull request's name, so the
    // agents reviewing it write new versions of one fact. 40 writes across six pull
    // requests by three agents.
    const AGENTS = ["agent-review", "agent-build", "agent-qa"];
    const BURST: Record<string, number> = {
      "acme/web#101": 12,
      "acme/web#102": 9,
      "acme/web#103": 7,
      "acme/web#104": 5,
      "acme/web#105": 4,
      "acme/web#106": 3,
    };

    /** A write capability per agent on `scopePath`, connected. */
    async function writers(scopePath: string): Promise<Client[]> {
      return Promise.all(
        AGENTS.map(async (agent) =>
          connectAs(
            `${agent}-${scopePath}`,
            await mintCapability(`${agent}-${scopePath}`, scopePath, false, "write"),
            scopePath,
          ),
        ),
      );
    }

    /**
     * memory_ingest as an agent follows it: a write refused as stale (a newer version this
     * agent was not shown, or a base another writer has replaced since) is retried by
     * reading the version the refusal names with memory_version and writing again with a
     * baseVersion, until the write is accepted: the one the refusal advises, or, when it
     * advises none (nothing ties the unread version to the fact the agent read:
     * services/memory/fact-reads.ts), the version just read, since every note this agent
     * writes under a name is about that one pull request. Whether a burst meets that refusal
     * depends on how fast it runs (a version stored more than a second earlier), so a test
     * that writes one must be ready for it.
     */
    async function ingestAsAnAgentDoes(client: Client, args: Record<string, unknown>): Promise<ToolResult> {
      let result = (await client.callTool({ name: "memory_ingest", arguments: args })) as ToolResult;
      for (let attempt = 0; attempt < 5; attempt++) {
        const refusal = result.content[0]!.text;
        const named = /^stale_version: .* Read (\S+) with memory_version/.exec(refusal)?.[1];
        if (named === undefined) return result;
        await client.callTool({ name: "memory_version", arguments: { versionId: named } });
        const baseVersion = /pass baseVersion (\S+)\.$/.exec(refusal)?.[1] ?? named;
        result = (await client.callTool({ name: "memory_ingest", arguments: { ...args, baseVersion } })) as ToolResult;
      }
      return result;
    }

    /**
     * The burst through memory_ingest: written one pull request at a time (a review pass
     * going down the queue), or interleaved round robin (agents working them all at once).
     */
    async function writeBurst(scopePath: string, order: "by-pull-request" | "interleaved"): Promise<void> {
      const clients = await writers(scopePath);
      const owed = new Map(Object.entries(BURST));
      let n = 0;
      const write = async (name: string) => {
        const version = BURST[name]! - owed.get(name)! + 1;
        const client = clients[n++ % clients.length]!;
        const result = await ingestAsAnAgentDoes(client, {
          name,
          content: `Review note ${version} on ${name}: comment thread ${version} resolved.`,
          scopePath,
        });
        expect(result.isError, result.content[0]!.text).toBeFalsy();
        if (owed.get(name) === 1) owed.delete(name);
        else owed.set(name, owed.get(name)! - 1);
      };
      if (order === "by-pull-request") {
        for (const name of Object.keys(BURST)) while (owed.has(name)) await write(name);
      } else {
        while (owed.size > 0) for (const name of [...owed.keys()]) await write(name);
      }
    }

    /** Change events in `scopePath` by anyone but the reader: what the reader has to hear. */
    const owedToReader = (scopePath: string) =>
      db.changeEvent.count({ where: { orgId: ORG, scopePath, actorId: { not: READER } } });

    /** How many changes a notice describes: a merged line's count, or one per plain line. */
    const describedIn = (notice: string): number =>
      notice
        .split("\n")
        .filter((line) => line.startsWith("- "))
        .reduce((sum, line) => sum + Number(/^- (\d+) changes to /.exec(line)?.[1] ?? 1), 0);

    /** Everything memory_changes still returns, page by page, until it says there is nothing. */
    async function drainMemoryChanges(client: Client): Promise<string[]> {
      const listed: string[] = [];
      for (;;) {
        const text = ((await client.callTool({ name: "memory_changes", arguments: { limit: 50 } })) as ToolResult)
          .content[0]!.text;
        if (text === "No changes.") return listed;
        listed.push(...text.split("\n").filter((line) => !line.startsWith("(")));
      }
    }

    it("reads a pull request's new versions as one line per fact, and leaves the rest waiting", async () => {
      const reader = await connectAs(READER, await mintCapability(READER, SALES), SALES);
      await unrelatedCall(reader);
      await writeBurst(SALES, "by-pull-request");

      const lines = (await unrelatedCall(reader)).content[1]!.text.split("\n");

      // One line per pull request, in the order they were reviewed. The conflict rule adds a
      // supersede for each version that lost its window, so the 40 writes are more than 40
      // changes, and one read of the feed (50) ends inside a pull request's run.
      const merged = lines.slice(1, -1);
      expect(merged.length).toBeGreaterThanOrEqual(3);
      expect(merged.length).toBeLessThanOrEqual(MAX_NOTICES_PER_CALL);
      // How many supersedes the burst makes depends on how fast it runs (ingestAsAnAgentDoes),
      // so where the read of 50 ends inside the last line's pull request does too: on a loaded
      // machine it took three of acme/web#104's changes, by two of
      // its three writers. So each line is held to the feed as the database recorded it: a whole
      // pull request's run, by its 3 writers, for every line before the last, and for the last,
      // exactly the changes the read reached and the writers who made them.
      const events = await db.changeEvent.findMany({
        where: { orgId: ORG, scopePath: SALES, actorId: { not: READER } },
        orderBy: { seq: "asc" },
        select: { actorId: true, op: true, recordType: true, recordId: true },
      });
      const factOf = new Map(
        (
          await db.memoryChunk.findMany({
            where: { orgId: ORG, id: { in: events.map((e) => e.recordId) } },
            select: { id: true, entityName: true },
          })
        ).map((row) => [row.id, row.entityName]),
      );
      const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const told: typeof events = [];
      for (const [i, line] of merged.entries()) {
        const fact = `acme/web#10${i + 1}`;
        const run = events.filter((e) => e.recordType === "fact" && factOf.get(e.recordId) === fact);
        const reached = run.slice(0, Number(/^- (\d+) changes to /.exec(line)?.[1] ?? 0));
        const actors = new Set(reached.map((e) => e.actorId));
        const latest = reached.at(-1)!;
        expect(reached.length, line).toBeGreaterThan(1);
        expect(line).toMatch(
          new RegExp(
            `^- ${reached.length} changes to fact "${escape(fact)}" by ${actors.size === 1 ? escape(latest.actorId) : `${actors.size} actors`}; latest: ${latest.op} fact ${escape(latest.recordId)}(:|$)`,
          ),
        );
        if (i < merged.length - 1) {
          expect(reached, line).toEqual(run);
          expect(line).toMatch(
            new RegExp(
              `^- \\d+ changes to fact "acme/web#10${i + 1}" by 3 actors; latest: (create|supersede) fact \\S+`,
            ),
          );
        }
        told.push(...reached);
      }
      // The lines describe the feed's first changes in order, none skipped and none twice.
      expect(told).toEqual(events.slice(0, told.length));
      expect(lines.at(-1)).toMatch(/^\d+ more changes are waiting: call memory_changes\.$/);
    });

    it("leaves every change it did not describe for memory_changes, and counts the waiting ones exactly", async () => {
      const reader = await connectAs(READER, await mintCapability(READER, SALES, false, "write"), SALES);
      await unrelatedCall(reader);
      await writeBurst(SALES, "interleaved");
      // The reader's own writes after the run: never counted as waiting for it. Each is a
      // tool call, so each carries a notice of its own.
      const notices: string[] = [];
      for (let i = 0; i < 3; i++) {
        const own = (await reader.callTool({
          name: "memory_ingest",
          arguments: { name: "reader notes", content: `own note ${i}`, scopePath: SALES },
        })) as ToolResult;
        notices.push(own.content[1]?.text ?? "");
      }
      const owed = await owedToReader(SALES);

      notices.push((await unrelatedCall(reader)).content[1]!.text);
      const listed = await drainMemoryChanges(reader);

      expect(notices.reduce((sum, notice) => sum + describedIn(notice), 0) + listed.length).toBe(owed);
      expect(notices.at(-1)!.split("\n").at(-1)).toBe(
        `${listed.length} more changes are waiting: call memory_changes.`,
      );
    });

    it("counts only the changes the reader may read, in its lines and in what is waiting", async () => {
      const reader = await connectAs(READER, await mintCapability(READER, SALES), SALES);
      await unrelatedCall(reader);
      await writeBurst(SALES, "by-pull-request");
      await writeBurst(ENGINEERING, "by-pull-request");
      const owed = await owedToReader(SALES);

      const notice = (await unrelatedCall(reader)).content[1]!.text;
      const listed = await drainMemoryChanges(reader);

      expect(describedIn(notice) + listed.length).toBe(owed);
      expect(notice.split("\n").at(-1)).toBe(`${listed.length} more changes are waiting: call memory_changes.`);
      expect(notice).not.toContain(ENGINEERING);
    });

    it("loses nothing when marking superseded writes fails after the run was read", async () => {
      const reader = await connectAs(READER, await mintCapability(READER, SALES), SALES);
      await unrelatedCall(reader);
      await writeBurst(SALES, "by-pull-request");
      const owed = await owedToReader(SALES);
      supersededMarking.failNext = true;

      const failed = await unrelatedCall(reader);
      const notices: string[] = [];
      for (
        let notice = (await unrelatedCall(reader)).content[1]?.text;
        notice;
        notice = (await unrelatedCall(reader)).content[1]?.text
      ) {
        notices.push(notice);
      }

      // The failed call carries no notice; nothing it read is lost for it.
      expect(failed.content).toHaveLength(1);
      expect(notices.reduce((sum, notice) => sum + describedIn(notice), 0)).toBe(owed);
    });

    it("describes each version on its own line, and loses nothing, when fact names cannot be read", async () => {
      const reader = await connectAs(READER, await mintCapability(READER, SALES), SALES);
      await unrelatedCall(reader);
      await writeBurst(SALES, "by-pull-request");
      const owed = await owedToReader(SALES);
      factNames.failNext = true;

      const notice = (await unrelatedCall(reader)).content[1]!.text;
      const listed = await drainMemoryChanges(reader);

      const lines = notice.split("\n").filter((line) => line.startsWith("- "));
      expect(lines).toHaveLength(MAX_NOTICES_PER_CALL);
      // Without names, a fact version merges only with its own later changes (its supersede).
      expect(lines.filter((line) => line.includes('changes to fact "'))).toEqual([]);
      expect(describedIn(notice) + listed.length).toBe(owed);
      expect(notice.split("\n").at(-1)).toBe(`${listed.length} more changes are waiting: call memory_changes.`);
    });

    it("records as sighted only the fact versions a notice line shows", async () => {
      const reader = await connectAs(READER, await mintCapability(READER, SALES), SALES);
      await unrelatedCall(reader);
      await writeBurst(SALES, "by-pull-request");

      const notice = (await unrelatedCall(reader)).content[1]!.text;

      const sighted = await db.factVersionRead.findMany({
        where: { orgId: ORG, agentId: READER, sightingOnly: true },
        select: { versionId: true },
      });
      expect(sighted.length).toBeGreaterThan(0);
      expect(sighted.filter(({ versionId }) => !notice.includes(versionId))).toEqual([]);
    });

    it("loses nothing when the count of waiting changes fails", async () => {
      const reader = await connectAs(READER, await mintCapability(READER, SALES), SALES);
      await unrelatedCall(reader);
      await writeBurst(SALES, "interleaved");
      const owed = await owedToReader(SALES);
      waitingCount.failNext = true;

      const notice = (await unrelatedCall(reader)).content[1]!.text;
      const listed = await drainMemoryChanges(reader);

      expect(notice.split("\n").at(-1)).toBe("More changes are waiting: call memory_changes.");
      expect(describedIn(notice) + listed.length).toBe(owed);
    });
  });

  it("stops notifying the moment the agent's capability is revoked", async () => {
    const token = await mintCapability(READER, SALES);
    const reader = await connectAs(READER, token, SALES);
    await db.capability.updateMany({
      where: { tokenHash: hashCapabilityToken(token) },
      data: { revokedAt: new Date() },
    });
    await writeBrief(SALES, "written after the revoke");

    const result = await unrelatedCall(reader);

    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("written after the revoke");
  });

  it("leaves memory_changes bare, since it is the feed itself", async () => {
    const reader = await connectAs(READER, await mintCapability(READER, SALES), SALES);
    const briefId = await writeBrief(SALES, "read on request");

    const result = (await reader.callTool({ name: "memory_changes", arguments: {} })) as ToolResult;

    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.text).toContain(briefId);
  });

  it("never lists the caller's own writes in memory_changes, and says so when that is all there was", async () => {
    const reader = await connectAs(READER, await mintCapability(READER, SALES), SALES);
    const ownId = await writeBrief(SALES, "my own write", READER);

    const onlyOwn = (await reader.callTool({ name: "memory_changes", arguments: {} })) as ToolResult;
    expect(onlyOwn.content[0]!.text).toBe("No changes.");

    const otherId = await writeBrief(SALES, "someone else's write");
    const mixed = (await reader.callTool({ name: "memory_changes", arguments: {} })) as ToolResult;
    expect(mixed.content[0]!.text).toContain(otherId);
    expect(mixed.content[0]!.text).not.toContain(ownId);
  });

  describe("an agent denied its own scope that keeps calling tools", () => {
    // Grant-governed with no live grant: the token resolves, check() denies it.
    const DENIED = "agent-denied";
    const ctxFor = (token: string) => ({
      orgId: ORG,
      actor: { type: "agent" as const, id: DENIED, capabilityToken: token },
      origin: "mcp" as const,
    });
    const denyRows = () => db.auditLog.count({ where: { orgId: ORG, actorId: DENIED, decision: "deny" } });

    async function grantRead(): Promise<string> {
      const scope = await db.scope.upsert({
        where: { orgId_path: { orgId: ORG, path: SALES } },
        update: {},
        create: { orgId: ORG, path: SALES, name: "sales" },
      });
      const grant = await db.grant.create({
        data: { orgId: ORG, scopeId: scope.id, granteeType: "agent", granteeId: DENIED, permission: "read" },
      });
      return grant.id;
    }

    it("audits the denial once per change of decision, not once per call", async () => {
      const ctx = ctxFor(await mintCapability(DENIED, SALES, true));

      await writeBrief(SALES, "unseen 1");
      for (let i = 0; i < 10; i++) expect(await toolCallNotice(ctx, SALES)).toBeNull();
      expect(await denyRows()).toBe(1);

      // More writes while still denied are not a new decision.
      await writeBrief(SALES, "unseen 2");
      for (let i = 0; i < 10; i++) expect(await toolCallNotice(ctx, SALES)).toBeNull();
      expect(await denyRows()).toBe(1);

      // Granted again: the next change is told, and nothing is denied.
      const grantId = await grantRead();
      await writeBrief(SALES, "after regrant");
      expect(await toolCallNotice(ctx, SALES)).toContain("after regrant");
      expect(await denyRows()).toBe(1);

      // Revoked again: a new decision, audited once more, and only once.
      await db.grant.delete({ where: { id: grantId } });
      await writeBrief(SALES, "after revoke");
      for (let i = 0; i < 10; i++) expect(await toolCallNotice(ctx, SALES)).toBeNull();
      expect(await denyRows()).toBe(2);
    });

    it("audits a second revoke that follows a regrant nothing was written under", async () => {
      const ctx = ctxFor(await mintCapability(DENIED, SALES, true));
      await toolCallNotice(ctx, SALES);
      expect(await denyRows()).toBe(1);

      // Granted again on a quiet org: the feed is never read, so ending the denial
      // cannot wait for a read.
      const grantId = await grantRead();
      expect(await toolCallNotice(ctx, SALES)).toBeNull();

      await db.grant.delete({ where: { id: grantId } });
      await toolCallNotice(ctx, SALES);
      await toolCallNotice(ctx, SALES);
      expect(await denyRows()).toBe(2);
    });

    it("is not told what was written while it was denied, once granted again", async () => {
      const ctx = ctxFor(await mintCapability(DENIED, SALES, true));
      await writeBrief(SALES, "written while denied");
      await toolCallNotice(ctx, SALES);

      await grantRead();
      await writeBrief(SALES, "written after grant");
      const told = await toolCallNotice(ctx, SALES);

      expect(told).toContain("written after grant");
      expect(told).not.toContain("written while denied");
    });

    it("writes one notice denial across many real tool calls, beside each call's own", async () => {
      const token = await mintCapability(DENIED, SALES, true);
      const denied = await connectAs(DENIED, token, SALES);
      await writeBrief(SALES, "unseen");
      const calls = 10;

      for (let i = 0; i < calls; i++) {
        const result = await unrelatedCall(denied);
        expect(result.isError).toBe(true);
        expect(result.content).toHaveLength(1);
      }

      // get_my_brief's own check() denies, and audits, every call; that is the
      // call's own record and stays. The notice adds exactly one row, for the
      // denial starting, where before it added one to every call.
      expect(await denyRows()).toBe(calls + 1);
    });
  });
});
