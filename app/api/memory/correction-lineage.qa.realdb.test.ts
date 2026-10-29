// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The correction lineage: what a person's correction
// does to the fact it overrules when part of it fails, when it races itself or an agent, when
// the Inngest job that stores it is delivered twice, when the fact it corrects was already
// replaced, and when it names an erased person. Two guards (the brief route's stored scope,
// the removal's org) are covered here too.
//
// A correction is two writes, the removal of the old fact and the ingest of the corrected
// text. The brief route now removes first, so the correction can name its own removal. That
// order makes one failure path lossy: when `ingestMemory` refuses the correction after the
// removal landed, the overruled fact is gone and the correction was never stored. The free
// plan's episode cap is the deterministic case (`checkEpisodeCap` throws `GuardrailError`);
// a failed queue send is the transient one. The person is told the correction failed, yet
// memory changed: the fact they flagged is no longer served, and nothing replaced it.
//
// Real: Postgres, the routes and check(), ingestMemory with its queued job (run through
// `after()`), the pgvector store, the change feed, the task-start read and the person
// erasure. Doubles: the signed-in session, the graph store, the model, the embedding service,
// the contradiction search behind a brief correction, and the episode cap's org lookup.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";

/** Work queued by `after()`, in queue order. */
const queuedJobs = vi.hoisted(() => [] as (() => Promise<unknown>)[]);
const session = vi.hoisted(() => ({ current: null as unknown }));
/** The contradiction a brief correction's search finds, and whether the org is at its episode cap. */
const knobs = vi.hoisted(() => ({
  contradiction: null as null | { uuid: string; fact: string; actorType: "agent" | "human" },
  atEpisodeCap: false,
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
  let episodes = 0;
  const graph = {
    ingest: async () => ({ episodeId: `graph-episode-${(episodes += 1)}` }),
    ingestBulk: async (inputs: unknown[]) => inputs.map(() => `graph-episode-${(episodes += 1)}`),
    removeFact: async () => ({ removed: false }),
    removeChunkFacts: async () => undefined,
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
vi.mock("@/services/facts/conflicts", () => ({
  findContradiction: async () => ({
    contradiction: knobs.contradiction && { ...knobs.contradiction, note: "contradicts" },
    complete: true,
  }),
}));
// The real GuardrailError, thrown exactly as checkEpisodeCap throws it for a free org at its cap.
vi.mock("@/services/guardrails", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/services/guardrails")>();
  return {
    ...real,
    checkEpisodeCap: async () => {
      if (knobs.atEpisodeCap) {
        throw new real.GuardrailError(
          "episode_cap_exceeded",
          "Free plan memory cap (1000 episodes) reached — upgrade to keep adding memory",
        );
      }
    },
    recordEpisode: async () => undefined,
  };
});

const QA_URL = process.env.QA_DATABASE_URL;
const DIMENSIONS = 384;
const ORG = "lineageqa";
const ROOT = `org_${ORG}`;
const DEAL = `${ROOT}.deal_a`;
const ADMIN = "u-lineageqa-admin";
const OTHER = "lineageqa2";
const WRITER = "u-lineageqa-writer";
const DANA = { name: "Dana Whitfield", email: "dana@acme.test" };
const AGENT_FACT = "Escalations go to the on-call engineer.";
const CORRECTION = "Escalations go to the support lead.";

describe.skipIf(!QA_URL)("a correction never loses the fact it overrules, and never forks its lineage", () => {
  let db: PrismaClient;
  let ingestMemory: (typeof import("@/lib/inngest"))["ingestMemory"];
  let factRoute: typeof import("@/app/api/memory/facts/[id]/route");
  let timelineChange: (typeof import("@/app/api/audit/timeline/[changeId]/route"))["GET"];
  let correctBrief: (typeof import("@/app/api/briefs/[id]/correct/route"))["POST"];
  let readChanges: (typeof import("@/services/memory/change-feed"))["readChanges"];
  let readServableTaskStart: (typeof import("@/services/memory/task-start"))["readServableTaskStart"];
  let erasePerson: (typeof import("@/services/memory/person-erasure"))["erasePerson"];
  let PgvectorMemoryStore: (typeof import("@/services/memory/pgvector-store"))["PgvectorMemoryStore"];

  const person = (id: string, role: "admin" | "member") => ({
    org: { id: ORG, name: ORG },
    user: { id, name: id },
    ctx: { orgId: ORG, actor: { type: "human", id, role }, origin: "app" } as AccessContext,
  });
  const as = (id: string, role: "admin" | "member" = "member") => {
    session.current = person(id, role);
  };

  async function runQueuedJobs(): Promise<void> {
    while (queuedJobs.length > 0) await queuedJobs.shift()!();
  }

  async function agentWrites(agentId: string, name: string, content: string): Promise<string> {
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
    });
    await runQueuedJobs();
    return ack.versionId!;
  }

  function patchRequest(factId: string, fact: string): Promise<Response> {
    return factRoute.PATCH(
      new Request(`http://t/api/memory/facts/${factId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fact, scope: DEAL }),
      }),
      { params: Promise.resolve({ id: factId }) },
    );
  }

  /** POST /api/briefs/:id/correct on a handoff brief in `scopePath` (the deal by default), as the
   * writer, or as the admin for a brief at the org root. The route's own errors are returned as
   * a 500, as Next answers a route that throws. */
  async function correctBriefAs(correction: string, scopePath = DEAL): Promise<Response> {
    const { id } = await db.brief.create({
      data: { orgId: ORG, type: "handoff", scopePath, title: "Handoff", summary: "x", sections: [] },
    });
    if (scopePath === DEAL) as(WRITER);
    else as(ADMIN, "admin");
    try {
      return await correctBrief(
        new Request(`http://t/api/briefs/${id}/correct`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ correction }),
        }),
        { params: Promise.resolve({ id }) },
      );
    } catch {
      return new Response("Internal Server Error", { status: 500 });
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

  async function supersedesEdges(): Promise<string[]> {
    const edges = await db.factEdge.findMany({
      where: { orgId: ORG, kind: "supersedes" },
      select: { fromId: true, toId: true },
    });
    return edges.map((e) => `${e.fromId}>${e.toId}`).sort();
  }

  async function agentReading(agentId: string): Promise<AccessContext> {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath: DEAL,
        permission: "read",
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    return { orgId: ORG, actor: { type: "agent", id: agentId, capabilityToken: token }, origin: "mcp" };
  }

  async function wipe(): Promise<void> {
    for (const orgId of [ORG, OTHER]) {
      await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${orgId}`;
      await db.changeEvent.deleteMany({ where: { orgId } });
      await db.factEdge.deleteMany({ where: { orgId } });
      await db.erasureSuppression.deleteMany({ where: { orgId } });
      await db.org.deleteMany({ where: { id: orgId } });
    }
    await db.user.deleteMany({ where: { id: { in: [ADMIN, WRITER] } } });
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
    ({ GET: timelineChange } = await import("@/app/api/audit/timeline/[changeId]/route"));
    ({ POST: correctBrief } = await import("@/app/api/briefs/[id]/correct/route"));
    ({ readChanges } = await import("@/services/memory/change-feed"));
    ({ readServableTaskStart } = await import("@/services/memory/task-start"));
    ({ erasePerson } = await import("@/services/memory/person-erasure"));
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
    knobs.contradiction = null;
    knobs.atEpisodeCap = false;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    await wipe();
    await db.org.create({ data: { id: ORG, name: ORG } });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    const deal = await db.scope.create({ data: { orgId: ORG, path: DEAL, name: "deal_a" } });
    await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: `${ADMIN}@lineage.test`, role: "admin", clerkId: `clerk-${ADMIN}` },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    await db.user.create({
      data: { id: WRITER, orgId: ORG, email: `${WRITER}@lineage.test`, role: "member", clerkId: `clerk-${WRITER}` },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: deal.id, granteeType: "user", granteeId: WRITER, permission: "write" },
    });
  });

  describe("a correction the ingest refuses after the removal", () => {
    // Regression from the reorder: on origin/main the brief route ingested first, so a cap
    // refusal returned before anything was removed and the flagged fact stayed served.
    it("a brief correction refused by the episode cap leaves the agent's fact stored, served and unannounced", async () => {
      const original = await agentWrites("agent-ops", "Escalations", AGENT_FACT);
      knobs.contradiction = { uuid: original, fact: AGENT_FACT, actorType: "agent" };
      knobs.atEpisodeCap = true;

      const res = await correctBriefAs(CORRECTION);
      await runQueuedJobs();

      // The person is told the correction did not go through...
      expect(res.ok).toBe(false);
      // ...so memory must not have changed: the flagged fact is still the standing answer.
      expect(await db.memoryChunk.count({ where: { id: original } })).toBe(1);
      expect(await served()).toEqual([AGENT_FACT]);
      expect(await db.changeEvent.count({ where: { orgId: ORG, op: "supersede", recordId: original } })).toBe(0);
    });

    // The same class on PATCH, which already removed first before this PR (fails on
    // origin/main too). The PR touches this block to add `correctionOf`; its own comment
    // names the class ("an edit that reached it would delete the fact and keep nothing")
    // and guards only the NUL case.
    it("a PATCH correction refused by the episode cap leaves the fact it edits stored and served", async () => {
      const original = await agentWrites("agent-ops", "Escalations", AGENT_FACT);
      knobs.atEpisodeCap = true;
      as(WRITER);

      let status: number;
      try {
        status = (await patchRequest(original, CORRECTION)).status;
      } catch {
        status = 500;
      }
      await runQueuedJobs();

      expect(status).not.toBe(202);
      expect(await db.memoryChunk.count({ where: { id: original } })).toBe(1);
      expect(await served()).toEqual([AGENT_FACT]);
    });
  });

  describe("races and redelivery", () => {
    it("two people correcting one fact at once: one correction replaces it, the other is told it is gone", async () => {
      const original = await agentWrites("agent-ops", "Escalations", AGENT_FACT);
      as(WRITER);
      const statuses = (
        await Promise.all([
          patchRequest(original, "Escalations go to the support lead."),
          patchRequest(original, "Escalations go to the duty manager."),
        ])
      )
        .map((r) => r.status)
        .sort();
      await runQueuedJobs();

      expect(statuses).toEqual([202, 404]);
      expect(await db.changeEvent.count({ where: { orgId: ORG, op: "supersede", recordId: original } })).toBe(1);
      const edges = await supersedesEdges();
      expect(edges).toHaveLength(1);
      expect(edges[0]).toMatch(new RegExp(`>${original}$`));
    });

    it("a correction's ingest job delivered twice records one version, one create and one edge", async () => {
      const original = await agentWrites("agent-ops", "Escalations", AGENT_FACT);
      knobs.contradiction = { uuid: original, fact: AGENT_FACT, actorType: "agent" };
      expect((await correctBriefAs(CORRECTION)).status).toBe(200);
      // Inngest redelivers the event: the same job runs twice, once after the other and once beside it.
      const [job] = queuedJobs.splice(0);
      await job!();
      await Promise.allSettled([job!(), job!()]);

      const versions = await db.memoryChunk.findMany({
        where: { orgId: ORG, content: CORRECTION },
        select: { id: true },
      });
      expect(versions).toHaveLength(1);
      expect(await db.changeEvent.count({ where: { orgId: ORG, op: "create", recordId: versions[0]!.id } })).toBe(1);
      expect(await supersedesEdges()).toEqual([`${versions[0]!.id}>${original}`]);
    });

    it("an agent update based on a fact a person has since corrected is not recorded as a second replacement", async () => {
      const original = await agentWrites("agent-ops", "Escalations", AGENT_FACT);
      as(WRITER);
      expect((await patchRequest(original, CORRECTION)).status).toBe(202);
      await runQueuedJobs();
      const correction = (await db.memoryChunk.findFirstOrThrow({ where: { orgId: ORG, content: CORRECTION } })).id;

      // The agent read the original before the correction and now updates it. Whether that
      // write is refused (today: its base is no longer a version) or stored, it must not
      // become a second replacement of the original.
      await ingestMemory({
        groupId: ORG,
        content: "Escalations go to the night desk.",
        name: "Escalations",
        scopePath: DEAL,
        actorType: "agent",
        actorId: "agent-ops",
        actorName: "agent-ops",
        source: "mcp",
        origin: "mcp",
        baseVersion: original,
      }).catch(() => undefined);
      await runQueuedJobs();

      const intoOriginal = (await supersedesEdges()).filter((e) => e.endsWith(`>${original}`));
      expect(intoOriginal).toEqual([`${correction}>${original}`]);
    });
  });

  describe("one replacement per version", () => {
    // A version an update already replaced is no longer current, and the change feed and the
    // Timeline name one replacement for it ("first recorded wins"). A person's PATCH of that
    // version by id (from a change notice, or a stale list) removes its row and, on this
    // branch, records the correction as a second replacement. The person's own removal event
    // then answers "replaced by" with the agent's update, which the person never saw, and the
    // version's lineage forks. recordReplacements refuses an edge FROM a replaced version, not
    // INTO one. On origin/main the version keeps its one replacement.
    it("a correction of a version an agent update already replaced records no second replacement", async () => {
      const original = await agentWrites("agent-ops", "Escalations", AGENT_FACT);
      const update = await ingestMemory({
        groupId: ORG,
        content: "Escalations go to the night desk.",
        name: "Escalations",
        scopePath: DEAL,
        actorType: "agent",
        actorId: "agent-ops",
        actorName: "agent-ops",
        source: "mcp",
        origin: "mcp",
        baseVersion: original,
      });
      await runQueuedJobs();
      as(WRITER);
      await patchRequest(original, CORRECTION);
      await runQueuedJobs();

      const intoOriginal = (await supersedesEdges()).filter((e) => e.endsWith(`>${original}`));
      expect(intoOriginal).toEqual([`${update.versionId}>${original}`]);
    });

    it("a correction of a conflict's loser records no second replacement", async () => {
      const winner = await agentWrites("agent-one", "Escalations", AGENT_FACT);
      const loser = await agentWrites("agent-two", "Escalations", "Escalations go to the night desk.");
      expect(await supersedesEdges()).toEqual([`${winner}>${loser}`]);
      as(WRITER);
      await patchRequest(loser, CORRECTION);
      await runQueuedJobs();

      expect((await supersedesEdges()).filter((e) => e.endsWith(`>${loser}`))).toEqual([`${winner}>${loser}`]);
    });
  });

  describe("guards no PR test reaches", () => {
    // The brief route names the removed fact's STORED scope (removedVersion.scopePath), not the
    // brief's. Replacing it with the brief's scope survives every test on the branch: the
    // org-root cases there all go through PATCH. A brief at the org root searches the whole
    // subtree (guardedMemory.retrieve, scope containment), so its contradiction can be a
    // deal's fact, and its removal at the root reaches that row.
    it("a brief corrected at the org root that overrules a deal's fact names no replacement", async () => {
      const original = await agentWrites("agent-ops", "Escalations", AGENT_FACT);
      knobs.contradiction = { uuid: original, fact: AGENT_FACT, actorType: "agent" };
      const res = await correctBriefAs(CORRECTION, ROOT);
      expect(await res.json()).toMatchObject({ ok: true, autoMerged: true });
      await runQueuedJobs();

      expect(
        await db.memoryChunk.findFirstOrThrow({
          where: { orgId: ORG, content: CORRECTION },
          select: { scopePath: true },
        }),
      ).toEqual({ scopePath: ROOT });
      expect(await supersedesEdges()).toEqual([]);
      const { changes } = await readChanges(await agentReading("agent-deal"), DEAL, { limit: 50 });
      expect(changes.map((c) => c.supersededById)).toEqual(changes.map(() => null));
    });

    // recordCorrection checks the named removal is a supersede of this fact IN THIS ORG.
    // Dropping the org predicate survives every test on the branch.
    it("a correction naming another org's removal of a fact with the same id records nothing", async () => {
      await db.org.create({ data: { id: OTHER, name: OTHER } });
      const sharedId = "fact-shared-id";
      const otherRemoval = await db.changeEvent.create({
        data: {
          orgId: OTHER,
          seq: BigInt(1),
          scopePath: `org_${OTHER}.deal_a`,
          recordType: "fact",
          recordId: sharedId,
          op: "supersede",
          actorId: "someone",
          summary: "",
        },
      });
      await ingestMemory({
        groupId: ORG,
        content: CORRECTION,
        actorType: "human",
        actorId: WRITER,
        origin: "app",
        scopePath: DEAL,
        resolve: false,
        correctionOf: { factId: sharedId, removalId: otherRemoval.id, scopePath: DEAL },
      });
      await runQueuedJobs();

      expect(await supersedesEdges()).toEqual([]);
    });
  });

  describe("erasure of the person a correction names", () => {
    it("never resurfaces through the corrected fact's lineage, the change feed or the task-start block", async () => {
      const original = await agentWrites("agent-ops", "Escalations", AGENT_FACT);
      as(WRITER);
      expect((await patchRequest(original, `Escalations go to ${DANA.name} (${DANA.email}).`)).status).toBe(202);
      await runQueuedJobs();
      const correction = (
        await db.memoryChunk.findFirstOrThrow({ where: { orgId: ORG, content: { contains: DANA.name } } })
      ).id;
      const correctionRow = await db.$queryRaw<
        { createdAt: Date }[]
      >`SELECT "createdAt" FROM memory_chunks WHERE id = ${correction}`;
      const correctionCreate = await db.changeEvent.findFirstOrThrow({
        where: { orgId: ORG, op: "create", recordId: correction },
      });
      const removal = await db.changeEvent.findFirstOrThrow({
        where: { orgId: ORG, op: "supersede", recordId: original },
      });

      await db.contact.create({
        data: {
          id: "dana",
          orgId: ORG,
          name: DANA.name,
          email: DANA.email,
          createdAt: new Date(Date.now() - 86_400_000),
        },
      });
      await erasePerson(person(ADMIN, "admin").ctx, { contactId: "dana" });
      // A restored backup puts the correction's row back; its announcement stays blank. (The
      // change feed has no erasure filter of its own, so a restored summary is a feed question,
      // not a lineage one, and is left out here.)
      expect((await db.changeEvent.findUniqueOrThrow({ where: { id: correctionCreate.id } })).summary).not.toMatch(
        /Dana/,
      );
      await db.$executeRaw`
        INSERT INTO memory_chunks ("id","orgId","content","source","actorType","actorId","scopePath","createdAt")
        VALUES (${correction}, ${ORG}, ${`Escalations go to ${DANA.name} (${DANA.email}).`}, 'text', 'human', ${WRITER}, ${DEAL}, ${correctionRow[0]!.createdAt})
      `;

      as(ADMIN, "admin");
      const detail = await timelineChange(
        new Request(`http://t/api/audit/timeline/${removal.id}?scope=${encodeURIComponent(DEAL)}`),
        { params: Promise.resolve({ changeId: removal.id }) },
      );
      const detailText = await detail.text();
      expect(detailText).not.toMatch(/Dana|Whitfield|dana@/i);
      expect(JSON.parse(detailText)).toMatchObject({ replacedById: null, replacedBy: null });

      const { changes } = await readChanges(await agentReading("agent-feed"), DEAL, { limit: 50 });
      expect(JSON.stringify(changes)).not.toMatch(/Dana|Whitfield|dana@/i);
      // Every write is served, so every one due the erased-person check is checked, as the block does.
      const read = await readServableTaskStart(await agentReading("agent-start"), DEAL, "escalations", "", (r) =>
        r.context.writes.map((w) => w.recordId),
      );
      expect(JSON.stringify(read.context.writes)).not.toMatch(/Dana|Whitfield|dana@/i);
    });
  });
});
