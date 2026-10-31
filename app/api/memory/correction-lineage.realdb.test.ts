// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// What replaced a corrected fact, and what its correction replaced, as the audit Timeline,
// GET /api/memory/versions/:id, the change feed and the task-start read answer it.
//
// A correction removes the old fact (announced as a `supersede`) and ingests the corrected
// text as a new version (announced as a `create`): PATCH /api/memory/facts/:id, and a brief
// correction that overrules an agent's fact. The new version's announcement records a
// `supersedes` edge to the old one, but only once the old one's removal is on the feed, and
// only when both are in one scope. So a correction whose removal failed never hides a fact
// that is still stored, and a correction made at a broader scope than the fact names nothing
// a reader of the fact's scope could not read.
//
// Real: Postgres, the routes and check(), ingestMemory with its queued job (run through
// `after()`), the pgvector store, the change feed, the task-start read and the person
// erasure. Doubles: the signed-in session, the graph store, the model, the embedding service
// and the contradiction search behind a brief correction.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { ChangeOp } from "@/lib/generated/prisma/enums";
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import { briefCorrectionName } from "@/services/memory/correction-names";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

/** Work queued by `after()`, in queue order. */
const queuedJobs = vi.hoisted(() => [] as (() => Promise<unknown>)[]);
const session = vi.hoisted(() => ({ current: null as unknown }));
/** The contradiction a brief correction's search finds, whether the graph refuses a removal,
 * and how the episode cap answers (see the guardrails mock). */
const brief = vi.hoisted(() => ({
  contradiction: null as null | { uuid: string; fact: string; actorType: "agent" | "human" },
  graphRemovalFails: false as boolean | "unexpectedly",
  capAllows: null as number | null,
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
    removeChunkFacts: async () => {
      if (brief.graphRemovalFails === "unexpectedly") throw new Error("connection reset");
      if (brief.graphRemovalFails) {
        const { MemoryServiceError } = await import("@/services/memory/graphiti-store");
        throw new MemoryServiceError("memory service unavailable", 503);
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
vi.mock("@/services/facts/conflicts", () => ({
  findContradiction: async () => ({
    contradiction: brief.contradiction && { ...brief.contradiction, note: "contradicts" },
    complete: true,
  }),
}));
// The real GuardrailError. `capAllows` is how many more cap checks pass before the cap
// refuses, as it does once another writer fills a free org's last slot; null never refuses.
vi.mock("@/services/guardrails", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/services/guardrails")>();
  return {
    ...real,
    checkEpisodeCap: async () => {
      if (brief.capAllows === null) return;
      if (brief.capAllows-- > 0) return;
      throw new real.GuardrailError(
        "episode_cap_exceeded",
        "Free plan memory cap (1000 episodes) reached — upgrade to keep adding memory",
      );
    },
    recordEpisode: async () => undefined,
  };
});

const QA_URL = process.env.QA_DATABASE_URL;
const DIMENSIONS = 384;
const ORG = "lineagefix";
const ROOT = `org_${ORG}`;
const DEAL = `${ROOT}.deal_a`;
const ADMIN = "u-lineagefix-admin";
const WRITER = "u-lineagefix-writer";
const READER = "u-lineagefix-reader";
const OTHER = "lineagefix2";
const OTHER_ADMIN = "u-lineagefix2-admin";
const DANA = { name: "Dana Whitfield", email: "dana@acme.test" };

type Lineage = {
  replacedById: string | null;
  replacesIds: string[];
  replacedBy: { id: string; change: { id: string; summary: string } | null } | null;
  replaces: { id: string; change: { id: string; summary: string } | null }[];
};
const NOTHING: Lineage = { replacedById: null, replacesIds: [], replacedBy: null, replaces: [] };

describe.skipIf(!QA_URL)("a corrected fact names what replaced it, and its correction names what it replaced", () => {
  let db: PrismaClient;
  let ingestMemory: (typeof import("@/lib/inngest"))["ingestMemory"];
  let factRoute: typeof import("@/app/api/memory/facts/[id]/route");
  let versionRoute: (typeof import("@/app/api/memory/versions/[id]/route"))["GET"];
  let timelineChange: (typeof import("@/app/api/audit/timeline/[changeId]/route"))["GET"];
  let correctBrief: (typeof import("@/app/api/briefs/[id]/correct/route"))["POST"];
  let readChanges: (typeof import("@/services/memory/change-feed"))["readChanges"];
  let readServableTaskStart: (typeof import("@/services/memory/task-start"))["readServableTaskStart"];
  let erasePerson: (typeof import("@/services/memory/person-erasure"))["erasePerson"];
  let PgvectorMemoryStore: (typeof import("@/services/memory/pgvector-store"))["PgvectorMemoryStore"];
  let guardedMemory: (typeof import("@/services/memory"))["guardedMemory"];

  const person = (orgId: string, id: string, role: "admin" | "member") => ({
    org: { id: orgId, name: orgId },
    user: { id, name: id },
    ctx: { orgId, actor: { type: "human", id, role }, origin: "app" } as AccessContext,
  });
  const as = (orgId: string, id: string, role: "admin" | "member" = "member") => {
    session.current = person(orgId, id, role);
  };

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
    });
    await runQueuedJobs();
    return ack.versionId!;
  }

  async function patch(factId: string, fact: string, scope?: string): Promise<number> {
    return (await patchReply(factId, fact, scope)).status;
  }

  /** PATCH /api/memory/facts/:id as the current session: its status and body. */
  async function patchReply(
    factId: string,
    fact: string,
    scope?: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await factRoute.PATCH(
      new Request(`http://t/api/memory/facts/${factId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fact, ...(scope ? { scope } : {}) }),
      }),
      { params: Promise.resolve({ id: factId }) },
    );
    await runQueuedJobs();
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  /** Run `body` with the queue refusing every job, as a queue that is down does. */
  async function withQueueDown<T>(body: () => Promise<T>): Promise<T> {
    const { inngest } = await import("@/lib/inngest");
    vi.stubEnv("INNGEST_BYPASS", "");
    const send = vi.spyOn(inngest, "send").mockRejectedValue(new Error("queue unavailable"));
    try {
      return await body();
    } finally {
      send.mockRestore();
      vi.stubEnv("INNGEST_BYPASS", "1");
    }
  }

  /** POST /api/briefs/:id/correct as the writer, on `briefId` or a fresh handoff brief in the deal. */
  async function correctBriefAs(correction: string, briefId?: string): Promise<Response> {
    const id =
      briefId ??
      (
        await db.brief.create({
          data: { orgId: ORG, type: "handoff", scopePath: DEAL, title: "Handoff", summary: "x", sections: [] },
        })
      ).id;
    as(ORG, WRITER);
    return correctBrief(
      new Request(`http://t/api/briefs/${id}/correct`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ correction }),
      }),
      { params: Promise.resolve({ id }) },
    );
  }

  /** The version the correction `content` was stored as. */
  async function versionOf(content: string, orgId = ORG): Promise<string> {
    return (await db.memoryChunk.findFirstOrThrow({ where: { orgId, content }, select: { id: true } })).id;
  }

  async function changeOn(op: ChangeOp, recordId: string): Promise<string> {
    return (await db.changeEvent.findFirstOrThrow({ where: { orgId: ORG, op, recordId }, select: { id: true } })).id;
  }

  async function detail(changeId: string, scope: string): Promise<{ status: number; text: string; lineage: Lineage }> {
    as(ORG, ADMIN, "admin");
    const res = await timelineChange(
      new Request(`http://t/api/audit/timeline/${changeId}?scope=${encodeURIComponent(scope)}`),
      { params: Promise.resolve({ changeId }) },
    );
    const text = await res.text();
    const { replacedById, replacesIds, replacedBy, replaces } = JSON.parse(text) as Lineage;
    return { status: res.status, text, lineage: { replacedById, replacesIds, replacedBy, replaces } };
  }

  async function version(
    id: string,
    asUser = READER,
  ): Promise<{ status: number; version?: { status: string; supersededById: string | null; supersedesIds: string[] } }> {
    as(ORG, asUser);
    const res = await versionRoute(new Request(`http://t/api/memory/versions/${id}`), {
      params: Promise.resolve({ id }),
    });
    return { status: res.status, ...((await res.json()) as object) };
  }

  async function supersedesEdges(orgId = ORG): Promise<string[]> {
    const edges = await db.factEdge.findMany({
      where: { orgId, kind: "supersedes" },
      select: { fromId: true, toId: true },
    });
    return edges.map((e) => `${e.fromId}>${e.toId}`).sort();
  }

  async function agentReading(agentId: string, scope: string): Promise<AccessContext> {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath: scope,
        permission: "read",
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    return { orgId: ORG, actor: { type: "agent", id: agentId, capabilityToken: token }, origin: "mcp" };
  }

  /** What memory_query's vector leg serves in `scope`. */
  async function served(scope = DEAL): Promise<string[]> {
    const { facts } = await new PgvectorMemoryStore().retrieve({
      groupId: ORG,
      tenantId: ORG,
      query: "escalations",
      limit: 50,
      scopePath: scope,
    });
    return facts.map((f) => f.fact).sort();
  }

  async function wipe(): Promise<void> {
    for (const orgId of [ORG, OTHER]) {
      await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${orgId}`;
      await db.changeEvent.deleteMany({ where: { orgId } });
      await db.factEdge.deleteMany({ where: { orgId } });
      await db.erasureSuppression.deleteMany({ where: { orgId } });
      await deleteOrgsWithRetry(db, { where: { id: orgId } });
    }
    await db.user.deleteMany({ where: { id: { in: [ADMIN, WRITER, READER, OTHER_ADMIN] } } });
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
    ({ PgvectorMemoryStore } = await import("@/services/memory/pgvector-store"));
    ({ guardedMemory } = await import("@/services/memory"));
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
    brief.graphRemovalFails = false;
    brief.capAllows = null;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    await wipe();
    for (const [orgId, admin] of [
      [ORG, ADMIN],
      [OTHER, OTHER_ADMIN],
    ] as const) {
      await db.org.create({ data: { id: orgId, name: orgId } });
      const root = await db.scope.create({ data: { orgId, path: `org_${orgId}`, name: "root" } });
      await db.scope.create({ data: { orgId, path: `org_${orgId}.deal_a`, name: "deal_a" } });
      await db.user.create({
        data: { id: admin, orgId, email: `${admin}@lineage.test`, role: "admin", clerkId: `clerk-${admin}` },
      });
      await db.grant.create({
        data: { orgId, scopeId: root.id, granteeType: "user", granteeId: admin, permission: "admin" },
      });
    }
    const deal = await db.scope.findFirstOrThrow({ where: { orgId: ORG, path: DEAL } });
    for (const [id, permission] of [
      [WRITER, "write"],
      [READER, "read"],
    ] as const) {
      await db.user.create({
        data: { id, orgId: ORG, email: `${id}@lineage.test`, role: "member", clerkId: `clerk-${id}` },
      });
      await db.grant.create({ data: { orgId: ORG, scopeId: deal.id, granteeType: "user", granteeId: id, permission } });
    }
  });

  it("a correction at the fact's own scope: each version names the other on every read path", async () => {
    const original = await agentWrites("agent-ops", "Escalations", "Escalations go to the on-call engineer.");
    as(ORG, WRITER);
    expect(await patch(original, "Escalations go to the support lead.", DEAL)).toBe(202);
    const corrected = await versionOf("Escalations go to the support lead.");

    expect(await supersedesEdges()).toEqual([`${corrected}>${original}`]);
    const createdId = await changeOn("create", corrected);
    expect((await detail(await changeOn("supersede", original), DEAL)).lineage).toEqual({
      replacedById: corrected,
      replacesIds: [],
      replacedBy: { id: corrected, change: expect.objectContaining({ id: createdId }) },
      replaces: [],
    });
    expect((await detail(createdId, DEAL)).lineage).toMatchObject({ replacedById: null, replacesIds: [original] });
    expect(await version(corrected)).toMatchObject({
      status: 200,
      version: { status: "current", supersededById: null, supersedesIds: [original] },
    });

    // The feed marks the old version's create with its replacement.
    const { changes } = await readChanges(await agentReading("agent-reader", DEAL), DEAL, { limit: 50 });
    expect(changes.filter((c) => c.op === "create").map((c) => [c.recordId, c.supersededById])).toEqual([
      [original, corrected],
      [corrected, null],
    ]);
    // The task-start read still leaves out the create of a version a correction removed.
    const read = await readServableTaskStart(
      await agentReading("agent-start", DEAL),
      DEAL,
      "escalations",
      "",
      () => [],
    );
    expect(read.context.writes.filter((w) => w.op === "create").map((w) => w.recordId)).toEqual([corrected]);
    expect(await served()).toEqual(["Escalations go to the support lead."]);
  });

  it("a correction of a correction: the middle version names both neighbours", async () => {
    const first = await agentWrites("agent-ops", "Escalations", "Escalations go to the on-call engineer.");
    as(ORG, WRITER);
    await patch(first, "Escalations go to the support lead.", DEAL);
    const second = await versionOf("Escalations go to the support lead.");
    await patch(second, "Escalations go to the duty manager.", DEAL);
    const third = await versionOf("Escalations go to the duty manager.");

    expect(await supersedesEdges()).toEqual([`${second}>${first}`, `${third}>${second}`].sort());
    expect((await detail(await changeOn("create", second), DEAL)).lineage).toMatchObject({
      replacedById: third,
      replacesIds: [first],
    });
  });

  it("a correction made at the org root of a fact stored in a deal names nothing, exactly as a delete", async () => {
    const corrected = await agentWrites("agent-ops", "Escalations", "Escalations go to the on-call engineer.");
    const deleted = await agentWrites("agent-ops", "Paging", "Paging escalates after ten minutes.");
    as(ORG, ADMIN, "admin");
    expect(await patch(corrected, "Escalations go to the support lead.")).toBe(202);
    const correction = await versionOf("Escalations go to the support lead.");
    const res = await factRoute.DELETE(
      new Request(`http://t/api/memory/facts/${deleted}?scope=${DEAL}`, { method: "DELETE" }),
      {
        params: Promise.resolve({ id: deleted }),
      },
    );
    expect(res.status).toBe(200);

    expect(await db.memoryChunk.findUniqueOrThrow({ where: { id: correction }, select: { scopePath: true } })).toEqual({
      scopePath: ROOT,
    });
    expect(await supersedesEdges()).toEqual([]);
    const absent = (await detail(await changeOn("create", deleted), DEAL)).lineage;
    expect(absent).toEqual(NOTHING);
    expect((await detail(await changeOn("create", corrected), DEAL)).lineage).toEqual(absent);
    expect((await detail(await changeOn("supersede", corrected), ROOT)).lineage).toEqual(absent);
    expect((await detail(await changeOn("create", correction), ROOT)).lineage).toEqual(absent);
    // The deal's reader cannot read the correction, and its own feed never names it.
    expect((await version(correction)).status).toBe(404);
    const { changes } = await readChanges(await agentReading("agent-deal", DEAL), DEAL, { limit: 50 });
    expect(changes.map((c) => c.supersededById)).toEqual(changes.map(() => null));
    expect(JSON.stringify(changes)).not.toContain(correction);
  });

  it("another org's correction of the same fact id is refused, and records nothing in either org", async () => {
    const original = await agentWrites("agent-ops", "Escalations", "Escalations go to the on-call engineer.");
    as(OTHER, OTHER_ADMIN, "admin");
    expect(await patch(original, "Escalations go to the support lead.", `org_${OTHER}.deal_a`)).toBe(404);

    expect(await supersedesEdges(ORG)).toEqual([]);
    expect(await supersedesEdges(OTHER)).toEqual([]);
    expect(await db.memoryChunk.count({ where: { orgId: OTHER } })).toBe(0);
    expect(await served()).toEqual(["Escalations go to the on-call engineer."]);
  });

  it("a brief correction that overrules an agent's fact records the fact's replacement once the removal lands", async () => {
    const original = await agentWrites("agent-ops", "Escalations", "Escalations go to the on-call engineer.");
    brief.contradiction = { uuid: original, fact: "Escalations go to the on-call engineer.", actorType: "agent" };
    const res = await correctBriefAs("Escalations go to the support lead.");
    expect(await res.json()).toMatchObject({ ok: true, autoMerged: true });
    await runQueuedJobs();

    const correction = await versionOf("Escalations go to the support lead.");
    expect(await supersedesEdges()).toEqual([`${correction}>${original}`]);
    expect((await detail(await changeOn("supersede", original), DEAL)).lineage).toMatchObject({
      replacedById: correction,
    });
  });

  it("a correction stored on the request path records its replacement in the same announcement", async () => {
    const original = await agentWrites("agent-ops", "Escalations", "Escalations go to the on-call engineer.");
    const writer = person(ORG, WRITER, "member").ctx;
    const removal = await guardedMemory.removeFact(
      writer,
      { groupId: ORG, factId: original },
      DEAL,
      "Escalations go to the support lead.",
    );
    expect(removal.removedVersion).toEqual({ changeId: await changeOn("supersede", original), scopePath: DEAL });
    const ack = await ingestMemory({
      groupId: ORG,
      content: "Escalations go to the support lead.",
      actorType: "human",
      actorId: WRITER,
      origin: "app",
      scopePath: DEAL,
      resolve: false,
      correctionOf: {
        factId: original,
        removalId: removal.removedVersion!.changeId,
        scopePath: removal.removedVersion!.scopePath,
      },
    });

    expect(ack.readableNow).toBe(true);
    expect(await supersedesEdges()).toEqual([`${ack.versionId}>${original}`]);
  });

  it("a correction naming a removal that is not this fact's records nothing", async () => {
    const corrected = await agentWrites("agent-ops", "Escalations", "Escalations go to the on-call engineer.");
    const other = await agentWrites("agent-ops", "Paging", "Paging goes to the on-call engineer.");
    const writer = person(ORG, WRITER, "member").ctx;
    const otherRemoval = await guardedMemory.removeFact(
      writer,
      { groupId: ORG, factId: other },
      DEAL,
      "Paging goes to the duty manager.",
    );
    // Another fact's removal, and this fact's own create: neither is this fact's removal.
    for (const removalId of [otherRemoval.removedVersion!.changeId, await changeOn("create", corrected)]) {
      await ingestMemory({
        groupId: ORG,
        content: `Escalations go to the support lead (${removalId}).`,
        actorType: "human",
        actorId: WRITER,
        origin: "app",
        scopePath: DEAL,
        resolve: false,
        correctionOf: { factId: corrected, removalId, scopePath: DEAL },
      });
    }

    expect(await supersedesEdges()).toEqual([]);
    expect(await served()).toContain("Escalations go to the on-call engineer.");
  });

  it("the same correction made twice to one brief is one version per fact it overruled", async () => {
    const first = await agentWrites("agent-ops", "Escalations", "Escalations go to the on-call engineer.");
    const second = await agentWrites("agent-ops", "Paging", "Paging goes to the on-call engineer.");
    const handoff = await db.brief.create({
      data: { orgId: ORG, type: "handoff", scopePath: DEAL, title: "Handoff", summary: "x", sections: [] },
    });
    for (const contradicted of [first, second]) {
      brief.contradiction = { uuid: contradicted, fact: "on-call", actorType: "agent" };
      expect((await correctBriefAs("Escalations go to the support lead.", handoff.id)).status).toBe(200);
      await runQueuedJobs();
    }
    // Each correction is filed under a name that says which fact it overruled
    // (services/memory/correction-names.ts), so each is its own version, replacing its own fact.
    const named = async (factId: string) =>
      (
        await db.memoryChunk.findFirstOrThrow({
          where: { orgId: ORG, entityName: briefCorrectionName(handoff.id, WRITER, factId) },
          select: { id: true },
        })
      ).id;
    expect(await supersedesEdges()).toEqual(
      [`${await named(first)}>${first}`, `${await named(second)}>${second}`].sort(),
    );
  });

  it("a correction that opens a dispute with a person's fact replaces nothing", async () => {
    const original = await agentWrites("agent-ops", "Escalations", "Escalations go to the on-call engineer.");
    brief.contradiction = { uuid: original, fact: "Escalations go to the on-call engineer.", actorType: "human" };
    expect(await (await correctBriefAs("Escalations go to the support lead.")).json()).toMatchObject({
      autoMerged: false,
    });
    await runQueuedJobs();

    expect(await supersedesEdges()).toEqual([]);
    expect(await served()).toEqual(["Escalations go to the on-call engineer.", "Escalations go to the support lead."]);
  });

  it("a brief correction of a fact the correcting person's own version already superseded leaves it to that version", async () => {
    // The person's own write lands first; an agent's write of the same fact in the
    // contention window loses to it, and that loss is announced as a `supersede` on the
    // agent's fact attributed to the winner's writer: the person.
    const ack = await ingestMemory({
      groupId: ORG,
      content: "Escalations go to the support lead.",
      name: "Escalations",
      scopePath: DEAL,
      actorType: "human",
      actorId: WRITER,
      origin: "app",
      resolve: false,
    });
    await runQueuedJobs();
    const winner = ack.versionId!;
    const loser = await agentWrites("agent-two", "Escalations", "Escalations go to the night desk.");
    expect(await supersedesEdges()).toEqual([`${winner}>${loser}`]);

    brief.contradiction = { uuid: loser, fact: "Escalations go to the night desk.", actorType: "agent" };
    const res = await correctBriefAs("Escalations go to the duty manager.");
    expect(await res.json()).toMatchObject({ ok: true, autoMerged: false });
    await runQueuedJobs();

    // The loser keeps its one replacement; the correction is stored as a fact of its own.
    expect(await db.memoryChunk.count({ where: { id: loser } })).toBe(1);
    expect(await supersedesEdges()).toEqual([`${winner}>${loser}`]);
    expect(await served()).toContain("Escalations go to the duty manager.");
  });

  it("a second correction whose own removal removed nothing is not recorded as replacing the fact", async () => {
    const original = await agentWrites("agent-ops", "Escalations", "Escalations go to the on-call engineer.");
    brief.contradiction = { uuid: original, fact: "Escalations go to the on-call engineer.", actorType: "agent" };
    expect((await correctBriefAs("Escalations go to the support lead.")).status).toBe(200);
    await runQueuedJobs();
    const first = await versionOf("Escalations go to the support lead.");
    // The same person corrects another brief against the same, already removed, fact: its
    // removal removes nothing and announces nothing.
    expect((await correctBriefAs("Escalations go to the duty manager.")).status).toBe(200);
    await runQueuedJobs();

    expect(await db.changeEvent.count({ where: { orgId: ORG, op: "supersede", recordId: original } })).toBe(1);
    expect(await supersedesEdges()).toEqual([`${first}>${original}`]);
  });

  it("a correction re-submitted after an agent updated it is a new version replacing the update, and records no cycle", async () => {
    const handoff = await db.brief.create({
      data: { orgId: ORG, type: "handoff", scopePath: DEAL, title: "Handoff", summary: "x", sections: [] },
    });
    const first = await agentWrites("agent-ops", "Escalations", "Escalations go to the on-call engineer.");
    brief.contradiction = { uuid: first, fact: "Escalations go to the on-call engineer.", actorType: "agent" };
    await correctBriefAs("Escalations go to the support lead.", handoff.id);
    await runQueuedJobs();
    const correction = await versionOf("Escalations go to the support lead.");
    // An agent updates the correction it read, naming it as its base.
    const update = await ingestMemory({
      groupId: ORG,
      content: "Escalations go to the night desk.",
      name: briefCorrectionName(handoff.id, WRITER, first),
      scopePath: DEAL,
      actorType: "agent",
      actorId: "agent-ops",
      actorName: "agent-ops",
      source: "mcp",
      origin: "mcp",
      baseVersion: correction,
    });
    await runQueuedJobs();
    const updated = update.versionId!;
    // The same correction again, overruling the update: filed under a name that names the
    // update, it is a version of its own, which replaces the update and nothing before it.
    brief.contradiction = { uuid: updated, fact: "Escalations go to the night desk.", actorType: "agent" };
    expect((await correctBriefAs("Escalations go to the support lead.", handoff.id)).status).toBe(200);
    await runQueuedJobs();
    const resubmitted = (
      await db.memoryChunk.findFirstOrThrow({
        where: { orgId: ORG, entityName: briefCorrectionName(handoff.id, WRITER, updated) },
        select: { id: true },
      })
    ).id;

    expect(await supersedesEdges()).toEqual(
      [`${correction}>${first}`, `${updated}>${correction}`, `${resubmitted}>${updated}`].sort(),
    );
  });

  it("a correction at the org root of a deal fact the feed never announced names nothing", async () => {
    // A fact stored in the deal before the change feed existed: a row, no `create` event.
    await db.$executeRaw`
      INSERT INTO memory_chunks ("id","orgId","content","source","actorType","actorId","entityName","scopePath","createdAt")
      VALUES ('legacy-fact-1', ${ORG}, 'Escalations go to the on-call engineer.', 'mcp', 'agent', 'agent-ops', 'Escalations', ${DEAL}, now() - interval '30 days')
    `;
    as(ORG, ADMIN, "admin");
    expect(await patch("legacy-fact-1", "Escalations go to the support lead.")).toBe(202);
    const correction = await versionOf("Escalations go to the support lead.");

    expect(await supersedesEdges()).toEqual([]);
    expect((await detail(await changeOn("create", correction), ROOT)).lineage).toEqual(NOTHING);
  });

  it("a correction whose removal failed records nothing, and the fact it named is still served", async () => {
    const original = await agentWrites("agent-ops", "Escalations", "Escalations go to the on-call engineer.");
    brief.contradiction = { uuid: original, fact: "Escalations go to the on-call engineer.", actorType: "agent" };
    brief.graphRemovalFails = true;
    const res = await correctBriefAs("Escalations go to the support lead.");
    expect(res.status).toBe(502);
    // The person is told what happened: the correction is saved, the fact was not removed.
    expect(await res.json()).toEqual({
      error: "Your correction was saved, but the fact it overrules was not removed: memory service unavailable",
    });
    await runQueuedJobs();

    expect(await db.changeEvent.count({ where: { orgId: ORG, op: "supersede" } })).toBe(0);
    expect(await supersedesEdges()).toEqual([]);
    expect(await served()).toEqual(["Escalations go to the on-call engineer.", "Escalations go to the support lead."]);
  });

  it("a removal that fails in an unexpected way still says the correction was saved", async () => {
    const original = await agentWrites("agent-ops", "Escalations", "Escalations go to the on-call engineer.");
    brief.contradiction = { uuid: original, fact: "Escalations go to the on-call engineer.", actorType: "agent" };
    brief.graphRemovalFails = "unexpectedly";
    const res = await correctBriefAs("Escalations go to the support lead.");
    await runQueuedJobs();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "Your correction was saved, but the fact it overrules was not removed.",
    });
    expect(await served()).toEqual(["Escalations go to the on-call engineer.", "Escalations go to the support lead."]);
  });

  it("a brief correction of a conflict's loser leaves it to its winner", async () => {
    const winner = await agentWrites("agent-one", "Escalations", "Escalations go to the on-call engineer.");
    const loser = await agentWrites("agent-two", "Escalations", "Escalations go to the night desk.");
    expect(await supersedesEdges()).toEqual([`${winner}>${loser}`]);
    brief.contradiction = { uuid: loser, fact: "Escalations go to the night desk.", actorType: "agent" };
    expect(await (await correctBriefAs("Escalations go to the support lead.")).json()).toMatchObject({
      autoMerged: false,
    });
    await runQueuedJobs();

    expect(await db.memoryChunk.count({ where: { id: loser } })).toBe(1);
    expect(await supersedesEdges()).toEqual([`${winner}>${loser}`]);
  });

  it("an erased person's text never comes back through a correction's lineage, from a restored row or a restored summary", async () => {
    const original = await agentWrites("agent-ops", "Escalations", `Escalations go to ${DANA.name} (${DANA.email}).`);
    const originalRow = await db.$queryRaw<
      { createdAt: Date }[]
    >`SELECT "createdAt" FROM memory_chunks WHERE id = ${original}`;
    const originalCreate = await db.changeEvent.findFirstOrThrow({
      where: { orgId: ORG, op: "create", recordId: original },
    });
    as(ORG, WRITER);
    await patch(original, "Escalations go to the support lead.", DEAL);
    const corrected = await versionOf("Escalations go to the support lead.");
    const correctedRow = await db.$queryRaw<{ entityName: string; createdAt: Date; embedding: string }[]>`
      SELECT "entityName", "createdAt", embedding::text AS embedding FROM memory_chunks WHERE id = ${corrected}
    `;
    const createdId = await changeOn("create", corrected);
    expect((await detail(createdId, DEAL)).lineage.replacesIds).toEqual([original]);

    await db.contact.create({
      data: {
        id: "dana",
        orgId: ORG,
        name: DANA.name,
        email: DANA.email,
        createdAt: new Date(Date.now() - 86_400_000),
      },
    });
    await erasePerson(person(ORG, ADMIN, "admin").ctx, { contactId: "dana" });
    // The correction was written in place of a fact that named her, so it goes with it
    // (services/memory/erasure-lineage.ts): neither end of the lineage is named any more.
    const afterErasure = await detail(createdId, DEAL);
    expect(afterErasure.lineage).toEqual(NOTHING);
    expect(afterErasure.text).not.toMatch(/Dana|Whitfield|dana@|support lead/i);
    expect(await version(corrected)).toMatchObject({ status: 404 });
    expect(await served()).toEqual([]);

    // A restored backup puts the correction's row back: it is known by its id, and stays hidden.
    const restoreCorrection = () => db.$executeRaw`
      INSERT INTO memory_chunks ("id","orgId","content","source","actorType","actorId","entityName","scopePath","factVersion","embedding","createdAt")
      VALUES (${corrected}, ${ORG}, 'Escalations go to the support lead.', 'text', 'human', ${WRITER}, ${correctedRow[0]!.entityName}, ${DEAL}, true, ${correctedRow[0]!.embedding}::vector, ${correctedRow[0]!.createdAt})
    `;
    await restoreCorrection();
    expect(await version(corrected)).toMatchObject({ status: 404 });
    expect(await served()).toEqual([]);

    // An erasure recorded before versions were kept by id is matched by text alone. The
    // original's restored announcement, or its restored row, still keeps it out of the
    // correction's lineage.
    await db.erasureSuppression.deleteMany({ where: { orgId: ORG, kind: "version_id" } });
    expect((await detail(createdId, DEAL)).lineage.replacesIds).toEqual([original]);
    await db.changeEvent.update({ where: { id: originalCreate.id }, data: { summary: originalCreate.summary } });
    const restoredSummary = await detail(createdId, DEAL);
    expect(restoredSummary.lineage).toEqual(NOTHING);
    expect(restoredSummary.text).not.toMatch(/Dana|Whitfield|dana@/i);
    expect(await version(corrected)).toMatchObject({ version: { status: "current", supersedesIds: [] } });

    await db.changeEvent.update({ where: { id: originalCreate.id }, data: { summary: "" } });
    await db.$executeRaw`
      INSERT INTO memory_chunks ("id","orgId","content","source","actorType","actorId","entityName","scopePath","createdAt")
      VALUES (${original}, ${ORG}, ${`Escalations go to ${DANA.name} (${DANA.email}).`}, 'mcp', 'agent', 'agent-ops', 'Escalations', ${DEAL}, ${originalRow[0]!.createdAt})
    `;
    expect((await detail(createdId, DEAL)).lineage).toEqual(NOTHING);
    expect(await version(corrected)).toMatchObject({ version: { supersedesIds: [] } });
  });

  it("a version an erased version replaced stays superseded, without naming it", async () => {
    const winner = await agentWrites("agent-one", "Escalations", `Escalations go to ${DANA.name}.`);
    const loser = await agentWrites("agent-two", "Escalations", "Escalations go to the night desk.");
    const winnerRow = await db.$queryRaw<
      { createdAt: Date }[]
    >`SELECT "createdAt" FROM memory_chunks WHERE id = ${winner}`;
    expect(await version(loser)).toMatchObject({ version: { status: "superseded", supersededById: winner } });

    await db.contact.create({
      data: {
        id: "dana",
        orgId: ORG,
        name: DANA.name,
        email: DANA.email,
        createdAt: new Date(Date.now() - 86_400_000),
      },
    });
    await erasePerson(person(ORG, ADMIN, "admin").ctx, { contactId: "dana" });
    // A restored backup puts the winner's row back.
    await db.$executeRaw`
      INSERT INTO memory_chunks ("id","orgId","content","source","actorType","actorId","entityName","scopePath","factVersion","createdAt")
      VALUES (${winner}, ${ORG}, ${`Escalations go to ${DANA.name}.`}, 'mcp', 'agent', 'agent-one', 'Escalations', ${DEAL}, true, ${winnerRow[0]!.createdAt})
    `;

    expect(await version(winner)).toMatchObject({ status: 404 });
    expect(await version(loser)).toMatchObject({ version: { status: "superseded", supersededById: null } });
    expect((await detail(await changeOn("supersede", loser), DEAL)).lineage).toEqual(NOTHING);
  });

  describe("a correction the queue does not take", () => {
    const PATCH_NOT_SAVED =
      "The fact was removed, but your corrected text was not confirmed as saved. If it does not show in memory within a minute, add it again as a new fact.";
    const BRIEF_NOT_SAVED =
      "The fact this corrects was removed, but your correction was not confirmed as saved. If it does not show in memory within a minute, submit it again.";

    it("a PATCH the queue does not take after the removal says the fact is gone and what to do", async () => {
      const original = await agentWrites("agent-ops", "Escalations", "Escalations go to the on-call engineer.");
      as(ORG, WRITER);
      const reply = await withQueueDown(() => patchReply(original, "Escalations go to the support lead.", DEAL));

      expect(reply).toEqual({ status: 503, body: { error: PATCH_NOT_SAVED, factRemoved: true } });
      expect(await served()).toEqual([]);
      expect(await db.changeEvent.count({ where: { orgId: ORG, op: "supersede", recordId: original } })).toBe(1);
      expect(await supersedesEdges()).toEqual([]);
    });

    it("a PATCH whose ingest meets the cap another writer just reached says the fact is gone", async () => {
      const original = await agentWrites("agent-ops", "Escalations", "Escalations go to the on-call engineer.");
      brief.capAllows = 1; // the route's own check passes; the ingest's, after the removal, refuses
      as(ORG, WRITER);
      const reply = await patchReply(original, "Escalations go to the support lead.", DEAL);

      expect(reply).toEqual({ status: 503, body: { error: PATCH_NOT_SAVED, factRemoved: true } });
      expect(await served()).toEqual([]);
      expect(await supersedesEdges()).toEqual([]);
    });

    it("a PATCH at the cap is refused before the fact is removed", async () => {
      const original = await agentWrites("agent-ops", "Escalations", "Escalations go to the on-call engineer.");
      brief.capAllows = 0;
      as(ORG, WRITER);
      const reply = await patchReply(original, "Escalations go to the support lead.", DEAL);

      expect(reply).toEqual({
        status: 402,
        body: { error: "Free plan memory cap (1000 episodes) reached — upgrade to keep adding memory" },
      });
      expect(await served()).toEqual(["Escalations go to the on-call engineer."]);
      expect(await db.changeEvent.count({ where: { orgId: ORG, op: "supersede" } })).toBe(0);
    });

    it("a brief correction the queue does not take after the removal says the fact is gone and what to do", async () => {
      const original = await agentWrites("agent-ops", "Escalations", "Escalations go to the on-call engineer.");
      brief.contradiction = { uuid: original, fact: "Escalations go to the on-call engineer.", actorType: "agent" };
      const res = await withQueueDown(() => correctBriefAs("Escalations go to the support lead."));

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: BRIEF_NOT_SAVED, factRemoved: true });
      expect(await served()).toEqual([]);
      expect(await db.feedbackEvent.count({ where: { orgId: ORG } })).toBe(0);
    });

    it("a brief correction with nothing to overrule whose ingest meets the cap another writer just reached is refused at the cap", async () => {
      await agentWrites("agent-ops", "Escalations", "Escalations go to the on-call engineer.");
      brief.capAllows = 1; // the route's own check passes; the ingest's refuses
      const res = await correctBriefAs("Escalations go to the support lead.");

      expect(res.status).toBe(402);
      expect(await res.json()).toEqual({
        error: "Free plan memory cap (1000 episodes) reached — upgrade to keep adding memory",
      });
      expect(await served()).toEqual(["Escalations go to the on-call engineer."]);
    });

    it("a brief correction overruling an agent fact that is no longer stored is not reported as merged", async () => {
      brief.contradiction = {
        uuid: "no-longer-stored",
        fact: "Escalations go to the on-call engineer.",
        actorType: "agent",
      };
      const res = await correctBriefAs("Escalations go to the support lead.");
      await runQueuedJobs();

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, autoMerged: false });
      expect(await served()).toEqual(["Escalations go to the support lead."]);
    });

    it("a brief correction with no contradiction is refused at the cap before anything is searched or stored", async () => {
      await agentWrites("agent-ops", "Escalations", "Escalations go to the on-call engineer.");
      brief.capAllows = 0;
      const res = await correctBriefAs("Escalations go to the support lead.");

      expect(res.status).toBe(402);
      expect(await res.json()).toEqual({
        error: "Free plan memory cap (1000 episodes) reached — upgrade to keep adding memory",
      });
      expect(await served()).toEqual(["Escalations go to the on-call engineer."]);
    });
  });

  describe("one replacement per version", () => {
    it("a PATCH of a version an update already replaced is refused with the version in force, and changes nothing", async () => {
      const original = await agentWrites("agent-ops", "Escalations", "Escalations go to the on-call engineer.");
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
      as(ORG, WRITER);
      const reply = await patchReply(original, "Escalations go to the support lead.", DEAL);

      expect(reply).toEqual({
        status: 409,
        body: {
          error: `This fact (${original}) was already replaced by ${update.versionId}. Correct ${update.versionId}, the version in force, instead. Nothing was changed.`,
          currentVersionId: update.versionId,
        },
      });
      expect(await db.memoryChunk.count({ where: { id: original } })).toBe(1);
      expect(await db.changeEvent.count({ where: { orgId: ORG, op: "supersede", recordId: original } })).toBe(1);
      expect(await supersedesEdges()).toEqual([`${update.versionId}>${original}`]);
    });

    it("a replaced version in a scope the corrector cannot delete in reads as absent, not as replaced", async () => {
      const dealB = `${ROOT}.deal_b`;
      await db.scope.create({ data: { orgId: ORG, path: dealB, name: "deal_b" } });
      const original = await agentWrites("agent-ops", "Escalations", "Escalations go to the on-call engineer.", dealB);
      await ingestMemory({
        groupId: ORG,
        content: "Escalations go to the night desk.",
        name: "Escalations",
        scopePath: dealB,
        actorType: "agent",
        actorId: "agent-ops",
        actorName: "agent-ops",
        source: "mcp",
        origin: "mcp",
        baseVersion: original,
      });
      await runQueuedJobs();
      as(ORG, WRITER);

      const hidden = await patchReply(original, "Escalations go to the support lead.", DEAL);
      const absent = await patchReply("no-such-version", "Escalations go to the support lead.", DEAL);
      expect(hidden).toEqual(absent);
      expect(hidden.status).toBe(404);
    });

    it("a correction at the org root of an untagged version another one replaced is refused with the version in force", async () => {
      // A row from before scopes were stored has no scope path; it lives at the org root.
      for (const [id, content] of [
        ["untagged-old", "Escalations go to the on-call engineer."],
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
      as(ORG, ADMIN, "admin");
      const reply = await patchReply("untagged-old", "Escalations go to the support lead.");

      expect(reply).toMatchObject({ status: 409, body: { currentVersionId: "untagged-new" } });
      expect(await db.memoryChunk.count({ where: { id: "untagged-old" } })).toBe(1);
    });

    it("the already-replaced check reads only this org's rows, even an untagged one at the root", async () => {
      // Another org's untagged row under an id this org's lineage names as replaced: this org
      // stores no such version, so its admin's correction at the root reads as absent.
      await db.$executeRaw`
        INSERT INTO memory_chunks ("id","orgId","content","source","actorType","createdAt")
        VALUES ('fact-elsewhere', ${OTHER}, 'Escalations go to the night desk.', 'mcp', 'agent', now())
      `;
      await db.factEdge.create({
        data: {
          orgId: ORG,
          fromId: "v-here",
          toId: "fact-elsewhere",
          kind: "supersedes",
          scopePath: ROOT,
          actorType: "agent",
          actorId: "agent-ops",
        },
      });
      as(ORG, ADMIN, "admin");

      expect(await patchReply("fact-elsewhere", "Escalations go to the support lead.")).toEqual({
        status: 404,
        body: { error: "fact not found" },
      });
      expect(await db.memoryChunk.count({ where: { id: "fact-elsewhere" } })).toBe(1);
    });

    it("a correction announced after another version replaced the fact it removed records no second replacement", async () => {
      const original = await agentWrites("agent-ops", "Escalations", "Escalations go to the on-call engineer.");
      const writer = person(ORG, WRITER, "member").ctx;
      const removal = await guardedMemory.removeFact(
        writer,
        { groupId: ORG, factId: original },
        DEAL,
        "Escalations go to the support lead.",
      );
      // Between the removal and the correction's announcement, another version is recorded as
      // the fact's replacement (a race the guard's check before the removal cannot see).
      await db.factEdge.create({
        data: {
          orgId: ORG,
          fromId: "v-raced",
          toId: original,
          kind: "supersedes",
          scopePath: DEAL,
          actorType: "agent",
          actorId: "agent-ops",
        },
      });
      const ack = await ingestMemory({
        groupId: ORG,
        content: "Escalations go to the support lead.",
        actorType: "human",
        actorId: WRITER,
        origin: "app",
        scopePath: DEAL,
        resolve: false,
        correctionOf: {
          factId: original,
          removalId: removal.removedVersion!.changeId,
          scopePath: removal.removedVersion!.scopePath,
        },
      });

      expect(ack.readableNow).toBe(true);
      expect(await supersedesEdges()).toEqual([`v-raced>${original}`]);
    });
  });
});
