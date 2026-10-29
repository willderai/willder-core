// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// QA rows for the rule "a decision a person confirmed is replaced only by that person or an
// org owner or admin; an agent's conflicting decision is served beside it as a lead and never
// demotes it" (services/memory/conventions.ts `personsRuleRefusal`), on the paths
// mcp/rule-confirmation.realdb.test.ts stubs out: the fact copy memory_ingest stores of a rule's
// text, as memory_query serves it, and a person's confirmation racing an agent's supersede.
//
// Real: Postgres, the MCP tools over an in-memory transport, check(), ingestMemory's
// write-through to memory_chunks, pgvector's SQL, the confirm path. Stubbed: the embedding and
// graph services (one fixed embedding, a graph with no facts), the episode cap, the LLM.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";

vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
}));
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
const ORG = "qa_confirmed_guard";
const ROOT = `org_${ORG}`;
const SALES = `${ROOT}.sales`;
const PROPOSER = "agent-proposer";
const WORKER = "agent-worker";
const READER = "agent-reader";
const CONFIRMER = "user-confirmer";
const EMBEDDING = Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
const CONFIRMED_TEXT = "Store sessions in Postgres, not Redis.";
const AGENT_TEXT = "Store sessions in SQLite.";

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

describe.skipIf(!QA_URL)(
  "a confirmed decision against an agent's conflicting one, on the paths the stubbed suite skips",
  { timeout: 60_000 },
  () => {
    let db: PrismaClient;
    let registerWillderTools: (typeof import("./tools"))["registerWillderTools"];
    let confirmConvention: (typeof import("@/services/memory/conventions"))["confirmConvention"];
    let retireConvention: (typeof import("@/services/memory/conventions"))["retireConvention"];
    const clients: Client[] = [];
    const person = (id: string): AccessContext => ({
      orgId: ORG,
      actor: { type: "human", id, role: "member" },
      origin: "app",
    });

    async function connect(agentId: string, permission: "read" | "write"): Promise<Client> {
      const capabilityToken = `wcap_test_${Math.random().toString(36).slice(2)}`;
      await db.capability.create({
        data: {
          orgId: ORG,
          agentId,
          tokenHash: hashCapabilityToken(capabilityToken),
          scopePath: SALES,
          permission,
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });
      const server = new McpServer({ name: "willder-test", version: "0.0.0" });
      registerWillderTools(
        server,
        { orgId: ORG, actor: { type: "agent", id: agentId, capabilityToken }, origin: "mcp" },
        { orgId: ORG, agentId, scopePath: SALES },
      );
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await server.connect(serverSide);
      const client = new Client({ name: "test-client", version: "0.0.0" });
      await client.connect(clientSide);
      clients.push(client);
      return client;
    }

    const call = async (client: Client, name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args })) as ToolResult;
    const text = (r: ToolResult) => r.content.map((c) => c.text).join("\n");

    /** An agent's decision, confirmed by CONFIRMER: the confirmed rule's id. */
    async function confirmedDecision(): Promise<{ proposed: string; confirmed: string }> {
      const proposer = await connect(PROPOSER, "write");
      const r = await call(proposer, "memory_ingest", {
        name: "Session store",
        content: CONFIRMED_TEXT,
        kind: "decision",
      });
      expect(r.isError, text(r)).toBeFalsy();
      const proposed = /^Recorded decision (\S+);/.exec(text(r))![1]!;
      const c = await confirmConvention(person(CONFIRMER), proposed);
      if (c.status !== "confirmed") throw new Error(`confirm failed: ${c.status}`);
      return { proposed, confirmed: c.id };
    }

    async function wipe() {
      await db.taskStartServedItem.deleteMany({ where: { orgId: ORG } });
      await db.taskStartDelivery.deleteMany({ where: { orgId: ORG } });
      await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
      await db.factEdge.deleteMany({ where: { orgId: ORG } });
      await db.convention.updateMany({ where: { orgId: ORG }, data: { supersededById: null } });
      await db.convention.deleteMany({ where: { orgId: ORG, supersedesId: { not: null } } });
      await db.convention.deleteMany({ where: { orgId: ORG } });
      await db.changeEvent.deleteMany({ where: { orgId: ORG } });
      await db.agentCursor.deleteMany({ where: { orgId: ORG } });
      await db.capability.deleteMany({ where: { orgId: ORG } });
      await db.auditLog.deleteMany({ where: { orgId: ORG } });
      await db.grant.deleteMany({ where: { orgId: ORG } });
      await db.orgMembership.deleteMany({ where: { orgId: ORG } });
      await db.scope.deleteMany({ where: { orgId: ORG } });
      await db.user.deleteMany({ where: { orgId: ORG } });
    }

    beforeAll(async () => {
      process.env.DATABASE_URL = QA_URL;
      vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example/");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          status: 200,
          json: async () => ({ embedding: EMBEDDING, facts: [], ids: [] }),
          text: async () => "{}",
        })),
      );
      db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
      const inngestModule = await import("@/lib/inngest");
      vi.spyOn(inngestModule.inngest, "send").mockImplementation((async () => ({ ids: ["job"] })) as never);
      ({ registerWillderTools } = await import("./tools"));
      ({ confirmConvention, retireConvention } = await import("@/services/memory/conventions"));
    }, 120_000);

    afterAll(async () => {
      if (!db) return;
      await Promise.all(clients.splice(0).map((c) => c.close()));
      await wipe();
      await db.$disconnect();
      vi.unstubAllGlobals();
    });

    beforeEach(async () => {
      await Promise.all(clients.splice(0).map((c) => c.close()));
      await wipe();
      await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
      await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
      const sales = await db.scope.create({ data: { orgId: ORG, path: SALES, name: "Sales" } });
      await db.user.create({
        data: {
          id: CONFIRMER,
          orgId: ORG,
          email: `${CONFIRMER}@guard.test`,
          clerkId: `clerk-${CONFIRMER}`,
          name: CONFIRMER,
        },
      });
      await db.grant.create({
        data: { orgId: ORG, scopeId: sales.id, granteeType: "user", granteeId: CONFIRMER, permission: "write" },
      });
      await db.orgMembership.upsert({
        where: { orgId_userId: { orgId: ORG, userId: CONFIRMER } },
        update: { role: "member" },
        create: { orgId: ORG, userId: CONFIRMER, role: "member", assertedAt: new Date() },
      });
    });

    // The same subject, and a case variant of it ("SESSION STORE"), which the store ranks as a tie
    // and once served in either order from run to run.
    it.each(["Session store", "SESSION STORE"])(
      "memory_query, after an agent's conflicting decision on subject %j, still serves the confirmed text first",
      async (subject) => {
        const { confirmed } = await confirmedDecision();
        const worker = await connect(WORKER, "write");
        // The worker reads first, as a well-behaved agent does, so its write is not refused as unread.
        await call(worker, "memory_query", { query: "What do we store sessions in?" });
        const w = await call(worker, "memory_ingest", {
          name: subject,
          content: AGENT_TEXT,
          kind: "decision",
          supersedes: confirmed,
        });
        expect(w.isError, text(w)).toBeFalsy();
        expect(text(w)).toContain(`It did not replace ${confirmed}`);
        const lead = /^Recorded decision (\S+);/.exec(text(w))![1]!;

        const reader = await connect(READER, "read");
        const answer = text(await call(reader, "memory_query", { query: "What do we store sessions in?" }));
        const lines = answer.split("\n").filter((l) => l.includes("Store sessions in"));
        // The confirmed decision must be served, and not as an earlier version the agent's replaced.
        const confirmedLine = lines.find((l) => l.includes(CONFIRMED_TEXT));
        expect(confirmedLine, answer).toBeDefined();
        expect(lines[0], answer).toContain(CONFIRMED_TEXT);
        // Each line says which rule it is and how it stands, as the task-start block does.
        expect(lines[0], answer).toMatch(
          new RegExp(`^• \\[settled decision ${confirmed}, a person's\\] ${CONFIRMED_TEXT}`),
        );
        expect(lines[1], answer).toMatch(
          new RegExp(`^• \\[lead to verify: decision ${lead}, not confirmed by a person\\] ${AGENT_TEXT}`),
        );
      },
    );

    it("memory_query serves a retired lead's text as a plain fact on the settled rule's subject: after it, as a lead", async () => {
      const { confirmed } = await confirmedDecision();
      const worker = await connect(WORKER, "write");
      await call(worker, "memory_query", { query: "What do we store sessions in?" });
      const w = await call(worker, "memory_ingest", {
        name: "Session store",
        content: AGENT_TEXT,
        kind: "decision",
        supersedes: confirmed,
      });
      const lead = /^Recorded decision (\S+);/.exec(text(w))![1]!;
      expect(await retireConvention(person(CONFIRMER), lead)).toBe(true);

      const reader = await connect(READER, "read");
      const answer = text(await call(reader, "memory_query", { query: "What do we store sessions in?" }));
      // The served facts; the change notice after them is history, read below.
      const lines = answer.split("\n").filter((l) => l.startsWith("• ") && l.includes("Store sessions in"));
      // No longer a copy of a rule in force, so not named as one; still on the confirmed rule's subject.
      expect(
        lines.find((l) => l.includes(AGENT_TEXT)),
        answer,
      ).toMatch(new RegExp(`^• \\[lead to verify: differs from settled decision ${confirmed}\\] ${AGENT_TEXT}`));
      expect(lines.join("\n"), answer).not.toContain(lead);
      // Elsewhere on the call the retired rule is named only by the change notice, which says it was retired.
      const naming = answer.split("\n").filter((l) => l.includes(lead));
      expect(
        naming.every((l) => /^- (create|delete|2 changes to) convention /.test(l)),
        answer,
      ).toBe(true);
      if (naming.length > 0)
        expect(
          naming.some((l) => l.includes(`delete convention ${lead}`) && l.includes("retired")),
          answer,
        ).toBe(true);
      expect(
        lines.find((l) => l.includes(CONFIRMED_TEXT)),
        answer,
      ).toMatch(new RegExp(`^• \\[settled decision ${confirmed}, a person's\\]`));
    });

    it("a person's confirmation racing an agent's supersede of the same proposal: one wins, and no person's rule ends replaced by an agent's", async () => {
      for (let round = 0; round < 4; round++) {
        await Promise.all(clients.splice(0).map((c) => c.close()));
        const proposer = await connect(PROPOSER, "write");
        const p = await call(proposer, "memory_ingest", {
          name: `Race ${round}`,
          content: `Proposal ${round}.`,
          kind: "decision",
        });
        const proposed = /^Recorded decision (\S+);/.exec(text(p))![1]!;
        const worker = await connect(WORKER, "write");
        const [confirmation, superseding] = await Promise.all([
          confirmConvention(person(CONFIRMER), proposed),
          call(worker, "memory_ingest", {
            name: `Race ${round}`,
            content: `Agent rewrite ${round}.`,
            kind: "decision",
            supersedes: proposed,
          }),
        ]);
        const replacements = await db.convention.findMany({ where: { orgId: ORG, supersedesId: proposed } });
        expect(replacements).toHaveLength(1);
        const won = replacements[0]!;
        if (confirmation.status === "confirmed") {
          expect(won.id).toBe(confirmation.id);
          expect(won.actorId).toBe(CONFIRMER);
          // The agent was told it lost, never that it replaced the rule.
          expect(superseding.isError, text(superseding)).toBe(true);
        } else {
          expect(confirmation.status).toBe("notInForce");
          expect(won.actorId).toBe(WORKER);
        }
        // Whatever happened, no rule a person recorded is replaced by an agent's.
        const personRules = await db.convention.findMany({ where: { orgId: ORG, actorId: CONFIRMER } });
        for (const rule of personRules) {
          expect(await db.convention.count({ where: { orgId: ORG, supersedesId: rule.id } })).toBe(0);
          expect(rule.supersededById).toBeNull();
        }
      }
    });
    // QA, second round. An agent that writes the same subject without `kind` stores a plain
    // fact, which the reorder leaves in place: it must still not lead a person's confirmed decision.
    it("memory_query, after an agent's plain fact on the confirmed decision's subject, still serves the confirmed text first", async () => {
      await confirmedDecision();
      const worker = await connect(WORKER, "write");
      await call(worker, "memory_query", { query: "What do we store sessions in?" });
      const w = await call(worker, "memory_ingest", { name: "Session store", content: AGENT_TEXT });
      expect(w.isError, text(w)).toBeFalsy();

      const reader = await connect(READER, "read");
      const answer = text(await call(reader, "memory_query", { query: "What do we store sessions in?" }));
      const lines = answer.split("\n").filter((l) => l.startsWith("•"));
      expect(lines[0], answer).toContain(CONFIRMED_TEXT);
    });

    // A person's own plain fact on the confirmed decision's subject is served after it, labelled by
    // its writer and not as a lead; an agent's plain fact there is still a lead.
    it("memory_query labels a person's own fact on the confirmed decision's subject by its writer, an agent's as a lead", async () => {
      await confirmedDecision();
      const worker = await connect(WORKER, "write");
      await call(worker, "memory_query", { query: "What do we store sessions in?" });
      const w = await call(worker, "memory_ingest", { name: "Session store", content: AGENT_TEXT });
      expect(w.isError, text(w)).toBeFalsy();
      const vector = `[${EMBEDDING.join(",")}]`;
      await db.$executeRaw`INSERT INTO memory_chunks ("id", "orgId", "content", "actorType", "actorName", "actorId", "entityName", "scopePath", "factVersion", "createdAt", "embedding")
      VALUES ('chunk-person-note', ${ORG}, 'Sessions expire after thirty days.', 'human', 'Sam', ${CONFIRMER}, 'Session store', ${SALES}, true, now() AT TIME ZONE 'UTC', ${vector}::vector)`;

      const reader = await connect(READER, "read");
      const answer = text(await call(reader, "memory_query", { query: "What do we store sessions in?" }));
      const lines = answer.split("\n").filter((l) => l.startsWith("•"));
      expect(lines[0], answer).toContain(CONFIRMED_TEXT);
      const personLine = lines.find((l) => l.includes("Sessions expire after thirty days."))!;
      expect(personLine, answer).toMatch(
        /\[on the subject of settled decision \S+; recorded by Sam, \d{4}-\d{2}-\d{2}\]/,
      );
      expect(personLine, answer).not.toContain("lead to verify");
      expect(
        lines.find((l) => l.includes(AGENT_TEXT)),
        answer,
      ).toContain("[lead to verify: differs from settled decision");
    });

    it("memory_query credits a confirmed decision's line to the person who confirmed it, not to the agent that proposed it", async () => {
      await confirmedDecision();
      const reader = await connect(READER, "read");
      const answer = text(await call(reader, "memory_query", { query: "What do we store sessions in?" }));
      const line = answer.split("\n").find((l) => l.includes(CONFIRMED_TEXT))!;
      expect(line, answer).toContain(CONFIRMER);
      expect(line, answer).not.toContain(PROPOSER);
    });

    // A settled rule and a lead on unrelated subjects do not conflict, so the read keeps the order
    // retrieval ranked them in. The embedding stub here ranks by the query: "deploy" texts match it.
    it("memory_query keeps retrieval's order for a settled rule and a lead on unrelated subjects", async () => {
      const axis = (i: number) => Array.from({ length: 384 }, (_, j) => (j === i ? 1 : 0));
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
          const embedding = /deploy/i.test(String(init?.body ?? "")) ? axis(0) : axis(1);
          return {
            ok: true,
            status: 200,
            json: async () => ({ embedding, facts: [], ids: [] }),
            text: async () => "{}",
          };
        }),
      );
      try {
        await call(await connect(WORKER, "write"), "memory_ingest", {
          name: "Deploy window",
          content: "Deploy on Fridays after the standup.",
          kind: "decision",
        });
        await call(await connect(PROPOSER, "write"), "memory_ingest", {
          name: "Code style",
          content: "Indent code with tabs everywhere.",
          kind: "convention",
        });
        const reader = await connect(READER, "read");
        const answer = text(await call(reader, "memory_query", { query: "When do we deploy?" }));
        const lines = answer.split("\n").filter((l) => l.startsWith("•"));
        expect(lines, answer).toHaveLength(2);
        expect(lines[0], answer).toContain("Deploy on Fridays after the standup.");
      } finally {
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({ embedding: EMBEDDING, facts: [], ids: [] }),
            text: async () => "{}",
          })),
        );
      }
    });
  },
);
