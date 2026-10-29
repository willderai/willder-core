// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Correction lineage at the edges: what a refused correction reveals, and whether a
// correction is erased with the person it names.
//
// - The refusal of a correction of an already-replaced version (409 with the version in
//   force) must not tell anyone who may not delete the fact that it exists: a person without
//   delete in its scope, one asking in a sibling scope whose path merely starts the same, and
//   one asking in a deal about an untagged row at the org root all read a missing id. Only a
//   correction is refused that way; a plain DELETE of a replaced version still removes it.
// - A correction stored as written on the request path skips the entity resolver, which is
//   what turns an alias the org registered ("Mike") into the person's full name, and the full
//   name is what a person erasure matches. A correction naming a person by alias must still be
//   erased with them.
// - A PATCH and a brief correction racing to overrule one fact record one replacement.
//
// Real: Postgres, the routes and check(), ingestMemory with its queued job (run through
// `after()`), the pgvector store, the entity resolver's alias registry and the person
// erasure. Doubles: the signed-in session, the graph store, the model, the embedding service,
// the contradiction search behind a brief correction, and the episode cap's org lookup.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
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
const ORG = "lineageqa3";
const ROOT = `org_${ORG}`;
const DEAL = `${ROOT}.deal_a`;
const ADMIN = "u-lineageqa3-admin";
const OTHER = "lineageqa4";
const SIBLING = `${ROOT}.deal_ab`;
const READER = "u-lineageqa3-reader";
const WRITER = "u-lineageqa3-writer";
const AGENT_FACT = "Escalations go to the on-call engineer.";
const CORRECTION = "Escalations go to the support lead.";

describe.skipIf(!QA_URL)(
  "correction lineage: refusals hide what they must, and a correction is erased with its person",
  () => {
    let db: PrismaClient;
    let ingestMemory: (typeof import("@/lib/inngest"))["ingestMemory"];
    let factRoute: typeof import("@/app/api/memory/facts/[id]/route");
    let correctBrief: (typeof import("@/app/api/briefs/[id]/correct/route"))["POST"];
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

    async function agentWrites(
      agentId: string,
      name: string,
      content: string,
      scopePath = DEAL,
      baseVersion?: string,
    ): Promise<string> {
      const ack = await ingestMemory({
        groupId: ORG,
        content,
        name,
        scopePath,
        ...(baseVersion ? { baseVersion } : {}),
        actorType: "agent",
        actorId: agentId,
        actorName: agentId,
        source: "mcp",
        origin: "mcp",
      });
      await runQueuedJobs();
      return ack.versionId!;
    }

    function patchRequest(factId: string, fact: string, scope = DEAL): Promise<Response> {
      return factRoute.PATCH(
        new Request(`http://t/api/memory/facts/${factId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ fact, scope }),
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

    async function wipe(): Promise<void> {
      for (const orgId of [ORG, OTHER]) {
        await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${orgId}`;
        await db.changeEvent.deleteMany({ where: { orgId } });
        await db.factEdge.deleteMany({ where: { orgId } });
        await db.erasureSuppression.deleteMany({ where: { orgId } });
        await db.org.deleteMany({ where: { id: orgId } });
      }
      await db.user.deleteMany({ where: { id: { in: [ADMIN, WRITER, READER] } } });
      await db.entityAlias.deleteMany({ where: { orgId: ORG } });
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
      // A sibling whose path starts with the deal's, and a reader of the deal who may not delete.
      await db.scope.create({ data: { orgId: ORG, path: SIBLING, name: "deal_ab" } });
      await db.user.create({
        data: { id: READER, orgId: ORG, email: `${READER}@lineage.test`, role: "member", clerkId: `clerk-${READER}` },
      });
      await db.grant.create({
        data: { orgId: ORG, scopeId: deal.id, granteeType: "user", granteeId: READER, permission: "read" },
      });
    });

    /** A fact an agent wrote in `scopePath` and then updated, so the update replaced it. */
    async function replacedFact(scopePath: string): Promise<{ original: string; update: string }> {
      const original = await agentWrites("agent-ops", "Escalations", AGENT_FACT, scopePath);
      const update = await agentWrites(
        "agent-ops",
        "Escalations",
        "Escalations go to the night desk.",
        scopePath,
        original,
      );
      return { original, update };
    }

    /** A PATCH's status and body, as the client reads them. */
    async function answer(res: Promise<Response>): Promise<{ status: number; body: unknown }> {
      const r = await res;
      return { status: r.status, body: await r.json() };
    }

    describe("the already-replaced refusal reads as absent to anyone who may not delete the fact", () => {
      it("asked in a sibling scope whose path starts the same, a replaced fact answers exactly as a missing id", async () => {
        const { original, update } = await replacedFact(SIBLING);
        as(WRITER);
        const replaced = await answer(patchRequest(original, CORRECTION, DEAL));
        const missing = await answer(patchRequest("no-such-fact-id", CORRECTION, DEAL));

        expect(replaced).toEqual(missing);
        expect(JSON.stringify(replaced)).not.toContain(update);
        expect(await db.memoryChunk.count({ where: { id: original } })).toBe(1);
      });

      it("asked by a person who may read the fact's scope but not delete in it, a replaced fact answers exactly as a missing id", async () => {
        const { original, update } = await replacedFact(DEAL);
        as(READER);
        const replaced = await answer(patchRequest(original, CORRECTION, DEAL));
        const missing = await answer(patchRequest("no-such-fact-id", CORRECTION, DEAL));

        expect(replaced).toEqual(missing);
        expect(JSON.stringify(replaced)).not.toContain(update);
      });

      // An untagged row lives at the org root. Counting it as inside every scope survives
      // every test on the branch; it would hand a deal-only deleter a root fact's existence and
      // the id of the version that replaced it.
      it("asked in the deal, an untagged replaced fact at the org root answers exactly as a missing id", async () => {
        for (const [id, content] of [
          ["untagged-old", AGENT_FACT],
          ["untagged-new", "Escalations go to the night desk."],
        ]) {
          await db.$executeRaw`
          INSERT INTO memory_chunks ("id","orgId","content","source","actorType","actorId","entityName","scopePath")
          VALUES (${id}, ${ORG}, ${content}, 'mcp', 'agent', 'agent-ops', 'Escalations', NULL)
        `;
        }
        await db.factEdge.create({
          data: {
            orgId: ORG,
            fromId: "untagged-new",
            toId: "untagged-old",
            kind: "supersedes",
            scopePath: ROOT,
            actorType: "agent",
            actorId: "agent-ops",
          },
        });
        as(WRITER);
        const replaced = await answer(patchRequest("untagged-old", CORRECTION, DEAL));
        const missing = await answer(patchRequest("no-such-fact-id", CORRECTION, DEAL));

        expect(replaced).toEqual(missing);
        expect(JSON.stringify(replaced)).not.toContain("untagged-new");
      });

      it("asked where the corrector may delete, it is refused with the version in force and nothing changes", async () => {
        const { original, update } = await replacedFact(DEAL);
        as(WRITER);
        const replaced = await answer(patchRequest(original, CORRECTION, DEAL));

        expect(replaced).toMatchObject({ status: 409, body: { currentVersionId: update } });
        expect(await db.memoryChunk.count({ where: { id: original } })).toBe(1);
        expect(await db.memoryChunk.count({ where: { orgId: ORG, content: CORRECTION } })).toBe(0);
      });
    });

    describe("only a correction is refused for an already-replaced version", () => {
      // Running the check on a plain delete survives every test on the branch; it would refuse
      // DELETE of a superseded version (and the run-tag cleanup that removes such rows).
      it("a DELETE of a version an update already replaced still removes it", async () => {
        const { original } = await replacedFact(DEAL);
        as(WRITER);
        const res = await factRoute.DELETE(
          new Request(`http://t/api/memory/facts/${original}?scope=${encodeURIComponent(DEAL)}`, { method: "DELETE" }),
          {
            params: Promise.resolve({ id: original }),
          },
        );

        expect(res.status).toBe(200);
        expect(await db.memoryChunk.count({ where: { id: original } })).toBe(0);
      });
    });

    describe("a correction stored now is still erased with the person it names", () => {
      // The stored row must hold the resolver's text, which names the person by the full name
      // the alias registry maps "Mike" to, so erasing them removes it.
      async function mikeWithAlias(): Promise<string> {
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
        return contact.id;
      }

      it("a PATCH correction naming a person by a registered alias is gone from reads after that person's erasure", async () => {
        const mike = await mikeWithAlias();
        const original = await agentWrites("agent-ops", "Escalations", AGENT_FACT);
        as(WRITER);
        expect((await patchRequest(original, "Escalations go to Mike.")).status).toBe(202);
        await runQueuedJobs();

        await erasePerson(person(ADMIN, "admin").ctx, { contactId: mike });

        expect(await served()).toEqual([]);
      });

      it("a brief correction naming a person by a registered alias is gone from reads after that person's erasure", async () => {
        const mike = await mikeWithAlias();
        const original = await agentWrites("agent-ops", "Escalations", AGENT_FACT);
        knobs.contradiction = { uuid: original, fact: AGENT_FACT, actorType: "agent" };
        expect(await (await correctBriefAs("Escalations go to Mike.")).json()).toMatchObject({
          ok: true,
          autoMerged: true,
        });
        await runQueuedJobs();

        await erasePerson(person(ADMIN, "admin").ctx, { contactId: mike });

        expect(await served()).toEqual([]);
      });
    });

    describe("two routes racing to overrule one fact", () => {
      it("a PATCH and a brief correction of the same agent fact record one replacement, and keep both corrections", async () => {
        const original = await agentWrites("agent-ops", "Escalations", AGENT_FACT);
        knobs.contradiction = { uuid: original, fact: AGENT_FACT, actorType: "agent" };
        const handoff = await db.brief.create({
          data: { orgId: ORG, type: "handoff", scopePath: DEAL, title: "Handoff", summary: "x", sections: [] },
        });
        as(WRITER);
        const [patched, briefed] = await Promise.all([
          patchRequest(original, "Escalations go to the duty manager."),
          correctBrief(
            new Request(`http://t/api/briefs/${handoff.id}/correct`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ correction: CORRECTION }),
            }),
            { params: Promise.resolve({ id: handoff.id }) },
          ),
        ]);
        await runQueuedJobs();

        expect(await db.changeEvent.count({ where: { orgId: ORG, op: "supersede", recordId: original } })).toBe(1);
        const edges = (await supersedesEdges()).filter((e) => e.endsWith(`>${original}`));
        expect(edges).toHaveLength(1);
        // The brief's correction is kept whichever removal won; a PATCH that lost is told the fact is gone.
        expect(briefed.status).toBe(200);
        expect([202, 404]).toContain(patched.status);
        expect(await db.memoryChunk.count({ where: { orgId: ORG, content: CORRECTION } })).toBe(1);
      });
    });
  },
);
