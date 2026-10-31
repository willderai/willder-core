// Keeping a version beside a person's rule copy must not cost an erasure its reach
// (services/memory/person-rule-copy.ts, services/memory/erasure-lineage.ts). The graph store is
// stubbed: what is proved here is which stored versions go. Run with QA_DATABASE_URL set.
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
          throw new Error("no llm");
        },
      },
    },
  }),
  LLM_MODEL_EXTRACT: "test-model",
  LLM_MODEL_ORCHESTRATOR: "test-model",
}));
vi.mock("@/services/memory/store", async (orig) => {
  const m = await orig<typeof import("@/services/memory/store")>();
  const over: Record<string, unknown> = {
    planPersonErasure: async () => [],
    erasePerson: async () => ({ episodes: 0, nodes: 0, edges: 0, summaries: 0, episodeIds: [] }),
    removeChunkFacts: async () => undefined,
    removeEpisode: async () => ({ removed: true }),
  };
  return {
    ...m,
    graphitiStore: new Proxy(m.graphitiStore as object, {
      get(t, p) {
        if (typeof p === "string" && p in over) return over[p];
        const v = (t as Record<string | symbol, unknown>)[p];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    }),
  };
});

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "qa_rule_copy_erase";
const OTHER = "qa_rule_copy_erase_o";
const ROOT = `org_${ORG}`;
const SALES = `${ROOT}.sales`;
const MKT = `${ROOT}.marketing`;
const OTHER_ROOT = `org_${OTHER}`;
const OTHER_SALES = `${OTHER_ROOT}.sales`;
const ADMIN = "qa_rule_admin";
const CONFIRMER = "qa_rule_confirmer";
const EMBEDDING = Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
interface R {
  content: { type: string; text: string }[];
  isError?: boolean;
}

describe.skipIf(!QA_URL)("what a person erasure takes with a person's rule copy", { timeout: 120_000 }, () => {
  let db: PrismaClient;
  let reg: (typeof import("./tools"))["registerWillderTools"];
  let conv: typeof import("@/services/memory/conventions");
  let erasePerson: (typeof import("@/services/memory/person-erasure"))["erasePerson"];
  const clients: Client[] = [];
  const person = (id: string): AccessContext => ({
    orgId: ORG,
    actor: { type: "human", id, role: "member" },
    origin: "app",
  });
  const admin: AccessContext = { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "app" };

  async function connect(
    agentId: string,
    permission: "read" | "write",
    scopePath = SALES,
    orgId = ORG,
  ): Promise<Client> {
    const capabilityToken = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId,
        agentId,
        tokenHash: hashCapabilityToken(capabilityToken),
        scopePath,
        permission,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    const server = new McpServer({ name: "t", version: "0.0.0" });
    reg(
      server,
      { orgId, actor: { type: "agent", id: agentId, capabilityToken }, origin: "mcp" },
      { orgId, agentId, scopePath },
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    const client = new Client({ name: "c", version: "0.0.0" });
    await client.connect(a);
    clients.push(client);
    return client;
  }
  const call = async (c: Client, name: string, args: Record<string, unknown>) =>
    (await c.callTool({ name, arguments: args })) as R;
  const text = (r: R) => r.content.map((c) => c.text).join("\n");
  const lines = (t: string) => t.split("\n").filter((l) => l.startsWith("•"));
  const versionIn = (t: string) => /Version: (\S+?)\./.exec(t)?.[1] ?? null;
  const ruleId = (t: string) => /^Recorded (?:decision|convention) (\S+);/.exec(t)![1]!;
  const wait = (ms: number) => new Promise((d) => setTimeout(d, ms));
  async function read(
    q: string,
    id = `agent-reader-${Math.random().toString(36).slice(2, 7)}`,
    scope = SALES,
    args: Record<string, unknown> = {},
  ): Promise<string> {
    const r = await connect(id, "read", scope);
    await call(r, "memory_query", { query: q, ...args });
    return text(await call(r, "memory_query", { query: q, ...args }));
  }
  const chunk = async (content: string) =>
    (
      await db.$queryRaw<{ id: string }[]>`SELECT id FROM memory_chunks WHERE "orgId" = ${ORG} AND content = ${content}`
    )[0]?.id ?? null;

  async function confirmed(
    subject: string,
    content: string,
    scope = SALES,
    base?: string,
    kind: "decision" | "convention" = "decision",
  ) {
    const p = await connect(`agent-proposer-${Math.random().toString(36).slice(2, 6)}`, "write", scope);
    const r = await call(p, "memory_ingest", {
      name: subject,
      content,
      kind,
      ...(base ? { baseVersion: base } : {}),
      ...(scope !== SALES ? { scopePath: scope } : {}),
    });
    if (r.isError) throw new Error(text(r));
    const proposed = ruleId(text(r));
    const c = await conv.confirmConvention(person(CONFIRMER), proposed);
    if (c.status !== "confirmed") throw new Error(c.status);
    return { proposed, confirmed: c.id };
  }
  async function wipe() {
    for (const orgId of [ORG, OTHER]) {
      await db.taskStartServedItem.deleteMany({ where: { orgId } });
      await db.taskStartDelivery.deleteMany({ where: { orgId } });
      await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${orgId}`;
      await db.factEdge.deleteMany({ where: { orgId } });
      for (const rule of await db.convention.findMany({
        where: { orgId },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      }))
        await db.convention.updateMany({ where: { orgId, supersedesId: rule.id }, data: { supersedesId: null } });
      await db.convention.updateMany({ where: { orgId }, data: { supersededById: null } });
      await db.convention.deleteMany({ where: { orgId } });
      await db.changeEvent.deleteMany({ where: { orgId } });
      await db.erasureSuppression.deleteMany({ where: { orgId } });
      await db.agentCursor.deleteMany({ where: { orgId } });
      await db.capability.deleteMany({ where: { orgId } });
      await db.contact.deleteMany({ where: { orgId } });
      await db.auditLog.deleteMany({ where: { orgId } });
      await db.grant.deleteMany({ where: { orgId } });
      await db.orgMembership.deleteMany({ where: { orgId } });
      await db.scope.deleteMany({ where: { orgId } });
      await db.user.deleteMany({ where: { orgId } });
    }
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL!;
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
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL! }) });
    const ing = await import("@/lib/inngest");
    vi.spyOn(ing.inngest, "send").mockImplementation((async () => ({ ids: ["job"] })) as never);
    ({ registerWillderTools: reg } = await import("./tools"));
    conv = await import("@/services/memory/conventions");
    ({ erasePerson } = await import("@/services/memory/person-erasure"));
  }, 180_000);
  afterAll(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
    await wipe();
    await db.$disconnect();
    vi.unstubAllGlobals();
  });
  beforeEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
    await wipe();
    for (const [o, root, sub] of [
      [ORG, ROOT, [SALES, MKT]],
      [OTHER, OTHER_ROOT, [OTHER_SALES]],
    ] as const) {
      await db.org.upsert({ where: { id: o }, update: {}, create: { id: o, name: o } });
      await db.scope.create({ data: { orgId: o, path: root, name: "root" } });
      for (const p of sub) await db.scope.create({ data: { orgId: o, path: p, name: p.split(".").pop()! } });
    }
    const root = await db.scope.findFirstOrThrow({ where: { orgId: ORG, path: ROOT } });
    await db.user.create({
      data: { id: CONFIRMER, orgId: ORG, email: `${CONFIRMER}@g.test`, clerkId: `clerk-${CONFIRMER}`, name: CONFIRMER },
    });
    await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: `${ADMIN}@g.test`, clerkId: `clerk-${ADMIN}`, role: "admin", name: ADMIN },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: CONFIRMER, permission: "write" },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    await db.orgMembership.upsert({
      where: { orgId_userId: { orgId: ORG, userId: CONFIRMER } },
      update: { role: "member" },
      create: { orgId: ORG, userId: CONFIRMER, role: "member", assertedAt: new Date() },
    });
    await db.orgMembership.upsert({
      where: { orgId_userId: { orgId: ORG, userId: ADMIN } },
      update: { role: "admin" },
      create: { orgId: ORG, userId: ADMIN, role: "admin", assertedAt: new Date() },
    });
    await db.contact.create({ data: { id: "dana", orgId: ORG, name: "Dana Whitfield", email: "dana.w@acme.example" } });
  });

  const SUBJ = "Refund approvals";
  const RULE = "Dana Whitfield approves refunds over 500 dollars.";
  const FIRST_RULE = "She approves refunds over 900 dollars.";
  const SECOND_RULE = "She approves refunds over 950 dollars.";
  const stored = async () =>
    (await db.$queryRaw<{ content: string }[]>`SELECT content FROM memory_chunks WHERE "orgId" = ${ORG}`)
      .map((r) => r.content)
      .sort();
  const dana = () => erasePerson(admin, { contactId: "dana" });
  const write = (w: Client, content: string, baseVersion?: string, name = SUBJ) =>
    call(w, "memory_ingest", { name, content, ...(baseVersion ? { baseVersion } : {}) });

  describe("a kept version goes with the rule's copy", () => {
    it("takes a rewrite and the chain built on it", async () => {
      await confirmed(SUBJ, RULE);
      const copy = (await chunk(RULE))!;
      const w = await connect("agent-worker", "write");
      const a = await write(w, FIRST_RULE, copy);
      await write(w, SECOND_RULE, versionIn(text(a))!);
      await dana();
      expect(await stored()).toEqual([]);
    });

    it("takes a long chain, each link written on the one before", async () => {
      await confirmed(SUBJ, RULE);
      const w = await connect("agent-worker", "write");
      let base = (await chunk(RULE))!;
      for (let i = 0; i < 5; i++)
        base = versionIn(text(await write(w, `She approves refunds over ${1000 + i} dollars.`, base)))!;
      await dana();
      expect(await stored()).toEqual([]);
    });

    it("takes the rewrite of a stale writer who follows its refusal", async () => {
      const w = await connect("agent-worker", "write");
      const base = versionIn(text(await write(w, "The refund owner approves over 500 dollars.")))!;
      await confirmed(SUBJ, RULE, SALES, base);
      const stale = await write(w, FIRST_RULE, base);
      expect(stale.isError).toBe(true);
      const refusal = text(stale).split("\n\n")[0]!;
      const copy = (await chunk(RULE))!;
      expect(refusal).toContain(`write it again with baseVersion ${copy}`);
      await write(w, FIRST_RULE, copy);
      await dana();
      const left = await stored();
      expect(left).not.toContain(FIRST_RULE);
      expect(lines(await read("Who approves refunds?")).join("\n")).not.toContain("approves");
    });

    it("takes a proposal based on the copy, confirmed, with the old rule retired", async () => {
      const { confirmed: rid } = await confirmed(SUBJ, RULE);
      const copy = (await chunk(RULE))!;
      const w = await connect("agent-worker", "write");
      const a = await call(w, "memory_ingest", {
        name: SUBJ,
        content: FIRST_RULE,
        kind: "decision",
        supersedes: rid,
        baseVersion: copy,
      });
      await conv.confirmConvention(person(CONFIRMER), ruleId(text(a)));
      await conv.retireConvention(admin, rid);
      await dana();
      expect(await stored()).toEqual([]);
    });

    it("finds the link again on a later walk, through the erased version", async () => {
      await confirmed(SUBJ, RULE);
      const copy = (await chunk(RULE))!;
      const w = await connect("agent-worker", "write");
      await write(w, FIRST_RULE, copy);
      await dana();
      const { erasedVersionsWithReplacements } = await import("@/services/memory/erasure-lineage");
      expect(await erasedVersionsWithReplacements(db as never, ORG)).toContain(copy);
    });

    it("takes a rewrite that names someone else, as a based rewrite always went: what it was written from is what counts", async () => {
      await confirmed(SUBJ, RULE);
      const w = await connect("agent-worker", "write");
      await write(w, "Bob Marsh approves refunds over 900 dollars.", (await chunk(RULE))!);
      await dana();
      expect(await stored()).toEqual([]);
    });
  });

  describe("and nothing unrelated goes", () => {
    const BOB = "Bob Marsh approves discounts over 20 percent.";

    it("leaves a kept version on another person's rule, and that rule", async () => {
      await confirmed(SUBJ, RULE);
      await confirmed("Discount approvals", BOB);
      const w = await connect("agent-worker", "write");
      await write(w, "He approves discounts over 30 percent.", (await chunk(BOB))!, "Discount approvals");
      await dana();
      expect(await stored()).toEqual([BOB, "He approves discounts over 30 percent."].sort());
    });

    it("leaves a kept version whose rule names no erased person, on a subject that is not her", async () => {
      const NEUTRAL = "Refunds over 500 dollars go through the finance queue.";
      await confirmed("Refund queue", NEUTRAL);
      const w = await connect("agent-worker", "write");
      await write(w, "Refunds go through the support queue.", (await chunk(NEUTRAL))!, "Refund queue");
      await dana();
      expect(await stored()).toEqual([NEUTRAL, "Refunds go through the support queue."].sort());
    });

    it("leaves a fact beside the rule that names no base, as it always stood", async () => {
      await confirmed(SUBJ, RULE);
      const w = await connect("agent-worker", "write");
      await call(w, "memory_query", { query: "Who approves refunds?" });
      await wait(1100);
      await write(w, FIRST_RULE);
      await dana();
      expect(await stored()).toEqual([FIRST_RULE]);
    });

    it("leaves a declared share: its derivedFrom edge names a scope, never a version", async () => {
      await confirmed(SUBJ, RULE);
      const w = await connect("agent-worker", "write");
      const share = versionIn(text(await write(w, "A note shared across scopes.", undefined, "Note")))!;
      const root = await db.scope.findFirstOrThrow({ where: { orgId: ORG, path: MKT } });
      await db.factEdge.create({
        data: {
          orgId: ORG,
          fromId: share,
          toId: root.id,
          kind: "derivedFrom",
          scopePath: SALES,
          actorType: "agent",
          actorId: "agent-worker",
        },
      });
      await dana();
      expect(await stored()).toEqual(["A note shared across scopes."]);
    });
  });

  describe("every reader of the link", () => {
    async function kept() {
      const { confirmed: rid } = await confirmed("Session store", "Store sessions in Postgres.");
      const copy = (await chunk("Store sessions in Postgres."))!;
      const w = await connect("agent-worker", "write");
      const k = versionIn(text(await write(w, "Store sessions in local storage.", copy, "Session store")))!;
      return { rid, copy, k, w };
    }

    it("records one edge, from the kept version to the copy, and no base", async () => {
      const { copy, k, w } = await kept();
      await write(w, "Store sessions in local storage.", copy, "Session store");
      expect(
        await db.factEdge.findMany({
          where: { orgId: ORG, kind: "derivedFrom" },
          select: { fromId: true, toId: true },
        }),
      ).toEqual([{ fromId: k, toId: copy }]);
    });

    it("never reads as a share on a served line", async () => {
      await kept();
      expect((await read("sessions")).toLowerCase()).not.toContain("shared from");
    });

    it("the stale report lists nothing while the copy is current, and the kept version once a person replaced it", async () => {
      const { copy, k } = await kept();
      const { staleReport } = await import("@/services/memory/dependencies");
      expect((await staleReport(admin, SALES)).stale).toEqual([]);
      const { ingestMemory } = await import("@/lib/inngest");
      await ingestMemory({
        groupId: ORG,
        content: "Store sessions in Valkey.",
        name: "Session store",
        actorType: "human",
        origin: "app",
        actorId: CONFIRMER,
        actorName: "C",
        source: "mcp",
        scopePath: SALES,
        baseVersion: copy,
        resolve: false,
      });
      expect((await staleReport(admin, SALES)).stale.map((s) => s.recordId)).toEqual([k]);
    });

    it("keeps the kept version current through a third write in the window, as its reply said", async () => {
      await confirmed("Session store", "Store sessions in Postgres.");
      const copy = (await chunk("Store sessions in Postgres."))!;
      const a = await connect("agent-a", "write");
      const b = await connect("agent-b", "write");
      const k = versionIn(text(await write(a, "Store sessions in local storage.", copy, "Session store")))!;
      await write(b, "Store sessions on disk.", undefined, "Session store");
      expect(await db.factEdge.count({ where: { orgId: ORG, kind: "supersedes", toId: k } })).toBe(0);
      expect(await db.factEdge.count({ where: { orgId: ORG, kind: "supersedes", toId: copy } })).toBe(0);
    });
  });
});
