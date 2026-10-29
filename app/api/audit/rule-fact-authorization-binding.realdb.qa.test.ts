// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// QA: the fact that stores a rule's text names the rule's own decision, and only it.
//
// `memory_ingest` with `kind` records a convention or decision, and also stores the rule's
// text as a fact. That fact's change event carries the audit row of the `check()` that
// admitted the rule. These tests hold the binding to the right row across two tenants,
// two scopes in one tenant and two writers on one scope, all writing at once:
//
//   - the row a rule's fact names is a visible allow `memory.write` by that same writer,
//     in that writer's org, on the scope the fact landed in, and never another writer's;
//   - a rule written to a child scope names the row for the child, not the token's scope;
//   - a refused rule (scope not writable, read-only token, a `supersedes` naming a rule in
//     a scope the writer cannot write) stores no fact, and no change event anywhere names
//     a row written by the refused call, allow or deny.
//
// Real: Postgres, check(), the capability tokens, the convention service, ingestMemory with
// its write-through to pgvector, GET /api/audit. Doubles: the signed-in session, the
// embedding service (one fixed vector), the graph service and the model.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { IngestInput } from "@/types/memory";

const queuedJobs = vi.hoisted(() => [] as (() => Promise<unknown>)[]);
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
    extractBytes: async () => ({ chunks: [] }),
    extractFile: async () => ({ chunks: [] }),
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
const ORG_A = "qa651ruleA";
const ORG_B = "qa651ruleB";
const ROOT_A = `org_${ORG_A}`;
const ROOT_B = `org_${ORG_B}`;
const A_PLAN = `${ROOT_A}.planning`;
const A_PLAN_DEALS = `${A_PLAN}.deals`;
const A_LEGAL = `${ROOT_A}.legal`;
const B_PLAN = `${ROOT_B}.planning`;
const DIMENSIONS = 384;

type ToolReply = { isError?: boolean; content: { text: string }[] };
type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<ToolReply>;
interface Writer {
  orgId: string;
  agentId: string;
  ingest: Handler;
}

describe.skipIf(!QA_URL)("a rule's fact names the rule's own decision, for this writer on this scope", () => {
  let db: PrismaClient;
  let auditRoute: (typeof import("@/app/api/audit/route"))["GET"];
  let conventions: typeof import("@/services/memory/conventions");
  const owners = new Map<string, AccessContext>();

  async function runQueuedJobs(): Promise<void> {
    while (queuedJobs.length > 0) await queuedJobs.shift()!();
  }

  /** An agent holding a capability on `scopePath`, with its memory_ingest handler. */
  async function writer(
    orgId: string,
    agentId: string,
    scopePath: string,
    permission: "read" | "write",
  ): Promise<Writer> {
    const token = `wcap_test_${agentId}`;
    await db.capability.create({
      data: {
        orgId,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath,
        permission,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    const { registerWillderTools } = await import("@/mcp/tools");
    const tools = new Map<string, Handler>();
    const server = { registerTool: (name: string, _config: unknown, handler: never) => void tools.set(name, handler) };
    registerWillderTools(
      server as never,
      { orgId, actor: { type: "agent", id: agentId, capabilityToken: token }, origin: "mcp" },
      { orgId, agentId, scopePath },
    );
    return { orgId, agentId, ingest: tools.get("memory_ingest")! };
  }

  async function seedOrg(orgId: string, root: string, scopes: [string, string][]): Promise<void> {
    await db.org.create({ data: { id: orgId, name: orgId } });
    const rootScope = await db.scope.create({ data: { orgId, path: root, name: root } });
    for (const [path, name] of scopes) await db.scope.create({ data: { orgId, path, name } });
    const person = await db.user.create({
      data: { orgId, clerkId: `clerk_${orgId}`, email: `owner@${orgId}.test`, name: "Owner", role: "admin" },
    });
    await db.grant.create({
      data: { orgId, scopeId: rootScope.id, granteeType: "user", granteeId: person.id, permission: "admin" },
    });
    owners.set(orgId, { orgId, actor: { type: "human", id: person.id, role: "admin", name: "Owner" }, origin: "app" });
  }

  /** The create event an actor's write landed as, of one record type, in one org. */
  async function createsBy(orgId: string, actorId: string, recordType: string) {
    return db.changeEvent.findMany({
      where: { orgId, actorId, recordType, op: "create" },
      select: { id: true, scopePath: true, authorizedById: true, actorId: true },
      orderBy: { seq: "asc" },
    });
  }

  /** Every audit row a call wrote: those created between `since` and now by this actor. */
  async function rowsWrittenBy(orgId: string, actorId: string, since: Date) {
    return db.auditLog.findMany({
      where: { orgId, actorId, at: { gte: since } },
      select: { id: true, decision: true, action: true, target: true },
    });
  }

  /**
   * The change event's row, checked against the writer and the scope it landed in.
   * Returns what failed, so a test names the gap instead of a bare false.
   */
  async function rowAnswersFor(
    event: { id: string; scopePath: string; authorizedById: string | null; actorId: string },
    orgId: string,
  ): Promise<string> {
    if (event.authorizedById === null) return "no authorization recorded";
    const row = await db.auditLog.findUnique({ where: { id: event.authorizedById } });
    if (!row) return "names no audit row";
    if (row.orgId !== orgId) return `names a row in org ${row.orgId}, not ${orgId}`;
    if (row.decision !== "allow" || row.action !== "memory.write") return `names a ${row.decision} ${row.action} row`;
    if (row.actorId !== event.actorId) return `names a row by ${row.actorId}, not the writer ${event.actorId}`;
    if (row.target !== event.scopePath) return `names a row on ${row.target}, not the fact's scope ${event.scopePath}`;
    session.current = {
      org: { id: orgId, name: orgId },
      user: { id: owners.get(orgId)!.actor.id },
      ctx: owners.get(orgId)!,
    };
    const res = await auditRoute(new Request(`http://t/api/audit?ids=${row.id}`));
    const listed = ((await res.json()) as { entries: { id: string; changeIds?: string[] }[] }).entries.find(
      (e) => e.id === row.id,
    );
    if (!listed) return "the row is not visible in GET /api/audit";
    if (!(listed.changeIds ?? []).includes(event.id)) return "GET /api/audit does not list the change under its row";
    return "answered";
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    vi.stubEnv("INNGEST_BYPASS", "1");
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL! }) });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ embedding: new Array(DIMENSIONS).fill(0.01) }))),
    );
    ({ GET: auditRoute } = await import("@/app/api/audit/route"));
    conventions = await import("@/services/memory/conventions");
  });

  afterAll(async () => {
    await db.changeEvent.deleteMany({ where: { orgId: { in: [ORG_A, ORG_B] } } });
    await db.org.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } });
    await db.$disconnect();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  beforeEach(async () => {
    queuedJobs.length = 0;
    await db.changeEvent.deleteMany({ where: { orgId: { in: [ORG_A, ORG_B] } } });
    await db.org.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } });
    await seedOrg(ORG_A, ROOT_A, [
      [A_PLAN, "planning"],
      [A_PLAN_DEALS, "deals"],
      [A_LEGAL, "legal"],
    ]);
    await seedOrg(ORG_B, ROOT_B, [[B_PLAN, "planning"]]);
  });

  it("two tenants and two writers on one scope, at once: each fact names its own writer's row on its own scope", async () => {
    const w = await writer(ORG_A, "agent_qa651_w", A_PLAN, "write");
    const x = await writer(ORG_A, "agent_qa651_x", A_PLAN, "write");
    const b = await writer(ORG_B, "agent_qa651_b", B_PLAN, "write");

    const replies = await Promise.all([
      w.ingest(
        { content: "Close deals only after legal signs off.", name: "Deal close", scopePath: A_PLAN, kind: "decision" },
        {},
      ),
      x.ingest(
        { content: "Quarterly plans freeze on the 5th.", name: "Plan freeze", scopePath: A_PLAN, kind: "convention" },
        {},
      ),
      b.ingest(
        { content: "Close deals only after legal signs off.", name: "Deal close", scopePath: B_PLAN, kind: "decision" },
        {},
      ),
      w.ingest(
        {
          content: "Deal desks dedupe accounts by domain.",
          name: "Dedupe",
          scopePath: A_PLAN_DEALS,
          kind: "convention",
        },
        {},
      ),
    ]);
    for (const r of replies) expect(r.isError, r.content[0]?.text).not.toBe(true);
    await runQueuedJobs();

    const named = new Set<string>();
    for (const { orgId, agentId, expected } of [
      { orgId: ORG_A, agentId: w.agentId, expected: [A_PLAN, A_PLAN_DEALS] },
      { orgId: ORG_A, agentId: x.agentId, expected: [A_PLAN] },
      { orgId: ORG_B, agentId: b.agentId, expected: [B_PLAN] },
    ]) {
      const rules = await createsBy(orgId, agentId, "convention");
      const facts = await createsBy(orgId, agentId, "fact");
      expect(facts.map((f) => f.scopePath).sort()).toEqual([...expected].sort());
      for (const fact of facts) {
        expect(await rowAnswersFor(fact, orgId), `${agentId} fact on ${fact.scopePath}`).toBe("answered");
        // The fact names exactly the row its own rule on that scope names.
        const rule = rules.find((r) => r.scopePath === fact.scopePath);
        expect(rule?.authorizedById).toBe(fact.authorizedById);
        named.add(fact.authorizedById!);
      }
    }
    // Four rules, four decisions: no two writes share a row.
    expect(named.size).toBe(4);
  });

  it("a rule to a scope the writer may not write stores no fact, and nothing names the refused call's rows", async () => {
    const w = await writer(ORG_A, "agent_qa651_w", A_PLAN, "write");
    const since = new Date(Date.now() - 1);

    const reply = await w.ingest(
      { content: "Legal holds every NDA for review.", name: "NDA hold", scopePath: A_LEGAL, kind: "decision" },
      {},
    );
    await runQueuedJobs();

    expect(reply.isError).toBe(true);
    expect(await createsBy(ORG_A, w.agentId, "convention")).toHaveLength(0);
    expect(await createsBy(ORG_A, w.agentId, "fact")).toHaveLength(0);
    const rows = await rowsWrittenBy(ORG_A, w.agentId, since);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.decision !== "allow")).toBe(true);
    expect(await db.changeEvent.count({ where: { authorizedById: { in: rows.map((r) => r.id) } } })).toBe(0);
  });

  it("a read-only token's rule stores no fact and attaches no row", async () => {
    const r = await writer(ORG_A, "agent_qa651_r", A_PLAN, "read");
    const since = new Date(Date.now() - 1);

    const reply = await r.ingest(
      { content: "Plans need two approvers.", name: "Approvers", scopePath: A_PLAN, kind: "convention" },
      {},
    );
    await runQueuedJobs();

    expect(reply.isError).toBe(true);
    expect(await createsBy(ORG_A, r.agentId, "fact")).toHaveLength(0);
    const rows = await rowsWrittenBy(ORG_A, r.agentId, since);
    expect(rows.every((row) => row.decision !== "allow")).toBe(true);
    expect(await db.changeEvent.count({ where: { authorizedById: { in: rows.map((row) => row.id) } } })).toBe(0);
  });

  it("a rule replacing one in a scope the writer cannot write is refused after its own scope was allowed, and that allow row names nothing", async () => {
    const legalRule = await conventions.recordConvention(owners.get(ORG_A)!, {
      kind: "decision",
      subject: "NDA hold",
      text: "Legal holds every NDA.",
      scopePath: A_LEGAL,
    });
    const w = await writer(ORG_A, "agent_qa651_w", A_PLAN, "write");
    const since = new Date(Date.now() - 1);

    const reply = await w.ingest(
      {
        content: "NDAs no longer need a hold.",
        name: "NDA hold",
        scopePath: A_PLAN,
        kind: "decision",
        supersedes: legalRule,
      },
      {},
    );
    await runQueuedJobs();

    expect(reply.isError).toBe(true);
    expect(await createsBy(ORG_A, w.agentId, "convention")).toHaveLength(0);
    expect(await createsBy(ORG_A, w.agentId, "fact")).toHaveLength(0);
    const rows = await rowsWrittenBy(ORG_A, w.agentId, since);
    // The writer's own scope was allowed before the replaced rule's scope was refused.
    expect(rows.some((r) => r.decision === "allow" && r.target === A_PLAN)).toBe(true);
    expect(await db.changeEvent.count({ where: { authorizedById: { in: rows.map((r) => r.id) } } })).toBe(0);
  });

  it("a rule replacing one in a parent scope it may write: the fact names the new rule's row on the child, not the replaced rule's", async () => {
    const w = await writer(ORG_A, "agent_qa651_w", A_PLAN, "write");
    const first = await w.ingest(
      { content: "Dedupe accounts by name.", name: "Dedupe", scopePath: A_PLAN, kind: "convention" },
      {},
    );
    expect(first.isError, first.content[0]?.text).not.toBe(true);
    const [oldRule] = await db.convention.findMany({ where: { orgId: ORG_A, actorId: w.agentId } });

    const reply = await w.ingest(
      {
        content: "Dedupe accounts by domain.",
        name: "Dedupe",
        scopePath: A_PLAN_DEALS,
        kind: "convention",
        supersedes: oldRule!.id,
      },
      {},
    );
    expect(reply.isError, reply.content[0]?.text).not.toBe(true);
    await runQueuedJobs();

    const rules = await createsBy(ORG_A, w.agentId, "convention");
    const facts = await createsBy(ORG_A, w.agentId, "fact");
    const childFact = facts.find((f) => f.scopePath === A_PLAN_DEALS)!;
    expect(await rowAnswersFor(childFact, ORG_A)).toBe("answered");
    expect(childFact.authorizedById).toBe(rules.find((r) => r.scopePath === A_PLAN_DEALS)!.authorizedById);
    const supersede = await db.changeEvent.findFirstOrThrow({
      where: { orgId: ORG_A, recordType: "convention", op: "supersede" },
    });
    expect(childFact.authorizedById).not.toBe(supersede.authorizedById);
  });

  it("across every write above, no change event names a row from another org, another actor, a deny, or a scope outside its own", async () => {
    const w = await writer(ORG_A, "agent_qa651_w", A_PLAN, "write");
    const b = await writer(ORG_B, "agent_qa651_b", B_PLAN, "write");
    await Promise.all([
      w.ingest({ content: "Plans freeze on the 5th.", name: "Freeze", scopePath: A_PLAN, kind: "convention" }, {}),
      w.ingest({ content: "Legal reviews all NDAs.", name: "NDA", scopePath: A_LEGAL, kind: "decision" }, {}),
      b.ingest({ content: "Plans freeze on the 5th.", name: "Freeze", scopePath: B_PLAN, kind: "convention" }, {}),
      b.ingest({ content: "Writes to org A.", name: "Cross", scopePath: A_PLAN, kind: "decision" }, {}),
    ]);
    await runQueuedJobs();

    const events = await db.changeEvent.findMany({
      where: { orgId: { in: [ORG_A, ORG_B] }, authorizedById: { not: null }, op: "create" },
      select: { id: true, orgId: true, scopePath: true, authorizedById: true, actorId: true },
    });
    expect(events.length).toBeGreaterThanOrEqual(4);
    for (const e of events) expect(await rowAnswersFor(e, e.orgId), e.id).toBe("answered");
    expect(await db.changeEvent.count({ where: { orgId: ORG_A, actorId: b.agentId } })).toBe(0);
  });
});
