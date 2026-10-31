// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test Postgres;
// without it every test here is skipped, not failed.
//
// Cleaning a killed measure run out of the demo scope by its tag, and nothing else.
//
// The demo scope holds what a killed concurrency run leaves: sixty facts (six
// writers, ten each, sent at once through memory_ingest with exactly the text and entity
// names a concurrency run writes) and one more in a run child scope, some of them read by a
// reader. Beside them is the scope's own content, including a note that quotes the run's tag
// and a fact named with the tag whose text lacks it. Around it: an underscore sibling of the
// demo scope that an unescaped LIKE would match, and another org's demo scope holding the
// same tag.
//
// Real: every row is written through the /api/mcp handler with live tokens and check(); the
// removal is the product's GuardedMemoryStore.removeFact under check(), against Postgres.
// Stood in: the embedding model (a deterministic double). Not simulated: the graph, whose
// episodes this cleanup reports and does not remove.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
/** The text a concurrency run writes for one writer's fact. */
const factText = (tag: string, agentId: string, i: number): string =>
  `${tag} writer ${agentId} fact ${i}: lane ${agentId} finished step ${i}`;
import { LOCAL_BASE_URL, localBrowserContext, localFetch } from "@/tests/support/local-routes.testsupport";
import {
  expectGraphRetiredAtChunkScope,
  stubGraphChunkRetirement,
} from "@/tests/support/memory-service-double.testsupport";
import { type McpCall, SecretVault, adminApiWith, mcpCallWith, mintToken } from "@/tests/support/live-api";
import type { AccessContext } from "@/services/access";
import type { DemoTarget, RunTagInventory } from "./run-tag-cleanup";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

// This suite moves one agent across sibling or parent and child scopes in one session, which
// the derived-write rule refuses by design; that rule is tested in mcp/derived-write.realdb.test.ts.
vi.mock("@/services/access/derived-writes", () => import("@/services/access/derived-writes.testsupport"));
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
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
const ORG = "runtagclean";
const OTHER_ORG = "runtagother";
const ROOT = `org_${ORG}`;
const DEMO = `${ROOT}.demo_ad8a10`;
const RUN_CHILD = `${DEMO}.ltconflict_202610052130`;
const LIKE_SIBLING = `${ROOT}.demoXad8a10.notes`;
const OTHER_DEMO = `org_${OTHER_ORG}.demo_ad8a10`;
const ADMIN = "u-admin-runtagclean";
const OTHER_ADMIN = "u-admin-runtagother";
const TAG = "ltload-20261005213000";
const WRITERS = ["writer-1", "writer-2", "writer-3", "writer-4", "writer-5", "writer-6"];

type Cleanup = typeof import("./run-tag-cleanup");

describe.skipIf(!QA_URL)("cleaning a killed measure run out of the demo scope by its tag", () => {
  let db: PrismaClient;
  let cleanup: Cleanup;
  let mcp: McpCall;
  /** A writer of the killed run, for a fact it stores after the dry run was reviewed. */
  let lateWriter: string;
  const vault = new SecretVault();
  const demo: DemoTarget = { orgId: ORG, scopePath: DEMO };
  /** Version ids of this run's tagged facts, as memory_ingest named them. */
  const tagged = new Set<string>();
  /** Version ids of everything else written, which must all survive. */
  const bystanders = new Set<string>();
  let dryRun: RunTagInventory;
  let retireGraph: Awaited<ReturnType<typeof stubGraphChunkRetirement>>;
  const admin = {
    orgId: ORG,
    actor: { type: "human", id: ADMIN, role: "admin" },
    origin: "script",
  } satisfies AccessContext;

  const asAdmin = (orgId: string, userId: string): AccessContext => ({
    orgId,
    actor: { type: "human", id: userId, role: "admin" },
    origin: "script",
  });

  async function write(token: string, content: string, name: string, scopePath: string): Promise<string> {
    const r = await mcp(token, "memory_ingest", { content, name, scopePath });
    const id = /Version: (\S+?)\./.exec(r.text)?.[1];
    if (!r.ok || !id) throw new Error(`memory_ingest did not store "${name}": ${r.text}`);
    return id;
  }

  /** Every memory table a removal touches, counted. */
  async function memorySnapshot(): Promise<Record<string, number>> {
    const [chunks, events, reads, edges] = await Promise.all([
      db.memoryChunk.count(),
      db.changeEvent.count(),
      db.factVersionRead.count(),
      db.factEdge.count(),
    ]);
    return { chunks, events, reads, edges };
  }

  async function reset(): Promise<void> {
    for (const org of [ORG, OTHER_ORG]) {
      await db.auditLog.deleteMany({ where: { orgId: org } });
      await db.changeEvent.deleteMany({ where: { orgId: org } });
      await db.capability.deleteMany({ where: { orgId: org } });
      await db.$executeRawUnsafe(`DELETE FROM memory_chunks WHERE "orgId" = $1`, org);
      await db.factEdge.deleteMany({ where: { orgId: org } });
      await db.grant.deleteMany({ where: { orgId: org } });
      await db.scope.deleteMany({ where: { orgId: org } });
      await db.user.deleteMany({ where: { orgId: org } });
      await deleteOrgsWithRetry(db, { where: { id: org } });
    }
  }

  async function seedOrg(org: string, admin: string, scopes: string[]): Promise<void> {
    await db.org.create({ data: { id: org, name: org } });
    await db.user.create({
      data: {
        id: admin,
        orgId: org,
        email: `admin@${org}.test`,
        role: "admin",
        clerkId: `clerk-${org}`,
        name: "Ada Admin",
      },
    });
    const root = await db.scope.create({ data: { orgId: org, path: `org_${org}`, name: "root" } });
    for (const path of scopes) await db.scope.create({ data: { orgId: org, path, name: path.split(".").pop()! } });
    await db.grant.create({
      data: { orgId: org, scopeId: root.id, granteeType: "user", granteeId: admin, permission: "admin" },
    });
  }

  async function signInAs(org: string, admin: string): Promise<void> {
    const { requireAccessContext } = (await import("@/lib/access-context")) as never as {
      requireAccessContext: ReturnType<typeof vi.fn>;
    };
    requireAccessContext.mockResolvedValue({
      org: await db.org.findUnique({ where: { id: org } }),
      user: await db.user.findUnique({ where: { id: admin } }),
      ctx: { orgId: org, actor: { type: "human", id: admin, role: "admin" } },
    });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    vi.stubEnv("INNGEST_BYPASS", "1");
    delete process.env.GRAPHITI_SERVICE_URL;
    retireGraph = await stubGraphChunkRetirement();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    await reset();
    await seedOrg(ORG, ADMIN, [DEMO, RUN_CHILD, `${ROOT}.demoXad8a10`, LIKE_SIBLING]);
    await seedOrg(OTHER_ORG, OTHER_ADMIN, [OTHER_DEMO]);

    const fetchImpl = await localFetch();
    vi.stubGlobal("fetch", fetchImpl);
    mcp = mcpCallWith(LOCAL_BASE_URL, fetchImpl);
    const api = adminApiWith(localBrowserContext(fetchImpl), LOCAL_BASE_URL);
    const token = async (agentId: string, scopePath: string, permission: "read" | "write" = "write") =>
      (await mintToken(api, vault, { agentId, scopePath, permission })).raw;

    await signInAs(ORG, ADMIN);
    // The demo scope's own content, written before the run.
    const curator = await token("demo-curator", DEMO);
    bystanders.add(await write(curator, "Acme Corp's renewal is due on 2027-03-31.", "Acme Corp", DEMO));
    bystanders.add(
      await write(curator, `The ${TAG} run was killed at 21:40; its facts are probe litter.`, "Measure notes", DEMO),
    );
    bystanders.add(await write(curator, "Lane writer-1 owns the Monday release.", `${TAG}-writer-1-handbook`, DEMO));

    // The killed run: six writers, ten facts each, all in flight at once.
    const writerTokens = await Promise.all(WRITERS.map((w) => token(w, DEMO)));
    lateWriter = writerTokens[1]!;
    const ids = await Promise.all(
      writerTokens.flatMap((t, w) =>
        Array.from({ length: 10 }, (_, i) => write(t, factText(TAG, WRITERS[w]!, i), `${TAG}-${WRITERS[w]}`, DEMO)),
      ),
    );
    ids.forEach((id) => tagged.add(id));
    // Its latency marker, written into a run child scope the way measure-all's suites write.
    tagged.add(await write(writerTokens[0]!, `${TAG} latency writer-1 round 0`, `${TAG}-lat-writer-1`, RUN_CHILD));
    // A reader saw some of them, so removing them also removes those reads.
    const reader = await token("feed-reader", DEMO, "read");
    const query = await mcp(reader, "memory_query", {
      query: `${TAG} writer writer-2 fact`,
      limit: 20,
      scopePath: DEMO,
    });
    expect(query.ok).toBe(true);

    // The same tag where it must never be touched: an underscore sibling, and another org.
    bystanders.add(
      await write(
        await token("sibling-writer", LIKE_SIBLING),
        factText(TAG, "writer-1", 0),
        `${TAG}-writer-1`,
        LIKE_SIBLING,
      ),
    );
    await signInAs(OTHER_ORG, OTHER_ADMIN);
    bystanders.add(
      await write(await token("writer-1", OTHER_DEMO), factText(TAG, "writer-1", 0), `${TAG}-writer-1`, OTHER_DEMO),
    );
    await signInAs(ORG, ADMIN);

    cleanup = await import("./run-tag-cleanup");
  }, 120_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (db) {
      await reset();
      await db.$disconnect();
    }
  });

  it("the dry run lists exactly the run's tagged facts, with counts per table, and changes no memory", async () => {
    const before = await memorySnapshot();
    const auditBefore = new Set(
      (await db.auditLog.findMany({ where: { orgId: ORG }, select: { id: true } })).map((r) => r.id),
    );
    dryRun = await cleanup.inventoryRunTag(admin, { orgId: ORG, scopePath: DEMO, tag: TAG }, demo);
    expect(new Set(dryRun.facts.map((f) => f.id))).toEqual(tagged);
    expect(dryRun.facts.filter((f) => f.scopePath === RUN_CHILD)).toHaveLength(1);
    expect(dryRun.removedWithFacts.memoryChunks).toBe(61);
    expect(dryRun.removedWithFacts.embeddings).toBe(61);
    expect(dryRun.removedWithFacts.factVersionReads).toBeGreaterThan(0);
    expect(dryRun.kept.changeEvents).toBe(61);
    expect(dryRun.graph).toBe(cleanup.GRAPH_REMOVAL);
    // A run whose tag is this one's first twelve digits names none of these facts, though their text contains it.
    expect(
      (await cleanup.inventoryRunTag(admin, { orgId: ORG, scopePath: DEMO, tag: "ltload-202610052130" }, demo)).facts,
    ).toEqual([]);
    expect(await memorySnapshot()).toEqual(before);
    // The only rows it adds are the audit log's record of its two authorized reads.
    const added = (await db.auditLog.findMany({ where: { orgId: ORG } })).filter((r) => !auditBefore.has(r.id));
    expect(added.map((r) => [r.action, r.decision, r.actorId])).toEqual([
      ["memory.read", "allow", ADMIN],
      ["memory.read", "allow", ADMIN],
    ]);
  });

  it("refuses another org, any scope but the demo scope, and anything that is not one run's tag, before reading", async () => {
    const refusals = [
      { orgId: OTHER_ORG, scopePath: DEMO, tag: TAG },
      { orgId: ORG, scopePath: ROOT, tag: TAG },
      { orgId: ORG, scopePath: RUN_CHILD, tag: TAG },
      { orgId: ORG, scopePath: LIKE_SIBLING, tag: TAG },
      { orgId: ORG, scopePath: DEMO, tag: "ltload" },
      { orgId: ORG, scopePath: DEMO, tag: "ltload-%" },
      { orgId: ORG, scopePath: DEMO, tag: "" },
    ];
    for (const request of refusals) {
      await expect(cleanup.inventoryRunTag(admin, request, demo), JSON.stringify(request)).rejects.toThrow(
        cleanup.CleanupRefusedError,
      );
    }
    expect(() => cleanup.demoTargetFrom({ DEMO_ORG_ID: ORG, DEMO_SCOPE_PATH: ROOT })).toThrow(
      cleanup.CleanupRefusedError,
    );
    expect(() => cleanup.demoTargetFrom({ DEMO_ORG_ID: ORG, DEMO_SCOPE_PATH: OTHER_DEMO })).toThrow(
      cleanup.CleanupRefusedError,
    );
    expect(cleanup.demoTargetFrom({ DEMO_ORG_ID: ORG, DEMO_SCOPE_PATH: DEMO })).toEqual(demo);
    // A removal acted out as another org's admin is refused before anything is removed.
    await expect(cleanup.removeRunTag(asAdmin(OTHER_ORG, OTHER_ADMIN), dryRun, demo)).rejects.toThrow(
      cleanup.CleanupRefusedError,
    );
    expect(await db.memoryChunk.count({ where: { id: { in: [...tagged] } } })).toBe(tagged.size);
  });

  it("removes only reviewed facts that are still the run's, with their derived rows, through the product's delete", async () => {
    // Between review and removal the list gains a fact of the scope's own, and the run stores one more.
    const stranger = [...bystanders][0]!;
    const reviewed: RunTagInventory = {
      ...dryRun,
      facts: [...dryRun.facts, { id: stranger, scopePath: DEMO, entityName: "edited in", createdAt: "" }],
    };
    const late = await write(lateWriter, factText(TAG, "writer-2", 99), `${TAG}-writer-2`, DEMO);
    const auditBefore = await db.auditLog.count();

    const removal = await cleanup.removeRunTag(admin, reviewed, demo);

    expect(new Set(removal.removed)).toEqual(tagged);
    expect(removal).toMatchObject({ skipped: [stranger], alreadyGone: [], remaining: 1 });
    // Counted after the removal: each removed fact keeps its `create` event and gains a `delete`.
    expect(removal.kept).toEqual({ changeEvents: 2 * tagged.size, factEdges: 0 });
    expect(await db.memoryChunk.count({ where: { id: { in: [...tagged] } } })).toBe(0);
    expect(await db.factVersionRead.count({ where: { versionId: { in: [...tagged] } } })).toBe(0);
    expect(await db.memoryChunk.count({ where: { id: { in: [...bystanders, late] } } })).toBe(bystanders.size + 1);
    // One authorized `delete` event per fact, at the fact's own scope, and the audit log only grew.
    const deletes = await db.changeEvent.findMany({
      where: { orgId: ORG, op: "delete", recordId: { in: [...tagged] } },
    });
    expect(deletes).toHaveLength(tagged.size);
    expect(deletes.every((e) => e.actorId === ADMIN && e.authorizedById !== null)).toBe(true);
    expect(deletes.find((e) => e.scopePath === RUN_CHILD)).toBeDefined();
    // Each fact's graph facts were retired at that fact's own scope, the run child's included.
    expectGraphRetiredAtChunkScope(retireGraph, deletes);
    expect(await db.auditLog.count()).toBeGreaterThan(auditBefore);
    // What is left of the run is the fact nobody reviewed, for the next dry run to list.
    expect(
      (await cleanup.inventoryRunTag(admin, { orgId: ORG, scopePath: DEMO, tag: TAG }, demo)).facts.map((f) => f.id),
    ).toEqual([late]);
  });
});
