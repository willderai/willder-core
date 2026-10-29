// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A person erasure removes what was written in place of a version it removes
// (services/memory/erasure-lineage.ts): a person's correction of a fact about them, a chain of
// corrections, an update based on their version, and everything each left behind on the read
// paths: its row, its graph copy, its change-feed text, the briefs that cite it, and a copy a
// restored backup puts back. A conflict's winner, stored before the version it beat, stays; so
// does every other org and every unrelated version.
//
// Real: Postgres, the PATCH and brief-correction routes and check(), ingestMemory with its
// queued job (run through `after()`), the entity resolver's alias registry, the pgvector store,
// the change feed, the task-start read, the Timeline detail route, the person erasure and
// reapplyErasures. Doubles: the signed-in session, the graph store (a spy that records what it
// is asked to remove, and can fail or let a write land mid-erasure), the model, the embedding
// service and the contradiction search behind a brief correction.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import { briefCorrectionName } from "@/services/memory/correction-names";

/** Work queued by `after()`, in queue order. */
const queuedJobs = vi.hoisted(() => [] as (() => Promise<unknown>)[]);
const session = vi.hoisted(() => ({ current: null as unknown }));
const brief = vi.hoisted(() => ({
  contradiction: null as null | { uuid: string; fact: string; actorType: "agent" | "human" },
}));
/** The graph store: what it was asked to remove, and hooks that fail a call or run a write while it is made. */
const graph = vi.hoisted(() => {
  const calls = {
    /** Graph writes: one per episode an ingest wrote. */
    ingested: 0,
    removeChunkFacts: [] as { groupId: string; chunkId: string }[],
    erasePerson: [] as { orgId: string; emails: string[]; names: string[]; entityIds: string[] }[],
  };
  const hooks = {
    /** How many more removeChunkFacts calls fail. */
    failChunkRemovals: 0,
    /** Run once, inside the next removeChunkFacts call whose chunk id matches. */
    duringChunkRemoval: null as null | { chunkId: string; run: () => Promise<void> },
  };
  let episodes = 0;
  /** Graph facts by uuid: a fact the extraction wrote, which has no chunk row. */
  const facts = new Map<string, string>();
  const store = {
    ingest: async () => {
      calls.ingested += 1;
      return { episodeId: `graph-episode-${(episodes += 1)}` };
    },
    ingestBulk: async (inputs: unknown[]) => {
      calls.ingested += inputs.length;
      return inputs.map(() => `graph-episode-${(episodes += 1)}`);
    },
    removeFact: async ({ factId }: { factId: string }) => ({ removed: facts.delete(factId) }),
    removeChunkFacts: async (input: { groupId: string; chunkId: string }) => {
      if (hooks.failChunkRemovals > 0) {
        hooks.failChunkRemovals -= 1;
        const { MemoryServiceError } = await import("@/services/memory/graphiti-store");
        throw new MemoryServiceError("memory service unavailable", 503);
      }
      calls.removeChunkFacts.push(input);
      const hook = hooks.duringChunkRemoval;
      if (hook && hook.chunkId === input.chunkId) {
        hooks.duringChunkRemoval = null;
        await hook.run();
      }
    },
    removeEpisode: async () => ({ removed: true }),
    findFactById: async ({ factId }: { factId: string }) => {
      const fact = facts.get(factId);
      return fact === undefined ? null : { uuid: factId, fact, invalidAt: null };
    },
    planPersonErasure: async () => [],
    erasePerson: async (input: { orgId: string; emails: string[]; names: string[]; entityIds: string[] }) => {
      calls.erasePerson.push(input);
      return { episodes: 0, nodes: 0, edges: 0, summaries: 0, episodeIds: [] };
    },
    retrieve: async () => ({ facts: [], storesRead: [{ store: "graph" }] }),
    dedupeNodes: async () => 0,
  };
  return {
    calls,
    hooks,
    store,
    facts,
    reset() {
      facts.clear();
      calls.ingested = 0;
      calls.removeChunkFacts.length = 0;
      calls.erasePerson.length = 0;
      hooks.failChunkRemovals = 0;
      hooks.duringChunkRemoval = null;
    },
  };
});

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
  return { graphitiStore: graph.store, memory: new HybridMemoryStore(graph.store as never, new PgvectorMemoryStore()) };
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
vi.mock("@/services/facts/conflicts", () => ({
  findContradiction: async () => ({
    contradiction: brief.contradiction && { ...brief.contradiction, note: "contradicts" },
    complete: true,
  }),
}));
vi.mock("@/services/guardrails", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/guardrails")>()),
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
}));

const QA_URL = process.env.QA_DATABASE_URL;
const DIMENSIONS = 384;
const ORG = "eraselineage";
const ROOT = `org_${ORG}`;
const DEAL = `${ROOT}.deal_a`;
/** A sibling of DEAL that DEAL's readers cannot read. */
const OTHER_DEAL = `${ROOT}.deal_b`;
const ADMIN = "u-eraselineage-admin";
/** Holds `admin` on DEAL alone, not on the org root. */
const DEAL_MANAGER = "u-eraselineage-dealmgr";
const WRITER = "u-eraselineage-writer";
/** Another org with the same scopes and the same person. */
const OTHER = "eraselineage2";
const OTHER_ADMIN = "u-eraselineage2-admin";
const OTHER_WRITER = "u-eraselineage2-writer";
const DANA = { name: "Dana Whitfield", email: "dana@acme.test" };
/** Everything that would show the erased person, or the corrections written about her. */
const LEAKS = /Dana|Whitfield|dana@|Denver|Austin|support lead|night desk/i;

describe.skipIf(!QA_URL)("a person erasure removes what was written in place of what it removes", () => {
  let db: PrismaClient;
  let ingestMemory: (typeof import("@/lib/inngest"))["ingestMemory"];
  let factRoute: typeof import("@/app/api/memory/facts/[id]/route");
  let versionRoute: (typeof import("@/app/api/memory/versions/[id]/route"))["GET"];
  let timelineChange: (typeof import("@/app/api/audit/timeline/[changeId]/route"))["GET"];
  let correctBrief: (typeof import("@/app/api/briefs/[id]/correct/route"))["POST"];
  let readChanges: (typeof import("@/services/memory/change-feed"))["readChanges"];
  let readServableTaskStart: (typeof import("@/services/memory/task-start"))["readServableTaskStart"];
  let erasePerson: (typeof import("@/services/memory/person-erasure"))["erasePerson"];
  let reapplyErasures: (typeof import("@/services/memory/erasure-reapply"))["reapplyErasures"];
  let lineage: typeof import("@/services/memory/erasure-lineage");
  let PgvectorMemoryStore: (typeof import("@/services/memory/pgvector-store"))["PgvectorMemoryStore"];

  const person = (orgId: string, id: string, role: "admin" | "member") => ({
    org: { id: orgId, name: orgId },
    user: { id, name: id },
    ctx: { orgId, actor: { type: "human", id, role }, origin: "app" } as AccessContext,
  });
  const as = (orgId: string, id: string, role: "admin" | "member" = "member") => {
    session.current = person(orgId, id, role);
  };
  const admin = (orgId = ORG) => person(orgId, orgId === ORG ? ADMIN : OTHER_ADMIN, "admin").ctx;

  async function runQueuedJobs(): Promise<void> {
    while (queuedJobs.length > 0) await queuedJobs.shift()!();
  }

  /** One agent's write of `name`, stored and announced on the request path. */
  async function agentWrites(
    agentId: string,
    name: string,
    content: string,
    scopePath = DEAL,
    orgId = ORG,
    baseVersion?: string,
  ): Promise<string> {
    const ack = await ingestMemory({
      groupId: orgId,
      content,
      name,
      scopePath,
      actorType: "agent",
      actorId: agentId,
      actorName: agentId,
      source: "mcp",
      origin: "mcp",
      baseVersion,
    });
    await runQueuedJobs();
    return ack.versionId!;
  }

  /** PATCH /api/memory/facts/:id as `writer`, at `scope`, with the queued correction run. */
  async function patch(
    factId: string,
    fact: string,
    { scope = DEAL, orgId = ORG, writer = WRITER } = {},
  ): Promise<number> {
    as(orgId, writer);
    const res = await factRoute.PATCH(
      new Request(`http://t/api/memory/facts/${factId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fact, scope }),
      }),
      { params: Promise.resolve({ id: factId }) },
    );
    await runQueuedJobs();
    return res.status;
  }

  /** POST /api/briefs/:id/correct as the writer, overruling `overruled`, on a fresh handoff brief in the deal. */
  async function correctBriefOverruling(
    overruled: string,
    correction: string,
  ): Promise<{ briefId: string; status: number }> {
    const briefId = (
      await db.brief.create({
        data: { orgId: ORG, type: "handoff", scopePath: DEAL, title: "Handoff", summary: "x", sections: [] },
      })
    ).id;
    brief.contradiction = { uuid: overruled, fact: "contradicted", actorType: "agent" };
    as(ORG, WRITER);
    const res = await correctBrief(
      new Request(`http://t/api/briefs/${briefId}/correct`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ correction }),
      }),
      { params: Promise.resolve({ id: briefId }) },
    );
    await runQueuedJobs();
    return { briefId, status: res.status };
  }

  /** The stored version holding `content`, or null when none does. */
  async function versionOf(content: string, orgId = ORG): Promise<string | null> {
    return (await db.memoryChunk.findFirst({ where: { orgId, content }, select: { id: true } }))?.id ?? null;
  }

  async function danaIn(orgId = ORG): Promise<void> {
    await db.contact.create({
      data: {
        id: `dana-${orgId}`,
        orgId,
        name: DANA.name,
        email: DANA.email,
        createdAt: new Date(Date.now() - 86_400_000),
      },
    });
  }

  async function eraseDana(orgId = ORG) {
    return erasePerson(admin(orgId), { contactId: `dana-${orgId}` });
  }

  /** What memory_query's vector leg serves in `scope`. */
  async function served(scope = DEAL, orgId = ORG): Promise<string[]> {
    const { facts } = await new PgvectorMemoryStore().retrieve({
      groupId: orgId,
      tenantId: orgId,
      query: "where",
      limit: 50,
      scopePath: scope,
    });
    return facts.map((f) => f.fact).sort();
  }

  /** Every fact change-feed summary in `orgId`, as stored. */
  async function feedText(orgId = ORG): Promise<string> {
    const events = await db.changeEvent.findMany({ where: { orgId }, select: { summary: true } });
    return events.map((e) => e.summary).join("\n");
  }

  async function version(id: string): Promise<number> {
    as(ORG, ADMIN, "admin");
    return (await versionRoute(new Request(`http://t/api/memory/versions/${id}`), { params: Promise.resolve({ id }) }))
      .status;
  }

  async function agentReading(orgId: string, agentId: string, scope: string): Promise<AccessContext> {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath: scope,
        permission: "read",
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    return { orgId, actor: { type: "agent", id: agentId, capabilityToken: token }, origin: "mcp" };
  }

  /** Every read path an agent of the deal has to the org's memory and its changes, as text. */
  async function everyRead(scope = DEAL): Promise<string> {
    const reader = await agentReading(ORG, `agent-reader-${Math.random().toString(36).slice(2)}`, scope);
    const changes = await readChanges(reader, scope, { limit: 200 });
    const start = await readServableTaskStart(reader, scope, "where is she based", "", () => []);
    return JSON.stringify({ served: await served(scope), changes, start });
  }

  async function erasedRow(): Promise<{
    stores: Record<string, Record<string, number>>;
    earlierRequestIds?: string[];
  }> {
    const rows = await db.auditLog.findMany({ where: { orgId: ORG, action: "person.erased" } });
    expect(rows).toHaveLength(1);
    return rows[0]!.metadata as never;
  }

  async function wipe(): Promise<void> {
    for (const orgId of [ORG, OTHER]) {
      await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${orgId}`;
      await db.changeEvent.deleteMany({ where: { orgId } });
      await db.factEdge.deleteMany({ where: { orgId } });
      await db.erasureSuppression.deleteMany({ where: { orgId } });
      await db.entityAlias.deleteMany({ where: { orgId } });
      await db.auditLog.deleteMany({ where: { orgId } });
      await db.org.deleteMany({ where: { id: orgId } });
    }
    await db.user.deleteMany({ where: { id: { in: [ADMIN, DEAL_MANAGER, WRITER, OTHER_ADMIN, OTHER_WRITER] } } });
  }

  beforeAll(async () => {
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    vi.stubEnv("INNGEST_BYPASS", "1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ embedding: new Array(DIMENSIONS).fill(0.01) }))),
    );
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL! }) });
    ({ ingestMemory } = await import("@/lib/inngest"));
    factRoute = await import("@/app/api/memory/facts/[id]/route");
    ({ GET: versionRoute } = await import("@/app/api/memory/versions/[id]/route"));
    ({ GET: timelineChange } = await import("@/app/api/audit/timeline/[changeId]/route"));
    ({ POST: correctBrief } = await import("@/app/api/briefs/[id]/correct/route"));
    ({ readChanges } = await import("@/services/memory/change-feed"));
    ({ readServableTaskStart } = await import("@/services/memory/task-start"));
    ({ erasePerson } = await import("@/services/memory/person-erasure"));
    ({ reapplyErasures } = await import("@/services/memory/erasure-reapply"));
    lineage = await import("@/services/memory/erasure-lineage");
    ({ PgvectorMemoryStore } = await import("@/services/memory/pgvector-store"));
  }, 60_000);

  afterAll(async () => {
    if (db) {
      await wipe();
      await db.$disconnect();
    }
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  beforeEach(async () => {
    queuedJobs.length = 0;
    brief.contradiction = null;
    graph.reset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    await wipe();
    for (const [orgId, adminId, writerId] of [
      [ORG, ADMIN, WRITER],
      [OTHER, OTHER_ADMIN, OTHER_WRITER],
    ] as const) {
      await db.org.create({ data: { id: orgId, name: orgId } });
      const root = await db.scope.create({ data: { orgId, path: `org_${orgId}`, name: "root" } });
      const deal = await db.scope.create({ data: { orgId, path: `org_${orgId}.deal_a`, name: "deal_a" } });
      const otherDeal = await db.scope.create({ data: { orgId, path: `org_${orgId}.deal_b`, name: "deal_b" } });
      await db.user.create({
        data: { id: adminId, orgId, email: `${adminId}@erase.test`, role: "admin", clerkId: `clerk-${adminId}` },
      });
      await db.grant.create({
        data: { orgId, scopeId: root.id, granteeType: "user", granteeId: adminId, permission: "admin" },
      });
      await db.user.create({
        data: { id: writerId, orgId, email: `${writerId}@erase.test`, role: "member", clerkId: `clerk-${writerId}` },
      });
      for (const scope of [deal, otherDeal]) {
        await db.grant.create({
          data: { orgId, scopeId: scope.id, granteeType: "user", granteeId: writerId, permission: "write" },
        });
      }
      if (orgId === ORG) {
        await db.user.create({
          data: { id: DEAL_MANAGER, orgId, email: "dealmgr@erase.test", role: "member", clerkId: "clerk-dealmgr" },
        });
        await db.grant.create({
          data: { orgId, scopeId: deal.id, granteeType: "user", granteeId: DEAL_MANAGER, permission: "admin" },
        });
      }
    }
  });

  describe("a correction of a fact about her", () => {
    it("PATCH: a correction of a fact filed under her, whose text never names her, goes with her from every read path", async () => {
      await danaIn();
      const original = await agentWrites("agent-ops", DANA.name, "Based in Boston.");
      expect(await patch(original, "Based in Denver.")).toBe(202);
      const corrected = (await versionOf("Based in Denver."))!;
      const correctedName = (
        await db.memoryChunk.findUniqueOrThrow({ where: { id: corrected }, select: { entityName: true } })
      ).entityName!;
      // The removal names what it corrected, which is how the erasure finds the correction
      // once the fact itself is gone.
      expect(
        (await db.changeEvent.findFirstOrThrow({ where: { orgId: ORG, op: "supersede", recordId: original } })).summary,
      ).toBe(`corrected: ${DANA.name}`);
      // Positive control: the correction is served before the erasure.
      expect(await served()).toEqual(["Based in Denver."]);
      expect(await everyRead()).toMatch(/Denver/);
      graph.reset();

      const result = await eraseDana();

      expect(await db.memoryChunk.count({ where: { orgId: ORG } })).toBe(0);
      expect(await everyRead()).not.toMatch(LEAKS);
      expect(await feedText()).not.toMatch(LEAKS);
      expect(await version(corrected)).toBe(404);
      // Its graph copy: the episodes stamped with its row, and those filed under its own name.
      expect(graph.calls.removeChunkFacts).toEqual([{ groupId: DEAL, chunkId: corrected }]);
      expect(graph.calls.erasePerson.map((c) => c.names)).toContainEqual([correctedName]);
      expect(result.replacementsRemoved).toBe(1);
      expect((await erasedRow()).stores.lineage).toEqual({ replacements: 1, announced: 0 });
      // Three summaries, each blanked once: the fact's create and the removal that named her,
      // and the correction's create.
      expect(result.changeSummariesScrubbed).toBe(3);
    });

    it("PATCH: a correction that took her name out of a fact goes too, since it was written in place of a version that named her", async () => {
      await danaIn();
      const original = await agentWrites("agent-ops", "Escalations", `Escalations go to ${DANA.name}.`);
      await patch(original, "Escalations go to the support lead.");
      expect(await served()).toEqual(["Escalations go to the support lead."]);

      await eraseDana();

      // The rule errs toward erasure: the org re-enters this fact.
      expect(await served()).toEqual([]);
      expect(await feedText()).not.toMatch(LEAKS);
    });

    it("brief correction: a correction that overruled a fact filed under her goes, graph copy and all", async () => {
      await danaIn();
      const original = await agentWrites("agent-ops", DANA.name, "Based in Boston.");
      const { briefId, status } = await correctBriefOverruling(original, "Based in Austin.");
      expect(status).toBe(200);
      const corrected = (await versionOf("Based in Austin."))!;
      expect(await served()).toEqual(["Based in Austin."]);

      await eraseDana();

      expect(await served()).toEqual([]);
      expect(await feedText()).not.toMatch(LEAKS);
      expect(await version(corrected)).toBe(404);
      expect(graph.calls.erasePerson.map((c) => c.names)).toContainEqual([
        briefCorrectionName(briefId, WRITER, original),
      ]);
    });

    it("PATCH at a broader scope than the fact, which records no edge: the correction goes, found by the authorization it shares with its removal", async () => {
      await danaIn();
      const original = await agentWrites("agent-ops", DANA.name, "Based in Boston.");
      expect(await patch(original, "Based in Denver.", { scope: ROOT, writer: ADMIN })).toBe(202);
      const corrected = (await versionOf("Based in Denver."))!;
      expect(await db.memoryChunk.findUniqueOrThrow({ where: { id: corrected }, select: { scopePath: true } })).toEqual(
        { scopePath: ROOT },
      );
      expect(await db.factEdge.count({ where: { orgId: ORG } })).toBe(0);

      const result = await eraseDana();

      expect(await served(ROOT)).toEqual([]);
      expect(await feedText()).not.toMatch(LEAKS);
      expect(result.replacementsRemoved).toBe(1);
    });

    it("a chain of two corrections: both go", async () => {
      await danaIn();
      const original = await agentWrites("agent-ops", DANA.name, "Based in Boston.");
      await patch(original, "Based in Austin.");
      const first = (await versionOf("Based in Austin."))!;
      await patch(first, "Based in Denver.");
      expect(await served()).toEqual(["Based in Denver."]);
      // A correction is filed under its own name, which says nothing of what it was about.
      expect(
        (await db.changeEvent.findFirstOrThrow({ where: { orgId: ORG, op: "supersede", recordId: first } })).summary,
      ).toBe("corrected");

      const result = await eraseDana();

      expect(await db.memoryChunk.count({ where: { orgId: ORG } })).toBe(0);
      expect(await feedText()).not.toMatch(LEAKS);
      expect(result.replacementsRemoved).toBe(2);
      // A second request finds nothing left.
      const again = await erasePerson(admin(), { email: DANA.email });
      expect(again.replacementsRemoved).toBe(0);
    });

    it("a correction whose text names her by an alias the resolver rewrote leaves no summary with the alias", async () => {
      // Follow-up 4: a change event keeps the text as written, so it named the person by
      // "Mike" while the stored row, resolved, named Michael Brown.
      const contact = await db.contact.create({
        data: {
          id: "mike",
          orgId: ORG,
          name: "Michael Brown",
          email: "michael@acme.test",
          createdAt: new Date(Date.now() - 86_400_000),
        },
      });
      await db.entityAlias.create({
        data: {
          orgId: ORG,
          entityId: contact.id,
          entityType: "contact",
          canonicalName: "Michael Brown",
          aliases: ["Mike"],
        },
      });
      const original = await agentWrites("agent-ops", "Escalations", "Escalations go to the on-call engineer.");
      await patch(original, "Escalations go to Mike.");
      expect(await feedText()).toMatch(/Mike/);

      await erasePerson(admin(), { contactId: "mike" });

      expect(await served()).toEqual([]);
      expect(await feedText()).not.toMatch(/Mike|Michael|Brown/);
    });

    it("a brief built from a replacement goes with it", async () => {
      await danaIn();
      const original = await agentWrites("agent-ops", DANA.name, "Based in Boston.");
      await patch(original, "Based in Denver.");
      const corrected = (await versionOf("Based in Denver."))!;
      await db.brief.create({
        data: {
          id: "b-cites-correction",
          orgId: ORG,
          type: "handoff",
          scopePath: DEAL,
          title: "Travel",
          summary: "Where the team is.",
          sections: [{ heading: "Office", content: "The account lead works from the west office." }],
          citations: { create: [{ sectionIndex: 0, factId: corrected, factText: "Based in Denver." }] },
        },
      });
      await db.brief.create({
        data: {
          id: "b-unrelated",
          orgId: ORG,
          type: "handoff",
          scopePath: DEAL,
          title: "Pricing",
          summary: "Annual plan.",
          sections: [],
        },
      });

      const result = await eraseDana();

      expect((await db.brief.findMany({ where: { orgId: ORG }, select: { id: true } })).map((b) => b.id)).toEqual([
        "b-unrelated",
      ]);
      expect(result.briefsRemoved).toBe(1);
    });
  });

  describe("a correction of a graph fact, a late job, a brief's own correction", () => {
    it("PATCH of a graph fact about her, which has no row: the removal names the fact's text, and the correction goes", async () => {
      await danaIn();
      graph.facts.set("graph-fact-1", `${DANA.name} is based in Boston.`);
      expect(await patch("graph-fact-1", "Based in Denver.")).toBe(202);
      expect(
        (await db.changeEvent.findFirstOrThrow({ where: { orgId: ORG, op: "supersede", recordId: "graph-fact-1" } }))
          .summary,
      ).toBe(`corrected fact: ${DANA.name} is based in Boston.`);
      expect(await served()).toEqual(["Based in Denver."]);

      const result = await eraseDana();

      expect(await served()).toEqual([]);
      expect(await feedText()).not.toMatch(LEAKS);
      expect(result.replacementsRemoved).toBe(1);
    });

    it("a brief correction overruling a graph fact about her goes", async () => {
      await danaIn();
      graph.facts.set("graph-fact-2", `${DANA.name} is based in Boston.`);
      expect((await correctBriefOverruling("graph-fact-2", "Based in Austin.")).status).toBe(200);
      expect(await served()).toEqual(["Based in Austin."]);

      await eraseDana();

      expect(await served()).toEqual([]);
      expect(await feedText()).not.toMatch(LEAKS);
    });

    it("a correction that named her in a fact about something else blanks only its own text", async () => {
      await danaIn();
      const original = await agentWrites("agent-ops", "Escalations", "Escalations go to the on-call engineer.");
      await patch(original, `Escalations go to ${DANA.name}.`);
      // Its removal as it was announced before 2026-10-13: the corrected text.
      await db.changeEvent.updateMany({
        where: { orgId: ORG, op: "supersede", recordId: original },
        data: { summary: `Escalations go to ${DANA.name}.` },
      });

      await eraseDana();

      expect(await served()).toEqual([]);
      // The fact it corrected was not about her: its own announcement keeps its text.
      expect(await feedText()).toMatch(/on-call engineer/);
      expect(await feedText()).not.toMatch(/Dana|Whitfield/);
    });

    it("a correction of a graph fact about someone else stays", async () => {
      await danaIn();
      graph.facts.set("graph-fact-4", "Kenji Sato is based in Boston.");
      await patch("graph-fact-4", "Kenji Sato is based in Denver.");

      await eraseDana();

      expect(await served()).toEqual(["Kenji Sato is based in Denver."]);
    });

    it("a correction whose queued job runs after the erasure finished is withdrawn", async () => {
      await danaIn();
      const original = await agentWrites("agent-ops", DANA.name, "Based in Boston.");
      as(ORG, WRITER);
      await factRoute.PATCH(
        new Request(`http://t/api/memory/facts/${original}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ fact: "Based in Denver.", scope: DEAL }),
        }),
        { params: Promise.resolve({ id: original }) },
      );
      const held = queuedJobs.splice(0);
      expect(held).toHaveLength(1);

      await eraseDana();
      const written = graph.calls.ingested;
      for (const job of held) await job();

      // Refused before it wrote anything, the graph included.
      expect(graph.calls.ingested).toBe(written);
      expect(await served()).toEqual([]);
      expect(await feedText()).not.toMatch(LEAKS);
    });

    it("a correction stored just after an erasure that passed it by is withdrawn by its job", async () => {
      await danaIn();
      const original = await agentWrites("agent-ops", DANA.name, "Based in Boston.");
      as(ORG, WRITER);
      await factRoute.PATCH(
        new Request(`http://t/api/memory/facts/${original}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ fact: "Based in Denver.", scope: DEAL }),
        }),
        { params: Promise.resolve({ id: original }) },
      );
      const held = queuedJobs.splice(0);
      // The job's first check passes; the whole erasure runs while it embeds the text, before
      // the row exists for the erasure to find.
      vi.mocked(globalThis.fetch).mockImplementationOnce(async () => {
        await eraseDana();
        return new Response(JSON.stringify({ embedding: new Array(DIMENSIONS).fill(0.01) }));
      });
      for (const job of held) await job();

      expect(await served()).toEqual([]);
      expect(await db.memoryChunk.count({ where: { orgId: ORG } })).toBe(0);
      expect(await feedText()).not.toMatch(LEAKS);
    });

    it("a correction an erasure overtakes between the job's write and its announcement is withdrawn by the job", async () => {
      await danaIn();
      const original = await agentWrites("agent-ops", DANA.name, "Based in Boston.");
      await patch(original, "Based in Austin.");
      const first = (await versionOf("Based in Austin."))!;
      as(ORG, WRITER);
      await factRoute.PATCH(
        new Request(`http://t/api/memory/facts/${first}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ fact: "Based in Denver.", scope: DEAL }),
        }),
        { params: Promise.resolve({ id: first }) },
      );
      // The job's own graph write is where the erasure lands: after the job's first check.
      const held = queuedJobs.splice(0);
      const ingest = graph.store.ingest;
      graph.store.ingest = async () => {
        graph.store.ingest = ingest;
        await eraseDana();
        return ingest();
      };
      try {
        for (const job of held) await job();
      } finally {
        graph.store.ingest = ingest;
      }

      expect(await served()).toEqual([]);
      expect(await feedText()).not.toMatch(LEAKS);
    });

    it("the queued job withdraws a correction of an erased version, before its writes and after them", async () => {
      const { inngest } = await import("@/lib/inngest");
      const { memoryIngest } = await import("@/lib/inngest/memory-ingest");
      const run = (data: unknown) =>
        (memoryIngest as unknown as { fn: (ctx: unknown) => Promise<unknown> }).fn({
          event: { data },
          runId: "run-1",
          step: { run: async (_name: string, fn: () => unknown) => fn() },
        });
      /** PATCH `factId` with the queue taking the job, as Inngest would; the job's event data. */
      const patchQueued = async (factId: string, fact: string): Promise<unknown> => {
        const sent: unknown[] = [];
        vi.stubEnv("INNGEST_BYPASS", "");
        const send = vi.spyOn(inngest, "send").mockImplementation((async (event: { data: unknown }) => {
          sent.push(event.data);
          return { ids: [] };
        }) as never);
        try {
          expect(await patch(factId, fact)).toBe(202);
        } finally {
          send.mockRestore();
          vi.stubEnv("INNGEST_BYPASS", "1");
        }
        expect(sent).toHaveLength(1);
        return sent[0];
      };
      await danaIn();
      const before = await patchQueued(
        await agentWrites("agent-ops", DANA.name, "Based in Boston."),
        "Based in Denver.",
      );

      // An erasure that runs whole while a job embeds its text, before its row exists: the job's
      // check after its last write withdraws it.
      const passedBy = await patchQueued(await agentWrites("agent-three", DANA.name, "Leads hiring."), "Leads sales.");
      vi.mocked(globalThis.fetch).mockImplementationOnce(async () => {
        await eraseDana();
        return new Response(JSON.stringify({ embedding: new Array(DIMENSIONS).fill(0.01) }));
      });
      expect(await run(passedBy)).toMatchObject({ refused: "corrects an erased version" });
      expect(await db.memoryChunk.count({ where: { orgId: ORG, content: "Leads sales." } })).toBe(0);

      // A job that runs after the erasure finished writes nothing, the graph included.
      const written = graph.calls.ingested;
      expect(await run(before)).toMatchObject({ refused: "corrects an erased version" });
      expect(graph.calls.ingested).toBe(written);

      expect(await served()).toEqual([]);
      expect(await feedText()).not.toMatch(/Denver|Leads sales/);
    });

    it("a person's correction of a brief that named her goes with the brief, though it overruled nothing", async () => {
      await danaIn();
      const handoff = await db.brief.create({
        data: {
          orgId: ORG,
          type: "handoff",
          scopePath: DEAL,
          title: `${DANA.name} handoff`,
          summary: "Who to call.",
          sections: [],
        },
      });
      const other = await db.brief.create({
        data: { orgId: ORG, type: "handoff", scopePath: DEAL, title: "Pricing", summary: "x", sections: [] },
      });
      for (const [briefId, correction] of [
        [handoff.id, "She moved to Denver in May."],
        [other.id, "The annual plan is 40k."],
      ] as const) {
        as(ORG, WRITER);
        await correctBrief(
          new Request(`http://t/api/briefs/${briefId}/correct`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ correction }),
          }),
          { params: Promise.resolve({ id: briefId }) },
        );
        await runQueuedJobs();
      }
      graph.reset();

      const result = await eraseDana();

      expect(await served()).toEqual(["The annual plan is 40k."]);
      expect(result.briefsRemoved).toBe(1);
      expect(graph.calls.erasePerson.map((c) => c.names)).toContainEqual([briefCorrectionName(handoff.id, WRITER)]);
      expect(graph.calls.erasePerson.map((c) => c.names)).not.toContainEqual([briefCorrectionName(other.id, WRITER)]);
    });
  });

  describe("what stays", () => {
    it("a conflict's winner, stored before her version, stays: it holds nothing from it", async () => {
      await danaIn();
      const winner = await agentWrites("agent-one", "Escalations", "Escalations go to the night desk.");
      const loser = await agentWrites("agent-two", "Escalations", `Escalations go to ${DANA.name}.`);
      expect(await db.factEdge.findMany({ where: { orgId: ORG }, select: { fromId: true, toId: true } })).toEqual([
        { fromId: winner, toId: loser },
      ]);

      const result = await eraseDana();

      expect(await served()).toEqual(["Escalations go to the night desk."]);
      expect(await db.memoryChunk.count({ where: { id: loser } })).toBe(0);
      expect(result.replacementsRemoved).toBe(0);
    });

    it("an update based on her version goes, as it was written from it", async () => {
      await danaIn();
      const base = await agentWrites("agent-one", "Escalations", `Escalations go to ${DANA.name}.`);
      await agentWrites("agent-two", "Escalations", "Escalations go to the night desk.", DEAL, ORG, base);
      expect(await served()).toEqual(["Escalations go to the night desk."]);

      const result = await eraseDana();

      expect(await served()).toEqual([]);
      expect(result.replacementsRemoved).toBe(1);
      // Its name is the fact's, shared with every other version of it: nothing is removed by name.
      expect(graph.calls.erasePerson.map((c) => c.names)).not.toContainEqual(["Escalations"]);
    });

    it("another org, and an unrelated correction in another scope, are not touched", async () => {
      await danaIn();
      await danaIn(OTHER);
      const mine = await agentWrites("agent-ops", DANA.name, "Based in Boston.");
      await patch(mine, "Based in Denver.");
      const theirs = await agentWrites("agent-ops", DANA.name, "Based in Boston.", `org_${OTHER}.deal_a`, OTHER);
      await patch(theirs, "Based in Denver.", { scope: `org_${OTHER}.deal_a`, orgId: OTHER, writer: OTHER_WRITER });
      const unrelated = await agentWrites(
        "agent-ops",
        "Escalations",
        "Escalations go to the on-call engineer.",
        OTHER_DEAL,
      );
      await patch(unrelated, "Escalations go to the duty manager.", { scope: OTHER_DEAL });
      // An edge in the other org that names this org's version: never followed from here.
      const otherCorrection = (await versionOf("Based in Denver.", OTHER))!;
      await db.factEdge.create({
        data: {
          orgId: OTHER,
          fromId: otherCorrection,
          toId: mine,
          kind: "supersedes",
          scopePath: `org_${OTHER}.deal_a`,
          actorType: "human",
          actorId: OTHER_WRITER,
        },
      });

      await eraseDana();

      expect(await served()).toEqual([]);
      expect(await served(OTHER_DEAL)).toEqual(["Escalations go to the duty manager."]);
      expect(await served(`org_${OTHER}.deal_a`, OTHER)).toEqual(["Based in Denver."]);
      expect(await feedText(OTHER)).toMatch(/Denver/);
      expect(await db.erasureSuppression.count({ where: { orgId: OTHER } })).toBe(0);
      expect(graph.calls.removeChunkFacts.map((c) => c.chunkId)).not.toContain(otherCorrection);
    });
  });

  describe("a replacement in a scope the reader of her fact cannot see", () => {
    it("is erased by the org-root erasure, which reaches every scope of the org", async () => {
      await danaIn();
      const original = await agentWrites("agent-ops", DANA.name, "Based in Boston.");
      // A replacement stored in a sibling scope, linked as an older or imported edge would be:
      // services/memory/edges.ts records no such edge today, but one on file is followed.
      const elsewhere = await agentWrites("agent-ops", "Travel", "Based in Denver.", OTHER_DEAL);
      await db.factEdge.create({
        data: {
          orgId: ORG,
          fromId: elsewhere,
          toId: original,
          kind: "supersedes",
          scopePath: OTHER_DEAL,
          actorType: "agent",
          actorId: "agent-ops",
        },
      });

      await eraseDana();

      expect(await served(OTHER_DEAL)).toEqual([]);
      expect(await served(ROOT)).toEqual([]);
    });

    it("is never reached by a manager of her fact's scope alone: the erasure is refused, and nothing changes", async () => {
      await danaIn();
      const original = await agentWrites("agent-ops", DANA.name, "Based in Boston.");
      await patch(original, "Based in Denver.");
      const before = await feedText();

      await expect(
        erasePerson(person(ORG, DEAL_MANAGER, "member").ctx, { contactId: `dana-${ORG}` }),
      ).rejects.toMatchObject({
        name: "AccessDeniedError",
      });

      expect(await served()).toEqual(["Based in Denver."]);
      expect(await feedText()).toBe(before);
      expect(await db.erasureSuppression.count({ where: { orgId: ORG } })).toBe(0);
    });
  });

  describe("an erasure that fails, races a writer, or is restored over", () => {
    it("a request sent again after the graph failed removes the correction, though what named her is already gone", async () => {
      await danaIn();
      const original = await agentWrites("agent-ops", DANA.name, "Based in Boston.");
      await patch(original, "Based in Denver.");
      graph.hooks.failChunkRemovals = 1;

      await expect(eraseDana()).rejects.toMatchObject({ name: "MemoryServiceError" });
      // Every record that named her is gone or blank; only the correction is left.
      expect(await feedText()).not.toMatch(/Dana|Whitfield|dana@/);
      expect(await served()).toEqual(["Based in Denver."]);

      const retry = await erasePerson(admin(), { email: DANA.email });

      expect(await served()).toEqual([]);
      expect(await feedText()).not.toMatch(LEAKS);
      expect(retry.replacementsRemoved).toBe(1);
      expect((await erasedRow()).earlierRequestIds).toHaveLength(1);
    });

    it("corrections committed while the request runs are removed: by the second pass with their graph copy, by the last transaction without it", async () => {
      await danaIn();
      const original = await agentWrites("agent-ops", DANA.name, "Based in Boston.");
      await patch(original, "Based in Austin.");
      const first = (await versionOf("Based in Austin."))!;
      // While the first pass removes the first correction's graph copy, someone corrects it.
      graph.hooks.duringChunkRemoval = {
        chunkId: first,
        run: async () => {
          await patch(first, "Based in Denver.");
          const second = (await versionOf("Based in Denver."))!;
          // And while the second pass removes that one's graph copy, someone corrects it again.
          graph.hooks.duringChunkRemoval = {
            chunkId: second,
            run: async () => void (await patch(second, "Based in Seattle.")),
          };
        },
      };

      const result = await eraseDana();

      expect(await db.memoryChunk.count({ where: { orgId: ORG } })).toBe(0);
      expect(await feedText()).not.toMatch(/Dana|Whitfield|Austin|Denver|Seattle/);
      expect(result.replacementsRemoved).toBe(3);
      // The third correction's row was found by the last transaction: its graph copy, which the
      // memory service holds outside that transaction, is not removed (a known limit).
      const third = (
        await db.changeEvent.findFirstOrThrow({ where: { orgId: ORG, op: "create" }, orderBy: { seq: "desc" } })
      ).recordId;
      expect(graph.calls.removeChunkFacts.map((c) => c.chunkId)).not.toContain(third);
      expect(new Set(graph.calls.removeChunkFacts.map((c) => c.chunkId)).size).toBe(3);
    });

    it("a replacement a restored backup puts back is not served as a fact of its task", async () => {
      await danaIn();
      const base = await agentWrites("agent-one", "Escalations", `Escalations go to ${DANA.name}.`);
      const update = await ingestMemory({
        groupId: ORG,
        content: "Escalations go to the night desk.",
        name: "Escalations",
        scopePath: DEAL,
        actorType: "agent",
        actorId: "agent-two",
        actorName: "agent-two",
        source: "mcp",
        origin: "mcp",
        baseVersion: base,
        task: "on-call-rota",
      });
      await runQueuedJobs();
      const replaced = update.versionId!;
      const row = await db.$queryRaw<{ createdAt: Date; embedding: string }[]>`
        SELECT "createdAt", embedding::text AS embedding FROM memory_chunks WHERE id = ${replaced}
      `;
      const taskFacts = async () =>
        JSON.stringify(
          (
            await readServableTaskStart(
              await agentReading(ORG, `agent-task-${Math.random()}`, DEAL),
              DEAL,
              "who takes escalations",
              "on-call-rota",
              (read) => read.task.facts.map((f) => f.id),
            )
          ).task.facts,
        );
      expect(await taskFacts()).toMatch(/night desk/);
      await eraseDana();

      await db.$executeRaw`
        INSERT INTO memory_chunks ("id","orgId","content","source","actorType","actorId","entityName","scopePath","factVersion","embedding","createdAt")
        VALUES (${replaced}, ${ORG}, 'Escalations go to the night desk.', 'mcp', 'agent', 'agent-two', 'Escalations', ${DEAL}, true, ${row[0]!.embedding}::vector, ${row[0]!.createdAt})
      `;
      expect(await taskFacts()).not.toMatch(/night desk/);
    });

    it("a correction a restored backup puts back is never served, and re-applying the erasures removes it", async () => {
      await danaIn();
      const original = await agentWrites("agent-ops", DANA.name, "Based in Boston.");
      await patch(original, "Based in Denver.");
      const corrected = (await versionOf("Based in Denver."))!;
      const row = await db.$queryRaw<{ entityName: string; createdAt: Date; embedding: string }[]>`
        SELECT "entityName", "createdAt", embedding::text AS embedding FROM memory_chunks WHERE id = ${corrected}
      `;
      const createdId = (
        await db.changeEvent.findFirstOrThrow({ where: { orgId: ORG, op: "create", recordId: corrected } })
      ).id;
      await eraseDana();

      const startRead = async () =>
        JSON.stringify(
          await readServableTaskStart(
            await agentReading(ORG, `agent-start-${Math.random()}`, DEAL),
            DEAL,
            "where is she based",
            "",
            (read) => read.context.writes.map((w) => w.recordId),
          ),
        );
      // The announcement alone comes back: the task-start block knows it by its version's id.
      await db.changeEvent.update({ where: { id: createdId }, data: { summary: "Based in Denver." } });
      expect(await startRead()).not.toMatch(/Denver/);
      // The row alone comes back.
      await db.changeEvent.update({ where: { id: createdId }, data: { summary: "" } });
      await db.$executeRaw`
        INSERT INTO memory_chunks ("id","orgId","content","source","actorType","actorId","entityName","scopePath","factVersion","embedding","createdAt")
        VALUES (${corrected}, ${ORG}, 'Based in Denver.', 'text', 'human', ${WRITER}, ${row[0]!.entityName}, ${DEAL}, true, ${row[0]!.embedding}::vector, ${row[0]!.createdAt})
      `;
      expect(await startRead()).not.toMatch(/Denver/);
      expect(await served()).toEqual([]);
      // Both.
      await db.changeEvent.update({ where: { id: createdId }, data: { summary: "Based in Denver." } });
      expect(await served()).toEqual([]);
      expect(await version(corrected)).toBe(404);
      expect(await startRead()).not.toMatch(/Denver/);
      const { readStoreOverview, readStorePage } = await import("@/services/memory/store-overview");
      expect(JSON.stringify((await readStoreOverview(ORG, DEAL)).chunks)).not.toMatch(/Denver/);
      const page = (search: string) =>
        readStorePage(ORG, DEAL, { list: "chunks", search, sort: "created", order: "desc", filter: null, page: 1 });
      expect((await page("")).items).toEqual([]);
      expect(await page("Denver")).toMatchObject({ items: [], total: 0 });
      // The fact it corrected names it nowhere, though its announcement is back.
      const supersedeId = (
        await db.changeEvent.findFirstOrThrow({ where: { orgId: ORG, op: "supersede", recordId: original } })
      ).id;
      as(ORG, ADMIN, "admin");
      const detail = await timelineChange(
        new Request(`http://t/api/audit/timeline/${createdId}?scope=${encodeURIComponent(DEAL)}`),
        { params: Promise.resolve({ changeId: createdId }) },
      );
      expect(await detail.text()).not.toMatch(/Dana|Whitfield/);
      const replaced = await timelineChange(
        new Request(`http://t/api/audit/timeline/${supersedeId}?scope=${encodeURIComponent(DEAL)}`),
        { params: Promise.resolve({ changeId: supersedeId }) },
      );
      expect(await replaced.json()).toMatchObject({ replacedById: null, replacedBy: null });

      expect(await reapplyErasures(admin())).toMatchObject({ chunksRemoved: 1 });
      expect(await db.memoryChunk.count({ where: { orgId: ORG } })).toBe(0);
    });
  });

  describe("versions that escaped an erasure made before this rule (scripts/erase-escaped-replacements.ts)", () => {
    /** An erasure as it ran before services/memory/erasure-lineage.ts: what named her blanked, nothing kept by id. */
    async function eraseTheOldWay(orgId = ORG): Promise<void> {
      const { recordSuppressions } = await import("@/services/memory/erasure-suppression");
      await recordSuppressions(db as never, orgId, "old-request", {
        emails: [DANA.email],
        names: [DANA.name.toLowerCase()],
        contactIds: [`dana-${orgId}`],
      });
      await db.$executeRaw`
        UPDATE change_events SET summary = '' WHERE "orgId" = ${orgId} AND (summary ILIKE '%dana whitfield%' OR summary ILIKE '%dana@acme.test%')
      `;
      await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${orgId} AND content ILIKE '%dana whitfield%'`;
      await db.contact.deleteMany({ where: { orgId, id: `dana-${orgId}` } });
    }

    it("finds the correction an old erasure left, removes it once, and finds nothing the second time", async () => {
      await danaIn();
      const original = await agentWrites("agent-ops", "Escalations", `Escalations go to ${DANA.name}.`);
      await patch(original, "Escalations go to the support lead.");
      // A correction made before edges were recorded is still linked to its removal, which then
      // carried the corrected text.
      await db.factEdge.deleteMany({ where: { orgId: ORG } });
      await db.changeEvent.updateMany({
        where: { orgId: ORG, op: "supersede", recordId: original },
        data: { summary: "Escalations go to the support lead." },
      });
      const corrected = (await versionOf("Escalations go to the support lead."))!;
      const untouched = await agentWrites("agent-ops", "Pricing", "The annual plan is 40k.");
      // A correction of a fact that never named her, and one of a fact still stored whose
      // announcement happens to read empty: neither escaped anything.
      const unrelated = await agentWrites("agent-ops", "Paging", "Paging goes to the on-call engineer.");
      await patch(unrelated, "Paging goes to the duty manager.");
      const stored = await agentWrites("agent-one", "Desk", "The night desk takes escalations.");
      await agentWrites("agent-two", "Desk", "The day desk takes escalations.", DEAL, ORG, stored);
      await db.changeEvent.updateMany({ where: { orgId: ORG, recordId: stored, op: "create" }, data: { summary: "" } });
      await eraseTheOldWay();
      const { findEscapedReplacements, eraseEscapedReplacements } = await import(
        "@/services/memory/erasure-lineage-backfill"
      );
      const before = [
        "Escalations go to the support lead.",
        "Paging goes to the duty manager.",
        "The annual plan is 40k.",
        "The day desk takes escalations.",
      ];
      expect(await served()).toEqual(before);

      const found = await findEscapedReplacements(ORG);
      expect(found.erasedVersions).toContain(original);
      expect(found.replacements).toEqual([corrected]);
      // Reading changes nothing.
      expect(await served()).toEqual(before);

      const applied = await eraseEscapedReplacements(admin());
      expect(applied).toMatchObject({ replacements: [corrected], removedChunks: 1 });
      expect(await served()).toEqual(before.filter((f) => f !== "Escalations go to the support lead."));
      expect(await feedText()).not.toMatch(/support lead/);
      expect(await db.memoryChunk.count({ where: { id: untouched } })).toBe(1);
      expect((await erasedRow()).stores.lineage).toEqual({ replacements: 1, announced: 0 });

      expect(await findEscapedReplacements(ORG)).toMatchObject({ replacements: [] });
      expect(await eraseEscapedReplacements(admin())).toMatchObject({ requestId: null, removedChunks: 0 });
    });

    it("finds nothing in an org no erasure ran in, and refuses a caller who may not manage the org", async () => {
      const original = await agentWrites("agent-ops", "Escalations", "Escalations go to the on-call engineer.");
      await patch(original, "Escalations go to the support lead.");
      await db.changeEvent.updateMany({
        where: { orgId: ORG, recordId: original, op: "create" },
        data: { summary: "" },
      });
      const { findEscapedReplacements, eraseEscapedReplacements } = await import(
        "@/services/memory/erasure-lineage-backfill"
      );

      expect(await findEscapedReplacements(ORG)).toEqual({ erasedVersions: [], replacements: [] });
      await expect(eraseEscapedReplacements(person(ORG, WRITER, "member").ctx)).rejects.toMatchObject({
        name: "AccessDeniedError",
      });
      expect(await served()).toEqual(["Escalations go to the support lead."]);
    });
  });

  describe("the walk", () => {
    /** A version announced on the feed, with an edge from it to `replaces` when given. */
    async function announced(id: string, replaces?: string): Promise<void> {
      const seq = BigInt((await db.changeEvent.count({ where: { orgId: ORG } })) + 1);
      await db.changeEvent.create({
        data: {
          orgId: ORG,
          seq,
          scopePath: DEAL,
          recordType: "fact",
          recordId: id,
          op: "create",
          actorId: "agent-ops",
          summary: "",
        },
      });
      if (replaces) {
        await db.factEdge.create({
          data: {
            orgId: ORG,
            fromId: id,
            toId: replaces,
            kind: "supersedes",
            scopePath: DEAL,
            actorType: "agent",
            actorId: "agent-ops",
          },
        });
      }
    }

    it("follows each chain to its end, and refuses past either bound rather than stop short", async () => {
      await announced("v1");
      await announced("v2", "v1");
      await announced("v3", "v2");
      await announced("v4", "v3");

      expect(await lineage.versionsWrittenInPlaceOf(db, ORG, ["v1"])).toEqual(["v2", "v3", "v4"]);
      expect(await lineage.versionsWrittenInPlaceOf(db, ORG, ["v2"])).toEqual(["v3", "v4"]);
      await expect(lineage.versionsWrittenInPlaceOf(db, ORG, ["v1"], { maxVersions: 3 })).rejects.toMatchObject({
        name: "ErasureLineageTooLargeError",
      });
      await expect(lineage.versionsWrittenInPlaceOf(db, ORG, ["v1"], { maxDepth: 2 })).rejects.toMatchObject({
        name: "ErasureLineageTooLargeError",
      });
      expect(await lineage.versionsWrittenInPlaceOf(db, ORG, ["v1"], { maxVersions: 4, maxDepth: 4 })).toEqual([
        "v2",
        "v3",
        "v4",
      ]);
    });

    it("ends at a cycle, and never follows an edge another org recorded", async () => {
      await announced("c1");
      await announced("c2", "c1");
      // A cycle back to the first version, which services/memory/edges.ts never records.
      await db.factEdge.create({
        data: {
          orgId: ORG,
          fromId: "c1",
          toId: "c2",
          kind: "supersedes",
          scopePath: DEAL,
          actorType: "agent",
          actorId: "agent-ops",
        },
      });
      await db.factEdge.create({
        data: {
          orgId: OTHER,
          fromId: "x1",
          toId: "c1",
          kind: "supersedes",
          scopePath: DEAL,
          actorType: "agent",
          actorId: "agent-ops",
        },
      });

      expect(await lineage.versionsWrittenInPlaceOf(db, ORG, ["c1"])).toEqual(["c2"]);
    });

    it("pairs a correction with its removal only when both are a person's, in one org", async () => {
      await announced("p1");
      const pair = async (
        orgId: string,
        recordId: string,
        op: "create" | "supersede",
        actorType: string,
        authorizedById: string,
      ) => {
        const seq = BigInt((await db.changeEvent.count({ where: { orgId } })) + 1);
        await db.changeEvent.create({
          data: {
            orgId,
            seq,
            scopePath: DEAL,
            recordType: "fact",
            recordId,
            op,
            actorId: "someone",
            actorType,
            summary: "",
            authorizedById,
          },
        });
      };
      // A connector's removal and a person's write that share an authorization; a person's
      // removal and a connector's write; a person's removal and a person's write in another org.
      await pair(ORG, "p1", "supersede", "extraction", "auth-a");
      await pair(ORG, "from-person", "create", "human", "auth-a");
      await pair(ORG, "p1", "supersede", "human", "auth-b");
      await pair(ORG, "from-connector", "create", "extraction", "auth-b");
      await pair(ORG, "p1", "supersede", "human", "auth-c");
      await pair(OTHER, "from-other-org", "create", "human", "auth-c");
      expect(await lineage.versionsWrittenInPlaceOf(db, ORG, ["p1"])).toEqual([]);

      await pair(ORG, "the-correction", "create", "human", "auth-c");
      expect(await lineage.versionsWrittenInPlaceOf(db, ORG, ["p1"])).toEqual(["the-correction"]);
    });

    it("never names, in a lineage, a replacement an erasure removed and a backup put back, announced or not", async () => {
      const { recordErasedVersions } = await import("@/services/memory/erasure-suppression");
      const { readVersionLineage } = await import("@/services/memory/versions");
      await announced("l1");
      await db.$executeRaw`
        INSERT INTO memory_chunks ("id","orgId","content","source","actorType","scopePath","createdAt")
        VALUES ('l2-unannounced', ${ORG}, 'Based in Denver.', 'mcp', 'agent', ${DEAL}, ${new Date(Date.now() - 60_000)})
      `;
      await db.factEdge.create({
        data: {
          orgId: ORG,
          fromId: "l2-unannounced",
          toId: "l1",
          kind: "supersedes",
          scopePath: DEAL,
          actorType: "agent",
          actorId: "agent-ops",
        },
      });
      expect(await readVersionLineage(ORG, "l1")).toMatchObject({ supersededById: "l2-unannounced" });

      await db.$transaction((tx) => recordErasedVersions(tx, ORG, "a-request", ["l2-unannounced"]));

      expect(await readVersionLineage(ORG, "l1")).toMatchObject({ supersededById: null });
    });

    it("takes a replacement the feed never announced as written in its place", async () => {
      await announced("a1");
      await db.factEdge.create({
        data: {
          orgId: ORG,
          fromId: "unannounced",
          toId: "a1",
          kind: "supersedes",
          scopePath: DEAL,
          actorType: "agent",
          actorId: "agent-ops",
        },
      });
      // And one announced before the version it is recorded as replacing: a conflict's winner.
      await db.changeEvent.updateMany({ where: { orgId: ORG, recordId: "a1" }, data: { seq: BigInt(100) } });
      await announced("winner");
      await db.changeEvent.updateMany({ where: { orgId: ORG, recordId: "winner" }, data: { seq: BigInt(1) } });
      await db.factEdge.create({
        data: {
          orgId: ORG,
          fromId: "winner",
          toId: "a1",
          kind: "supersedes",
          scopePath: DEAL,
          actorType: "agent",
          actorId: "agent-ops",
        },
      });

      expect(await lineage.versionsWrittenInPlaceOf(db, ORG, ["a1"])).toEqual(["unannounced"]);
    });
  });

  // Guards the suites above did not pin. Removing any one of them alone left
  // every test above green.
  describe("what stays, by guard", () => {
    it("a correction of a fact filed under an entity named after her, not under her, stays", async () => {
      await danaIn();
      const original = await agentWrites("agent-ops", `${DANA.name} Foundation`, "The grant budget is three million.");
      expect(await patch(original, "The grant budget is four million.")).toBe(202);
      expect(await served()).toEqual(["The grant budget is four million."]);

      const result = await eraseDana();

      // The removal's own summary names the Foundation, and is blanked as any text naming her is;
      // the correction itself was written in place of a fact that was never hers.
      expect(await served()).toEqual(["The grant budget is four million."]);
      expect(result.replacementsRemoved).toBe(0);
    });

    it("never removes another org's row or feed text, though an edge in this org names it as a replacement", async () => {
      await danaIn();
      const mine = await agentWrites("agent-ops", DANA.name, "Based in Boston.");
      const theirs = await agentWrites(
        "agent-ops",
        "Escalations",
        "Escalations go to the duty manager.",
        `org_${OTHER}.deal_a`,
        OTHER,
      );
      // An edge recorded in this org whose replacement is the other org's version.
      await db.factEdge.create({
        data: {
          orgId: ORG,
          fromId: theirs,
          toId: mine,
          kind: "supersedes",
          scopePath: DEAL,
          actorType: "agent",
          actorId: "agent-ops",
        },
      });

      await eraseDana();

      expect(await served(`org_${OTHER}.deal_a`, OTHER)).toEqual(["Escalations go to the duty manager."]);
      expect(await feedText(OTHER)).toMatch(/duty manager/);
      expect(graph.calls.removeChunkFacts.map((c) => c.chunkId)).not.toContain(theirs);
    });

    it("never removes another org's fact filed under a deleted brief's correction name", async () => {
      await danaIn();
      const handoff = await db.brief.create({
        data: {
          orgId: ORG,
          type: "handoff",
          scopePath: DEAL,
          title: `${DANA.name} handoff`,
          summary: "Who to call.",
          sections: [],
        },
      });
      await agentWrites(
        "agent-ops",
        briefCorrectionName(handoff.id, OTHER_WRITER),
        "The annual plan is 40k.",
        `org_${OTHER}.deal_a`,
        OTHER,
      );

      const result = await eraseDana();

      expect(result.briefsRemoved).toBe(1);
      expect(await served(`org_${OTHER}.deal_a`, OTHER)).toEqual(["The annual plan is 40k."]);
    });
  });
});
