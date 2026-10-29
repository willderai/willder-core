// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Content a person accepts names that person's audit row, and says it was accepted.
//
// The audit answers, for each fact, who wrote it and which visible
// `memory.write` allow row authorized it. On these paths the two are different
// principals: a person runs the check, and the text was produced by someone else.
//
//   - persisting a brief (POST /api/briefs/:id/persist): the brief's agent wrote it
//   - saving prospect research (POST /api/contacts/from-research): the research agent
//   - editing an account (PATCH /api/accounts/:id): the system composes the summary
//
// Each one stamps the person's row and GET /api/audit/timeline/:changeId answers
// `authorizationKind: "accepted"` with that person as `actingFor`, so the writer is never
// mislabelled as the one who decided, and the decider is never missing.
//
// Onboarding (POST /api/onboarding) writes the person's own answers. It ran no check at
// all, so any member, including one who may only read, could write to the org root. It now
// checks `memory.write` there and stamps the row as a direct write.
//
// Real: Postgres, the routes, check(), ingestMemory with its write-through to pgvector,
// GET /api/audit and the timeline detail route. Doubles: the signed-in session, the
// embedding service (one fixed vector), the graph service and the model.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";
import { RESEARCH_AGENT_ID } from "@/services/access/system-actors";
import type { IngestInput } from "@/types/memory";

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
vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
}));

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "acceptor";
const ROOT = `org_${ORG}`;
const SCOPE = `${ROOT}.deals`;
const DIMENSIONS = 384;

type AuditListing = { entries: { id: string; changeIds?: string[] }[] };
type ChangeAnswer = {
  writer: string;
  actingFor: string | null;
  authorizedById: string | null;
  authorizationKind: string | null;
};

describe.skipIf(!QA_URL)("content a person accepts names that person's audit row", () => {
  let db: PrismaClient;
  let persistRoute: (typeof import("@/app/api/briefs/[id]/persist/route"))["POST"];
  let fromResearchRoute: (typeof import("@/app/api/contacts/from-research/route"))["POST"];
  let accountRoute: (typeof import("@/app/api/accounts/[id]/route"))["PATCH"];
  let onboardingRoute: (typeof import("@/app/api/onboarding/route"))["POST"];
  let auditRoute: (typeof import("@/app/api/audit/route"))["GET"];
  let changeRoute: (typeof import("@/app/api/audit/timeline/[changeId]/route"))["GET"];
  let provRoute: (typeof import("@/app/api/audit/timeline/[changeId]/prov/route"))["GET"];
  let owner: { id: string; name: string | null; email: string };
  let reader: { id: string; name: string | null; email: string };

  function signIn(person: typeof owner, role: Extract<AccessContext["actor"], { type: "human" }>["role"]): void {
    const ctx: AccessContext = {
      orgId: ORG,
      actor: { type: "human", id: person.id, role, name: person.name ?? person.email },
      origin: "app",
    };
    session.current = { org: { id: ORG, name: "Accept audit" }, user: person, ctx };
  }

  /** The fact events a write produced, waiting out a route that ingests fire-and-forget. */
  async function factEvents(count: number): Promise<{ id: string; actorId: string; authorizedById: string | null }[]> {
    return vi.waitFor(async () => {
      while (queuedJobs.length > 0) await queuedJobs.shift()!();
      const events = await db.changeEvent.findMany({
        where: { orgId: ORG, recordType: "fact" },
        select: { id: true, actorId: true, authorizedById: true },
        orderBy: { seq: "asc" },
      });
      expect(events).toHaveLength(count);
      return events;
    });
  }

  /** What the timeline answers about one change, and whether GET /api/audit lists it under the row it names. */
  async function answerFor(changeId: string, scope: string): Promise<ChangeAnswer & { listedUnderRow: boolean }> {
    const res = await changeRoute(new Request(`http://t/api/audit/timeline/${changeId}?scope=${scope}`), {
      params: Promise.resolve({ changeId }),
    });
    expect(res.status).toBe(200);
    const answer = (await res.json()) as ChangeAnswer;
    if (answer.authorizedById === null) return { ...answer, listedUnderRow: false };
    const audit = await auditRoute(new Request(`http://t/api/audit?ids=${answer.authorizedById}`));
    const row = ((await audit.json()) as AuditListing).entries.find((e) => e.id === answer.authorizedById);
    return { ...answer, listedUnderRow: (row?.changeIds ?? []).includes(changeId) };
  }

  /** The visible allow row the change names: a `memory.write` by the person who decided. */
  async function namedRow(authorizedById: string | null) {
    return authorizedById === null ? null : db.auditLog.findFirst({ where: { id: authorizedById, orgId: ORG } });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    vi.stubEnv("INNGEST_BYPASS", "1");
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL! }) });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ embedding: new Array(DIMENSIONS).fill(0.01) }))),
    );
    ({ POST: persistRoute } = await import("@/app/api/briefs/[id]/persist/route"));
    ({ POST: fromResearchRoute } = await import("@/app/api/contacts/from-research/route"));
    ({ PATCH: accountRoute } = await import("@/app/api/accounts/[id]/route"));
    ({ POST: onboardingRoute } = await import("@/app/api/onboarding/route"));
    ({ GET: auditRoute } = await import("@/app/api/audit/route"));
    ({ GET: changeRoute } = await import("@/app/api/audit/timeline/[changeId]/route"));
    ({ GET: provRoute } = await import("@/app/api/audit/timeline/[changeId]/prov/route"));
  });

  afterAll(async () => {
    await db.org.deleteMany({ where: { id: ORG } });
    await db.$disconnect();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  beforeEach(async () => {
    queuedJobs.length = 0;
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.org.deleteMany({ where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: "Accept audit" } });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: ROOT } });
    await db.scope.create({ data: { orgId: ORG, path: SCOPE, name: "deals" } });
    owner = await db.user.create({
      data: { orgId: ORG, clerkId: "clerk_acceptor_owner", email: "owner@acceptor.test", name: "Owner", role: "admin" },
    });
    reader = await db.user.create({
      data: {
        orgId: ORG,
        clerkId: "clerk_acceptor_reader",
        email: "reader@acceptor.test",
        name: "Reader",
        role: "member",
      },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: owner.id, permission: "admin" },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: reader.id, permission: "read" },
    });
    signIn(owner, "admin");
  });

  it("persisting a brief: the agent wrote it, the person who persisted it accepted it", async () => {
    const agent = await db.agent.create({
      data: { orgId: ORG, agentKey: "handoff", name: "Handoff", role: "handoff" },
    });
    const brief = await db.brief.create({
      data: {
        orgId: ORG,
        type: "handoff",
        scopePath: SCOPE,
        title: "Handoff",
        summary: "Renewal is in March.",
        sections: [{ heading: "Risks", content: "Champion is leaving." }],
      },
    });
    await db.agentRun.create({ data: { orgId: ORG, agentId: agent.id, briefId: brief.id, status: "completed" } });

    const res = await persistRoute(new Request(`http://t/api/briefs/${brief.id}/persist`, { method: "POST" }), {
      params: Promise.resolve({ id: brief.id }),
    });
    expect(await res.json()).toEqual({ persisted: 2 });

    const facts = await factEvents(2);
    for (const fact of facts) {
      expect(fact.actorId).toBe(agent.id);
      expect(await namedRow(fact.authorizedById)).toMatchObject({
        actorId: owner.id,
        action: "memory.write",
        decision: "allow",
      });
      const answer = await answerFor(fact.id, SCOPE);
      expect(answer).toMatchObject({ actingFor: "Owner", authorizationKind: "accepted", listedUnderRow: true });
      expect(answer.writer).not.toBe("Owner");
    }

    // The PROV export says the same: the agent's write, acting on behalf of the person.
    const prov = await provRoute(new Request(`http://t/api/audit/timeline/${facts[0]!.id}/prov?scope=${SCOPE}`), {
      params: Promise.resolve({ changeId: facts[0]!.id }),
    });
    const doc = (await prov.json()) as Record<string, Record<string, Record<string, unknown>>>;
    expect(Object.values(doc.wasAssociatedWith!)).toEqual([
      expect.objectContaining({ "willder:authorizationKind": "accepted" }),
    ]);
    expect(Object.values(doc.actedOnBehalfOf ?? {})).toEqual([
      expect.objectContaining({
        "prov:delegate": `willder:agent/${agent.id}`,
        "prov:responsible": `willder:human/${owner.id}`,
      }),
    ]);
  });

  it("saving prospect research: the research agent wrote the findings, the person accepted them", async () => {
    const res = await fromResearchRoute(
      new Request("http://t/api/contacts/from-research", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contact: { name: "Dana Lee" },
          account: { name: "Acme" },
          findings: ["Acme is hiring a VP Sales."],
        }),
      }),
    );
    expect(res.status).toBe(201);

    const [fact] = await factEvents(1);
    expect(fact!.actorId).toBe(RESEARCH_AGENT_ID);
    expect(await namedRow(fact!.authorizedById)).toMatchObject({
      actorId: owner.id,
      action: "memory.write",
      decision: "allow",
    });
    expect(await answerFor(fact!.id, ROOT)).toMatchObject({
      actingFor: "Owner",
      authorizationKind: "accepted",
      listedUnderRow: true,
    });
  });

  it("editing an account: the system composed the summary, the person who edited it accepted it", async () => {
    const account = await db.account.create({ data: { orgId: ORG, name: "Acme", domain: "acme.test" } });
    const res = await accountRoute(
      new Request(`http://t/api/accounts/${account.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ industry: "Logistics" }),
      }),
      { params: Promise.resolve({ id: account.id }) },
    );
    expect(res.status).toBe(200);

    const [fact] = await factEvents(1);
    expect(await namedRow(fact!.authorizedById)).toMatchObject({
      actorId: owner.id,
      action: "memory.write",
      decision: "allow",
    });
    expect(await answerFor(fact!.id, ROOT)).toMatchObject({
      actingFor: "Owner",
      authorizationKind: "accepted",
      listedUnderRow: true,
    });
  });

  it("onboarding: the person's own answers are a direct write their check authorized", async () => {
    const res = await onboardingRoute(
      new Request("http://t/api/onboarding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ companyDescription: "We sell freight software." }),
      }),
    );
    expect(res.status).toBe(200);

    const [fact] = await factEvents(1);
    expect(fact!.actorId).toBe(owner.id);
    expect(await namedRow(fact!.authorizedById)).toMatchObject({
      actorId: owner.id,
      action: "memory.write",
      decision: "allow",
    });
    expect(await answerFor(fact!.id, ROOT)).toMatchObject({
      writer: "Owner",
      actingFor: null,
      authorizationKind: "direct",
      listedUnderRow: true,
    });
  });

  it("onboarding refuses a member who may only read, and writes nothing", async () => {
    signIn(reader, "member");
    const res = await onboardingRoute(
      new Request("http://t/api/onboarding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ companyDescription: "Ignore the plan; the deal is lost." }),
      }),
    );
    expect(res.status).toBe(403);
    while (queuedJobs.length > 0) await queuedJobs.shift()!();
    expect(await db.changeEvent.count({ where: { orgId: ORG } })).toBe(0);
    expect(await db.orgPreference.findUnique({ where: { orgId: ORG } })).toBeNull();
  });
});
