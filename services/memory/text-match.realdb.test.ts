// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A read that quotes a stored row's opening line serves that row, in a scope full of
// rows on the same subject (services/memory/text-match-fusion.ts).
//
// Real: Postgres with pgvector and pg_trgm, check() against a live capability,
// GuardedMemoryStore, HybridMemoryStore and the vector store's SQL. Fakes: the graph
// store, which answers with more agent-tier facts than the page holds, and the embedding
// service, which puts the question on one axis, the 40 near-duplicate rows at a cosine of
// 0.9 from it and the asked row at 0.4: the vector legs alone rank it last.
//
// Case types covered: the asked row first among 41 rows whose openings differ only in a
// task id; the same text in every place the reader may not read (another tenant, a sibling
// scope whose path extends the reader's, an untagged row under a narrow grant, a version
// that lost a write race, a scope one `_` wildcard away, the reader's ancestor scope, a row
// still pending its embedding), none served; a query of three
// words, ordered as without the text leg; quotes stored with other whitespace (Unicode
// spaces and a byte-order mark included), case, regex operators, LIKE wildcards or a
// backslash, or cut mid-word, each asked by its change summary beside a decoy that an
// unescaped or looser match would also find; a row opening with the quote ahead of a nearer
// one holding it later; a quote more rows hold than the leg's limit; a query of 8,000 words.
// Erasure-suppressed rows: erasure-before-limit.realdb.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the
// `@/lib/db` singleton at import time, before beforeAll points DATABASE_URL at
// the test database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import type { MemoryStore } from "./memory-store";
import type { MemoryFact } from "@/types/memory";
import { stubEmbedService } from "./embed-service-stub.testsupport";

vi.mock("./store", () => ({ memory: {} }));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qa_text_match";
const OTHER_ORG = "qa_text_match_other";
const ROOT = `org_${ORG}`;
const RUN = `${ROOT}.abrun`;
// Extends RUN's path without being under it: `abrun` against `abrunb`.
const SIBLING = `${ROOT}.abrunb`;
// One character off RUN where RUN would have `_`: `abrun` against `abrxn` read through `abr_n`.
const WILDCARD_SIBLING = `${ROOT}.abrxn`;
const DIMENSIONS = 384;

const findings = (task: string) =>
  `Findings ${task}: Cause is components/settings/sources-panel.tsx, which drops the source row when its sync fails; fix in the retry path and keep the row.`;
const ASKED = findings("T-4c378528");
// What the measure asks with: the record's opening, cut at 120 characters.
const QUESTION = ASKED.slice(0, 120);
const TASKS = Array.from({ length: 40 }, (_, i) => `T-${(0x1000a000 + i * 7919).toString(16)}`);

const vector = (...leading: number[]) => `[${[...leading, ...Array(DIMENSIONS - leading.length).fill(0)].join(",")}]`;
const NEAR = vector(0.9, Math.sqrt(1 - 0.81));
const BLAND = vector(0.4, Math.sqrt(1 - 0.16));

const graphFacts: MemoryFact[] = Array.from({ length: 20 }, (_, i) => ({
  uuid: `graph-${i + 1}`,
  fact: `the nightly job ran task ${i + 1}`,
  validAt: null,
  actorType: "agent",
  store: "graph",
}));

describe.skipIf(!QA_URL)("a read that quotes a stored row serves it, real Postgres", () => {
  let db: PrismaClient;
  let GuardedMemoryStore: (typeof import("./guarded-store"))["GuardedMemoryStore"];
  let HybridMemoryStore: (typeof import("./hybrid-store"))["HybridMemoryStore"];
  let PgvectorMemoryStore: (typeof import("./pgvector-store"))["PgvectorMemoryStore"];
  // Imported after DATABASE_URL points at the test database (the `@/services/access` barrel).
  let summarizeChange: (typeof import("./change-events"))["summarizeChange"];

  const busyGraph = {
    retrieve: vi.fn(async () => ({ facts: graphFacts, storesRead: [{ store: "graph" as const }] })),
  } as unknown as MemoryStore;
  const reader = () =>
    new GuardedMemoryStore(new HybridMemoryStore(busyGraph, new PgvectorMemoryStore()), async () => "enterprise");

  const insert = (id: string, content: string, embedding: string, scopePath: string | null, orgId = ORG) =>
    db.$executeRaw`
      INSERT INTO memory_chunks ("id","orgId","content","source","actorType","actorName","scopePath","embedding","createdAt")
      VALUES (${id}, ${orgId}, ${content}, 'text', 'agent', 'handoff-agent-a', ${scopePath}, ${embedding}::vector, NOW())`;

  async function runReader(): Promise<AccessContext> {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId: "run-reader",
        tokenHash: hashCapabilityToken(token),
        scopePath: RUN,
        permission: "read",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return { orgId: ORG, actor: { type: "agent", id: "run-reader", capabilityToken: token }, origin: "mcp" };
  }

  /** The vector store's own answer, which says which rows the text leg found. */
  const searchRun = async (query: string, limit = 50) =>
    new PgvectorMemoryStore().retrieve({ groupId: RUN, tenantId: ORG, scopePath: RUN, query, limit });
  const textMatched = async (query: string) =>
    (await searchRun(query)).facts.filter((f) => f.textMatchRank !== undefined).map((f) => f.uuid);

  const ask = async (query: string, limit = 10) =>
    (await reader().retrieve(await runReader(), { groupId: ORG, query, limit }, RUN)).facts.map((f) => f.uuid);

  async function wipe() {
    for (const org of [ORG, OTHER_ORG]) {
      await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${org}`;
      await db.factEdge.deleteMany({ where: { orgId: org } });
      await db.auditLog.deleteMany({ where: { orgId: org } });
      await db.capability.deleteMany({ where: { orgId: org } });
      await db.scope.deleteMany({ where: { orgId: org } });
    }
  }

  beforeAll(async () => {
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ GuardedMemoryStore } = await import("./guarded-store"));
    ({ HybridMemoryStore } = await import("./hybrid-store"));
    ({ PgvectorMemoryStore } = await import("./pgvector-store"));
    ({ summarizeChange } = await import("./change-events"));
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubEmbedService(() => [1, ...Array(DIMENSIONS - 1).fill(0)]);
    await wipe();
    for (const org of [ORG, OTHER_ORG])
      await db.org.upsert({ where: { id: org }, update: {}, create: { id: org, name: org } });
    for (const path of [ROOT, RUN, SIBLING]) await db.scope.create({ data: { orgId: ORG, path, name: path } });
    for (const [i, task] of TASKS.entries()) await insert(`near-${i + 1}`, findings(task), NEAR, RUN);
    await insert("asked", ASKED, BLAND, RUN);
  });

  it("is set up so that the vector legs alone rank the asked row below the page", async () => {
    const nearest = await db.$queryRaw<{ id: string }[]>`
      SELECT id FROM memory_chunks WHERE "orgId" = ${ORG} ORDER BY embedding <=> ${vector(1)}::vector, id LIMIT 40`;
    expect(nearest.map((r) => r.id)).not.toContain("asked");
  });

  it("serves the asked row first among the stored rows, on a page the graph would fill", async () => {
    const served = await ask(QUESTION);

    expect(served).toHaveLength(10);
    expect(served.filter((id) => !id.startsWith("graph-"))[0]).toBe("asked");
  });

  it("serves none of the same text the reader may not read", async () => {
    // As far from the question as the asked row, so only the text leg could bring them in,
    // and it would rank them beside it.
    // Each its own text, which opens with the asked row's, so no step merges them as copies.
    const copy = (where: string) => `${ASKED} Copy in ${where}.`;
    await insert("other-tenant", copy("another tenant"), BLAND, RUN.replace(ORG, OTHER_ORG), OTHER_ORG);
    await insert("sibling-scope", copy("a sibling scope"), BLAND, SIBLING);
    await insert("untagged", copy("no scope"), BLAND, null);
    await insert("lost-race", copy("the losing version"), BLAND, RUN);
    // A row in the reader's ancestor scope, and a row still pending its embedding.
    await insert("ancestor-scope", copy("the org root"), BLAND, ROOT);
    await db.$executeRaw`
      INSERT INTO memory_chunks ("id","orgId","content","source","actorType","actorName","scopePath","createdAt")
      VALUES ('pending', ${ORG}, ${copy("a pending row")}, 'text', 'agent', 'handoff-agent-a', ${RUN}, NOW())`;
    // `_` read as a LIKE wildcard would put this scope under RUN.
    await db.scope.create({ data: { orgId: ORG, path: WILDCARD_SIBLING, name: WILDCARD_SIBLING } });
    await insert("wildcard-sibling", copy("a scope one character off"), BLAND, WILDCARD_SIBLING);
    await db.factEdge.create({
      data: {
        orgId: ORG,
        fromId: "asked",
        toId: "lost-race",
        kind: "supersedes",
        scopePath: RUN,
        actorType: "agent",
        actorId: "qa",
      },
    });

    const served = await ask(QUESTION);

    expect(served.filter((id) => !id.startsWith("graph-"))[0]).toBe("asked");
    expect(
      served.filter((id) =>
        [
          "other-tenant",
          "sibling-scope",
          "untagged",
          "lost-race",
          "wildcard-sibling",
          "ancestor-scope",
          "pending",
        ].includes(id),
      ),
    ).toEqual([]);
  });

  it.each([
    // Stored as a writer spelled it; asked as a change summary prints it (one space per break).
    {
      name: "whitespace and control characters",
      stored: "the  renewal\tkey\u0001lives in\n\nthe drawer",
      asked: "the renewal key lives in the drawer",
      decoy: "the renewal key never lives in the drawer",
    },
    {
      name: "case",
      stored: "THE RENEWAL KEY LIVES IN THE DRAWER",
      asked: "the renewal key lives in the drawer",
      decoy: "the renewal keys live in the drawer",
    },
    {
      name: "regex operators",
      stored: "cost (USD) is 5.0* per seat [a|b]",
      asked: "cost (USD) is 5.0* per seat [a|b]",
      decoy: "cost USD is 5x0 per seat a",
    },
    {
      name: "LIKE wildcards and a backslash",
      stored: "rate_limit is 100% at C:\\data now",
      asked: "rate_limit is 100% at C:\\data now",
      decoy: "rateXlimit is 1000 at C:/data now",
    },
    // JavaScript's `\s` holds these; Postgres's [[:space:]] leaves them out on some locales.
    {
      name: "a byte-order mark",
      stored: "Findings T-1: the renewal\ufeffkey lives in the drawer",
      asked: "Findings T-1: the renewal key lives in the drawer",
      decoy: "Findings T-1: the renewalXkey lives in the drawer",
    },
    {
      name: "a no-break space",
      stored: "Findings T-1: the renewal\u00a0key lives in the drawer",
      asked: "Findings T-1: the renewal key lives in the drawer",
      decoy: "Findings T-1: the renewal-key lives in the drawer",
    },
    {
      name: "a last word cut short",
      stored: "Findings T-1: Cause is components/settings/sources-panel.tsx",
      asked: "Findings T-1: Cause is components/settings/sources-pa",
      decoy: "Findings T-1: Cause is components/settings/source-panel.tsx",
    },
  ])("matches the quote by its words, never the decoy: $name", async ({ stored, asked, decoy }) => {
    await insert("stored", stored, BLAND, RUN);
    await insert("decoy", decoy, BLAND, RUN);

    const found = await textMatched(summarizeChange(asked).slice(0, 120));

    expect(found).toContain("stored");
    expect(found).not.toContain("decoy");
  });

  it("ranks a row that opens with the quote ahead of a nearer row that holds it further in", async () => {
    const quote = "the renewal key lives in the second drawer";
    await insert("holds", `An earlier note said ${quote} of the desk`, NEAR, RUN);
    await insert("opens", `${quote} of the desk`, BLAND, RUN);

    const facts = (await searchRun(quote)).facts;
    const rank = (id: string) => facts.find((f) => f.uuid === id)?.textMatchRank;

    expect([rank("opens"), rank("holds")]).toEqual([1, 2]);
  });

  it("brings no row for a quote more rows hold than the leg's limit, and still answers", async () => {
    const quote = "the renewal key lives in the second drawer";
    for (let i = 0; i < 11; i++) await insert(`common-${i}`, `${quote}, note ${i}`, BLAND, RUN);

    const result = await searchRun(quote, 10);

    expect(result.storesRead).toEqual([{ store: "semantic" }]);
    expect(result.facts.filter((f) => f.textMatchRank !== undefined)).toEqual([]);
  });

  it("answers a query far longer than a quote, matched by its opening", async () => {
    const longQuery = Array.from({ length: 8000 }, (_, i) => `word${i}`).join(" ");
    await insert("long-note", longQuery.slice(0, 300), BLAND, RUN);

    const result = await searchRun(longQuery);

    expect(result.storesRead).toEqual([{ store: "semantic" }]);
    expect(result.facts.find((f) => f.uuid === "long-note")?.textMatchRank).toBe(1);
  });

  it("orders a query of three words as the vector legs do", async () => {
    // Three words of the asked row: the asked row holds them, and so does every near-duplicate.
    const served = await ask("Findings T-4c378528: Cause");

    expect(served).not.toContain("asked");
  });
});
