// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A file uploaded without Blob storage is stored and announced the way the file-ingest
// job stores and announces one uploaded with it.
//
// A self-hosted install with no BLOB_READ_WRITE_TOKEN extracts an upload inline in
// POST /api/memory/upload instead of queueing the file-ingest job. Its passages must
// still land in pgvector, the store memory_query's semantic leg reads, cited to the
// person who uploaded them; the file must be announced once, as a document under the
// id the upload returned, never as fact versions memory_version cannot find; and an
// agent's own fact named like the file must stay current.
//
// Real: Postgres, the upload route handler (content-length gate, scope resolution,
// check()), the memory_ingest, memory_query and memory_version tool handlers, check()
// against live capabilities, the agent's ingest job (runMemoryIngest, via after()), the
// hybrid store and pgvector's SQL. Doubles: the signed-in session (a fixed person with a
// write grant), the embedding service (one fixed vector), the graph service (it extracts
// two passages from any file, accepts writes and finds nothing) and the distiller's model.
// Faults: the embedding service refusing one passage once, and the graph service
// refusing every write. Not simulated: real PDF extraction, the graph's entity
// extraction, and a retry after a response that was lost on its way to the client.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import type { IngestInput } from "@/types/memory";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

/** Work queued by `after()`, in queue order. */
const queuedJobs = vi.hoisted(() => [] as (() => Promise<unknown>)[]);
/** The signed-in person the upload route sees. */
const session = vi.hoisted(() => ({ current: null as unknown }));
/** Faults the doubles inject: a passage whose embedding is refused once, and a graph that refuses writes. */
const faults = vi.hoisted(() => ({ refuseEmbeddingOnce: null as string | null, graphDown: false }));

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
  const nothing = async () => null;
  let episodes = 0;
  const graph = {
    extractBytes: async ({ filename }: { filename: string }) => ({
      chunks: [
        `${filename} sets Q3 targets: 40 new logos and 2.1M in new ARR.`,
        `${filename} names the owner of each target and the review date.`,
      ],
    }),
    ingest: async () => ({ episodeId: `graph-episode-${(episodes += 1)}` }),
    ingestBulk: async (inputs: IngestInput[]) => {
      if (faults.graphDown) throw new Error("graph service unavailable");
      return inputs.map(() => `graph-episode-${(episodes += 1)}`);
    },
    dedupeNodes: async () => 0,
    retrieve: async () => ({ facts: [], storesRead: [{ store: "graph" }] }),
    entity: nothing,
    graph: async () => ({ nodes: [], edges: [] }),
    removeFact: async () => ({ removed: false }),
    removeEntity: async () => ({ removed: false }),
    transferEntity: async () => ({ transferred: 0 }),
    findFactById: nothing,
  };
  return { graphitiStore: graph, memory: new HybridMemoryStore(graph as never, new PgvectorMemoryStore()) };
});
vi.mock("@/lib/llm", () => ({
  LLM_MODEL_EXTRACT: "test-model",
  LLM_MODEL_ORCHESTRATOR: "test-model",
  createLLMClient: () => ({
    chat: {
      completions: {
        create: async () => ({
          choices: [
            { message: { content: JSON.stringify({ facts: [], entities: [], attributes: [], decisions: [] }) } },
          ],
        }),
      },
    },
  }),
}));
vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
}));

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "selfhostupload";
const ROOT = `org_${ORG}`;
const SCOPE = `${ROOT}.planning`;
const DIMENSIONS = 384;
const PAST_CONTENTION_WINDOW_MS = 1_100;
// 19 uploads in all: the route allows one org 20 an hour.
const FILES = 10;
const RACES = 8;

type ToolReply = { content: { type: "text"; text: string }[]; isError?: boolean };
type Tools = Map<string, (args: Record<string, unknown>) => Promise<ToolReply>>;

describe.skipIf(!QA_URL)(
  "a file uploaded without Blob storage is stored and announced like one uploaded with it",
  () => {
    let db: PrismaClient;
    let registerWillderTools: (typeof import("@/mcp/tools"))["registerWillderTools"];
    let uploadRoute: (typeof import("@/app/api/memory/upload/route"))["POST"];
    let uploaderId: string;

    async function toolsFor(agentId: string): Promise<Tools> {
      const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
      await db.capability.create({
        data: {
          orgId: ORG,
          agentId,
          tokenHash: hashCapabilityToken(token),
          scopePath: ROOT,
          permission: "write",
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });
      const ctx: AccessContext = {
        orgId: ORG,
        actor: { type: "agent", id: agentId, capabilityToken: token },
        origin: "mcp",
      };
      const tools: Tools = new Map();
      const server = {
        registerTool: (name: string, _c: unknown, handler: (args: Record<string, unknown>) => Promise<ToolReply>) =>
          tools.set(name, handler),
      };
      registerWillderTools(server as never, ctx, { orgId: ORG, agentId, scopePath: ROOT });
      return tools;
    }
    const textOf = (reply: ToolReply) => reply.content.map((block) => block.text).join("\n");
    const pastContentionWindow = () => new Promise((resolve) => setTimeout(resolve, PAST_CONTENTION_WINDOW_MS));
    async function runQueuedJobs(): Promise<void> {
      for (const job of queuedJobs.splice(0)) await job();
    }

    /** The signed-in person uploads a PDF named `filename` into SCOPE; returns the route's response. */
    async function send(filename: string): Promise<Response> {
      const form = new FormData();
      form.set("file", new File([new Uint8Array([37, 80, 68, 70])], filename));
      form.set("scope", SCOPE);
      const multipart = new Request("http://localhost/api/memory/upload", { method: "POST", body: form });
      const body = await multipart.arrayBuffer();
      return uploadRoute(
        new Request("http://localhost/api/memory/upload", {
          method: "POST",
          body,
          headers: {
            "content-type": multipart.headers.get("content-type")!,
            "content-length": String(body.byteLength),
          },
        }),
      );
    }

    /** {@link send}, which must be accepted, then the work it queued; returns the upload's job id. */
    async function upload(filename: string): Promise<string> {
      const response = await send(filename);
      if (response.status !== 202)
        throw new Error(`upload of ${filename} answered ${response.status}: ${await response.text()}`);
      const { jobId } = (await response.json()) as { jobId: string };
      await runQueuedJobs();
      return jobId;
    }

    async function writeFact(agent: Tools, name: string, content: string): Promise<string> {
      const reply = textOf(await agent.get("memory_ingest")!({ content, name, scopePath: SCOPE }));
      await runQueuedJobs();
      return reply;
    }

    /** The status memory_version reports for `versionId`, or "missing" for "Version not found.". */
    async function versionStatus(reader: Tools, versionId: string): Promise<string> {
      const text = textOf(await reader.get("memory_version")!({ versionId }));
      return /^\S+ \S+ \((current|superseded|retired)\)/m.exec(text)?.[1] ?? "missing";
    }

    async function storedIdOf(content: string): Promise<string> {
      const rows = await db.$queryRaw<
        { id: string }[]
      >`SELECT id FROM memory_chunks WHERE "orgId" = ${ORG} AND content = ${content}`;
      if (rows.length !== 1) throw new Error(`expected one stored row for "${content}", found ${rows.length}`);
      return rows[0]!.id;
    }

    beforeAll(async () => {
      process.env.DATABASE_URL = QA_URL;
      vi.stubEnv("INNGEST_BYPASS", "1");
      vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
      db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL! }) });
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init?: RequestInit) => {
          const { text } = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
          if (text !== undefined && text === faults.refuseEmbeddingOnce) {
            faults.refuseEmbeddingOnce = null;
            return new Response("upstream timeout", { status: 503 });
          }
          return new Response(JSON.stringify({ embedding: new Array(DIMENSIONS).fill(0.01) }));
        }),
      );
      ({ registerWillderTools } = await import("@/mcp/tools"));
      ({ POST: uploadRoute } = await import("@/app/api/memory/upload/route"));
    });

    afterAll(async () => {
      await deleteOrgsWithRetry(db, { where: { id: ORG } });
      await db.$disconnect();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    beforeEach(async () => {
      queuedJobs.length = 0;
      faults.refuseEmbeddingOnce = null;
      faults.graphDown = false;
      await deleteOrgsWithRetry(db, { where: { id: ORG } });
      await db.org.create({ data: { id: ORG, name: "Self-hosted" } });
      await db.scope.create({ data: { orgId: ORG, path: ROOT, name: ROOT } });
      const planning = await db.scope.create({ data: { orgId: ORG, path: SCOPE, name: "planning" } });
      const person = await db.user.create({
        data: { orgId: ORG, clerkId: "clerk_uploader", email: "owner@selfhost.test", name: "Owner", role: "admin" },
      });
      await db.grant.create({
        data: { orgId: ORG, scopeId: planning.id, granteeType: "user", granteeId: person.id, permission: "write" },
      });
      uploaderId = person.id;
      session.current = {
        org: { id: ORG, name: "Self-hosted" },
        user: person,
        ctx: { orgId: ORG, actor: { type: "human", id: person.id, role: "admin", name: "Owner" }, origin: "app" },
      };
    });

    it("memory_query finds every passage of the uploaded files, cited to the uploader, at a version memory_version finds", async () => {
      const reader = await toolsFor("agent_reader");
      const filenames = Array.from({ length: FILES }, (_, i) => `Plan ${i}.pdf`);
      for (const filename of filenames) await upload(filename);

      const answer = textOf(
        await reader.get("memory_query")!({ query: "Q3 targets owners review date", scopePath: SCOPE, limit: 50 }),
      );
      const passages = filenames.flatMap((filename) => [
        `${filename} sets Q3 targets: 40 new logos and 2.1M in new ARR.`,
        `${filename} names the owner of each target and the review date.`,
      ]);
      const found: string[] = [];
      for (const passage of passages) {
        const line = answer.split("\n").find((l) => l.includes(passage));
        const version = line && /from: Owner \(human\) · version (\S+)/.exec(line)?.[1];
        if (version && (await versionStatus(reader, version)) === "current") found.push(passage);
      }
      expect(found).toEqual(passages);
    }, 60_000);

    it("announces the file once, as a document under the id the upload returned, and no version memory_version cannot find", async () => {
      const reader = await toolsFor("agent_reader");
      const jobId = await upload("Board deck.pdf");

      const announced = await db.changeEvent.findMany({
        where: { orgId: ORG, actorId: uploaderId },
        select: { recordType: true, recordId: true, summary: true, op: true, scopePath: true },
      });
      const unfindable: string[] = [];
      for (const event of announced.filter((e) => e.recordType !== "document")) {
        if ((await versionStatus(reader, event.recordId)) === "missing") unfindable.push(event.recordId);
      }
      expect(unfindable).toEqual([]);
      expect(announced.filter((e) => e.recordType === "document")).toEqual([
        { recordType: "document", recordId: jobId, summary: "Board deck.pdf", op: "create", scopePath: SCOPE },
      ]);
    }, 30_000);

    it("an agent's fact named like an uploaded file stays current, whichever lands first", async () => {
      const [agent, reader] = [await toolsFor("agent_planner"), await toolsFor("agent_reader")];
      const notCurrent: string[] = [];
      for (let race = 0; race < RACES; race++) {
        const name = `Launch plan ${race}.pdf`;
        await writeFact(agent, name, `${name}: the launch slips a week.`);
        await pastContentionWindow();
        const fileFirst = race % 2 === 0;
        if (fileFirst) await upload(name);
        const update = `${name}: the launch is back to October.`;
        const reply = await writeFact(agent, name, update);
        if (!fileFirst) await upload(name);
        if (
          !reply.includes("Stored and readable now") ||
          (await versionStatus(reader, await storedIdOf(update))) !== "current"
        ) {
          notCurrent.push(name);
        }
      }
      expect(notCurrent).toEqual([]);
    }, 120_000);

    /**
     * Run the rest of the test two hours on, as the route's rate limiter sees it: the tests
     * above spend 19 of the org's 20 uploads an hour.
     */
    function twoHoursLater(): void {
      const now = Date.now.bind(Date);
      vi.spyOn(Date, "now").mockImplementation(() => now() + 2 * 3_600_000);
    }

    /** How many stored rows hold each of `passages`, in order. */
    async function rowsPerPassage(passages: string[]): Promise<number[]> {
      const counts: number[] = [];
      for (const passage of passages) {
        counts.push(await db.memoryChunk.count({ where: { orgId: ORG, content: passage } }));
      }
      return counts;
    }

    it("keeps nothing of an upload a passage failed in, tells the person to upload again, and the retry stores each passage once", async () => {
      const filename = "Q2 report.pdf";
      const passages = [
        `${filename} sets Q3 targets: 40 new logos and 2.1M in new ARR.`,
        `${filename} names the owner of each target and the review date.`,
      ];
      faults.refuseEmbeddingOnce = passages[1]!;
      twoHoursLater();
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});

      const failed = await send(filename);
      const { error } = (await failed.json()) as { error: string };
      expect(failed.status).toBe(502);
      expect(error).toMatch(/upload the file again/i);
      expect(error).not.toMatch(/embed|503|http|graphiti/i);
      expect(errors).toHaveBeenCalled();
      expect(await rowsPerPassage(passages)).toEqual([0, 0]);
      expect(await db.changeEvent.count({ where: { orgId: ORG, recordType: "document" } })).toBe(0);

      const jobId = await upload(filename);
      expect(await rowsPerPassage(passages)).toEqual([1, 1]);
      expect(
        await db.changeEvent.findMany({ where: { orgId: ORG, recordType: "document" }, select: { recordId: true } }),
      ).toEqual([{ recordId: jobId }]);
    }, 30_000);

    it("announces the document under the returned id when the graph refuses the file, and logs the graph failure against that id", async () => {
      faults.graphDown = true;
      twoHoursLater();
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});

      const response = await send("Pricing memo.pdf");
      expect(response.status).toBe(202);
      const { jobId } = (await response.json()) as { jobId: string };
      await Promise.allSettled(queuedJobs.splice(0).map((job) => job()));

      expect(
        await db.changeEvent.findMany({
          where: { orgId: ORG, recordType: "document" },
          select: { recordId: true, summary: true },
        }),
      ).toEqual([{ recordId: jobId, summary: "Pricing memo.pdf" }]);
      expect(await db.memoryChunk.count({ where: { orgId: ORG, content: { startsWith: "Pricing memo.pdf" } } })).toBe(
        2,
      );
      expect(errors.mock.calls.some((call) => call.some((part) => String(part).includes(jobId)))).toBe(true);
    }, 30_000);
  },
);
