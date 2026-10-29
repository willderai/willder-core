// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres (and, for the PROV case, PROV_PYTHON names the validator's Python); without
// them these tests skip, not fail.
//
// QA for the "accepted" authorization kind, at the boundaries the builder's suite
// (accepted-content-names-its-acceptor.realdb.test.ts) does not reach:
//
//   - Onboarding's new check is a check at the ORG ROOT: a member who may write only in a
//     team scope is refused, and nothing reaches memory or preferences.
//   - The acceptor is read from the authorizing row IN THE CHANGE'S OWN ORG: a change whose
//     authorizedById names another org's person's allow row is not "accepted" by them, and
//     that person is never named as actingFor.
//   - A brief persisted by a team-scoped writer exports as PROV the reference validator
//     accepts, with that writer as the responsible agent and the kind carried through.
//
// Real: Postgres, the routes, check(), ingestMemory with its write-through to pgvector, the
// timeline detail and PROV routes, the PROV validator. Doubles: the signed-in session, the
// embedding service, the graph service and the model (same doubles as the builder's file).
// embedding service (one fixed vector), the graph service and the model.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";
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
import { PROV_PYTHON, validateProv } from "@/services/audit/prov-validator.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "qaaccept";
const ROOT = `org_${ORG}`;
const TEAM = `${ROOT}.deals`;
const OTHER_ORG = "qaacceptother";
const OTHER_ROOT = `org_${OTHER_ORG}`;
const DIMENSIONS = 384;

type Person = { id: string; name: string | null; email: string };
type ChangeAnswer = {
  writer: string;
  actingFor: string | null;
  authorizedById: string | null;
  authorizationKind: string | null;
};

describe.skipIf(!QA_URL)("accepted content: scope, tenant and PROV boundaries", () => {
  let db: PrismaClient;
  let persistRoute: (typeof import("@/app/api/briefs/[id]/persist/route"))["POST"];
  let onboardingRoute: (typeof import("@/app/api/onboarding/route"))["POST"];
  let changeRoute: (typeof import("@/app/api/audit/timeline/[changeId]/route"))["GET"];
  let provRoute: (typeof import("@/app/api/audit/timeline/[changeId]/prov/route"))["GET"];
  let owner: Person;
  let teamWriter: Person;
  let outsider: Person;

  function signIn(
    orgId: string,
    person: Person,
    role: Extract<AccessContext["actor"], { type: "human" }>["role"],
  ): void {
    const ctx: AccessContext = {
      orgId,
      actor: { type: "human", id: person.id, role, name: person.name ?? person.email },
      origin: "app",
    };
    session.current = { org: { id: orgId, name: orgId }, user: person, ctx };
  }

  async function drain(): Promise<void> {
    while (queuedJobs.length > 0) await queuedJobs.shift()!();
  }

  async function factEvents(count: number) {
    return vi.waitFor(async () => {
      await drain();
      const events = await db.changeEvent.findMany({
        where: { orgId: ORG, recordType: "fact" },
        select: { id: true, actorId: true, authorizedById: true },
        orderBy: { seq: "asc" },
      });
      expect(events).toHaveLength(count);
      return events;
    });
  }

  async function answerFor(changeId: string, scope: string): Promise<ChangeAnswer> {
    const res = await changeRoute(new Request(`http://t/api/audit/timeline/${changeId}?scope=${scope}`), {
      params: Promise.resolve({ changeId }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as ChangeAnswer;
  }

  async function persistBrief(): Promise<{ agentId: string }> {
    const agent = await db.agent.create({
      data: { orgId: ORG, agentKey: "handoff", name: "Handoff", role: "handoff" },
    });
    const brief = await db.brief.create({
      data: {
        orgId: ORG,
        type: "handoff",
        scopePath: TEAM,
        title: "Handoff",
        summary: "Renewal is in March.",
        sections: [],
      },
    });
    await db.agentRun.create({ data: { orgId: ORG, agentId: agent.id, briefId: brief.id, status: "completed" } });
    const res = await persistRoute(new Request(`http://t/api/briefs/${brief.id}/persist`, { method: "POST" }), {
      params: Promise.resolve({ id: brief.id }),
    });
    expect(res.status).toBe(200);
    return { agentId: agent.id };
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
    ({ POST: onboardingRoute } = await import("@/app/api/onboarding/route"));
    ({ GET: changeRoute } = await import("@/app/api/audit/timeline/[changeId]/route"));
    ({ GET: provRoute } = await import("@/app/api/audit/timeline/[changeId]/prov/route"));
  });

  afterAll(async () => {
    await db.changeEvent.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
    await db.org.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
    await db.$disconnect();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  beforeEach(async () => {
    queuedJobs.length = 0;
    await db.changeEvent.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
    await db.org.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
    for (const [id, root] of [
      [ORG, ROOT],
      [OTHER_ORG, OTHER_ROOT],
    ] as const) {
      await db.org.create({ data: { id, name: id } });
      await db.scope.create({ data: { orgId: id, path: root, name: root } });
    }
    const rootScope = await db.scope.findFirstOrThrow({ where: { orgId: ORG, path: ROOT } });
    const team = await db.scope.create({ data: { orgId: ORG, path: TEAM, name: "deals" } });
    owner = await db.user.create({
      data: { orgId: ORG, clerkId: "clerk_qaaccept_owner", email: "owner@qaaccept.test", name: "Owner", role: "admin" },
    });
    teamWriter = await db.user.create({
      data: {
        orgId: ORG,
        clerkId: "clerk_qaaccept_team",
        email: "team@qaaccept.test",
        name: "Team Writer",
        role: "member",
      },
    });
    outsider = await db.user.create({
      data: {
        orgId: OTHER_ORG,
        clerkId: "clerk_qaaccept_out",
        email: "out@qaacceptother.test",
        name: "Outsider",
        role: "admin",
      },
    });
    const otherRoot = await db.scope.findFirstOrThrow({ where: { orgId: OTHER_ORG, path: OTHER_ROOT } });
    await db.grant.create({
      data: { orgId: ORG, scopeId: rootScope.id, granteeType: "user", granteeId: owner.id, permission: "admin" },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: team.id, granteeType: "user", granteeId: teamWriter.id, permission: "write" },
    });
    await db.grant.create({
      data: {
        orgId: OTHER_ORG,
        scopeId: otherRoot.id,
        granteeType: "user",
        granteeId: outsider.id,
        permission: "admin",
      },
    });
  });

  it("onboarding refuses a member whose write grant is a team scope, not the org root, and writes nothing", async () => {
    signIn(ORG, teamWriter, "member");
    const res = await onboardingRoute(
      new Request("http://t/api/onboarding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ companyDescription: "Our ICP is now hospitals." }),
      }),
    );
    expect(res.status).toBe(403);
    await drain();
    expect(await db.changeEvent.count({ where: { orgId: ORG } })).toBe(0);
    expect(await db.orgPreference.findUnique({ where: { orgId: ORG } })).toBeNull();
    // The refusal is a visible deny row, not a silent drop.
    expect(
      await db.auditLog.count({
        where: { orgId: ORG, actorId: teamWriter.id, action: "memory.write", decision: "deny" },
      }),
    ).toBe(1);
  });

  it("names no acceptor from another org's allow row, even when a change points at one", async () => {
    // The outsider's own allow row, in their own org.
    signIn(OTHER_ORG, outsider, "admin");
    const res = await onboardingRoute(
      new Request("http://t/api/onboarding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ companyDescription: "Outsider's company." }),
      }),
    );
    expect(res.status).toBe(200);
    await drain();
    const foreignRow = await db.auditLog.findFirstOrThrow({
      where: { orgId: OTHER_ORG, actorId: outsider.id, action: "memory.write", decision: "allow" },
    });

    // An agent's write in ORG, stamped (as if by a faulty or hostile writer) with that row.
    signIn(ORG, teamWriter, "member");
    await persistBrief();
    const [fact] = await factEvents(1);
    await db.changeEvent.update({ where: { id: fact!.id }, data: { authorizedById: foreignRow.id } });

    signIn(ORG, owner, "admin");
    const answer = await answerFor(fact!.id, TEAM);
    expect(answer.authorizationKind).not.toBe("accepted");
    expect(answer.actingFor).not.toBe("Outsider");
    expect(answer.actingFor).not.toBe(outsider.id);
  });

  it.skipIf(!PROV_PYTHON)(
    "a team writer's persisted brief exports as valid PROV naming them as the responsible agent",
    async () => {
      signIn(ORG, teamWriter, "member");
      const { agentId } = await persistBrief();
      const [fact] = await factEvents(1);

      signIn(ORG, owner, "admin");
      expect(await answerFor(fact!.id, TEAM)).toMatchObject({
        authorizationKind: "accepted",
        actingFor: "Team Writer",
      });

      const prov = await provRoute(new Request(`http://t/api/audit/timeline/${fact!.id}/prov?scope=${TEAM}`), {
        params: Promise.resolve({ changeId: fact!.id }),
      });
      expect(prov.status).toBe(200);
      const result = validateProv(await prov.json());
      if (!result.ok) throw new Error(`PROV validator refused the export: ${result.error}`);
      const { author } = result.answers as {
        author: { writer: { id: string }; authorizationKind: string; authority: { id: string; type: string } | null };
      };
      expect(author.authorizationKind).toBe("accepted");
      expect(JSON.stringify(author.writer)).toContain(agentId);
      expect(JSON.stringify(author.authority)).toContain(teamWriter.id);
    },
  );
});
