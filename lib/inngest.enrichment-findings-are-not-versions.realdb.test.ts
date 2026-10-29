// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Research findings about a CRM record are not a version of the fact named after it.
//
// A person enriches a contact from the app; the enrichment job researches it and stores
// the findings in memory. Meanwhile an agent keeps the same contact up to date through
// contact_upsert, whose write is stored and announced as a version of the fact named
// after the contact. The contention rule (services/memory/conflict.ts) treats every
// stored row under that name as a version, so findings stored there were one more
// version, never announced and never read by the agent: when they landed inside the
// contention window before the agent's update, they superseded it, and memory_query
// stopped serving the update.
//
// Real: Postgres, the contact_upsert, memory_version and memory_query tool handlers,
// check() against live capabilities, the request-path store and announcement, the
// enrichment job (runEnrichment), the hybrid store and pgvector's SQL. Doubles: the
// research providers (one block of findings), the embedding service (one fixed vector)
// and the graph service (it accepts writes and holds an entity for every contact named in
// what it was sent). Not simulated: the queued Inngest run of either job.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import type { IngestInput } from "@/types/memory";

/** Ingest jobs queued by `after()`, in queue order. */
const queuedJobs = vi.hoisted(() => [] as (() => Promise<unknown>)[]);
/** Every content the graph service received. */
const graphContents = vi.hoisted(() => [] as string[]);
/** The contacts the test created; the graph holds an entity for each one named in what it was sent. */
const contactNames = vi.hoisted(() => [] as string[]);

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => Promise<unknown>) => {
    queuedJobs.push(task);
  },
}));
vi.mock("@/services/enrichment", () => ({
  enrich: async (target: { name: string }) => ({
    content: `${target.name} leads revenue at Acme and spoke at SaaStr 2026 about pipeline hygiene.`,
    results: [{ provider: "exa", ok: true }],
    hasFindings: true,
  }),
}));
vi.mock("@/services/memory/store", async () => {
  const { HybridMemoryStore } = await import("@/services/memory/hybrid-store");
  const { PgvectorMemoryStore } = await import("@/services/memory/pgvector-store");
  const nothing = async () => null;
  const graph = {
    ingest: async (input: IngestInput) => {
      graphContents.push(input.content);
      return { episodeId: `graph-episode-${graphContents.length}` };
    },
    ingestBulk: async (inputs: IngestInput[]) => {
      graphContents.push(...inputs.map((input) => input.content));
      return inputs.map((_, i) => `graph-episode-bulk-${graphContents.length}-${i}`);
    },
    retrieve: async () => ({ facts: [], storesRead: [{ store: "graph" }] }),
    entity: nothing,
    graph: async () => ({
      nodes: contactNames
        .filter((name) => graphContents.some((content) => content.includes(name)))
        .map((name) => ({ uuid: `entity-${name}`, name, type: "Person" })),
      edges: [],
    }),
    removeFact: async () => ({ removed: false }),
    removeEntity: async () => ({ removed: false }),
    transferEntity: async () => ({ transferred: 0 }),
    findFactById: nothing,
  };
  return { graphitiStore: graph, memory: new HybridMemoryStore(graph as never, new PgvectorMemoryStore()) };
});
vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
}));

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "enrichrace";
const ROOT = `org_${ORG}`;
const DIMENSIONS = 384;
const PAST_CONTENTION_WINDOW_MS = 1_100;
const PERSON = { id: "user_enrich_owner", name: "Owner" };

type ToolReply = { content: { type: "text"; text: string }[]; isError?: boolean };
type Tools = Map<string, (args: Record<string, unknown>) => Promise<ToolReply>>;

describe.skipIf(!QA_URL)("research findings about a contact are not a version of the contact's fact", () => {
  let db: PrismaClient;
  let registerWillderTools: (typeof import("@/mcp/tools"))["registerWillderTools"];
  let runEnrichment: (typeof import("@/lib/inngest/enrichment"))["runEnrichment"];

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

  /** One contact, as an agent keeps it up to date and a person enriches it. */
  function contactIn(agent: Tools, name: string) {
    let contactId = "";
    let revision = 0;
    let writes = 0;
    contactNames.push(name);
    async function upsert(fields: Record<string, unknown>): Promise<void> {
      const reply = await agent.get("contact_upsert")!({ idempotencyKey: `${name}-${(writes += 1)}`, ...fields });
      const match = /\[(\S+)\] .* · rev (\d+)/.exec(textOf(reply));
      if (!match) throw new Error(`contact_upsert failed: ${textOf(reply)}`);
      [contactId, revision] = [match[1]!, Number(match[2])];
      await runQueuedJobs();
    }
    return {
      name,
      create: () =>
        upsert({ name, email: `${name.toLowerCase().replaceAll(" ", ".")}@acme.test`, title: "Head of Sales" }),
      retitle: (title: string) => upsert({ contactId, baseRevision: revision, title }),
      enrich: () =>
        runEnrichment({
          orgId: ORG,
          target: { kind: "contact", name },
          recordId: contactId,
          actorId: PERSON.id,
          actorName: PERSON.name,
          origin: "app",
        }),
      /** The version the agent's write with `title` stored. */
      async versionTitled(title: string): Promise<string> {
        const rows = await db.$queryRaw<{ id: string }[]>`
          SELECT id FROM memory_chunks WHERE "orgId" = ${ORG} AND "entityName" = ${name} AND content LIKE ${`%(${title})%`}
        `;
        if (rows.length !== 1)
          throw new Error(`expected one version titled ${title} for ${name}, found ${rows.length}`);
        return rows[0]!.id;
      },
    };
  }
  async function statusOf(reader: Tools, versionId: string): Promise<string | null> {
    const reply = await reader.get("memory_version")!({ versionId });
    return /^\S+ \S+ \((current|superseded|retired)\)/m.exec(textOf(reply))?.[1] ?? null;
  }
  async function served(reader: Tools, query: string, text: string): Promise<boolean> {
    const answer = textOf(await reader.get("memory_query")!({ query, limit: 50 }));
    return answer.split("\n").some((line) => line.startsWith("•") && line.includes(text));
  }
  /** Whether the enrichment job stored findings about `name`, so the component under test was present. */
  const researched = (name: string) => graphContents.some((content) => content.startsWith(`${name} leads revenue`));

  beforeAll(async () => {
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    vi.stubEnv("INNGEST_BYPASS", "1");
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    vi.stubGlobal("fetch", vi.fn());
    ({ registerWillderTools } = await import("@/mcp/tools"));
    ({ runEnrichment } = await import("@/lib/inngest/enrichment"));
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
    graphContents.length = 0;
    contactNames.length = 0;
    await db.org.deleteMany({ where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.scope.create({ data: { orgId: ORG, path: ROOT, name: ROOT } });
  });

  it("keeps an agent's update current and served when a person's enrichment of the contact landed just before it", async () => {
    const [agent, reader] = [await toolsFor("crm-agent"), await toolsFor("reader")];
    const jane = contactIn(agent, "Jane Doe");
    await jane.create();
    await pastContentionWindow();

    const run = await jane.enrich();
    await jane.retitle("VP Sales");

    expect(run.ingested).toBe(true);
    expect(researched(jane.name)).toBe(true);
    expect(run.entityId).toBe("entity-Jane Doe");
    expect(await statusOf(reader, await jane.versionTitled("VP Sales"))).toBe("current");
    expect(await served(reader, "Jane Doe VP Sales", "(VP Sales)")).toBe(true);
    expect(await served(reader, "Jane Doe research", "Jane Doe leads revenue at Acme")).toBe(true);
  }, 30_000);

  it("loses no agent update in thirty enrichment races, whichever lands first", async () => {
    const [agent, reader] = [await toolsFor("crm-agent"), await toolsFor("reader")];
    const contacts = [];
    for (let race = 0; race < 30; race += 1) {
      const contact = contactIn(agent, `Contact ${race}`);
      await contact.create();
      contacts.push(contact);
    }
    await pastContentionWindow();

    const lost: string[] = [];
    for (const [race, contact] of contacts.entries()) {
      const researchFirst = race % 2 === 0;
      if (researchFirst) await contact.enrich();
      await contact.retitle("VP Sales");
      if (!researchFirst) await contact.enrich();

      if (!researched(contact.name)) throw new Error(`race ${race}: the enrichment job stored no findings`);
      if ((await statusOf(reader, await contact.versionTitled("VP Sales"))) !== "current") {
        lost.push(`race ${race} (${researchFirst ? "research first" : "update first"})`);
      }
    }

    console.log(
      `lost agent updates: ${lost.length} of 30 enrichment races${lost.length ? `: ${lost.join(", ")}` : ""}`,
    );
    expect(lost).toEqual([]);
  }, 180_000);
});
