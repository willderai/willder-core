// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The conflict winner rule, the writer half: two writes from the same writer are never
// competing versions of one fact, while writes from different writers that name the same
// entity inside the contention window still resolve to one winner.
//
// The main case is the workflow that hit this: an agent summarising a customer call
// records its notes about the account as a burst of parallel memory_ingest calls, one of
// them retried, while a second agent writes about the same account. Before this rule the
// first agent kept one note and lost the rest to its own first write, each reply said
// "Stored and readable now", and no notice reached it, because supersede notices carry
// the winner's writer and an agent's own writes are left out of its notices.
//
// Real: the hosted MCP endpoint over a socket, one MCP session per agent, check() against
// live capabilities, the write-through store into Postgres, conflict resolution under the
// per-org lock, and pgvector's SQL. A stand-in memory service answers the embedding call
// with one fixed vector and the graph search with nothing, so memory_query answers from
// the stored rows alone; the queue is a no-op, since graph extraction is not measured here.
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the `@/lib/db`
// singleton at import time, before beforeAll points DATABASE_URL at the test database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import { EmptyGraphMemoryService } from "./memory-service-stub.testsupport";

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
const ORG = "ownwrites";
const ROOT = `org_${ORG}`;
/** One scope per case, so no case's versions fall inside another case's window. */
const SCOPES = {
  account: `${ROOT}.account`,
  twoWriters: `${ROOT}.two_writers`,
  unknownWriter: `${ROOT}.unknown_writer`,
  twoSessions: `${ROOT}.two_sessions`,
} as const;

/** What an agent records after a call with Acme: distinct facts about one account. */
const MEETING_NOTES = [
  "Acme Corp's renewal is due on 2027-03-31.",
  "Acme Corp wants SSO before it signs the renewal.",
  "Acme Corp's champion is Dana Reyes, Head of Platform.",
  "Acme Corp's CFO is Zoë Müller; she prefers email over calls.",
  "Acme Corp runs 340 seats today and plans 500 by Q3.",
  "Acme Corp flagged slow search on its EU workspace.",
  "Acme Corp asked for a security review call next week.",
  "Acme Corp's procurement contact is procurement@acme.example.",
];

/** What a second agent, working the same account's support queue at the same time, records. */
const SUPPORT_NOTES = [
  "Acme Corp opened ticket 4821 about failed CSV exports.",
  "Acme Corp's admin reset 12 user passwords on Monday.",
];

describe.skipIf(!QA_URL)("a writer's own writes never compete with each other", () => {
  const service = new EmptyGraphMemoryService();
  let db: PrismaClient;
  let mcpUrl: string;
  let closeMcp: () => Promise<void>;
  let ClientClass: (typeof import("@modelcontextprotocol/sdk/client/index.js"))["Client"];
  let Transport: (typeof import("@modelcontextprotocol/sdk/client/streamableHttp.js"))["StreamableHTTPClientTransport"];
  let recordIngestApplied: (typeof import("@/services/memory/fact-change-event"))["recordIngestApplied"];
  let CONTENTION_WINDOW_MS: number;

  async function mint(agentId: string, scopePath: string, permission: "read" | "write"): Promise<string> {
    const token = `wcap_test_${agentId}_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath,
        permission,
        grantGoverned: false,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return token;
  }

  /** An MCP client connected to the hosted endpoint as the holder of `token`. */
  async function connect(token: string): Promise<Client> {
    const client: Client = new ClientClass({ name: "own-writes", version: "0.0.0" });
    await client.connect(
      new Transport(new URL(mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
    );
    return client;
  }

  /** One tool call in `client`'s session: the tool's own answer, without the notices. */
  async function callOn(client: Client, name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args });
    const texts = (result.content as { type: string; text?: string }[]).map((part) => part.text ?? "");
    return { isError: Boolean(result.isError), answer: texts[0] ?? "" };
  }

  /** One tool call in a session of its own, closed afterwards. */
  async function callTool(token: string, name: string, args: Record<string, unknown>) {
    const client = await connect(token);
    try {
      return await callOn(client, name, args);
    } finally {
      await client.close();
    }
  }

  const supersedesIn = (scopePath: string) =>
    db.factEdge.findMany({ where: { orgId: ORG, kind: "supersedes", scopePath }, orderBy: { toId: "asc" } });

  beforeAll(async () => {
    if (QA_URL === undefined) return;
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    process.env.GRAPHITI_SERVICE_URL = await service.start();
    process.env.GRAPHITI_SERVICE_API_KEY = "test-key";
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });

    const inngestModule = await import("@/lib/inngest");
    vi.spyOn(inngestModule.inngest, "send").mockImplementation((async () => ({ ids: ["job"] })) as never);
    ({ recordIngestApplied } = await import("@/services/memory/fact-change-event"));
    ({ CONTENTION_WINDOW_MS } = await import("@/services/memory/conflict"));
    ({ Client: ClientClass } = await import("@modelcontextprotocol/sdk/client/index.js"));
    ({ StreamableHTTPClientTransport: Transport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js"));
    const { startMcpTestServer } = await import("./http-test-server");
    const mcp = await startMcpTestServer();
    mcpUrl = mcp.url;
    closeMcp = mcp.close;

    await db.org.deleteMany({ where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.scope.create({ data: { orgId: ORG, path: ROOT, name: ROOT } });
    for (const [name, path] of Object.entries(SCOPES)) await db.scope.create({ data: { orgId: ORG, path, name } });
  });

  afterAll(async () => {
    if (QA_URL === undefined) return;
    await closeMcp?.();
    await service.stop();
    await db.org.deleteMany({ where: { id: ORG } });
    await db.$disconnect();
  });

  it("an agent's burst of notes about one account all stay readable while a second agent's notes still lose", async () => {
    const scopePath = SCOPES.account;
    const accountAgent = await connect(await mint("account-agent", scopePath, "write"));
    const supportAgent = await connect(await mint("support-agent", scopePath, "write"));
    const reviewer = await connect(await mint("reviewer", scopePath, "read"));
    onTestFinished(async () => {
      for (const client of [accountAgent, supportAgent, reviewer]) await client.close();
    });
    const ingest = (client: Client, content: string) =>
      callOn(client, "memory_ingest", { content, name: "Acme Corp", scopePath });

    // The account agent's first note lands, then it fires the rest of its notes at once,
    // with one of them sent twice the way a client retries a call it timed out on. The
    // support agent writes its notes about the same account right after, one at a time.
    const [first, ...rest] = MEETING_NOTES;
    const firstReply = await ingest(accountAgent, first);
    const burst = await Promise.all([...rest, rest[0]].map((note) => ingest(accountAgent, note)));
    const supportReplies: Awaited<ReturnType<typeof ingest>>[] = [];
    for (const note of SUPPORT_NOTES) supportReplies.push(await ingest(supportAgent, note));
    for (const reply of [firstReply, ...burst, ...supportReplies]) expect(reply.isError, reply.answer).toBe(false);

    const versions = await db.memoryChunk.findMany({
      where: { orgId: ORG, scopePath },
      select: { id: true, content: true, actorId: true, createdAt: true, receivedAt: true },
    });
    const versionOf = (content: string) => versions.filter((version) => version.content === content);
    for (const note of [...MEETING_NOTES, ...SUPPORT_NOTES]) expect(versionOf(note), note).toHaveLength(1);
    const writerOf = new Map(versions.map((version) => [version.id, version.actorId]));

    // The decision itself: no version is superseded by its own writer.
    const edges = await supersedesIn(scopePath);
    for (const edge of edges) expect(writerOf.get(edge.fromId)).not.toBe(writerOf.get(edge.toId));

    // Between the two writers, each of the support agent's notes loses, once, to the
    // account agent's version stored first among those in flight with it (stored no more
    // than the contention window before the note was received, services/memory/conflict.ts
    // `inFlightTogether`), and its reply names that version. Which version that is depends
    // on how long the burst took: `first` when the whole burst landed within the window, a
    // burst note when it did not. So it is read from the stored times, not assumed.
    const accountVersions = versions
      .filter((version) => version.actorId === "account-agent")
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    const winnerOf = (note: string) => {
      const stored = versionOf(note)[0];
      const receivedAt = (stored.receivedAt ?? stored.createdAt).getTime();
      const winner = accountVersions.find(
        (version) => receivedAt - version.createdAt.getTime() <= CONTENTION_WINDOW_MS,
      );
      // Each support note is sent after every account note is stored, so the newest of
      // those is always an earlier version; only a store slower than the window misses it.
      if (!winner)
        throw new Error(`no account note stored within ${CONTENTION_WINDOW_MS} ms before "${note}" was received`);
      return winner.id;
    };
    expect(edges.map((edge) => [edge.fromId, edge.toId]).sort()).toEqual(
      SUPPORT_NOTES.map((note) => [winnerOf(note), versionOf(note)[0].id]).sort(),
    );
    SUPPORT_NOTES.forEach((note, i) => expect(supportReplies[i].answer).toContain(`superseded by ${winnerOf(note)}`));

    // Every reader gets every one of the account agent's notes, and none of the losers.
    for (const reader of [accountAgent, supportAgent, reviewer]) {
      const { answer, isError } = await callOn(reader, "memory_query", {
        query: "What do we know about Acme Corp?",
        scopePath,
        limit: 20,
      });
      expect(isError, answer).toBe(false);
      for (const note of MEETING_NOTES) expect(answer).toContain(note);
      for (const note of SUPPORT_NOTES) expect(answer).not.toContain(note);
    }
  });

  it("two writers naming one entity inside the window still resolve to one winner", async () => {
    const scopePath = SCOPES.twoWriters;
    const [writerA, writerB] = await Promise.all([
      mint("writer-a", scopePath, "write"),
      mint("writer-b", scopePath, "write"),
    ]);
    const days = ["Monday", "Tuesday"];

    const replies = await Promise.all([
      callTool(writerA, "memory_ingest", {
        content: `The release train leaves on ${days[0]}.`,
        name: "Release train",
        scopePath,
      }),
      callTool(writerB, "memory_ingest", {
        content: `The release train leaves on ${days[1]}.`,
        name: "Release train",
        scopePath,
      }),
    ]);
    for (const reply of replies) expect(reply.isError, reply.answer).toBe(false);

    expect(await supersedesIn(scopePath)).toHaveLength(1);
    const reader = await mint("reader-pair", scopePath, "read");
    const { answer } = await callTool(reader, "memory_query", {
      query: "When does the release train leave?",
      scopePath,
    });
    expect(days.filter((day) => answer.includes(day))).toHaveLength(1);
  });

  it("two sessions of one agent that disagree about one fact both stay current: they are one writer", async () => {
    const scopePath = SCOPES.twoSessions;
    // Two sessions of the same agent run at once, each with its own capability, and write
    // conflicting values. The writer is the agent, not the session or the token, so
    // neither version supersedes the other and a reader is given both to reconcile.
    const [morningSession, eveningSession] = await Promise.all([
      mint("planner-agent", scopePath, "write"),
      mint("planner-agent", scopePath, "write"),
    ]);
    const days = ["FRIDAY", "MONDAY"];

    const replies = await Promise.all([
      callTool(morningSession, "memory_ingest", {
        content: `The launch date is ${days[0]}.`,
        name: "Launch date",
        scopePath,
      }),
      callTool(eveningSession, "memory_ingest", {
        content: `The launch date is ${days[1]}.`,
        name: "Launch date",
        scopePath,
      }),
    ]);
    for (const reply of replies) expect(reply.answer).toContain("Stored and readable now");

    expect(await supersedesIn(scopePath)).toEqual([]);
    const reader = await mint("reader-sessions", scopePath, "read");
    const { answer } = await callTool(reader, "memory_query", { query: "When is the launch date?", scopePath });
    expect(days.filter((day) => answer.includes(day))).toEqual(days);
  });

  it("versions with no recorded writer are not one writer: they still contend", async () => {
    const scopePath = SCOPES.unknownWriter;
    const storedFirst = new Date("2026-10-07T12:00:00.000Z");
    // A store that records no actor id leaves `actorId` null; two such versions cannot be
    // shown to come from one writer, so they are treated as two.
    for (const [id, content, offsetMs] of [
      ["unknown-first", "The launch date is FRIDAY.", 0],
      ["unknown-second", "The launch date is MONDAY.", 40],
    ] as const) {
      await db.$executeRaw`
        INSERT INTO "memory_chunks" ("id","orgId","content","source","actorType","actorId","entityName","scopePath","createdAt")
        VALUES (${id}, ${ORG}, ${content}, 'text', 'agent', NULL, 'Launch date', ${scopePath}, ${new Date(storedFirst.getTime() + offsetMs)})
      `;
      await recordIngestApplied(
        {
          groupId: ORG,
          content,
          name: "Launch date",
          actorType: "agent",
          origin: "mcp",
          actorId: "unrecorded",
          scopePath,
        },
        id,
      );
    }

    expect(await supersedesIn(scopePath)).toEqual([
      expect.objectContaining({ fromId: "unknown-first", toId: "unknown-second" }),
    ]);
  });
});
