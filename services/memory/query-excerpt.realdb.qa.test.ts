// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The over-budget fact on a real read is served as a query-focused excerpt, and the
// excerpt is cut only from a fact the erasure filter already let through. Everything
// below the checked read is real except Graphiti and the embedding service: check()
// runs against a live capability, the hybrid store routes the read, pgvector's
// similarity SQL and the erasure suppression list run against Postgres, and the page
// is packed to the team tier's real token budget.
//
// Set QA_DATABASE_URL to an ISOLATED test database with the migrations applied.
// Never the sandbox's inherited DATABASE_URL. Skips cleanly without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
// Leaf modules, not the `@/services/access` barrel: the barrel builds the `@/lib/db`
// singleton at import time, before beforeAll points DATABASE_URL at the test database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import type { MemoryStore } from "./memory-store";

vi.mock("./store", () => ({ memory: {} }));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "excerptqa";
const ROOT = `org_${ORG}`;
const DIMENSIONS = 384;
const TEAM_BUDGET_TOKENS = 6_000;

const QUERY = "why did the revoked token pass the cache";
const ERASED_EMAIL = "talvi.reyes@example.com";
const ANSWER = "The revoked token passed the cache because invalidation ran after the read.";

/** A unit vector whose cosine similarity to the query vector [1, 0, ...] is `similarity`. */
function vectorAt(similarity: number): string {
  const rest = Array(DIMENSIONS - 2).fill(0);
  return `[${[similarity, Math.sqrt(1 - similarity ** 2), ...rest].join(",")}]`;
}

/** About 30,000 characters of release notes with `buried` as sentence 250 of 400: well over the team budget. */
function longFact(buried: string): string {
  const filler = Array.from(
    { length: 400 },
    (_, i) => `Deploy note ${i} covers routine release housekeeping for the web tier.`,
  );
  filler[250] = buried;
  return filler.join(" ");
}

const estimateTokens = (text: string) => Math.ceil(text.length / 4);

describe.skipIf(!QA_URL)("the over-budget fact on a real read", () => {
  let db: PrismaClient;
  let GuardedMemoryStore: (typeof import("./guarded-store"))["GuardedMemoryStore"];
  let HybridMemoryStore: (typeof import("./hybrid-store"))["HybridMemoryStore"];
  let PgvectorMemoryStore: (typeof import("./pgvector-store"))["PgvectorMemoryStore"];
  let recordSuppressions: (typeof import("./erasure-suppression"))["recordSuppressions"];

  const emptyGraph = {
    retrieve: vi.fn(async () => ({ facts: [], storesRead: [{ store: "graph" as const }] })),
  } as unknown as MemoryStore;

  const reader = () =>
    new GuardedMemoryStore(new HybridMemoryStore(emptyGraph, new PgvectorMemoryStore()), async () => "team");

  /** Written an hour ago, so an erasure recorded now covers it. */
  const insertChunk = (id: string, content: string, similarity: number) =>
    db.$executeRaw`
      INSERT INTO memory_chunks ("id","orgId","content","source","actorType","scopePath","embedding","createdAt")
      VALUES (${id}, ${ORG}, ${content}, 'text', 'human', ${ROOT}, ${vectorAt(similarity)}::vector, NOW() - INTERVAL '1 hour')
    `;

  async function rootReader(): Promise<AccessContext> {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId: "root-reader",
        tokenHash: hashCapabilityToken(token),
        scopePath: ROOT,
        permission: "read",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return { orgId: ORG, actor: { type: "agent", id: "root-reader", capabilityToken: token }, origin: "mcp" };
  }

  async function clear() {
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
    await db.erasureSuppression.deleteMany({ where: { orgId: ORG } });
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.capability.deleteMany({ where: { orgId: ORG } });
    await db.scope.deleteMany({ where: { orgId: ORG } });
  }

  beforeAll(async () => {
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ GuardedMemoryStore } = await import("./guarded-store"));
    ({ HybridMemoryStore } = await import("./hybrid-store"));
    ({ PgvectorMemoryStore } = await import("./pgvector-store"));
    ({ recordSuppressions } = await import("./erasure-suppression"));
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await clear();
    await db.$disconnect();
  });

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ embedding: [1, ...Array(DIMENSIONS - 1).fill(0)] }), { status: 200 }),
      ),
    );
    await clear();
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
    await db.scope.create({ data: { orgId: ORG, path: ROOT, name: ROOT } });
  });

  it("serves the buried answer of a fact larger than the whole budget, marked, within the budget", async () => {
    const long = longFact(ANSWER);
    await insertChunk("short", "Release 4.2 shipped on Tuesday.", 0.9);
    await insertChunk("long", long, 0.8);
    await insertChunk("after", "A lower-ranked fact that must not displace the excerpt.", 0.7);

    const { facts } = await reader().retrieve(await rootReader(), { groupId: ORG, query: QUERY, limit: 10 });

    expect(facts.map((f) => f.uuid)).toEqual(["short", "long"]);
    expect(facts[0].fact).toBe("Release 4.2 shipped on Tuesday.");
    expect(facts[0].excerptOfChars).toBeUndefined();
    expect(facts[1].excerptOfChars).toBe(long.length);
    expect(facts[1].fact).toContain(ANSWER);
    expect(facts[1].fact.startsWith("… ") && facts[1].fact.endsWith(" …")).toBe(true);
    expect(facts.reduce((sum, f) => sum + estimateTokens(f.fact), 0)).toBeLessThanOrEqual(TEAM_BUDGET_TOKENS);
  });

  it("serves nothing of an erased person's fact, not even its sentences that do not name them", async () => {
    // The erased fact ranks first and its matching sentence does not name her; the
    // sentence that does is elsewhere. An excerpt cut before the filter would serve it.
    const erasedFact = longFact(ANSWER).replace(
      "Deploy note 10 covers",
      `Escalations about the revoked token cache go to ${ERASED_EMAIL}, who covers`,
    );
    const bystanderAnswer = "The revoked token passed the cache because the TTL was 900 seconds.";
    await insertChunk("erased", erasedFact, 0.9);
    await insertChunk("bystander", longFact(bystanderAnswer), 0.8);
    await recordSuppressions(db, ORG, "qa-erasure", { emails: [ERASED_EMAIL], names: [], contactIds: [] });

    const { facts } = await reader().retrieve(await rootReader(), { groupId: ORG, query: QUERY, limit: 10 });

    expect(facts.map((f) => f.uuid)).toEqual(["bystander"]);
    expect(facts[0].fact).toContain(bystanderAnswer);
    const served = facts.map((f) => f.fact).join("\n");
    expect(served).not.toContain(ERASED_EMAIL);
    expect(served).not.toContain(ANSWER);
  });

  it("negative control: without the suppression row, the same read excerpts the person's fact", async () => {
    const erasedFact = longFact(ANSWER).replace(
      "Deploy note 10 covers",
      `Escalations about the revoked token cache go to ${ERASED_EMAIL}, who covers`,
    );
    await insertChunk("erased", erasedFact, 0.9);

    const { facts } = await reader().retrieve(await rootReader(), { groupId: ORG, query: QUERY, limit: 10 });

    expect(facts.map((f) => f.uuid)).toEqual(["erased"]);
    expect(facts[0].excerptOfChars).toBe(erasedFact.length);
  });
});

describe("packWithinTokenBudget's bound, over random pages", () => {
  it("never serves more estimated tokens than the budget, and excerpts at most one fact, last", async () => {
    const { packWithinTokenBudget } = await import("./account-tiers");
    let seed = 624;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const words = ["revoked", "token", "cache", "deploy", "the", "Wörter", "数据", "ok.", "why?", "\n", "a!"];
    for (let run = 0; run < 400; run++) {
      const facts = Array.from({ length: 1 + Math.floor(rand() * 8) }, (_, i) => ({
        uuid: `f${i}`,
        validAt: null,
        fact: Array.from({ length: Math.floor(rand() * 3000) }, () => words[Math.floor(rand() * words.length)]).join(
          rand() < 0.5 ? " " : ". ",
        ),
      }));
      const budget = Math.floor(rand() * 4000);
      const packed = packWithinTokenBudget(facts, budget, "why revoked token cache");
      const used = packed.reduce((sum, f) => sum + estimateTokens(f.fact), 0);
      expect(used).toBeLessThanOrEqual(budget);
      const excerpts = packed.filter((f) => f.excerptOfChars !== undefined);
      expect(excerpts.length).toBeLessThanOrEqual(1);
      if (excerpts.length) expect(packed[packed.length - 1]).toBe(excerpts[0]);
      packed.forEach((f, i) => expect(f.uuid).toBe(`f${i}`));
    }
  });
});
