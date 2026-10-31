// A person's rule stays served when an agent writes over its fact copy. A decision's text is stored
// as a rule and as a fact (mcp/tools/memory-ingest.ts), and memory_query reads the fact. A based
// write used to replace that fact, so the reader was served the agent's text alone while the rule
// stood untouched in the conventions table. Run with QA_DATABASE_URL set on a scratch Postgres.
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
const ORG = "qa_person_rule_copy";
const ROOT = `org_${ORG}`;
const SALES = `${ROOT}.sales`;
const PROPOSER = "agent-proposer";
const WORKER = "agent-worker";
const READER = "agent-reader";
const CONFIRMER = "user-confirmer";
const EMBEDDING = Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
const CONFIRMED_TEXT = "Store sessions in Postgres, not Redis.";

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

describe.skipIf(!QA_URL)(
  "a person's rule against an agent's based write, on a real database",
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
    async function confirmedDecision(baseVersion?: string): Promise<{ proposed: string; confirmed: string }> {
      const proposer = await connect(PROPOSER, "write");
      const r = await call(proposer, "memory_ingest", {
        name: "Session store",
        content: CONFIRMED_TEXT,
        kind: "decision",
        ...(baseVersion ? { baseVersion } : {}),
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

    const QUESTION = "What do we store sessions in?";
    const OLD_FACT = "Store sessions in cookies.";
    const AGENT_FACT = "Store sessions in local storage.";

    /** The facts a read serves, without the change list or the task-start notice. */
    const served = (t: string) => t.split("\n").filter((l) => l.startsWith("\u2022"));
    const versionIn = (t: string) => /Version: (\S+?)\./.exec(t)![1]!;

    /** The first call carries the task-start notice, which names the rule whatever a read does. */
    async function readAgain(): Promise<string[]> {
      const reader = await connect(READER, "read");
      await call(reader, "memory_query", { query: QUESTION });
      return served(text(await call(reader, "memory_query", { query: QUESTION })));
    }

    async function copyOf(content: string): Promise<string> {
      const rows = await db.$queryRaw<
        { id: string }[]
      >`SELECT "id" FROM memory_chunks WHERE "orgId" = ${ORG} AND "content" = ${content}`;
      return rows[0]!.id;
    }

    const replaced = async (id: string) => db.factEdge.count({ where: { orgId: ORG, toId: id, kind: "supersedes" } });

    describe("the write guard", () => {
      it("keeps an agent's based write beside the copy, and the rule stays served first", async () => {
        const worker = await connect(WORKER, "write");
        const { confirmed } = await confirmedDecision();
        const copy = await copyOf(CONFIRMED_TEXT);
        const w = await call(worker, "memory_ingest", {
          name: "Session store",
          content: AGENT_FACT,
          baseVersion: copy,
        });
        expect(w.isError, text(w)).toBeFalsy();
        expect(text(w)).toContain(`did not replace ${copy}`);
        expect(text(w)).toContain(confirmed);
        expect(text(w)).toContain(`retires ${confirmed}`);
        expect(await replaced(copy)).toBe(0);
        const lines = await readAgain();
        expect(lines[0]).toContain(`[settled decision ${confirmed}, a person's] ${CONFIRMED_TEXT}`);
        expect(lines[1]).toContain(`[lead to verify: differs from settled decision ${confirmed}] ${AGENT_FACT}`);
      });

      it("follows the stale refusal to the same place: a loser's rewrite on the copy replaces nothing", async () => {
        const worker = await connect(WORKER, "write");
        const first = await call(worker, "memory_ingest", { name: "Session store", content: OLD_FACT });
        const base = versionIn(text(first));
        await confirmedDecision(base);
        const copy = await copyOf(CONFIRMED_TEXT);
        const stale = await call(worker, "memory_ingest", {
          name: "Session store",
          content: AGENT_FACT,
          baseVersion: base,
        });
        expect(stale.isError).toBe(true);
        const w = await call(worker, "memory_ingest", {
          name: "Session store",
          content: AGENT_FACT,
          baseVersion: copy,
        });
        expect(w.isError, text(w)).toBeFalsy();
        expect(await replaced(copy)).toBe(0);
        expect((await readAgain())[0]).toContain(CONFIRMED_TEXT);
      });

      it("leaves the copy the version a second writer bases on: what is kept beside it is no newer version", async () => {
        await confirmedDecision();
        const copy = await copyOf(CONFIRMED_TEXT);
        const worker = await connect(WORKER, "write");
        await call(worker, "memory_ingest", { name: "Session store", content: AGENT_FACT, baseVersion: copy });
        const second = await connect("agent-second", "write");
        const w = await call(second, "memory_ingest", {
          name: "Session store",
          content: "Store sessions in memcached.",
          baseVersion: copy,
        });
        expect(w.isError, text(w)).toBeFalsy();
        expect(text(w)).toContain(`did not replace ${copy}`);
        const row = await db.$queryRaw<
          { n: number }[]
        >`SELECT count(*)::int AS n FROM memory_chunks WHERE "orgId" = ${ORG} AND "baseVersionId" = ${copy}`;
        expect(row[0]!.n).toBe(0);
      });

      it("answers an identical retry the way it answered the write, and stores nothing more", async () => {
        await confirmedDecision();
        const copy = await copyOf(CONFIRMED_TEXT);
        const worker = await connect(WORKER, "write");
        const args = { name: "Session store", content: AGENT_FACT, baseVersion: copy };
        const once = await call(worker, "memory_ingest", args);
        const again = await call(worker, "memory_ingest", args);
        expect(again.isError, text(again)).toBeFalsy();
        expect(versionIn(text(again))).toBe(versionIn(text(once)));
        expect(text(again)).toContain(`did not replace ${copy}`);
        expect(await replaced(copy)).toBe(0);
      });

      it("lets a person's own based write replace the copy, and the rule row stands", async () => {
        const { confirmed } = await confirmedDecision();
        const copy = await copyOf(CONFIRMED_TEXT);
        const { ingestMemory } = await import("@/lib/inngest");
        await ingestMemory({
          groupId: ORG,
          content: AGENT_FACT,
          name: "Session store",
          actorType: "human",
          origin: "app",
          actorId: CONFIRMER,
          actorName: "Confirmer",
          source: "mcp",
          scopePath: SALES,
          baseVersion: copy,
          resolve: false,
        });
        expect(await replaced(copy)).toBe(1);
        expect(
          await db.convention.findFirst({
            where: { id: confirmed },
            select: { retiredAt: true, supersededById: true },
          }),
        ).toEqual({ retiredAt: null, supersededById: null });
      });

      it("lets a confirmed change through: an agent's proposal on the copy, confirmed, with the old rule retired, leads", async () => {
        const { confirmed } = await confirmedDecision();
        const copy = await copyOf(CONFIRMED_TEXT);
        const proposer = await connect("agent-second", "write");
        const NEXT = "Store sessions in Valkey.";
        const r = await call(proposer, "memory_ingest", {
          name: "Session store",
          content: NEXT,
          kind: "decision",
          baseVersion: copy,
        });
        expect(r.isError, text(r)).toBeFalsy();
        expect(await replaced(copy)).toBe(0);
        const id = /^Recorded decision (\S+);/.exec(text(r))![1]!;
        const yes = await confirmConvention(person(CONFIRMER), id);
        await retireConvention(person(CONFIRMER), confirmed);
        const lines = await readAgain();
        expect(lines[0]).toContain(
          `[settled decision ${yes.status === "confirmed" ? yes.id : "?"}, a person's] ${NEXT}`,
        );
      });

      it("guards only a rule in force: once the rule is retired, an agent replaces the copy as any version", async () => {
        const { confirmed } = await confirmedDecision();
        await retireConvention(person(CONFIRMER), confirmed);
        const copy = await copyOf(CONFIRMED_TEXT);
        const worker = await connect(WORKER, "write");
        await call(worker, "memory_ingest", { name: "Session store", content: AGENT_FACT, baseVersion: copy });
        expect(await replaced(copy)).toBe(1);
      });

      it("guards nothing an agent proposed and no person confirmed", async () => {
        const proposer = await connect(PROPOSER, "write");
        await call(proposer, "memory_ingest", { name: "Session store", content: CONFIRMED_TEXT, kind: "decision" });
        const copy = await copyOf(CONFIRMED_TEXT);
        const worker = await connect(WORKER, "write");
        await call(worker, "memory_ingest", { name: "Session store", content: AGENT_FACT, baseVersion: copy });
        expect(await replaced(copy)).toBe(1);
      });
    });

    describe("the read label, for a copy no longer current", () => {
      const stands = (id: string) => `[a person's settled decision ${id} stands on this subject: '${CONFIRMED_TEXT}']`;

      it("names the rule and its text when an agent replaced the copy before the person confirmed", async () => {
        const proposer = await connect(PROPOSER, "write");
        const r = await call(proposer, "memory_ingest", {
          name: "Session store",
          content: CONFIRMED_TEXT,
          kind: "decision",
        });
        const id = /^Recorded decision (\S+);/.exec(text(r))![1]!;
        const copy = await copyOf(CONFIRMED_TEXT);
        const worker = await connect(WORKER, "write");
        await call(worker, "memory_ingest", { name: "Session store", content: AGENT_FACT, baseVersion: copy });
        expect(await replaced(copy)).toBe(1);
        const yes = await confirmConvention(person(CONFIRMER), id);
        if (yes.status !== "confirmed") throw new Error(yes.status);
        const lines = await readAgain();
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain(stands(yes.id));
        expect(lines[0]).toContain(`] ${AGENT_FACT}`);
        expect(lines[0]).not.toContain("differs");
      });

      it("names it when the copy lost the conflict window to an agent's fact", async () => {
        const worker = await connect(WORKER, "write");
        await call(worker, "memory_ingest", { name: "Session store", content: AGENT_FACT });
        const proposer = await connect(PROPOSER, "write");
        const r = await call(proposer, "memory_ingest", {
          name: "Session store",
          content: CONFIRMED_TEXT,
          kind: "decision",
        });
        const copy = await copyOf(CONFIRMED_TEXT);
        expect(await replaced(copy)).toBe(1);
        const yes = await confirmConvention(person(CONFIRMER), /^Recorded decision (\S+);/.exec(text(r))![1]!);
        if (yes.status !== "confirmed") throw new Error(yes.status);
        expect((await readAgain())[0]).toContain(stands(yes.id));
      });

      it("names it when the copy is gone and the rule is not", async () => {
        const { confirmed } = await confirmedDecision();
        const worker = await connect(WORKER, "write");
        await new Promise((done) => setTimeout(done, 1_100));
        await call(worker, "memory_query", { query: QUESTION });
        await call(worker, "memory_ingest", { name: "Session store", content: AGENT_FACT });
        await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG} AND "content" = ${CONFIRMED_TEXT}`;
        expect((await readAgain())[0]).toContain(stands(confirmed));
      });

      it("names it over a person's own replacement", async () => {
        const { confirmed } = await confirmedDecision();
        const copy = await copyOf(CONFIRMED_TEXT);
        const { ingestMemory } = await import("@/lib/inngest");
        await ingestMemory({
          groupId: ORG,
          content: AGENT_FACT,
          name: "Session store",
          actorType: "human",
          origin: "app",
          actorId: CONFIRMER,
          actorName: "Confirmer",
          source: "mcp",
          scopePath: SALES,
          baseVersion: copy,
          resolve: false,
        });
        const lines = await readAgain();
        expect(lines[0]).toContain(stands(confirmed));
      });

      it("a cut label's way to the whole rule works for the reader it was served to", async () => {
        const { confirmed } = await confirmedDecision();
        const reader = await connect(READER, "read");
        expect(text(await call(reader, "memory_version", { versionId: confirmed }))).toContain(CONFIRMED_TEXT);
      });

      it("says nothing once the rule is retired", async () => {
        const proposer = await connect(PROPOSER, "write");
        const r = await call(proposer, "memory_ingest", {
          name: "Session store",
          content: CONFIRMED_TEXT,
          kind: "decision",
        });
        const copy = await copyOf(CONFIRMED_TEXT);
        const worker = await connect(WORKER, "write");
        await call(worker, "memory_ingest", { name: "Session store", content: AGENT_FACT, baseVersion: copy });
        const yes = await confirmConvention(person(CONFIRMER), /^Recorded decision (\S+);/.exec(text(r))![1]!);
        if (yes.status !== "confirmed") throw new Error(yes.status);
        await retireConvention(person(CONFIRMER), yes.id);
        const lines = await readAgain();
        expect(lines[0]).not.toContain(CONFIRMED_TEXT);
        expect(lines[0]).not.toContain("lead to verify");
      });

      it.each([1, 2, 3, 4, 5, 6])("holds when an agent's based write races the confirmation (round %i)", async () => {
        const proposer = await connect(PROPOSER, "write");
        const r = await call(proposer, "memory_ingest", {
          name: "Session store",
          content: CONFIRMED_TEXT,
          kind: "decision",
        });
        const id = /^Recorded decision (\S+);/.exec(text(r))![1]!;
        const copy = await copyOf(CONFIRMED_TEXT);
        const worker = await connect(WORKER, "write");
        const [w, yes] = await Promise.all([
          call(worker, "memory_ingest", { name: "Session store", content: AGENT_FACT, baseVersion: copy }),
          confirmConvention(person(CONFIRMER), id),
        ]);
        expect(w.isError, text(w)).toBeFalsy();
        if (yes.status !== "confirmed") throw new Error(yes.status);
        expect((await readAgain()).join("\n")).toContain(CONFIRMED_TEXT);
        const first = (await readAgain())[0]!;
        expect(first).toContain(CONFIRMED_TEXT);
      });
    });

    it("task start lists the rule as settled, whichever way the copy went", async () => {
      const proposer = await connect(PROPOSER, "write");
      const r = await call(proposer, "memory_ingest", {
        name: "Session store",
        content: CONFIRMED_TEXT,
        kind: "decision",
      });
      const copy = await copyOf(CONFIRMED_TEXT);
      const worker = await connect(WORKER, "write");
      await call(worker, "memory_ingest", { name: "Session store", content: AGENT_FACT, baseVersion: copy });
      const yes = await confirmConvention(person(CONFIRMER), /^Recorded decision (\S+);/.exec(text(r))![1]!);
      if (yes.status !== "confirmed") throw new Error(yes.status);
      const reader = await connect(READER, "read");
      const notice = text(await call(reader, "memory_query", { query: QUESTION }));
      expect(notice).toMatch(
        new RegExp(`Settled in your scope[^]*\\[decision ${yes.id}\\] Session store: ${CONFIRMED_TEXT}`),
      );
    });

    describe("the refusals", () => {
      async function rule() {
        const worker = await connect(WORKER, "write");
        const first = await call(worker, "memory_ingest", { name: "Session store", content: OLD_FACT });
        const base = versionIn(text(first));
        const { confirmed } = await confirmedDecision(base);
        return { worker, base, confirmed, copy: await copyOf(CONFIRMED_TEXT) };
      }

      it("the stale refusal names the rule and the base, and following it stands beside the copy", async () => {
        const { worker, base, confirmed, copy } = await rule();
        const stale = await call(worker, "memory_ingest", {
          name: "Session store",
          content: AGENT_FACT,
          baseVersion: base,
        });
        expect(stale.isError).toBe(true);
        const reply = text(stale).split("\n\n")[0]!;
        expect(reply).toContain(`copy of decision ${confirmed}`);
        expect(reply).toContain(`write it again with baseVersion ${copy}`);
        expect(reply).toContain("never replaces it");
        expect(reply).toContain(`supersedes ${confirmed}`);
        expect(reply).toContain(`retires ${confirmed}`);
        expect(reply).toContain(`I redid my change beside ${copy}`);

        const beside = await call(worker, "memory_ingest", {
          name: "Session store",
          content: AGENT_FACT,
          baseVersion: copy,
        });
        expect(beside.isError, text(beside)).toBeFalsy();
        expect(await replaced(copy)).toBe(0);
        const lines = await readAgain();
        expect(lines[0]).toContain(CONFIRMED_TEXT);
        expect(lines[1]).toContain(AGENT_FACT);
      });

      it("the unread-version refusal names the copy as the base, and says the write stands beside it", async () => {
        const worker = await connect(WORKER, "write");
        const first = await call(worker, "memory_ingest", { name: "Session store", content: OLD_FACT });
        const { confirmed } = await confirmedDecision(versionIn(text(first)));
        const copy = await copyOf(CONFIRMED_TEXT);
        await new Promise((done) => setTimeout(done, 1_100));
        const refused = await call(worker, "memory_ingest", { name: "Session store", content: AGENT_FACT });
        expect(refused.isError).toBe(true);
        expect(text(refused)).toContain(`copy of decision ${confirmed}`);
        expect(text(refused)).toContain(`pass baseVersion ${copy}`);
        expect(text(refused)).toContain("beside");
      });

      it("a loser told the same text repeats is told so, and the named base stores it", async () => {
        await confirmedDecision();
        const copy = await copyOf(CONFIRMED_TEXT);
        const w = await connect(WORKER, "write");
        await call(w, "memory_ingest", { name: "Session store", content: AGENT_FACT });
        const again = await call(w, "memory_ingest", { name: "Session store", content: AGENT_FACT });
        expect(again.isError).toBe(true);
        expect(text(again)).toContain("The same text again without a baseVersion only repeats this answer.");
        const based = await call(w, "memory_ingest", { name: "Session store", content: AGENT_FACT, baseVersion: copy });
        expect(based.isError, text(based)).toBeFalsy();
        expect(await replaced(copy)).toBe(0);
      });

      it("a rule's stale fact copy is told to stand beside a person's copy, by its base", async () => {
        const { base, copy, confirmed } = await rule();
        const proposer = await connect("agent-second", "write");
        const r = await call(proposer, "memory_ingest", {
          name: "Session store",
          content: "Store sessions in Valkey.",
          kind: "decision",
          baseVersion: base,
        });
        expect(r.isError, text(r)).toBeFalsy();
        expect(text(r)).toContain(`copy of decision ${confirmed}`);
        expect(text(r)).toContain(`To store the copy beside ${copy}`);
        expect(text(r)).toContain(`baseVersion ${copy}, and without kind or supersedes`);
      });
    });

    it.each([
      ["inside the conflict window", 0],
      ["after it", 1_100],
    ])("an unbased write %s leaves the rule first", async (_when, wait) => {
      await confirmedDecision();
      const worker = await connect(WORKER, "write");
      if (wait) await new Promise((done) => setTimeout(done, wait));
      await call(worker, "memory_ingest", { name: "Session store", content: AGENT_FACT });
      expect((await readAgain())[0]).toContain(CONFIRMED_TEXT);
    });
  },
);
