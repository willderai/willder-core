// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A correction removes the old fact first, then queues the corrected text naming that removal.
// What fails after the removal either keeps the correction or answers in words that stay true,
// and the fact's lineage never forks:
//
// - the graph failing to retire the removed chunk's episodes a second time, after the delete;
// - recording the removal failing after the store deleted the fact;
// - the ingest call failing after the queue took the job (503, then the job stores it);
// - two people correcting one brief within the conflict window, or two PATCHes in one millisecond;
// - an agent's update based on the fact landing between the check for one and the removal.
//
// Real: Postgres, the routes and check(), ingestMemory with its job (run through `after()`),
// the pgvector store. Doubles: the signed-in session, the graph store (with failure knobs),
// the model, the entity resolver (which may rewrite the text), the embedding service, the
// contradiction search, and the episode counter.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const queuedJobs = vi.hoisted(() => [] as (() => Promise<unknown>)[]);
const session = vi.hoisted(() => ({ current: null as unknown }));
const knobs = vi.hoisted(() => ({
  contradiction: null as null | { uuid: string; fact: string; actorType: "agent" | "human" },
  removeChunkFactsFailOnCall: null as number | null,
  removeChunkFactsCalls: 0,
  onFirstRemoveChunkFacts: null as null | (() => Promise<void>),
  recordEpisodeThrowsOnce: false,
  rewrite: false,
  /** Recordings of a removal to fail next, after the store deleted the fact. */
  failRecordFactRemoved: 0,
}));

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
  const { MemoryServiceError } = await import("@/services/memory/graphiti-store");
  let episodes = 0;
  const graph = {
    ingest: async () => ({ episodeId: `graph-episode-${(episodes += 1)}` }),
    ingestBulk: async (inputs: unknown[]) => inputs.map(() => `graph-episode-${(episodes += 1)}`),
    removeFact: async () => ({ removed: false }),
    removeChunkFacts: async () => {
      knobs.removeChunkFactsCalls += 1;
      if (knobs.removeChunkFactsCalls === 1 && knobs.onFirstRemoveChunkFacts) {
        const hook = knobs.onFirstRemoveChunkFacts;
        knobs.onFirstRemoveChunkFacts = null;
        await hook();
      }
      if (knobs.removeChunkFactsFailOnCall === knobs.removeChunkFactsCalls) {
        throw new MemoryServiceError("graph timed out", 504);
      }
    },
    findFactById: async () => null,
    planPersonErasure: async () => [],
    erasePerson: async () => ({ episodes: 0, nodes: 0, edges: 0, summaries: 0, episodeIds: [] }),
    retrieve: async () => ({ facts: [], storesRead: [{ store: "graph" }] }),
    dedupeNodes: async () => 0,
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
vi.mock("@/services/resolver", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/services/resolver")>();
  return {
    ...real,
    resolveEntities: async (_org: string, _actor: string, text: string) => {
      const resolvedText = knobs.rewrite ? text.replace("the support lead", "Sam Lee, the support lead") : text;
      return { resolvedText, resolutions: [], changed: resolvedText !== text };
    },
  };
});
vi.mock("@/services/memory/fact-change-event", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/services/memory/fact-change-event")>();
  return {
    ...real,
    recordFactRemoved: async (...args: Parameters<typeof real.recordFactRemoved>) => {
      if (knobs.failRecordFactRemoved > 0) {
        knobs.failRecordFactRemoved -= 1;
        throw new Error("connection reset while recording the removal");
      }
      return real.recordFactRemoved(...args);
    },
  };
});
vi.mock("@/services/facts/conflicts", () => ({
  findContradiction: async () => ({
    contradiction: knobs.contradiction && { ...knobs.contradiction, note: "contradicts" },
    complete: true,
  }),
}));
vi.mock("@/services/guardrails", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/services/guardrails")>();
  return {
    ...real,
    checkEpisodeCap: async () => undefined,
    recordEpisode: async () => {
      if (knobs.recordEpisodeThrowsOnce) {
        knobs.recordEpisodeThrowsOnce = false;
        throw new Error("connection reset after the event was sent");
      }
    },
  };
});

const QA_URL = process.env.QA_DATABASE_URL;
const DIMENSIONS = 384;
const ORG = "lineagedur";
const ROOT = `org_${ORG}`;
const DEAL = `${ROOT}.deal_a`;
const WRITER = "u-lineagedur-writer";
const WRITER2 = "u-lineagedur-writer2";
const AGENT_FACT = "Escalations go to the on-call engineer.";
const CORRECTION = "Escalations go to the support lead.";

describe.skipIf(!QA_URL)("a correction is never lost, whatever fails after its removal", () => {
  let db: PrismaClient;
  let ingestMemory: (typeof import("@/lib/inngest"))["ingestMemory"];
  let factRoute: typeof import("@/app/api/memory/facts/[id]/route");
  let correctBrief: (typeof import("@/app/api/briefs/[id]/correct/route"))["POST"];
  let PgvectorMemoryStore: (typeof import("@/services/memory/pgvector-store"))["PgvectorMemoryStore"];

  const as = (id: string) => {
    session.current = {
      org: { id: ORG, name: ORG },
      user: { id, name: id },
      ctx: { orgId: ORG, actor: { type: "human", id, role: "member" }, origin: "app" } as AccessContext,
    };
  };

  async function runQueuedJobs(): Promise<void> {
    while (queuedJobs.length > 0) await queuedJobs.shift()!();
  }

  async function agentWrites(agentId: string, name: string, content: string, baseVersion?: string): Promise<string> {
    const ack = await ingestMemory({
      groupId: ORG,
      content,
      name,
      scopePath: DEAL,
      actorType: "agent",
      actorId: agentId,
      actorName: agentId,
      source: "mcp",
      origin: "mcp",
      ...(baseVersion ? { baseVersion } : {}),
    });
    await runQueuedJobs();
    return ack.versionId!;
  }

  async function patch(factId: string, fact: string): Promise<{ status: number; body: unknown }> {
    try {
      const res = await factRoute.PATCH(
        new Request(`http://t/api/memory/facts/${factId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ fact, scope: DEAL }),
        }),
        { params: Promise.resolve({ id: factId }) },
      );
      return { status: res.status, body: await res.json().catch(() => null) };
    } catch (e) {
      return { status: 500, body: String(e) };
    }
  }

  async function correctBriefId(briefId: string, correction: string): Promise<{ status: number; body: unknown }> {
    try {
      const res = await correctBrief(
        new Request(`http://t/api/briefs/${briefId}/correct`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ correction }),
        }),
        { params: Promise.resolve({ id: briefId }) },
      );
      return { status: res.status, body: await res.json().catch(() => null) };
    } catch (e) {
      return { status: 500, body: String(e) };
    }
  }

  async function served(): Promise<string[]> {
    const { facts } = await new PgvectorMemoryStore().retrieve({
      groupId: ORG,
      tenantId: ORG,
      query: "escalations",
      limit: 50,
      scopePath: DEAL,
    });
    return facts.map((f) => f.fact).sort();
  }

  async function edges(): Promise<string[]> {
    const rows = await db.factEdge.findMany({
      where: { orgId: ORG, kind: "supersedes" },
      select: { fromId: true, toId: true },
    });
    return rows.map((e) => `${e.fromId}>${e.toId}`).sort();
  }

  async function stored(content: string | { contains: string }): Promise<string[]> {
    const rows = await db.memoryChunk.findMany({ where: { orgId: ORG, content }, select: { id: true } });
    return rows.map((r) => r.id);
  }

  async function wipe(): Promise<void> {
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.factEdge.deleteMany({ where: { orgId: ORG } });
    await db.brief.deleteMany({ where: { orgId: ORG } });
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.user.deleteMany({ where: { id: { in: [WRITER, WRITER2] } } });
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
    ({ POST: correctBrief } = await import("@/app/api/briefs/[id]/correct/route"));
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
    Object.assign(knobs, {
      contradiction: null,
      removeChunkFactsFailOnCall: null,
      removeChunkFactsCalls: 0,
      onFirstRemoveChunkFacts: null,
      recordEpisodeThrowsOnce: false,
      rewrite: false,
      failRecordFactRemoved: 0,
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    await wipe();
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    const deal = await db.scope.create({ data: { orgId: ORG, path: DEAL, name: "deal_a" } });
    for (const id of [WRITER, WRITER2]) {
      await db.user.create({
        data: { id, orgId: ORG, email: `${id}@lineage.test`, role: "member", clerkId: `clerk-${id}` },
      });
      await db.grant.create({
        data: { orgId: ORG, scopeId: deal.id, granteeType: "user", granteeId: id, permission: "write" },
      });
    }
  });

  it("a PATCH whose graph retirement fails after the delete keeps the correction, named as the replacement", async () => {
    const original = await agentWrites("agent-ops", "Escalations", AGENT_FACT);
    knobs.removeChunkFactsFailOnCall = 2; // the retirement after the row delete
    as(WRITER);
    const res = await patch(original, CORRECTION);
    await runQueuedJobs();

    expect(res).toEqual({ status: 202, body: { jobId: "queued" } });
    expect(await stored(AGENT_FACT)).toEqual([]);
    const [correction] = await stored(CORRECTION);
    expect(await edges()).toEqual([`${correction}>${original}`]);
    expect(await served()).toEqual([CORRECTION]);
  });

  it("a brief correction whose graph retirement fails after the delete answers as merged, and is named as the replacement", async () => {
    const original = await agentWrites("agent-ops", "Escalations", AGENT_FACT);
    knobs.removeChunkFactsFailOnCall = 2;
    knobs.contradiction = { uuid: original, fact: AGENT_FACT, actorType: "agent" };
    const { id: briefId } = await db.brief.create({
      data: { orgId: ORG, type: "handoff", scopePath: DEAL, title: "H", summary: "x", sections: [] },
    });
    as(WRITER);
    const res = await correctBriefId(briefId, CORRECTION);
    await runQueuedJobs();

    expect(res).toEqual({ status: 200, body: { ok: true, autoMerged: true } });
    const [correction] = await stored(CORRECTION);
    expect(await edges()).toEqual([`${correction}>${original}`]);
    expect(await served()).toEqual([CORRECTION]);
  });

  it("an ingest that fails after the queue took the job answers 503 without claiming the text is lost, and the job stores it once", async () => {
    const original = await agentWrites("agent-ops", "Escalations", AGENT_FACT);
    knobs.recordEpisodeThrowsOnce = true; // the ingest call fails after the event was sent
    knobs.rewrite = true;
    as(WRITER);
    const res = await patch(original, CORRECTION);
    await runQueuedJobs();

    // "Not confirmed", and the job then stores the correction: the answer was true either way.
    expect(res).toEqual({
      status: 503,
      body: {
        error:
          "The fact was removed, but your corrected text was not confirmed as saved. If it does not show in memory within a minute, add it again as a new fact.",
        factRemoved: true,
      },
    });
    const versions = await stored({ contains: "support lead" });
    expect(versions).toHaveLength(1);
    expect(await edges()).toEqual([`${versions[0]}>${original}`]);
  });
  it("two people correcting one brief, each overruling a different fact: both corrections stay served, each replacing its own fact", async () => {
    const f1 = await agentWrites("agent-ops", "Escalations", AGENT_FACT);
    const f2 = await agentWrites("agent-ops", "Refunds", "Refunds over $500 need a manager.");
    const { id: briefId } = await db.brief.create({
      data: { orgId: ORG, type: "handoff", scopePath: DEAL, title: "Handoff", summary: "x", sections: [] },
    });

    knobs.contradiction = { uuid: f1, fact: AGENT_FACT, actorType: "agent" };
    as(WRITER);
    await correctBriefId(briefId, CORRECTION);
    knobs.contradiction = { uuid: f2, fact: "Refunds over $500 need a manager.", actorType: "agent" };
    as(WRITER2);
    await correctBriefId(briefId, "Refunds over $500 need the finance lead.");
    // Both jobs run together, as a backlog delivers them: inside one contention window.
    await runQueuedJobs();

    const [c1] = await stored(CORRECTION);
    const [c2] = await stored("Refunds over $500 need the finance lead.");
    expect(await edges()).toEqual([`${c1}>${f1}`, `${c2}>${f2}`].sort());
    const { facts } = await new PgvectorMemoryStore().retrieve({
      groupId: ORG,
      tenantId: ORG,
      query: "refunds",
      limit: 50,
      scopePath: DEAL,
    });
    expect(facts.map((f) => f.fact)).toContain("Refunds over $500 need the finance lead.");
  });

  it("two people's PATCH corrections of two facts in the same millisecond stay two facts, both served", async () => {
    const f1 = await agentWrites("agent-ops", "Escalations", AGENT_FACT);
    const f2 = await agentWrites("agent-ops", "Paging", "Paging escalates after ten minutes.");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-13T12:00:00.000Z"));
    try {
      as(WRITER);
      expect((await patch(f1, CORRECTION)).status).toBe(202);
      as(WRITER2);
      expect((await patch(f2, "Escalations page the support lead after five minutes.")).status).toBe(202);
    } finally {
      vi.useRealTimers();
    }
    await runQueuedJobs();

    expect(await served()).toEqual([CORRECTION, "Escalations page the support lead after five minutes."].sort());
    expect((await edges()).filter((e) => !e.endsWith(`>${f1}`) && !e.endsWith(`>${f2}`))).toEqual([]);
  });

  it("an update based on the fact that lands between the check for one and the removal keeps one replacement, and the correction", async () => {
    const original = await agentWrites("agent-ops", "Escalations", AGENT_FACT);
    let update: string | undefined;
    knobs.onFirstRemoveChunkFacts = async () => {
      update = await agentWrites("agent-ops", "Escalations", "Escalations go to the night desk.", original);
    };
    as(WRITER);
    const res = await patch(original, CORRECTION);
    await runQueuedJobs();

    // The check before the removal saw no replacement, so the correction went ahead; the
    // update was recorded as the replacement first, and stays the only one.
    expect(res.status).toBe(202);
    expect((await edges()).filter((e) => e.endsWith(`>${original}`))).toEqual([`${update}>${original}`]);
    expect(await stored(CORRECTION)).toHaveLength(1);
    expect(await served()).toEqual(["Escalations go to the night desk.", CORRECTION].sort());
  });

  it("a PATCH whose removal landed but could not be recorded keeps the correction, which names no removal", async () => {
    const original = await agentWrites("agent-ops", "Escalations", AGENT_FACT);
    knobs.failRecordFactRemoved = 1;
    as(WRITER);
    const res = await patch(original, CORRECTION);
    await runQueuedJobs();

    expect(res).toEqual({ status: 202, body: { jobId: "queued" } });
    expect(await stored(AGENT_FACT)).toEqual([]);
    expect(await served()).toEqual([CORRECTION]);
    expect(await edges()).toEqual([]);
    // The correction still names the delete decision that authorized the edit.
    const [correction] = await stored(CORRECTION);
    const { authorizedById } = await db.changeEvent.findFirstOrThrow({
      where: { orgId: ORG, op: "create", recordId: correction },
    });
    expect(
      await db.auditLog.findUnique({
        where: { id: authorizedById ?? "" },
        select: { action: true, target: true, decision: true },
      }),
    ).toEqual({ action: "memory.delete", target: `${DEAL}/fact:${original}`, decision: "allow" });
  });
  it("a brief correction whose removal landed but could not be recorded answers as merged and keeps the correction", async () => {
    const original = await agentWrites("agent-ops", "Escalations", AGENT_FACT);
    knobs.failRecordFactRemoved = 1;
    knobs.contradiction = { uuid: original, fact: AGENT_FACT, actorType: "agent" };
    const { id: briefId } = await db.brief.create({
      data: { orgId: ORG, type: "handoff", scopePath: DEAL, title: "H", summary: "x", sections: [] },
    });
    as(WRITER);
    const res = await correctBriefId(briefId, CORRECTION);
    await runQueuedJobs();

    expect(res).toEqual({ status: 200, body: { ok: true, autoMerged: true } });
    expect(await stored(AGENT_FACT)).toEqual([]);
    expect(await served()).toEqual([CORRECTION]);
  });
  it("a brief correction whose removal landed unrecorded and whose ingest then fails says the fact is gone", async () => {
    const original = await agentWrites("agent-ops", "Escalations", AGENT_FACT);
    knobs.failRecordFactRemoved = 1;
    knobs.recordEpisodeThrowsOnce = true;
    knobs.contradiction = { uuid: original, fact: AGENT_FACT, actorType: "agent" };
    const { id: briefId } = await db.brief.create({
      data: { orgId: ORG, type: "handoff", scopePath: DEAL, title: "H", summary: "x", sections: [] },
    });
    as(WRITER);
    const res = await correctBriefId(briefId, CORRECTION);

    expect(res).toMatchObject({ status: 503, body: { factRemoved: true } });
    expect(await stored(AGENT_FACT)).toEqual([]);
  });
  it("a brief correction with nothing to overrule whose ingest fails is not reported as removing anything", async () => {
    await agentWrites("agent-ops", "Escalations", AGENT_FACT);
    knobs.recordEpisodeThrowsOnce = true;
    const { id: briefId } = await db.brief.create({
      data: { orgId: ORG, type: "handoff", scopePath: DEAL, title: "H", summary: "x", sections: [] },
    });
    as(WRITER);

    // The route throws, as on main: nothing was removed, so there is nothing to report as gone.
    expect(await correctBriefId(briefId, CORRECTION)).toEqual({
      status: 500,
      body: "Error: connection reset after the event was sent",
    });
    expect(await served()).toEqual([AGENT_FACT]);
  });
  it("a DELETE whose removal landed but could not be recorded answers that the fact is removed", async () => {
    const original = await agentWrites("agent-ops", "Escalations", AGENT_FACT);
    knobs.failRecordFactRemoved = 1;
    as(WRITER);
    const res = await factRoute.DELETE(
      new Request(`http://t/api/memory/facts/${original}?scope=${DEAL}`, { method: "DELETE" }),
      {
        params: Promise.resolve({ id: original }),
      },
    );

    expect({ status: res.status, body: await res.json() }).toEqual({ status: 200, body: { removed: original } });
    expect(await stored(AGENT_FACT)).toEqual([]);
  });
});
