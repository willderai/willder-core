// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The text leg's literal spans (services/memory/text-spans.ts, RETRIEVAL_TEXT_SPANS): a read
// whose query holds an error code, an identifier or a path a stored row holds serves that
// row, in a scope full of rows on the same subject, and never a row the reader may not read.
//
// Real: Postgres with pgvector and pg_trgm, check() against a live capability,
// GuardedMemoryStore, HybridMemoryStore and the vector store's SQL. Fakes: the graph store,
// which answers with more facts than the page holds, and the embedding service, which puts
// every query on one axis, 40 near-duplicate rows at a cosine of 0.9 from it and the asked
// row at 0.4: the vector legs alone rank it below the page.
//
// Case types covered: the asked row first by its error code and service name, through the
// full read and through the text leg alone; the same spans in every place the reader may
// not read (another tenant, a sibling scope whose path extends the reader's, an untagged row
// under a narrow grant, a version that lost a write race, a scope one `_` wildcard away, the
// reader's ancestor scope, a row still pending its embedding), none served by either read;
// a span inside a longer token, not matched; a span more rows hold than the cap, ignored; a
// span five rows hold, three of them lifted, through either read; a probe the database
// refuses, followed by one that still runs; a span named in passing in a question mostly in
// prose, whose far-off row is not lifted;
// with the flag off (unset or "0"), a read with spans returns exactly what the same read
// returns for a query that holds none.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the `@/lib/db`
// singleton at import time, before beforeAll points DATABASE_URL at the test database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import type { MemoryStore } from "./memory-store";
import type { MemoryFact } from "@/types/memory";
import { stubEmbedService } from "./embed-service-stub.testsupport";

vi.mock("./store", () => ({ memory: {} }));
// One span the database refuses (an invalid expression, 2201B, one of the codes the leg gives
// up on), so a test can show a probe that gives up costs the read only that span.
vi.mock("./text-spans", async (importOriginal) => {
  const real = await importOriginal<typeof import("./text-spans")>();
  return {
    ...real,
    literalSpanPattern: (span: string) => (span === "REFUSED_SPAN_X" ? "(" : real.literalSpanPattern(span)),
  };
});

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qa_text_spans";
const OTHER_ORG = "qa_text_spans_other";
const ROOT = `org_${ORG}`;
const RUN = `${ROOT}.s1run`;
// Extends RUN's path without being under it: `s1run` against `s1runb`.
const SIBLING = `${ROOT}.s1runb`;
// One character off RUN where RUN would have `_`: `s1run` against `s1rxn` read through `s1r_n`.
const WILDCARD_SIBLING = `${ROOT}.s1rxn`;
const DIMENSIONS = 384;

const SERVICES = Array.from({ length: 40 }, (_, i) => `worker-${i + 1}`);
const log = (service: string, code: string) =>
  `${service}: ${code} while syncing invoices from the provider; raised the keep-alive and retried.`;
const ASKED = log("billing-api", "ERR_SOCKET_CLOSED_7Q");
const QUESTION = "how did we resolve ERR_SOCKET_CLOSED_7Q on billing-api?";

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

const FORBIDDEN = [
  "other-tenant",
  "sibling-scope",
  "untagged",
  "lost-race",
  "wildcard-sibling",
  "ancestor-scope",
  "pending",
];

describe.skipIf(!QA_URL)("the text leg's literal spans, real Postgres", () => {
  let db: PrismaClient;
  let GuardedMemoryStore: (typeof import("./guarded-store"))["GuardedMemoryStore"];
  let HybridMemoryStore: (typeof import("./hybrid-store"))["HybridMemoryStore"];
  let PgvectorMemoryStore: (typeof import("./pgvector-store"))["PgvectorMemoryStore"];

  const busyGraph = {
    retrieve: vi.fn(async () => ({ facts: graphFacts, storesRead: [{ store: "graph" as const }] })),
  } as unknown as MemoryStore;
  const reader = () =>
    new GuardedMemoryStore(new HybridMemoryStore(busyGraph, new PgvectorMemoryStore()), async () => "enterprise");

  const insert = (id: string, content: string, embedding: string, scopePath: string | null, orgId = ORG) =>
    db.$executeRaw`
      INSERT INTO memory_chunks ("id","orgId","content","source","actorType","actorName","scopePath","embedding","createdAt")
      VALUES (${id}, ${orgId}, ${content}, 'text', 'agent', 'span-agent', ${scopePath}, ${embedding}::vector, NOW())`;

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

  const read = { groupId: RUN, tenantId: ORG, scopePath: RUN };
  const searchRun = (query: string, limit = 10) => new PgvectorMemoryStore().retrieve({ ...read, query, limit });
  const textOnly = (query: string, limit = 10) => new PgvectorMemoryStore().retrieveText({ ...read, query, limit });
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
    vi.stubEnv("RETRIEVAL_TEXT_SPANS", "1");
    await wipe();
    for (const org of [ORG, OTHER_ORG])
      await db.org.upsert({ where: { id: org }, update: {}, create: { id: org, name: org } });
    for (const path of [ROOT, RUN, SIBLING]) await db.scope.create({ data: { orgId: ORG, path, name: path } });
    for (const [i, service] of SERVICES.entries())
      await insert(`near-${i + 1}`, log(service, `ERR_SOCKET_CLOSED_${i + 1}`), NEAR, RUN);
    await insert("asked", ASKED, BLAND, RUN);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is set up so that the vector legs alone rank the asked row below the page", async () => {
    vi.stubEnv("RETRIEVAL_TEXT_SPANS", "");

    expect((await searchRun(QUESTION)).facts.map((f) => f.uuid)).not.toContain("asked");
  });

  it("serves the asked row first by its error code and service name, on a page the graph would fill", async () => {
    const served = await ask(QUESTION);

    expect(served).toHaveLength(10);
    expect(served.filter((id) => !id.startsWith("graph-"))[0]).toBe("asked");
  });

  it("serves it through the text leg alone too", async () => {
    expect((await textOnly(QUESTION)).facts.map((f) => f.uuid)).toEqual(["asked"]);
  });

  it("serves none of the same spans the reader may not read, through either read", async () => {
    // As far from the query as the asked row, so only the text leg could bring them in.
    const copy = (where: string) => `${ASKED} Copy in ${where}.`;
    await insert("other-tenant", copy("another tenant"), BLAND, RUN.replace(ORG, OTHER_ORG), OTHER_ORG);
    await insert("sibling-scope", copy("a sibling scope"), BLAND, SIBLING);
    await insert("untagged", copy("no scope"), BLAND, null);
    await insert("lost-race", copy("the losing version"), BLAND, RUN);
    await insert("ancestor-scope", copy("the org root"), BLAND, ROOT);
    await db.$executeRaw`
      INSERT INTO memory_chunks ("id","orgId","content","source","actorType","actorName","scopePath","createdAt")
      VALUES ('pending', ${ORG}, ${copy("a pending row")}, 'text', 'agent', 'span-agent', ${RUN}, NOW())`;
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
    const raw = (await searchRun(QUESTION, 50)).facts.map((f) => f.uuid);
    const alone = (await textOnly(QUESTION, 50)).facts.map((f) => f.uuid);

    expect(served.filter((id) => !id.startsWith("graph-"))[0]).toBe("asked");
    expect(served.filter((id) => FORBIDDEN.includes(id))).toEqual([]);
    expect(raw.filter((id) => FORBIDDEN.includes(id))).toEqual([]);
    expect(alone).toEqual(["asked"]);
  });

  it("does not match a span inside a longer token", async () => {
    await insert("longer", log("billing-api-v2", "ERR_SOCKET_CLOSED_7QX"), BLAND, RUN);

    const textMatched = (await searchRun(QUESTION, 50)).facts
      .filter((f) => f.textMatchRank !== undefined)
      .map((f) => f.uuid);

    expect(textMatched).toEqual(["asked"]);
  });

  it("ignores a span more rows hold than the cap, and still ranks by the rarer one", async () => {
    // "billing-api" in 40 more rows than the cap of 30 allows; the code in the asked row only.
    for (let i = 0; i < 40; i++) await insert(`billing-${i}`, log("billing-api", `ERR_OTHER_${i}`), NEAR, RUN);

    const result = await searchRun(QUESTION);

    expect(result.storesRead).toEqual([{ store: "semantic" }]);
    expect(result.facts.filter((f) => f.textMatchRank !== undefined).map((f) => f.uuid)).toEqual(["asked"]);
    expect(result.facts[0]!.uuid).toBe("asked");
  });

  it("still runs the probes after one that gives up, and the read does not fail", async () => {
    const result = await searchRun("is REFUSED_SPAN_X related to billing-api?");

    expect(result.storesRead).toEqual([{ store: "semantic" }]);
    expect(result.facts.filter((f) => f.textMatchRank !== undefined).map((f) => f.uuid)).toEqual(["asked"]);
    expect((await textOnly("is REFUSED_SPAN_X related to billing-api?")).facts.map((f) => f.uuid)).toEqual(["asked"]);
  });

  it("lifts no far-off row for a span named in passing in a question mostly in prose", async () => {
    await insert("decoy", "Incident INC-2265: the dashboard was slow after a deploy.", BLAND, RUN);
    const passing =
      "what did we change after the sockets kept closing on the invoice sync job, around the time of INC-2265?";

    const result = await searchRun(passing);

    expect(result.facts.filter((f) => f.textMatchRank !== undefined)).toEqual([]);
    expect(result.facts.map((f) => f.uuid)).not.toContain("decoy");
  });

  it("lifts at most three of the rows a span alone found, and the rest keep their own place", async () => {
    for (let i = 0; i < 5; i++) await insert(`shared-${i}`, log(`shared-${i}`, "ERR_SHARED_9"), BLAND, RUN);

    const result = await searchRun("how did we resolve ERR_SHARED_9?", 50);
    const lifted = result.facts.filter((f) => f.textMatchRank !== undefined).map((f) => f.uuid);

    expect(lifted).toHaveLength(3);
    expect(
      result.facts
        .slice(0, 3)
        .map((f) => f.uuid)
        .sort(),
    ).toEqual([...lifted].sort());
    expect(result.facts.map((f) => f.uuid)).toEqual(
      expect.arrayContaining(["shared-0", "shared-1", "shared-2", "shared-3", "shared-4"]),
    );

    expect((await textOnly("how did we resolve ERR_SHARED_9?", 50)).facts).toHaveLength(3);
  });

  it.each([
    { name: "unset", value: "" },
    { name: '"0"', value: "0" },
  ])(
    "with the flag $name, returns for a query with spans exactly what it returns for one without",
    async ({ value }) => {
      vi.stubEnv("RETRIEVAL_TEXT_SPANS", value);

      // Both queries embed to the same vector (the stub), so only a text leg could tell them apart.
      const withSpans = await searchRun(QUESTION);
      const without = await searchRun("how did we resolve the socket problem on the billing service?");

      expect(JSON.stringify(withSpans)).toBe(JSON.stringify(without));
      expect(withSpans.facts.some((f) => f.textMatchRank !== undefined)).toBe(false);
      expect((await textOnly(QUESTION)).facts).toEqual([]);
    },
  );
});
