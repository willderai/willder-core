// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Two writes to one fact in the contention window leave one
// version current on EVERY read path, the losing writer gets a change notice, and the id
// in that notice reads the superseded version.
//
// A single read path proving this is not enough. A suite whose graph leg answered nothing
// once passed while the real graph answered with the superseded version, so every path a
// client can reach is asked here, as a third reader, after a real race. The list of paths
// is derived from the tool and route registries.
//
// Everything is real except the memory service: both writers go through the hosted MCP
// endpoint (app/api/mcp/route.ts) over a socket, the conflict is detected and recorded in
// Postgres under the per-org lock, pgvector's SQL runs, and the REST routes run their own handlers.
// The memory service is a real HTTP server standing in for Graphiti in the one way that
// matters here: like the real graph it keeps every version ever written and answers
// with all of them, reworded, each carrying the chunk ids its episode was stamped with
// (the contract memory-service/tests/test_api.py holds /search, /entities and /graph to).
// It also holds what a real graph holds beside the two versions: an edge both episodes
// assert (Graphiti merges a repeated claim into one edge with both stamps), an edge from
// before chunk stamps existed, two edges Graphiti itself already retired (one with
// `invalid_at` and `expired_at` set, one with `expired_at` alone), and one edge true until
// a date still ahead, which Graphiti stores with `expired_at` already set. Like the real
// service, every view returns all three with Graphiti's marks on them; the answer paths
// must leave out the two retired ones and keep the one whose end date is ahead, and the
// graph view must mark only the retired ones. Unlike the real /search, the stand-in's
// /search filters nothing, so the app's own rule is what keeps a retired edge out.
// A stand-in that answered with nothing could not see a superseded version leak.
//
// What it does not model: Graphiti's own contradiction step invalidating one of the two
// raced edges. Whether the real extractor does that for a pair stored a second apart is
// unverified; if it invalidates the winner, the graph view shows no current version and
// a conflict measure against a deployment reports the path as
// unobserved, never as passing.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { toGid } from "@/services/memory/graphiti-store";
import { PrismaPg } from "@prisma/adapter-pg";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { IngestInput, MemoryEdge, MemoryFact, StoresOverview } from "@/types/memory";
import type { Change } from "@/services/memory/change-feed";
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
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "everyreadpath";
const ROOT = `org_${ORG}`;
const SCOPE = `${ROOT}.release`;
const GROUP = toGid(SCOPE);
const ADMIN = "u-every-read-path-admin";
const ENTITY_ID = "ent-release-train";
const FACT_NAME = "Release train";
const QUESTION = "When does the release train leave?";
const DAYS = ["Monday", "Tuesday"] as const;

/** One episode the write path sent to the graph. */
interface Episode {
  groupId: string;
  content: string;
  chunkId: string | null;
}

/** The sentence a graph extractor distils from a stored one: same claim, other words. */
const reworded = (content: string) =>
  `Release train departure: ${content.replace(/^The release train leaves on /, "")}`;

/** A claim both raced writes make, which Graphiti keeps as one edge stamped with both chunks. */
const SHARED_FACT = "Release train is run by the Platform team";
/** An edge written before episodes carried a chunk stamp; no stored version names it, so it is never served. */
const UNSTAMPED_FACT = "Release train ships from the main branch";
/** An older claim Graphiti invalidated itself, with its own timestamps. */
const GRAPHITI_INVALIDATED = {
  fact: "Release train used to leave on Friday",
  invalidAt: "2026-01-05T00:00:00.000Z",
  expiredAt: "2026-01-06T00:00:00.000Z",
};
/** An older claim Graphiti expired without a date it stopped being true. */
const GRAPHITI_EXPIRED = {
  fact: "Release train used to ship from the legacy branch",
  expiredAt: "2026-01-07T00:00:00.000Z",
};
/**
 * A claim true until a date still ahead, stored the way graphiti-core stores it: it sets
 * `expired_at` the moment it records any `invalid_at`, a future one included. It is current
 * until that date.
 */
const GRAPHITI_ENDS_LATER = {
  fact: "Release train keeps the winter timetable until spring",
  invalidAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
  expiredAt: "2026-01-08T00:00:00.000Z",
};

/**
 * A memory service on a real socket. It keeps every episode it is sent, filters nothing,
 * and answers /search, /entities/:id and /graph with one reworded fact per episode, each
 * with the chunk id that episode was stamped with — what the real service returns.
 */
class GraphLikeMemoryService {
  readonly episodes: Episode[] = [];
  /**
   * Answer as a memory service deployed before /entities and /graph carried `chunk_ids`
   * and before /search, /entities and /graph carried `expired_at` (and the first two
   * `invalid_at`): no stamps on those views, the stored sentence unchanged, and only
   * /graph's `invalid_at`.
   */
  predatesStampsOnViews = false;
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

  private facts(groups: readonly string[], view: "search" | "entity" | "graph" = "search") {
    const unstamped = view !== "search" && this.predatesStampsOnViews;
    const inGroups = this.episodes.filter((episode) => groups.includes(episode.groupId));
    const stamps = (episodes: readonly Episode[]) =>
      unstamped ? undefined : episodes.flatMap((episode) => (episode.chunkId ? [episode.chunkId] : []));
    const edge = (
      uuid: string,
      fact: string,
      chunkIds: string[] | undefined,
      retired: { invalidAt?: string; expiredAt?: string } = {},
    ) => ({
      uuid,
      fact,
      valid_at: null,
      ...(this.predatesStampsOnViews && view !== "graph" ? {} : { invalid_at: retired.invalidAt ?? null }),
      ...(this.predatesStampsOnViews ? {} : { expired_at: retired.expiredAt ?? null }),
      actor_type: "agent",
      group_id: GROUP,
      ...(chunkIds === undefined ? {} : { chunk_ids: chunkIds }),
    });
    const versions = inGroups.map((episode, i) => ({
      ...edge(`edge-${i}`, unstamped ? episode.content : reworded(episode.content), stamps([episode])),
      group_id: episode.groupId,
    }));
    if (!groups.includes(GROUP)) return versions;
    return [
      ...versions,
      edge("edge-shared", SHARED_FACT, stamps(inGroups)),
      edge("edge-unstamped", UNSTAMPED_FACT, unstamped ? undefined : []),
      edge("edge-graphiti-invalidated", GRAPHITI_INVALIDATED.fact, unstamped ? undefined : [], GRAPHITI_INVALIDATED),
      edge("edge-graphiti-expired", GRAPHITI_EXPIRED.fact, unstamped ? undefined : [], GRAPHITI_EXPIRED),
      edge("edge-graphiti-ends-later", GRAPHITI_ENDS_LATER.fact, unstamped ? undefined : [], GRAPHITI_ENDS_LATER),
    ];
  }

  private async handle(req: IncomingMessage): Promise<[number, unknown]> {
    const url = new URL(req.url ?? "/", "http://memory");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    if (url.pathname === "/embed") return [200, { embedding: new Array(384).fill(0.01) }];
    if (url.pathname === "/ingest") {
      this.episodes.push({ groupId: body.group_id, content: body.content, chunkId: body.chunk_id ?? null });
      return [200, { episode_id: `ep-${this.episodes.length}` }];
    }
    if (url.pathname === "/search") return [200, { facts: this.facts([body.group_id]) }];
    if (url.pathname === `/entities/${ENTITY_ID}`) {
      const group = url.searchParams.get("group_id") ?? "";
      if (group !== GROUP) return [404, { detail: "entity not found" }];
      // The real entity view lists every edge of the node, retired ones included.
      return [
        200,
        { uuid: ENTITY_ID, name: FACT_NAME, type: "Project", summary: "", facts: this.facts([group], "entity") },
      ];
    }
    if (url.pathname === "/graph") {
      const groups: string[] = body.group_ids ?? [];
      if (!groups.includes(GROUP)) return [200, { nodes: [], edges: [] }];
      return [
        200,
        {
          nodes: [
            { uuid: ENTITY_ID, name: FACT_NAME, type: "Project" },
            { uuid: "ent-platform", name: "Platform", type: "Team" },
          ],
          edges: this.facts(groups, "graph").map((fact) => ({ ...fact, source: ENTITY_ID, target: "ent-platform" })),
        },
      ];
    }
    return [404, { detail: `no route ${url.pathname}` }];
  }
}

/** The marker days a text presents. */
const daysIn = (text: string) => DAYS.filter((day) => text.includes(day));

/**
 * The days a log-shaped answer presents as current: the ones on lines that do not say
 * the version was superseded. A change feed lists the losing write as history, and may,
 * as long as it says that version lost.
 */
const currentDaysIn = (text: string) =>
  daysIn(
    text
      .split("\n")
      .filter((line) => !/superseded/i.test(line))
      .join("\n"),
  );

describe.skipIf(!QA_URL)("one current version on every read path after a race", () => {
  const service = new GraphLikeMemoryService();
  let db: PrismaClient;
  let mcpUrl: string;
  let closeMcp: () => Promise<void>;
  let ClientClass: (typeof import("@modelcontextprotocol/sdk/client/index.js"))["Client"];
  let Transport: (typeof import("@modelcontextprotocol/sdk/client/streamableHttp.js"))["StreamableHTTPClientTransport"];
  const tokens: Record<"a" | "b" | "reader", string> = { a: "", b: "", reader: "" };
  let winner: { id: string; actorId: string; day: string };
  let loser: { id: string; actorId: string; day: string };
  /** The reader's first tool call: the answer and the notices piggybacked on it. */
  let firstRead: { answer: string; notices: string };

  async function mint(agentId: string, permission: "read" | "write"): Promise<string> {
    const token = `wcap_test_${agentId}_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath: SCOPE,
        permission,
        grantGoverned: false,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return token;
  }

  /** One MCP tool call over the hosted endpoint: the tool's answer, then whatever rode on it. */
  async function callTool(token: string, name: string, args: Record<string, unknown>) {
    const client: Client = new ClientClass({ name: "every-read-path", version: "0.0.0" });
    await client.connect(
      new Transport(new URL(mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
    );
    try {
      const result = await client.callTool({ name, arguments: args });
      const texts = (result.content as { type: string; text?: string }[]).map((part) => part.text ?? "");
      return { isError: Boolean(result.isError), answer: texts[0] ?? "", notices: texts.slice(1).join("\n\n") };
    } finally {
      await client.close();
    }
  }

  async function asAdmin() {
    const { requireAccessContext } = (await import("@/lib/access-context")) as unknown as {
      requireAccessContext: ReturnType<typeof vi.fn>;
    };
    requireAccessContext.mockResolvedValue({
      org: await db.org.findUnique({ where: { id: ORG } }),
      user: await db.user.findUnique({ where: { id: ADMIN } }),
      ctx: { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" } },
    });
  }

  beforeAll(async () => {
    if (QA_URL === undefined) return;
    process.env.DATABASE_URL = QA_URL;
    const serviceUrl = await service.start();
    process.env.GRAPHITI_SERVICE_URL = serviceUrl;
    process.env.GRAPHITI_SERVICE_API_KEY = "test-key";
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });

    // Run the queued graph write inline, so the episode really reaches the service with
    // the chunk id the request path stamped on it.
    const inngestModule = await import("@/lib/inngest");
    vi.spyOn(inngestModule.inngest, "send").mockImplementation((async (event: { data: IngestInput }) => {
      await inngestModule.runMemoryIngest(event.data);
      return { ids: ["job"] };
    }) as never);
    ({ Client: ClientClass } = await import("@modelcontextprotocol/sdk/client/index.js"));
    ({ StreamableHTTPClientTransport: Transport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js"));
    const { startMcpTestServer } = await import("./http-test-server");
    const mcp = await startMcpTestServer();
    mcpUrl = mcp.url;
    closeMcp = mcp.close;

    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.user.deleteMany({ where: { id: ADMIN } });
    await db.org.create({ data: { id: ORG, name: ORG } });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: ROOT } });
    await db.scope.create({ data: { orgId: ORG, path: SCOPE, name: "release" } });
    // The claims Graphiti retired (or will) on its own were direct writes stored before
    // episodes carried a chunk stamp, which the graph holds verbatim. A graph fact is served
    // only while a stored source stands behind it (services/memory/graph-fact-sources.ts), so
    // these are stored, with no embedding, so the vector leg never answers with them.
    for (const [i, { fact }] of [GRAPHITI_INVALIDATED, GRAPHITI_EXPIRED, GRAPHITI_ENDS_LATER].entries()) {
      await db.$executeRaw`INSERT INTO memory_chunks ("id","orgId","content","source","actorType","scopePath","createdAt") VALUES (${`pre-stamp-${i}`}, ${ORG}, ${fact}, 'text', 'agent', ${SCOPE}, now())`;
    }
    await db.user.create({
      data: {
        id: ADMIN,
        orgId: ORG,
        email: "admin@every-read-path.test",
        role: "admin",
        clerkId: "clerk-every-read-path",
      },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    tokens.a = await mint("writer-a", "write");
    tokens.b = await mint("writer-b", "write");
    tokens.reader = await mint("reader-c", "read");

    // The race: two writers, one fact, different content, started in the same tick.
    const writes = await Promise.all([
      callTool(tokens.a, "memory_ingest", {
        content: "The release train leaves on Monday.",
        name: FACT_NAME,
        scopePath: SCOPE,
      }),
      callTool(tokens.b, "memory_ingest", {
        content: "The release train leaves on Tuesday.",
        name: FACT_NAME,
        scopePath: SCOPE,
      }),
    ]);
    for (const write of writes) expect(write.isError, write.answer).toBe(false);

    const edges = await db.factEdge.findMany({ where: { orgId: ORG, kind: "supersedes" } });
    expect(edges, "the race must be recorded as one conflict").toHaveLength(1);
    const version = async (id: string) => {
      const row = await db.memoryChunk.findUniqueOrThrow({ where: { id } });
      return { id, actorId: row.actorId ?? "", day: daysIn(row.content)[0]! };
    };
    winner = await version(edges[0]!.fromId);
    loser = await version(edges[0]!.toId);
    expect(service.episodes.map((e) => e.chunkId).sort(), "the graph holds both versions").toEqual(
      [winner.id, loser.id].sort(),
    );

    firstRead = await callTool(tokens.reader, "memory_query", { query: QUESTION, scopePath: SCOPE });
  });

  afterAll(async () => {
    if (QA_URL === undefined) return;
    await closeMcp?.();
    await service.stop();
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.user.deleteMany({ where: { id: ADMIN } });
    await db.$disconnect();
  });

  describe("MCP, as a third agent", () => {
    it("memory_query answers with the winner only", () => {
      expect(daysIn(firstRead.answer)).toEqual([winner.day]);
    });

    it("memory_query leaves out what Graphiti itself retired", () => {
      expect(firstRead.answer).toContain(SHARED_FACT);
      expect(firstRead.answer).not.toContain(GRAPHITI_INVALIDATED.fact);
      expect(firstRead.answer).not.toContain(GRAPHITI_EXPIRED.fact);
    });

    it("memory_query keeps a fact whose end date is still ahead, though Graphiti marked it expired", () => {
      expect(firstRead.answer).toContain(GRAPHITI_ENDS_LATER.fact);
    });

    it("the task-start block does not serve the losing write as open state", () => {
      const block = firstRead.notices.split("\n\n").find((part) => part.startsWith("Before you start")) ?? "";
      expect(block, "the reader's first call is served a task-start block").not.toBe("");
      expect(currentDaysIn(block)).not.toContain(loser.day);
    });

    // The change notice names the supersede by id. The losing write's text may be shown on the
    // call once, by the task-start block or the notice (a notice leaves out a fact version the
    // block on the same result just showed), and wherever it is shown it is marked superseded.
    it("the change notice on the same call marks the losing write as superseded", () => {
      const notice = firstRead.notices.split("\n\n").find((part) => part.startsWith("Changed in your scope")) ?? "";
      expect(
        notice
          .split("\n")
          .some((l) => l.includes(`supersede fact ${loser.id} `) && l.includes(`superseded by ${winner.id}`)),
        notice,
      ).toBe(true);
      expect(currentDaysIn(notice)).not.toContain(loser.day);
      expect(firstRead.notices).toContain(loser.day);
      expect(currentDaysIn(firstRead.notices)).toEqual([winner.day]);
    });

    it("memory_entity answers with the winner only", async () => {
      const { answer, isError } = await callTool(tokens.reader, "memory_entity", {
        entityId: ENTITY_ID,
        scopePath: SCOPE,
      });
      expect(isError, answer).toBe(false);
      expect(daysIn(answer)).toEqual([winner.day]);
      // The loser is dropped; a claim the winner's episode also asserts is still current. An
      // edge with no stamp, no source and no stored version is not served at all: nothing in
      // Postgres still stands behind it (services/memory/graph-fact-sources.ts).
      expect(answer).toContain(SHARED_FACT);
      expect(answer).not.toContain(UNSTAMPED_FACT);
      // An edge Graphiti retired on its own is not current either; one whose end date is
      // still ahead is.
      expect(answer).not.toContain(GRAPHITI_INVALIDATED.fact);
      expect(answer).not.toContain(GRAPHITI_EXPIRED.fact);
      expect(answer).toContain(GRAPHITI_ENDS_LATER.fact);
    });

    it("memory_version reads the winner as current and the loser as superseded by it", async () => {
      const won = await callTool(tokens.reader, "memory_version", { versionId: winner.id });
      const lost = await callTool(tokens.reader, "memory_version", { versionId: loser.id });
      expect(won.answer.split("\n")[0]).toBe(`fact ${winner.id} (current)`);
      expect(lost.answer.split("\n")[0]).toBe(`fact ${loser.id} (superseded)`);
      expect(lost.answer).toContain(`superseded by: ${winner.id}`);
    });

    it("memory_changes lists the losing write only as superseded", async () => {
      // A second reader, so the feed is read from the start rather than after the
      // notices the first reader was already served.
      const token = await mint("reader-d", "read");
      const { answer } = await callTool(token, "memory_changes", { scopePath: SCOPE });
      expect(answer).toContain(loser.day);
      expect(currentDaysIn(answer)).toEqual([winner.day]);
    });
  });

  describe("the losing writer", () => {
    it("is told on its next call, and the id it is given reads the superseded version", async () => {
      const loserToken = loser.actorId === "writer-a" ? tokens.a : tokens.b;
      const next = await callTool(loserToken, "memory_query", { query: QUESTION, scopePath: SCOPE });
      const notice = next.notices.split("\n").find((line) => line.startsWith("- supersede fact "));
      expect(notice, next.notices).toBeDefined();
      const noticedId = notice!.split(" ")[3]!;

      const version = await callTool(loserToken, "memory_version", { versionId: noticedId });

      expect(version.answer.split("\n")[0]).toBe(`fact ${loser.id} (superseded)`);
      expect(version.answer).toContain(`superseded by: ${winner.id}`);
      expect(daysIn(version.answer)).toEqual([loser.day]);
    });
  });

  describe("REST, as a signed-in admin", () => {
    it("POST /api/memory/query answers with the winner only", async () => {
      await asAdmin();
      const { POST } = await import("@/app/api/memory/query/route");
      const res = await POST(
        new Request("http://t/api/memory/query", {
          method: "POST",
          body: JSON.stringify({ query: QUESTION, scope: SCOPE }),
        }),
      );
      const { facts } = (await res.json()) as { facts: MemoryFact[] };
      expect(res.status).toBe(200);
      expect(daysIn(facts.map((f) => f.fact).join("\n"))).toEqual([winner.day]);
      expect(facts.map((f) => f.fact)).not.toEqual(expect.arrayContaining([GRAPHITI_INVALIDATED.fact]));
      expect(facts.map((f) => f.fact)).not.toEqual(expect.arrayContaining([GRAPHITI_EXPIRED.fact]));
      expect(facts.map((f) => f.fact)).toEqual(expect.arrayContaining([GRAPHITI_ENDS_LATER.fact]));
    });

    it("GET /api/memory/entities/:id answers with the winner only", async () => {
      await asAdmin();
      const { GET } = await import("@/app/api/memory/entities/[id]/route");
      const res = await GET(new Request(`http://t/api/memory/entities/${ENTITY_ID}?scope=${SCOPE}`), {
        params: Promise.resolve({ id: ENTITY_ID }),
      });
      const entity = (await res.json()) as { facts: MemoryFact[] };
      expect(res.status).toBe(200);
      expect(daysIn(entity.facts.map((f) => f.fact).join("\n"))).toEqual([winner.day]);
      expect(entity.facts.map((f) => f.fact)).toEqual(expect.arrayContaining([SHARED_FACT, GRAPHITI_ENDS_LATER.fact]));
      expect(entity.facts.map((f) => f.fact)).not.toContain(UNSTAMPED_FACT);
      expect(entity.facts.map((f) => f.fact)).not.toEqual(expect.arrayContaining([GRAPHITI_INVALIDATED.fact]));
      expect(entity.facts.map((f) => f.fact)).not.toEqual(expect.arrayContaining([GRAPHITI_EXPIRED.fact]));
    });

    it("GET /api/memory/graph shows the loser, but only as superseded", async () => {
      await asAdmin();
      const { GET } = await import("@/app/api/memory/graph/route");
      const res = await GET(new Request(`http://t/api/memory/graph?scope=${SCOPE}`));
      const { edges } = (await res.json()) as { edges: MemoryEdge[] };
      expect(res.status).toBe(200);
      const valid = edges.filter((e) => !e.invalidAt);
      expect(daysIn(valid.map((e) => e.fact).join("\n"))).toEqual([winner.day]);
      expect(
        daysIn(
          edges
            .filter((e) => e.invalidAt)
            .map((e) => e.fact)
            .join("\n"),
        ),
      ).toEqual([loser.day]);
      expect(valid.map((e) => e.fact)).toEqual(expect.arrayContaining([SHARED_FACT, GRAPHITI_ENDS_LATER.fact]));
      // An edge nothing stored stands behind is not shown (services/memory/graph-fact-sources.ts).
      expect(edges.map((e) => e.fact)).not.toContain(UNSTAMPED_FACT);
      // An edge Graphiti retired on its own keeps Graphiti's timestamp: when the fact
      // stopped being true, or, without one, when the graph recorded that it had.
      expect(edges.find((e) => e.fact === GRAPHITI_INVALIDATED.fact)?.invalidAt).toBe(GRAPHITI_INVALIDATED.invalidAt);
      expect(edges.find((e) => e.fact === GRAPHITI_EXPIRED.fact)?.invalidAt).toBe(GRAPHITI_EXPIRED.expiredAt);
    });

    it("GET /api/memory/versions/:id reads the loser as superseded by the winner", async () => {
      await asAdmin();
      const { GET } = await import("@/app/api/memory/versions/[id]/route");
      const read = async (id: string) =>
        (
          (await (
            await GET(new Request(`http://t/api/memory/versions/${id}`), { params: Promise.resolve({ id }) })
          ).json()) as {
            version: { status: string; supersededById: string | null };
          }
        ).version;
      expect((await read(winner.id)).status).toBe("current");
      expect(await read(loser.id)).toMatchObject({ status: "superseded", supersededById: winner.id });
    });

    it("GET /api/memory/stores lists the losing chunk only as superseded", async () => {
      await asAdmin();
      const { GET } = await import("@/app/api/memory/stores/route");
      const res = await GET(new Request(`http://t/api/memory/stores?scope=${SCOPE}`));
      const { chunks } = (await res.json()) as StoresOverview;
      expect(res.status).toBe(200);
      expect(chunks.map((c) => [c.id, c.supersededById])).toEqual(
        expect.arrayContaining([
          [winner.id, null],
          [loser.id, winner.id],
        ]),
      );
    });

    it("GET /api/changes marks the losing write as superseded", async () => {
      const token = await mint("reader-e", "read");
      const { GET } = await import("@/app/api/changes/route");
      const res = await GET(
        new Request(`http://t/api/changes?scope=${SCOPE}&limit=50`, { headers: { authorization: `Bearer ${token}` } }),
      );
      const { changes } = (await res.json()) as { changes: (Omit<Change, "createdAt"> & { createdAt: string })[] };
      expect(res.status).toBe(200);
      const creates = changes.filter((c) => c.op === "create" && c.recordType === "fact");
      expect(creates.map((c) => [c.recordId, c.supersededById ?? null])).toEqual(
        expect.arrayContaining([
          [winner.id, null],
          [loser.id, winner.id],
        ]),
      );
    });
  });

  describe("against a memory service deployed before /entities and /graph carried chunk_ids", () => {
    // The app and the memory service deploy separately. Until the service is redeployed,
    // the entity and graph views come back unstamped; the guarded read then matches a
    // fact to the stored versions by its text, which is exactly what it did before
    // the stamps existed — no crash, no new leak.
    async function withUnstampedViews<T>(read: () => Promise<T>): Promise<T> {
      service.predatesStampsOnViews = true;
      try {
        return await read();
      } finally {
        service.predatesStampsOnViews = false;
      }
    }

    it("GET /api/memory/entities/:id still answers with the winner only", async () => {
      await asAdmin();
      const { GET } = await import("@/app/api/memory/entities/[id]/route");
      const res = await withUnstampedViews(() =>
        GET(new Request(`http://t/api/memory/entities/${ENTITY_ID}?scope=${SCOPE}`), {
          params: Promise.resolve({ id: ENTITY_ID }),
        }),
      );
      const entity = (await res.json()) as { facts: MemoryFact[] };
      expect(res.status).toBe(200);
      expect(entity.facts.every((f) => f.chunkIds === undefined)).toBe(true);
      expect(daysIn(entity.facts.map((f) => f.fact).join("\n"))).toEqual([winner.day]);
      // Without Graphiti's marks the app cannot tell a retired edge apart, so it answers
      // as it did before the marks existed: the edge is listed, nothing fails.
      expect(entity.facts.map((f) => f.fact)).toEqual(
        expect.arrayContaining([GRAPHITI_INVALIDATED.fact, GRAPHITI_EXPIRED.fact]),
      );
    });

    it("GET /api/memory/graph still shows the loser only as superseded", async () => {
      await asAdmin();
      const { GET } = await import("@/app/api/memory/graph/route");
      const res = await withUnstampedViews(() => GET(new Request(`http://t/api/memory/graph?scope=${SCOPE}`)));
      const { edges } = (await res.json()) as { edges: MemoryEdge[] };
      expect(res.status).toBe(200);
      expect(edges.every((e) => e.chunkIds === undefined)).toBe(true);
      expect(
        daysIn(
          edges
            .filter((e) => !e.invalidAt)
            .map((e) => e.fact)
            .join("\n"),
        ),
      ).toEqual([winner.day]);
      expect(
        daysIn(
          edges
            .filter((e) => e.invalidAt)
            .map((e) => e.fact)
            .join("\n"),
        ),
      ).toEqual([loser.day]);
    });
  });
});
