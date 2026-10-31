// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Every person's write names the visible audit row that authorized it.
//
// For any fact, the audit trail must answer who wrote it and which visible
// `memory.write` allow row authorized it. The answer is the change event's
// `authorizedById`, read back by GET /api/audit as that row's `changeIds`. A write path
// that runs `check()` but drops the row id leaves the sampled fact with no answer.
// POST /api/memory/facts and /api/memory/ingest carry it; so must these:
//
//   - Ask's confirmed save (POST /api/memory/chat with `confirmed`)
//   - a file upload, inline (no Blob storage) and through the file-ingest job
//   - a convention: recorded, replacing another, and retired
//   - a correction to a brief (POST /api/briefs/:id/correct)
//   - an agent run's memory_write tool
//   - a rule an agent records through memory_ingest: its text is also stored as a fact,
//     and that fact must name the row the rule's own check() authorized both with
//
// Each case writes through the real route or service and then asks the audit trail:
// the event names a row, the row is a visible allow `memory.write`
// by the same person, and GET /api/audit lists the event under that row.
//
// Real: Postgres, the routes, check(), ingestMemory with its write-through to pgvector,
// the file-ingest job, the convention service, GET /api/audit. Doubles: the signed-in
// session, the embedding service (one fixed vector), the graph service, the model, Blob
// storage, and the contradiction search behind a correction.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { IngestInput } from "@/types/memory";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

/** Work queued by `after()`, in queue order. */
const queuedJobs = vi.hoisted(() => [] as (() => Promise<unknown>)[]);
/** The signed-in person the routes see. */
const session = vi.hoisted(() => ({ current: null as unknown }));

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
  let episodes = 0;
  const graph = {
    extractBytes: async () => ({ chunks: ["The Q3 plan sets 40 new logos."] }),
    extractFile: async () => ({ chunks: ["The Q3 plan sets 40 new logos."] }),
    ingest: async () => ({ episodeId: `graph-episode-${(episodes += 1)}` }),
    ingestBulk: async (inputs: IngestInput[]) => inputs.map(() => `graph-episode-${(episodes += 1)}`),
    dedupeNodes: async () => 0,
    retrieve: async () => ({ facts: [], storesRead: [{ store: "graph" }] }),
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
vi.mock("@/lib/blob-storage", () => ({
  putPrivateBlob: async (path: string) => ({ url: `https://blob.test/${path}` }),
  deletePrivateBlob: async () => undefined,
}));
vi.mock("@/services/facts/conflicts", () => ({
  findContradiction: async () => ({ contradiction: null, complete: true }),
}));
vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
}));

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "stamped";
const ROOT = `org_${ORG}`;
const SCOPE = `${ROOT}.planning`;
const DIMENSIONS = 384;

type AuditListing = { entries: { id: string; changeIds?: string[] }[] };

describe.skipIf(!QA_URL)("every person's write names the visible audit row that authorized it", () => {
  let db: PrismaClient;
  let chatRoute: (typeof import("@/app/api/memory/chat/route"))["POST"];
  let uploadRoute: (typeof import("@/app/api/memory/upload/route"))["POST"];
  let correctRoute: (typeof import("@/app/api/briefs/[id]/correct/route"))["POST"];
  let auditRoute: (typeof import("@/app/api/audit/route"))["GET"];
  let conventions: typeof import("@/services/memory/conventions");
  let inngestModule: typeof import("@/lib/inngest");
  let ctx: AccessContext;

  /** Run queued work until none is left: a queued ingest queues its own graph step. */
  async function runQueuedJobs(): Promise<void> {
    while (queuedJobs.length > 0) await queuedJobs.shift()!();
  }

  /**
   * The author answer for one change event: it names a row, the row is a
   * visible allow `memory.write` by the writer, and the audit log lists the event under
   * that row. Returns what failed, so a test names the gap instead of a bare `false`.
   */
  async function authorAnswer(eventId: string): Promise<string> {
    const event = await db.changeEvent.findUniqueOrThrow({ where: { id: eventId } });
    if (event.authorizedById === null) return "no authorization recorded";
    const row = await db.auditLog.findFirst({ where: { id: event.authorizedById, orgId: ORG } });
    if (!row) return "names a row that is not in this org's audit log";
    if (row.action !== "memory.write" || row.decision !== "allow") return `names a ${row.decision} ${row.action} row`;
    if (row.actorId !== event.actorId) return `names a row by ${row.actorId}, not the writer ${event.actorId}`;
    const res = await auditRoute(new Request(`http://t/api/audit?ids=${row.id}`));
    const listed = ((await res.json()) as AuditListing).entries.find((e) => e.id === row.id);
    if (!listed) return "the row is not visible in GET /api/audit";
    if (!(listed.changeIds ?? []).includes(event.id)) return "GET /api/audit does not list the change under its row";
    return "answered";
  }

  async function eventsOf(recordType: string): Promise<{ id: string; op: string }[]> {
    return db.changeEvent.findMany({
      where: { orgId: ORG, recordType },
      select: { id: true, op: true },
      orderBy: { seq: "asc" },
    });
  }

  async function sendUpload(filename: string): Promise<Response> {
    const form = new FormData();
    form.set("file", new File([new Uint8Array([37, 80, 68, 70])], filename));
    form.set("scope", SCOPE);
    const multipart = new Request("http://t/api/memory/upload", { method: "POST", body: form });
    const body = await multipart.arrayBuffer();
    return uploadRoute(
      new Request("http://t/api/memory/upload", {
        method: "POST",
        body,
        headers: { "content-type": multipart.headers.get("content-type")!, "content-length": String(body.byteLength) },
      }),
    );
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    vi.stubEnv("INNGEST_BYPASS", "1");
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL! }) });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ embedding: new Array(DIMENSIONS).fill(0.01) }))),
    );
    ({ POST: chatRoute } = await import("@/app/api/memory/chat/route"));
    ({ POST: uploadRoute } = await import("@/app/api/memory/upload/route"));
    ({ POST: correctRoute } = await import("@/app/api/briefs/[id]/correct/route"));
    ({ GET: auditRoute } = await import("@/app/api/audit/route"));
    conventions = await import("@/services/memory/conventions");
    inngestModule = await import("@/lib/inngest");
  });

  afterAll(async () => {
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.$disconnect();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  beforeEach(async () => {
    queuedJobs.length = 0;
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: "Write stamp" } });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: ROOT } });
    await db.scope.create({ data: { orgId: ORG, path: SCOPE, name: "planning" } });
    const person = await db.user.create({
      data: { orgId: ORG, clerkId: "clerk_stamped", email: "owner@stamped.test", name: "Owner", role: "admin" },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: person.id, permission: "admin" },
    });
    ctx = { orgId: ORG, actor: { type: "human", id: person.id, role: "admin", name: "Owner" }, origin: "app" };
    session.current = { org: { id: ORG, name: "Write stamp" }, user: person, ctx };
  });

  it("Ask's confirmed save", async () => {
    const res = await chatRoute(
      new Request("http://t/api/memory/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: "save it",
          confirmed: true,
          pendingContent: "Renewal is due in March.",
          scope: SCOPE,
        }),
      }),
    );
    await res.text();
    await runQueuedJobs();

    const facts = await eventsOf("fact");
    expect(facts).toHaveLength(1);
    expect(await authorAnswer(facts[0]!.id)).toBe("answered");
  });

  it("a file uploaded without Blob storage", async () => {
    expect((await sendUpload("Q3 plan.pdf")).status).toBe(202);
    await runQueuedJobs();

    const documents = await eventsOf("document");
    expect(documents).toHaveLength(1);
    expect(await authorAnswer(documents[0]!.id)).toBe("answered");
  });

  it("a file uploaded through Blob storage and the file-ingest job", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "blob-token");
    const sent: { id: string; data: unknown }[] = [];
    vi.spyOn(inngestModule.inngest, "send").mockImplementation((async (event: { data: unknown }) => {
      sent.push({ id: "job-stamped", data: event.data });
      return { ids: ["job-stamped"] };
    }) as never);

    expect((await sendUpload("Q3 plan.pdf")).status).toBe(202);
    const [job] = sent;
    const fileIngest = inngestModule.fileIngest as unknown as {
      fn: (c: {
        event: { id: string; data: unknown };
        step: { run: (n: string, f: () => unknown) => unknown };
        runId: string;
      }) => Promise<unknown>;
    };
    await fileIngest.fn({ event: job!, step: { run: async (_n, f) => f() }, runId: "run-stamped" });

    const documents = await eventsOf("document");
    expect(documents).toHaveLength(1);
    expect(await authorAnswer(documents[0]!.id)).toBe("answered");
  });

  it("a convention recorded, then replaced, then retired", async () => {
    const first = await conventions.recordConvention(ctx, {
      kind: "convention",
      subject: "Account dedupe",
      text: "Merge accounts by domain.",
      scopePath: SCOPE,
    });
    const second = await conventions.recordConvention(ctx, {
      kind: "convention",
      subject: "Account dedupe",
      text: "Merge accounts by domain and region.",
      scopePath: SCOPE,
      supersedes: first,
    });
    expect(await conventions.retireConvention(ctx, second)).toBe(true);

    const events = await eventsOf("convention");
    expect(events.map((e) => e.op)).toEqual(["create", "create", "supersede", "delete"]);
    for (const event of events) expect(await authorAnswer(event.id)).toBe("answered");
  });

  it("a correction to a brief", async () => {
    const brief = await db.brief.create({
      data: {
        orgId: ORG,
        type: "handoff",
        scopePath: SCOPE,
        title: "Handoff",
        summary: "Renewal in May.",
        sections: [],
      },
    });
    const res = await correctRoute(
      new Request(`http://t/api/briefs/${brief.id}/correct`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ correction: "Renewal is in March, not May." }),
      }),
      { params: Promise.resolve({ id: brief.id }) },
    );
    expect(res.status).toBe(200);
    await runQueuedJobs();

    const facts = await eventsOf("fact");
    expect(facts).toHaveLength(1);
    expect(await authorAnswer(facts[0]!.id)).toBe("answered");
  });

  it("an agent run's memory_write tool", async () => {
    const token = "wcap_test_stamped_runner";
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId: "agent_researcher",
        tokenHash: hashCapabilityToken(token),
        scopePath: SCOPE,
        permission: "write",
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    const runtime = new Map<string, string>([
      ["orgId", ORG],
      ["capabilityToken", token],
      ["actorId", "agent_researcher"],
      ["actorName", "Researcher"],
      ["memoryScope", SCOPE],
    ]);
    const { memoryWriteTool } = await import("@/services/agents/tools");
    const execute = memoryWriteTool.execute as unknown as (args: unknown) => Promise<{ episodeId: string | null }>;
    const result = await execute({
      context: { content: "Acme renews in March.", name: "Acme" },
      runtimeContext: runtime,
    });
    expect(result.episodeId).toBe("queued");
    await runQueuedJobs();

    const facts = await eventsOf("fact");
    expect(facts).toHaveLength(1);
    expect(await authorAnswer(facts[0]!.id)).toBe("answered");
  });

  it("a decision an agent records through memory_ingest, and the fact that stores its text", async () => {
    const agentId = "agent_planner";
    const token = "wcap_" + "test_stamped_planner";
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath: SCOPE,
        permission: "write",
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    const { registerWillderTools } = await import("@/mcp/tools");
    const tools = new Map<
      string,
      (args: Record<string, unknown>, extra: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }>
    >();
    const server = { registerTool: (name: string, _config: unknown, handler: never) => void tools.set(name, handler) };
    registerWillderTools(
      server as never,
      { orgId: ORG, actor: { type: "agent", id: agentId, capabilityToken: token }, origin: "mcp" },
      { orgId: ORG, agentId, scopePath: SCOPE },
    );

    const reply = await tools.get("memory_ingest")!(
      {
        content: "Pin isDev to false in every production build.",
        name: "Inngest mode",
        scopePath: SCOPE,
        kind: "decision",
      },
      {},
    );
    expect(reply.isError, reply.content[0]?.text).not.toBe(true);
    await runQueuedJobs();

    const [rule] = await eventsOf("convention");
    const facts = await eventsOf("fact");
    expect(rule).toBeDefined();
    expect(facts).toHaveLength(1);
    expect(await authorAnswer(rule!.id)).toBe("answered");
    expect(await authorAnswer(facts[0]!.id)).toBe("answered");
  });
});
