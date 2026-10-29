// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A decision an agent records is a proposal until a person confirms it, and one click makes
// it the person's (services/memory/conventions.ts `confirmConvention`). The journey a user
// takes: their agent records "save this as our decision" through memory_ingest, the reply
// hands over a confirm link, the next agent session is served the decision as a lead to
// verify, the person posts to the confirm route, and from then on every session in the scope
// is served it as settled.
//
// Real: Postgres, the MCP tools over an in-memory transport, check(), the confirm route, the
// row lock and the supersede index, the erasure, the task-start block. Stand-ins: the Clerk
// session (requireAccessContext returns the signed-in person), the ingest queue and the graph.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { createWillderServer } from "./willder-server";
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import type { RequestContext } from "@/lib/access-context";

vi.mock("@/lib/inngest", () => ({ ingestMemory: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/services/memory/store", () => ({
  memory: {},
  graphitiStore: {
    planPersonErasure: async () => [],
    erasePerson: async () => ({ episodes: 0, nodes: 0, edges: 0, summaries: 0, episodeIds: [] }),
    removeChunkFacts: async () => undefined,
    removeEpisode: async () => ({ removed: true }),
  },
}));
const session = vi.hoisted(() => ({ current: null as RequestContext | null }));
vi.mock("@/lib/access-context", () => ({ requireAccessContext: async () => session.current }));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qa_rule_confirm";
const OTHER_ORG = "qa_rule_confirm_other";
const ROOT = `org_${ORG}`;
const SALES = `${ROOT}.sales`;
// A sibling of sales, not a descendant: an unescaped LIKE or a prefix match would reach sales.
const SALES_EU = `${ROOT}.sales_eu`;
const OTHER_ROOT = `org_${OTHER_ORG}`;

const AGENT = "agent-proposer";
const WORKER = "agent-worker";
const OWNER = "user-owner";
const READER = "user-reader";
const SIBLING = "user-sibling";
const OTHER_OWNER = "user-other-owner";

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

describe.skipIf(!QA_URL)("a person confirms the decision an agent recorded", { timeout: 60_000 }, () => {
  let db: PrismaClient;
  let registerWillderTools: (typeof import("./tools"))["registerWillderTools"];
  let recordConvention: (typeof import("@/services/memory/conventions"))["recordConvention"];
  let confirmConvention: (typeof import("@/services/memory/conventions"))["confirmConvention"];
  let retireConvention: (typeof import("@/services/memory/conventions"))["retireConvention"];
  let recordAuthorizedConvention: (typeof import("@/services/memory/conventions"))["recordAuthorizedConvention"];
  let erasePerson: (typeof import("@/services/memory/person-erasure"))["erasePerson"];
  let POST: (typeof import("@/app/api/memory/conventions/[id]/confirm/route"))["POST"];
  const clients: Client[] = [];

  const person = (id: string, orgId = ORG, role: "admin" | "member" = "member"): AccessContext => ({
    orgId,
    actor: { type: "human", id, role },
    origin: "app",
  });

  async function token(agentId: string, scopePath: string, permission: "read" | "write"): Promise<string> {
    const value = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId,
        tokenHash: hashCapabilityToken(value),
        scopePath,
        permission,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    return value;
  }

  /** A write token on sales for `agentId`, through the MCP tools. */
  async function connect(agentId: string, scopePath: string, permission: "read" | "write"): Promise<Client> {
    const capabilityToken = await token(agentId, scopePath, permission);
    const server = createWillderServer();
    registerWillderTools(
      server,
      { orgId: ORG, actor: { type: "agent", id: agentId, capabilityToken }, origin: "mcp" },
      { orgId: ORG, agentId, scopePath },
    );
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientSide);
    clients.push(client);
    return client;
  }

  /** The agent records a decision the way a user's "save this as our decision" does. */
  async function agentDecision(
    subject = "Session store",
    text = "Store sessions in Postgres, not Redis.",
    task?: string,
  ): Promise<{ id: string; reply: string }> {
    const agent = await connect(AGENT, SALES, "write");
    const _meta = task === undefined ? {} : { "willder/task": task, "willder/session": "proposer" };
    const result = (await agent.callTool({
      name: "memory_ingest",
      arguments: { name: subject, content: text, kind: "decision" },
      _meta,
    })) as ToolResult;
    expect(result.isError).toBeFalsy();
    const reply = result.content[0]!.text;
    return { id: /^Recorded decision (\S+);/.exec(reply)![1]!, reply };
  }

  /** The task-start block a new worker session is served, without the change notices. */
  async function blockFor(sessionKey: string, task?: string): Promise<string> {
    const worker = await connect(WORKER, SALES, "read");
    const _meta =
      task === undefined ? { "willder/session": sessionKey } : { "willder/session": sessionKey, "willder/task": task };
    const result = (await worker.callTool({
      name: "get_my_brief",
      arguments: { briefId: "none" },
      _meta,
    })) as ToolResult;
    return (
      result.content
        .map((c) => c.text)
        .find((t) => t.startsWith("Before you start"))
        ?.split("\n\nChanged in your scope")[0] ?? ""
    );
  }

  /** POST /api/memory/conventions/[id]/confirm, signed in as `userId`. */
  async function confirmAs(
    userId: string | null,
    id: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    session.current = userId === null ? null : ({ ctx: person(userId) } as RequestContext);
    const res = await POST(new Request(`http://localhost/api/memory/conventions/${id}/confirm`, { method: "POST" }), {
      params: Promise.resolve({ id }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  const rulesInOrg = () => db.convention.findMany({ where: { orgId: ORG }, orderBy: { createdAt: "asc" } });

  async function wipe() {
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.taskStartServedItem.deleteMany({ where: { orgId } });
      await db.taskStartDelivery.deleteMany({ where: { orgId } });
      await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${orgId}`;
      await db.factEdge.deleteMany({ where: { orgId } });
      await db.convention.deleteMany({ where: { orgId, supersedesId: { not: null } } });
      await db.convention.deleteMany({ where: { orgId } });
      await db.changeEvent.deleteMany({ where: { orgId } });
      await db.erasureSuppression.deleteMany({ where: { orgId } });
      await db.contact.deleteMany({ where: { orgId } });
      await db.agentCursor.deleteMany({ where: { orgId } });
      await db.capability.deleteMany({ where: { orgId } });
      await db.auditLog.deleteMany({ where: { orgId } });
      await db.grant.deleteMany({ where: { orgId } });
      await db.orgMembership.deleteMany({ where: { orgId } });
      await db.scope.deleteMany({ where: { orgId } });
      await db.user.deleteMany({ where: { orgId } });
    }
  }

  async function grant(orgId: string, userId: string, scopeId: string, permission: "read" | "write" | "admin") {
    await db.user.upsert({
      where: { id: userId },
      update: {},
      create: { id: userId, orgId, email: `${userId}@confirm.test`, clerkId: `clerk-${userId}`, name: userId },
    });
    await db.grant.create({ data: { orgId, scopeId, granteeType: "user", granteeId: userId, permission } });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example/");
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ registerWillderTools } = await import("./tools"));
    ({ recordConvention, confirmConvention, retireConvention, recordAuthorizedConvention } = await import(
      "@/services/memory/conventions"
    ));
    ({ erasePerson } = await import("@/services/memory/person-erasure"));
    ({ POST } = await import("@/app/api/memory/conventions/[id]/confirm/route"));
  }, 120_000);

  afterAll(async () => {
    if (!db) return;
    await Promise.all(clients.splice(0).map((c) => c.close()));
    await wipe();
    await db.$disconnect();
  });

  beforeEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
    await wipe();
    for (const orgId of [ORG, OTHER_ORG])
      await db.org.upsert({ where: { id: orgId }, update: {}, create: { id: orgId, name: orgId } });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    const sales = await db.scope.create({ data: { orgId: ORG, path: SALES, name: "Sales" } });
    const salesEu = await db.scope.create({ data: { orgId: ORG, path: SALES_EU, name: "Sales EU" } });
    const otherRoot = await db.scope.create({ data: { orgId: OTHER_ORG, path: OTHER_ROOT, name: "root" } });
    await grant(ORG, OWNER, root.id, "admin");
    await grant(ORG, READER, sales.id, "read");
    await grant(ORG, SIBLING, salesEu.id, "write");
    await grant(OTHER_ORG, OTHER_OWNER, otherRoot.id, "admin");
  });

  it("serves an agent's decision as a lead, then as a standing rule once a person confirms it", async () => {
    const { id, reply } = await agentDecision();
    expect(reply).toContain(`it is proposed in ${SALES}, not yet a standing rule`);
    expect(reply).toContain(
      `Ask the person to open https://app.example/memory/confirm/${id} and choose Confirm decision.`,
    );

    const before = await blockFor("before");
    expect(before).toContain("Session store: Store sessions in Postgres, not Redis.");
    expect(before).not.toContain("Settled in your scope (rules in force):");

    const audited = (await db.auditLog.findMany({ where: { orgId: ORG }, select: { id: true } })).map((r) => r.id);
    const { status, body } = await confirmAs(OWNER, id);
    expect(status).toBe(200);
    expect(body.replaced).toBe(id);
    const confirmedId = body.confirmed as string;

    const [agents, owners] = [
      await db.convention.findUniqueOrThrow({ where: { id } }),
      await db.convention.findUniqueOrThrow({ where: { id: confirmedId } }),
    ];
    expect(owners).toMatchObject({
      supersedesId: id,
      actorId: OWNER,
      scopePath: SALES,
      kind: "decision",
      subject: agents.subject,
      text: agents.text,
    });
    expect(agents.retiredAt).toBeNull();
    const created = await db.changeEvent.findFirstOrThrow({
      where: { orgId: ORG, recordId: confirmedId, op: "create" },
    });
    expect(created).toMatchObject({ actorType: "human", actorId: OWNER, origin: "app" });
    expect(await db.changeEvent.count({ where: { orgId: ORG, recordId: id, op: "supersede" } })).toBe(1);
    // One write decision, not one per step.
    const rows = await db.auditLog.findMany({ where: { orgId: ORG, id: { notIn: audited } } });
    expect(rows.map((r) => [r.action, r.decision])).toEqual([["memory.write", "allow"]]);
    expect(created.authorizedById).toBe(rows[0]!.id);

    const after = await blockFor("after");
    expect(after).toContain("Settled in your scope (rules in force):");
    expect(after).toContain(`[decision ${confirmedId}]`);
    expect(after).not.toContain(id);
  });

  it("settles a task's own decision for that task once a person confirms it", async () => {
    const task = "Move sessions off Redis";
    const { id } = await agentDecision("Session store", "Store sessions in Postgres, not Redis.", task);
    const before = await blockFor("task-before", task);
    expect(before).toContain(`[untested plan: verify before following]`);
    expect(before).not.toContain("Settled for this task:");

    const confirmedId = (await confirmAs(OWNER, id)).body.confirmed as string;
    const after = await blockFor("task-after", task);
    const settled = after.split("Settled for this task:")[1]?.split(/\n(?=\S)(?!- )/)[0] ?? "";
    expect(settled).toContain(confirmedId);
    expect(settled).toContain("Store sessions in Postgres, not Redis.");
    expect(after).not.toContain("[untested plan: verify before following]");
  });

  it("answers a second click without writing anything", async () => {
    const { id } = await agentDecision();
    const first = await confirmAs(OWNER, id);
    const count = (await rulesInOrg()).length;

    expect(await confirmAs(OWNER, id)).toMatchObject({ status: 409 });
    expect(await confirmAs(OWNER, first.body.confirmed as string)).toEqual({
      status: 200,
      body: { confirmed: first.body.confirmed, alreadyConfirmed: true },
    });
    expect((await rulesInOrg()).length).toBe(count);
  });

  it("lets exactly one of many concurrent confirmations through", async () => {
    const { id } = await agentDecision();
    const results = await Promise.all(Array.from({ length: 12 }, () => confirmConvention(person(OWNER), id)));

    expect(results.filter((r) => r.status === "confirmed")).toHaveLength(1);
    expect(results.filter((r) => r.status !== "confirmed").every((r) => r.status === "notInForce")).toBe(true);
    expect(await db.convention.count({ where: { orgId: ORG, supersedesId: id } })).toBe(1);
  });

  it("never brings a retired rule back, whichever of confirm and retire runs first", async () => {
    for (let round = 0; round < 15; round += 1) {
      const { id } = await agentDecision(`Rule ${round}`, `Text ${round}.`);
      const [confirmed, retired] = await Promise.all([
        confirmConvention(person(OWNER), id),
        retireConvention(person(OWNER), id),
      ]);
      expect(retired).toBe(true);
      const replacement = await db.convention.findFirst({ where: { orgId: ORG, supersedesId: id } });
      if (confirmed.status === "confirmed") {
        // Confirmed first: the person's version replaced it, and the retire landed on the replaced row.
        expect(replacement?.id).toBe(confirmed.id);
      } else {
        expect(confirmed.status).toBe("notInForce");
        expect(replacement).toBeNull();
      }
    }
  });

  it("waits for a retirement still in flight and then refuses, instead of confirming the version it read", async () => {
    const { id } = await agentDecision();
    let confirming: Promise<unknown> | undefined;
    await db.$transaction(
      async (tx) => {
        // A retirement that has taken the row but not committed yet.
        await tx.$executeRaw`UPDATE "conventions" SET "retiredAt" = now() WHERE "id" = ${id}`;
        confirming = confirmConvention(person(OWNER), id);
        await new Promise((resolve) => setTimeout(resolve, 500));
      },
      { timeout: 20_000 },
    );
    expect(await confirming).toEqual({ status: "notInForce" });
    expect(await db.convention.count({ where: { orgId: ORG, supersedesId: id } })).toBe(0);
  });

  it("refuses a reader 403 and answers an unreadable, unknown or other-org id 404, writing nothing", async () => {
    const { id } = await agentDecision();
    const otherOrgRule = await recordConvention(person(OTHER_OWNER, OTHER_ORG, "admin"), {
      kind: "decision",
      subject: "X",
      text: "Y",
      scopePath: OTHER_ROOT,
    });
    const count = (await rulesInOrg()).length;

    expect((await confirmAs(READER, id)).status).toBe(403);
    const sibling = await confirmAs(SIBLING, id);
    const unknown = await confirmAs(SIBLING, "no-such-rule");
    expect(sibling).toEqual(unknown);
    expect(sibling.status).toBe(404);
    expect((await confirmAs(OWNER, otherOrgRule)).status).toBe(404);
    expect((await confirmAs(null, id)).status).toBe(401);
    expect((await rulesInOrg()).length).toBe(count);
  });

  it("refuses an agent even through the service, so no token can settle its own decision", async () => {
    const { id } = await agentDecision();
    // Even holding a write token on the decision's own scope.
    const capabilityToken = await token(AGENT, SALES, "write");
    await expect(
      confirmConvention({ orgId: ORG, actor: { type: "agent", id: AGENT, capabilityToken }, origin: "mcp" }, id),
    ).rejects.toThrow(/Only a person can confirm/);
    expect(await db.convention.count({ where: { orgId: ORG, supersedesId: id } })).toBe(0);
  });

  it("answers a rule naming an erased person as missing, so confirming never stores the name again", async () => {
    await db.contact.create({ data: { id: "dana", orgId: ORG, name: "Dana Whitfield", email: "dana@acme.example" } });
    const { id } = await agentDecision("Renewals", "Dana Whitfield approves renewals.");
    await erasePerson(person(OWNER, ORG, "admin"), { email: "dana@acme.example" });

    expect((await confirmAs(OWNER, id)).status).toBe(404);
    // A reader, who could otherwise be refused 403, gets what an unknown id gets.
    expect(await confirmAs(READER, id)).toEqual(await confirmAs(READER, "no-such-rule"));
    expect(await db.convention.count({ where: { orgId: ORG, supersedesId: id } })).toBe(0);
  });

  // The whole path a stated rule takes: the server's instructions (mcp/willder-server.ts) tell the
  // agent which kind to record and to show the confirm link, the reply carries the link, the person
  // confirms, and the next session is served the rule as standing, attributed to the person.
  it.each([
    [
      "convention",
      "Dependencies",
      "Never add a runtime dependency without asking first.",
      "A person can confirm it as theirs at ",
    ],
    ["decision", "Session store", "Keep sessions in Postgres, not Redis.", "Ask the person to open "],
  ] as const)(
    "serves a stated %s, recorded as the server instructions say, as standing at the next task start once the person confirms it",
    async (kind, subject, said, linkLead) => {
      const agent = await connect(AGENT, SALES, "write");
      expect(agent.getInstructions()).toContain(`kind "${kind}"`);
      const result = (await agent.callTool({
        name: "memory_ingest",
        arguments: { name: subject, content: said, kind },
      })) as ToolResult;
      const reply = result.content[0]!.text;
      const id = new RegExp(`^Recorded ${kind} (\\S+);`).exec(reply)![1]!;
      expect(reply).toContain(`${linkLead}https://app.example/memory/confirm/${id}`);

      const { status, body } = await confirmAs(OWNER, id);
      expect(status).toBe(200);
      const after = await blockFor(`next-${kind}`);
      const settled = after.split("Settled in your scope (rules in force):")[1]?.split(/\n(?=\S)(?!- )/)[0] ?? "";
      const line = settled.split("\n").find((l) => l.includes(said)) ?? "";
      expect(line).toContain(`[${kind} ${body.confirmed as string}]`);
      expect(line).not.toContain("[agent-recorded]");
      expect(after).not.toContain(id);
    },
  );

  describe("who may replace a decision a person confirmed", () => {
    const CONFIRMER = "user-confirmer";
    const PEER = "user-peer";
    const ADMIN = "user-admin";
    const ORG_OWNER = "user-org-owner";
    const ADMIN_ELSEWHERE = "user-admin-elsewhere";
    const NEW_TEXT = "Store sessions in SQLite.";

    beforeEach(async () => {
      const sales = await db.scope.findFirstOrThrow({ where: { orgId: ORG, path: SALES } });
      const member = async (userId: string, orgId: string, role: "owner" | "admin" | "member") =>
        db.orgMembership.upsert({
          where: { orgId_userId: { orgId, userId } },
          update: { role },
          create: { orgId, userId, role, assertedAt: new Date() },
        });
      // Every one of them may write sales, so a refusal below is this rule's and not the scope check's.
      for (const userId of [CONFIRMER, PEER, ADMIN, ORG_OWNER, ADMIN_ELSEWHERE])
        await grant(ORG, userId, sales.id, "write");
      await member(CONFIRMER, ORG, "member");
      await member(PEER, ORG, "member");
      await member(ADMIN, ORG, "admin");
      await member(ORG_OWNER, ORG, "owner");
      await member(ADMIN_ELSEWHERE, ORG, "member");
      await member(ADMIN_ELSEWHERE, OTHER_ORG, "admin");
    });

    type RuleKind = "confirmed" | "recorded" | "convention" | "no-create-event" | "untyped-event" | "proposed";

    /**
     * The rule an attempt targets. CONFIRMER confirmed an agent's decision, recorded a decision or
     * convention directly, or wrote a decision whose create event is missing (as an imported org's
     * are) or names no actor type (as events from before the type was recorded do). Or it is an
     * agent's own proposal.
     */
    async function ruleOf(kind: RuleKind): Promise<string> {
      if (kind === "proposed") return (await agentDecision()).id;
      if (kind === "confirmed") {
        const confirmed = await confirmConvention(person(CONFIRMER), (await agentDecision()).id);
        if (confirmed.status !== "confirmed") throw new Error(`confirm failed: ${confirmed.status}`);
        return confirmed.id;
      }
      const id = await recordConvention(person(CONFIRMER), {
        kind: kind === "convention" ? "convention" : "decision",
        subject: "Session store",
        text: "Store sessions in Postgres, not Redis.",
        scopePath: SALES,
      });
      if (kind === "no-create-event") await db.changeEvent.deleteMany({ where: { orgId: ORG, recordId: id } });
      if (kind === "untyped-event")
        await db.changeEvent.updateMany({ where: { orgId: ORG, recordId: id }, data: { actorType: null } });
      return id;
    }

    /** One attempt to replace `ruleId`: a person through the service, an agent through memory_ingest. */
    async function supersede(
      by: { person: string } | { agent: string },
      ruleId: string,
      kind: "decision" | "convention",
    ): Promise<{ id?: string; reply?: string; error?: string }> {
      if ("person" in by) {
        // The request's own role always claims admin: only the stored membership may count.
        const ctx = person(by.person, ORG, "admin");
        try {
          return {
            id: (
              await recordAuthorizedConvention(ctx, {
                kind,
                subject: "Session store",
                text: NEW_TEXT,
                scopePath: SALES,
                supersedes: ruleId,
              })
            ).id,
          };
        } catch (e) {
          return { error: (e as Error).message };
        }
      }
      const agent = await connect(by.agent, SALES, "write");
      const result = (await agent.callTool({
        name: "memory_ingest",
        arguments: { name: "Session store", content: NEW_TEXT, kind, supersedes: ruleId },
      })) as ToolResult;
      const reply = result.content[0]!.text;
      if (result.isError) return { error: reply };
      return { id: new RegExp(`^Recorded ${kind} (\\S+);`).exec(reply)![1]!, reply };
    }

    // outcome: "replaces" supersedes it as today; "beside" stores the new rule next to it,
    // replacing nothing; "refused" stores nothing.
    const cases: {
      name: string;
      rule: RuleKind;
      by: { person: string } | { agent: string };
      outcome: "replaces" | "beside" | "refused";
    }[] = [
      {
        name: "an agent with a write token, on a confirmed decision",
        rule: "confirmed",
        by: { agent: AGENT },
        outcome: "beside",
      },
      {
        name: "an agent, on a decision a person recorded without a confirm",
        rule: "recorded",
        by: { agent: AGENT },
        outcome: "beside",
      },
      {
        name: "an agent, on a convention a person recorded",
        rule: "convention",
        by: { agent: AGENT },
        outcome: "beside",
      },
      {
        name: "an agent, on a person's decision with no create event",
        rule: "no-create-event",
        by: { agent: AGENT },
        outcome: "beside",
      },
      {
        name: "an agent, on a person's decision whose event names no actor type",
        rule: "untyped-event",
        by: { agent: AGENT },
        outcome: "beside",
      },
      {
        name: "an agent whose id is the confirming person's id",
        rule: "confirmed",
        by: { agent: CONFIRMER },
        outcome: "beside",
      },
      { name: "the person who confirmed it", rule: "confirmed", by: { person: CONFIRMER }, outcome: "replaces" },
      { name: "an org admin", rule: "confirmed", by: { person: ADMIN }, outcome: "replaces" },
      { name: "an org owner", rule: "confirmed", by: { person: ORG_OWNER }, outcome: "replaces" },
      { name: "a peer member", rule: "confirmed", by: { person: PEER }, outcome: "refused" },
      {
        name: "a member here who is admin of another org",
        rule: "confirmed",
        by: { person: ADMIN_ELSEWHERE },
        outcome: "refused",
      },
      {
        name: "an agent, on an unconfirmed agent decision (no change)",
        rule: "proposed",
        by: { agent: WORKER },
        outcome: "replaces",
      },
      {
        name: "a peer member, on an unconfirmed agent decision (no change)",
        rule: "proposed",
        by: { person: PEER },
        outcome: "replaces",
      },
    ];

    it.each(cases)("$name: $outcome", async ({ rule, by, outcome }) => {
      const kind = rule === "convention" ? "convention" : "decision";
      const ruleId = await ruleOf(rule);
      const rulesBefore = (await rulesInOrg()).length;
      const auditedBefore = (await db.auditLog.findMany({ where: { orgId: ORG }, select: { id: true } })).map(
        (r) => r.id,
      );

      const result = await supersede(by, ruleId, kind);

      const replacement = await db.convention.findFirst({ where: { orgId: ORG, supersedesId: ruleId } });
      const denied = await db.auditLog.findMany({
        where: { orgId: ORG, decision: "deny", id: { notIn: auditedBefore } },
        select: { action: true, target: true },
      });
      if (outcome === "replaces") {
        expect(result.error).toBeUndefined();
        expect(replacement?.id).toBe(result.id);
        expect(denied).toEqual([]);
        return;
      }
      expect(replacement).toBeNull();
      expect(denied).toEqual([{ action: "memory.write", target: `${SALES}/${ruleId}` }]);
      if (outcome === "refused") {
        expect(result.error).toBe(
          `supersedes: ${ruleId} was recorded or confirmed by a person, so only that person or an owner or admin of this organization can replace it. ` +
            "Nothing was stored. To keep yours beside it, record it again without supersedes; to replace it, ask that person or an org owner or admin.",
        );
        expect((await rulesInOrg()).length).toBe(rulesBefore);
        return;
      }
      // Beside: stored, in force, replacing nothing, and the reply says so and names the fix.
      expect(result.error).toBeUndefined();
      expect(await db.convention.findUniqueOrThrow({ where: { id: result.id! } })).toMatchObject({
        supersedesId: null,
        supersededById: null,
        retiredAt: null,
        text: NEW_TEXT,
      });
      expect(result.reply).toContain(`It did not replace ${ruleId}: a person recorded or confirmed that rule`);
      expect(result.reply).toContain(
        kind === "decision"
          ? `both are served, ${ruleId} as settled and ${result.id} beside it as a lead.`
          : `both are served at the start of every session there, ${result.id} tagged as agent-recorded.`,
      );
      expect(result.reply).toContain(
        `ask one of them to confirm ${result.id} at https://app.example/memory/confirm/${result.id} and retire ${ruleId}.`,
      );
      if (rule === "no-create-event" || rule === "untyped-event") return; // the block reads these as no one's: not this rule's concern
      const block = await blockFor(`after-${rule}`);
      const settled = block.split("Settled in your scope (rules in force):")[1]!.split("\n\n")[0]!;
      const outsideSettled = block.replace(settled, "");
      expect(settled).toContain(`[${kind} ${ruleId}]`);
      if (kind === "decision") {
        // The agent's decision is a lead: served, and not among the rules in force.
        expect(settled).not.toContain(NEW_TEXT);
        expect(outsideSettled).toContain(`Session store: ${NEW_TEXT}`);
      } else {
        // The agent's convention is in force beside the person's, tagged as the agent's.
        expect(settled).toContain(`[convention ${result.id}] [agent-recorded] Session store: ${NEW_TEXT}`);
      }
    });
  });
});
