// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// An imported file's text is not a version of a fact named like the file.
//
// A person uploads "Plan 7.pdf", or a connected Google Drive folder syncs a doc named
// "Plan 7", while an agent keeps its own fact "Plan 7" current through memory_ingest in
// the same scope. Both import jobs store each extracted passage as a pgvector row; the
// contention rule (services/memory/conflict.ts) and the stale-read rule
// (services/memory/fact-reads.ts) read every row under a name as a version of that fact,
// so passages stored under the file's name were versions nobody announced and the agent
// never read: landing inside the contention window before the agent's update, they
// superseded it and memory_query stopped serving it; landing earlier, they got the
// agent's next update refused as written from a stale read.
//
// Real: Postgres, the memory_ingest, memory_version and memory_query tool handlers,
// check() against live capabilities, the request-path store and announcement, the
// agent's ingest job (runMemoryIngest, via after()), both import jobs (the fileIngest
// function's handler with its steps run inline, and processDriveFile), the Source and
// SourceFile rows, the hybrid store and pgvector's SQL. Doubles: the embedding service
// (one fixed vector), the graph service (it extracts two passages from any file, accepts
// writes and finds nothing), the distiller's model, the Drive download and the blob put.
// Not simulated: the queued Inngest runs, a job retried after a partial run, and real
// PDF or Docs extraction.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import type { DriveFile } from "@/services/connectors/gdrive";
import type { IngestInput } from "@/types/memory";

/** Ingest jobs queued by `after()`, in queue order. */
const queuedJobs = vi.hoisted(() => [] as (() => Promise<unknown>)[]);

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => Promise<unknown>) => {
    queuedJobs.push(task);
  },
}));
vi.mock("@/services/memory/store", async () => {
  const { HybridMemoryStore } = await import("@/services/memory/hybrid-store");
  const { PgvectorMemoryStore } = await import("@/services/memory/pgvector-store");
  const nothing = async () => null;
  let episodes = 0;
  const graph = {
    extractFile: async ({ filename }: { filename: string }) => ({
      chunks: [
        `${filename} sets Q3 targets: 40 new logos and 2.1M in new ARR.`,
        `${filename} names the owner of each target and the review date.`,
      ],
    }),
    ingest: async () => ({ episodeId: `graph-episode-${(episodes += 1)}` }),
    ingestBulk: async (inputs: IngestInput[]) => inputs.map(() => `graph-episode-${(episodes += 1)}`),
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
// The file-ingest job deletes its raw blob once extracted; these files hold no real blob.
vi.mock("@vercel/blob", () => ({ del: async () => undefined }));

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "importrace";
const ROOT = `org_${ORG}`;
const SCOPE = `${ROOT}.planning`;
const DIMENSIONS = 384;
const PAST_CONTENTION_WINDOW_MS = 1_100;
const PERSON = { id: "user_import_owner", name: "Owner" };
const DRIVE = { id: "src_import_drive", orgId: ORG, name: "Planning", scopePath: SCOPE, connectAuthorizationId: null };
const RACES = 30;

type ToolReply = { content: { type: "text"; text: string }[]; isError?: boolean };
type Tools = Map<string, (args: Record<string, unknown>) => Promise<ToolReply>>;
type Importer = (name: string) => Promise<void>;

describe.skipIf(!QA_URL)("an imported file's text is not a version of a fact named like the file", () => {
  let db: PrismaClient;
  let registerWillderTools: (typeof import("@/mcp/tools"))["registerWillderTools"];
  let fileIngest: (typeof import("@/lib/inngest/file-ingest"))["fileIngest"];
  let processDriveFile: (typeof import("@/lib/inngest/connector-drive-files"))["processDriveFile"];

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

  /** A person uploads a PDF named `filename`: the event the upload route sends, run through the job's handler. */
  const upload: Importer = async (filename) => {
    const data = {
      groupId: ORG,
      blobUrl: `https://blob.test/${encodeURIComponent(filename)}`,
      filename,
      fileType: "pdf",
      actorId: PERSON.id,
      actorName: PERSON.name,
      scopePath: SCOPE,
      origin: "app",
    };
    type Handler = { fn: (ctx: unknown) => Promise<unknown> };
    await (fileIngest as unknown as Handler).fn({
      event: { id: `upload-${filename}`, data },
      step: { run: async (_step: string, fn: () => unknown) => fn() },
      runId: `run-${filename}`,
    });
  };
  /** The connected Drive folder syncs a Google Doc named `name`. */
  const driveSync: Importer = async (name) => {
    const file: DriveFile = {
      id: `drive-${name}`,
      name,
      mimeType: "application/vnd.google-apps.document",
      checksum: "c1",
      contentVersion: "c1",
      fileType: "docx",
    };
    const outcome = await processDriveFile(DRIVE, file, "drive-token", {
      downloadFile: async () => new Blob(["exported doc"]),
      put: async (pathname) => ({ url: `https://blob.test/${pathname}` }),
      del: async () => undefined,
    });
    if (outcome !== "synced") throw new Error(`Drive sync of ${name} ended ${outcome}`);
  };

  /** One fact an agent keeps current about a plan, written through memory_ingest. */
  function factIn(agent: Tools, name: string) {
    async function write(content: string): Promise<string> {
      const reply = textOf(await agent.get("memory_ingest")!({ content, name, scopePath: SCOPE }));
      await runQueuedJobs();
      return reply;
    }
    return {
      name,
      create: () => write(`${name}: launch slips to November.`),
      update: () => write(`${name}: launch moved back to October.`),
      /** The version the agent's update stored. */
      async updateVersion(): Promise<string> {
        const rows = await db.$queryRaw<{ id: string }[]>`
          SELECT id FROM memory_chunks WHERE "orgId" = ${ORG} AND content = ${`${name}: launch moved back to October.`}
        `;
        if (rows.length !== 1) throw new Error(`expected one stored update of ${name}, found ${rows.length}`);
        return rows[0]!.id;
      },
    };
  }
  async function statusOf(reader: Tools, versionId: string): Promise<string | null> {
    const reply = await reader.get("memory_version")!({ versionId });
    return /^\S+ \S+ \((current|superseded|retired)\)/m.exec(textOf(reply))?.[1] ?? null;
  }
  /** The memory_query answer line that serves `text`, or undefined. */
  async function servedLine(reader: Tools, query: string, text: string): Promise<string | undefined> {
    const answer = textOf(await reader.get("memory_query")!({ query, scopePath: SCOPE, limit: 50 }));
    return answer.split("\n").find((line) => line.startsWith("•") && line.includes(text));
  }
  /** The passages an import job stored from the file named `filename`, so the component under test was present. */
  async function importedPassages(filename: string): Promise<{ id: string }[]> {
    return db.$queryRaw<{ id: string }[]>`
      SELECT id FROM memory_chunks WHERE "orgId" = ${ORG} AND "source" = 'document' AND content LIKE ${`${filename} %`}
    `;
  }

  /**
   * Thirty plans, each updated by its agent while a file named like the plan's fact is
   * imported, alternating which lands first. Returns the races whose update was lost.
   */
  async function racesLost(agent: Tools, reader: Tools, importFile: Importer, extension: string): Promise<string[]> {
    const facts = [];
    for (let race = 0; race < RACES; race += 1) {
      const fact = factIn(agent, `Plan ${race}${extension}`);
      await fact.create();
      facts.push(fact);
    }
    await pastContentionWindow();

    const lost: string[] = [];
    for (const [race, fact] of facts.entries()) {
      const fileFirst = race % 2 === 0;
      if (fileFirst) await importFile(fact.name);
      await fact.update();
      if (!fileFirst) await importFile(fact.name);

      if ((await importedPassages(fact.name)).length === 0)
        throw new Error(`race ${race}: the import stored no passages`);
      if ((await statusOf(reader, await fact.updateVersion())) !== "current") {
        lost.push(`race ${race} (${fileFirst ? "file first" : "update first"})`);
      }
    }
    return lost;
  }

  beforeAll(async () => {
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    // No queue: each write's job is handed to `after()`, as in a deployment without one.
    vi.stubEnv("INNGEST_BYPASS", "1");
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    vi.stubGlobal("fetch", vi.fn());
    ({ registerWillderTools } = await import("@/mcp/tools"));
    ({ fileIngest } = await import("@/lib/inngest/file-ingest"));
    ({ processDriveFile } = await import("@/lib/inngest/connector-drive-files"));
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await db.org.deleteMany({ where: { id: ORG } });
    await db.$disconnect();
  });
  beforeEach(async () => {
    vi.mocked(globalThis.fetch)
      .mockReset()
      .mockImplementation(async () => new Response(JSON.stringify({ embedding: new Array(DIMENSIONS).fill(0.01) })));
    queuedJobs.length = 0;
    await db.org.deleteMany({ where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.scope.create({ data: { orgId: ORG, path: ROOT, name: ROOT } });
    await db.scope.create({ data: { orgId: ORG, path: SCOPE, name: "planning" } });
    await db.source.create({
      data: {
        id: DRIVE.id,
        orgId: ORG,
        type: "gdrive",
        externalId: "folder-planning",
        name: DRIVE.name,
        scopePath: SCOPE,
      },
    });
  });

  it("keeps an agent's update current and served when an uploaded file named like its fact landed just before it", async () => {
    const [agent, reader] = [await toolsFor("planning-agent"), await toolsFor("reader")];
    const plan = factIn(agent, "Q3 plan.pdf");
    await plan.create();
    await pastContentionWindow();

    await upload("Q3 plan.pdf");
    const reply = await plan.update();

    expect(await importedPassages("Q3 plan.pdf")).toHaveLength(2);
    expect(reply).toContain("Stored and readable now");
    expect(await statusOf(reader, await plan.updateVersion())).toBe("current");
    expect(await servedLine(reader, "Q3 plan launch October", "launch moved back to October")).toBeDefined();
    expect(await servedLine(reader, "Q3 plan targets", "Q3 plan.pdf sets Q3 targets")).toContain("from: Owner (human)");
  }, 30_000);

  it("keeps an agent's update current and served when a Drive doc named like its fact synced just before it", async () => {
    const [agent, reader] = [await toolsFor("planning-agent"), await toolsFor("reader")];
    const plan = factIn(agent, "Q3 plan");
    await plan.create();
    await pastContentionWindow();

    await driveSync("Q3 plan");
    const reply = await plan.update();

    const passages = await importedPassages("Q3 plan");
    expect(passages).toHaveLength(2);
    expect(reply).toContain("Stored and readable now");
    expect(await statusOf(reader, await plan.updateVersion())).toBe("current");
    expect(await servedLine(reader, "Q3 plan launch October", "launch moved back to October")).toBeDefined();
    expect(await servedLine(reader, "Q3 plan targets", "Q3 plan sets Q3 targets")).toContain(
      "source: Planning (gdrive)",
    );
    // The sync still records every passage it wrote, so a later edit or removal retires them.
    const synced = await db.sourceFile.findUniqueOrThrow({
      where: { sourceId_externalFileId: { sourceId: DRIVE.id, externalFileId: "drive-Q3 plan" } },
    });
    expect([...synced.chunkIds].sort()).toEqual(passages.map((p) => p.id).sort());
  }, 30_000);

  it.each([
    { how: "uploaded", importFile: () => upload, filename: "Q3 plan.pdf" },
    { how: "synced from Drive", importFile: () => driveSync, filename: "Q3 plan" },
  ])(
    "does not refuse an agent's later update because a file named like its fact was $how since",
    async ({ importFile, filename }) => {
      const agent = await toolsFor("planning-agent");
      const plan = factIn(agent, filename);
      await plan.create();
      await importFile()(filename);
      await pastContentionWindow();

      const reply = await plan.update();

      expect(await importedPassages(filename)).toHaveLength(2);
      expect(reply).toContain("Stored and readable now");
    },
    30_000,
  );

  it.each([
    { how: "uploaded", importFile: () => upload, extension: ".pdf" },
    // A Google Doc's name has no extension.
    { how: "synced from Drive", importFile: () => driveSync, extension: "" },
  ])(
    "loses no agent update in thirty races with a file $how under the fact's name",
    async ({ how, importFile, extension }) => {
      const [agent, reader] = [await toolsFor("planning-agent"), await toolsFor("reader")];
      const lost = await racesLost(agent, reader, importFile(), extension);

      console.log(
        `lost agent updates: ${lost.length} of ${RACES} races with a file ${how}${lost.length ? `: ${lost.join(", ")}` : ""}`,
      );
      expect(lost).toEqual([]);
    },
    180_000,
  );
});
