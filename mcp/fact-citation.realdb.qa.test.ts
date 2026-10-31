// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// memory_query citations against a real database.
//
// memory_query names the connected source behind each fact. The security
// property is that a source is named only when its `Source` row belongs to the
// caller's org. The unit test stubs `db.source.findMany`; here the org-bound
// lookup and the `"sourceId"`/`"actorName"` columns in the pgvector SELECT run
// against Postgres 16 with pgvector: the real PgvectorMemoryStore query feeds
// the real formatCitedFacts.
//
// Two tenants, two scopes. Each org has its own source; one org-A chunk carries
// a planted org-B source id, standing in for any path that lets a foreign id
// reach the stamped provenance. Only the embedding HTTP call is stubbed.
//
// Set QA_DATABASE_URL to an ISOLATED test database, never the inherited
// DATABASE_URL. Skips cleanly without it, and also when memory_chunks has no
// `embedding` column: that column is created by a hand-written migration, so a
// database provisioned with `prisma db push` does not carry it.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-243";
const OTHER_ORG = "org-qa-243-other";
/** A query and chunk embedding shaped like production's BGE-384 column. */
const EMBEDDING = Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));

const SALES = `${ORG}.sales`;
const ENG = `${ORG}.eng`;

describe.skipIf(!QA_URL)("memory_query citations against a real database", () => {
  let db: PrismaClient;
  let formatCitedFacts: (typeof import("./fact-citation"))["formatCitedFacts"];
  let PgvectorMemoryStore: (typeof import("@/services/memory/pgvector-store"))["PgvectorMemoryStore"];
  let ownSourceId = "";
  let foreignSourceId = "";
  let hasEmbeddingColumn = false;

  async function clear() {
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.memoryChunk.deleteMany({ where: { orgId } });
      await db.source.deleteMany({ where: { orgId } });
    }
    await deleteOrgsWithRetry(db, { where: { id: { in: [ORG, OTHER_ORG] } } });
  }

  async function chunk(
    orgId: string,
    id: string,
    content: string,
    scopePath: string,
    extra: { sourceId?: string; actorName?: string; actorType?: string },
  ) {
    await db.$executeRawUnsafe(
      `INSERT INTO memory_chunks ("id","orgId","content","actorType","actorName","scopePath","sourceId","embedding")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::vector)`,
      id,
      orgId,
      content,
      extra.actorType ?? "extraction",
      extra.actorName ?? null,
      scopePath,
      extra.sourceId ?? null,
      JSON.stringify(EMBEDDING),
    );
  }

  /** A line without its "(as of …)" date, which is a row's createdAt and changes every run. */
  const withoutDate = (line: string) => line.replace(/ \(as of [^)]*\)\)?/, "");

  async function answer(orgId: string, scopePath: string): Promise<string[]> {
    const { facts } = await new PgvectorMemoryStore().retrieve({
      groupId: orgId,
      tenantId: orgId,
      query: "release",
      scopePath,
      limit: 20,
    });
    // Dates are stripped: pgvector's validAt is the chunk's createdAt, which
    // changes every run and is not what this PR touches.
    return (await formatCitedFacts(orgId, facts)).split("\n").map(withoutDate).sort();
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ embedding: EMBEDDING }) }));
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    const columns = await db.$queryRaw<unknown[]>`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'memory_chunks' AND column_name = 'embedding'`;
    hasEmbeddingColumn = columns.length > 0;
    if (!hasEmbeddingColumn) return;
    ({ formatCitedFacts } = await import("./fact-citation"));
    ({ PgvectorMemoryStore } = await import("@/services/memory/pgvector-store"));
    await clear();
    for (const orgId of [ORG, OTHER_ORG]) await db.org.create({ data: { id: orgId, name: orgId } });

    ownSourceId = (
      await db.source.create({
        data: { orgId: ORG, type: "github", externalId: "acme/platform", name: "acme/platform", scopePath: SALES },
      })
    ).id;
    foreignSourceId = (
      await db.source.create({
        data: {
          orgId: OTHER_ORG,
          type: "github",
          externalId: "rival/roadmap",
          name: "rival/secret-roadmap",
          scopePath: `${OTHER_ORG}.sales`,
        },
      })
    ).id;

    await chunk(ORG, "a-sales-src", "release ships Friday", SALES, {
      sourceId: ownSourceId,
      actorName: "acme/platform",
    });
    await chunk(ORG, "a-sales-human", "Dana owns the release", SALES, { actorType: "human", actorName: "Dana" });
    await chunk(ORG, "a-sales-planted", "release date moved", SALES, {
      sourceId: foreignSourceId,
      actorName: "rival/secret-roadmap",
    });
    await chunk(ORG, "a-eng-src", "eng release branch cut", ENG, { sourceId: ownSourceId, actorName: "acme/platform" });
    await chunk(OTHER_ORG, "b-sales-src", "rival release in October", `${OTHER_ORG}.sales`, {
      sourceId: foreignSourceId,
      actorName: "rival/secret-roadmap",
    });
  });

  afterAll(async () => {
    if (!db) return;
    await clear();
    await db.$disconnect();
    vi.unstubAllGlobals();
  });

  it("cites the caller's own source and actor, and never names a foreign source id", async (ctx) => {
    if (!hasEmbeddingColumn) ctx.skip();
    expect(await answer(ORG, SALES)).toEqual([
      "• Dana owns the release — from: Dana (human) · version a-sales-human",
      "• release date moved — uncited · version a-sales-planted",
      "• release ships Friday — source: acme/platform (github) · version a-sales-src",
    ]);
  });

  it("keeps scope containment: a sales-scoped read sees no eng fact, and org B sees only its own", async (ctx) => {
    if (!hasEmbeddingColumn) ctx.skip();
    const sales = (await answer(ORG, SALES)).join("\n");
    expect(sales).not.toContain("eng release branch cut");
    expect(await answer(ORG, ENG)).toEqual([
      "• eng release branch cut — source: acme/platform (github) · version a-eng-src",
    ]);
    expect(await answer(OTHER_ORG, `${OTHER_ORG}.sales`)).toEqual([
      "• rival release in October — source: rival/secret-roadmap (github) · version b-sales-src",
    ]);
  });

  it("drops the citation once the source is disconnected, without falling back to the stamped name", async (ctx) => {
    if (!hasEmbeddingColumn) ctx.skip();
    const tmp = await db.source.create({
      data: { orgId: ORG, type: "slack", externalId: "eng-updates", name: "eng-updates", scopePath: ENG },
    });
    await chunk(ORG, "a-eng-tmp", "release retro Monday", ENG, { sourceId: tmp.id, actorName: "eng-updates" });
    expect(await answer(ORG, ENG)).toContain(
      "• release retro Monday — source: eng-updates (slack) · version a-eng-tmp",
    );
    await db.source.delete({ where: { id: tmp.id } });
    expect(await answer(ORG, ENG)).toContain("• release retro Monday — uncited · version a-eng-tmp");
    await db.memoryChunk.delete({ where: { id: "a-eng-tmp" } });
  });

  it("cites a graph fact derived from one stored version to that version's writer, read in the caller's org only", async (ctx) => {
    if (!hasEmbeddingColumn) ctx.skip();
    await chunk(ORG, "a-sales-agent", "Ada passed Ticket #609", SALES, { actorType: "agent", actorName: "Ada" });
    await chunk(OTHER_ORG, "b-sales-agent", "Rival passed Ticket #1", `${OTHER_ORG}.sales`, {
      actorType: "agent",
      actorName: "Rival",
    });
    // As the graph returns them: an entity definition seeded from the write, stamped
    // "extraction", and an extracted edge with no stamp, each naming the one version.
    const lines = (
      await formatCitedFacts(ORG, [
        {
          uuid: "e1",
          fact: "Ticket #609 is a Project",
          validAt: null,
          actorType: "extraction",
          actorName: "Ada",
          chunkIds: ["a-sales-agent"],
          store: "graph",
        },
        { uuid: "e2", fact: "Ada passed Ticket #609", validAt: null, chunkIds: ["a-sales-agent"], store: "graph" },
        { uuid: "e3", fact: "Rival passed Ticket #1", validAt: null, chunkIds: ["b-sales-agent"], store: "graph" },
      ])
    ).split("\n");
    // Each fact is dated by its version's row in the caller's org; the other org's row
    // dates nothing, so that fact keeps the graph's date, here none.
    const [stored] = await db.memoryChunk.findMany({ where: { id: "a-sales-agent" }, select: { createdAt: true } });
    expect(lines.map((l) => /\(as of ([^)]*)\)/.exec(l)?.[1] ?? null)).toEqual([
      stored.createdAt.toISOString(),
      stored.createdAt.toISOString(),
      null,
    ]);
    expect(lines.map(withoutDate)).toEqual([
      "• Ticket #609 is a Project — from: Ada (agent) · version a-sales-agent",
      "• Ada passed Ticket #609 — from: Ada (agent) · version a-sales-agent",
      "• Rival passed Ticket #1 — uncited · version b-sales-agent",
    ]);
    await db.memoryChunk.deleteMany({ where: { id: { in: ["a-sales-agent", "b-sales-agent"] } } });
  });

  it("keeps the graph's citation when the one version came from a connected source or names no writer", async (ctx) => {
    if (!hasEmbeddingColumn) ctx.skip();
    // A row written before actorName existed records a type but no name.
    await chunk(ORG, "a-sales-unnamed", "Ada passed Ticket #610", SALES, { actorType: "human" });
    // a-sales-src is the connector's row: its writer columns name the source, not a person.
    const lines = (
      await formatCitedFacts(ORG, [
        {
          uuid: "e1",
          fact: "Ticket #610 passed",
          validAt: null,
          actorType: "agent",
          actorName: "Ada",
          chunkIds: ["a-sales-unnamed"],
          store: "graph",
        },
        {
          uuid: "e2",
          fact: "release ships Friday",
          validAt: null,
          actorType: "agent",
          actorName: "Ada",
          chunkIds: ["a-sales-src"],
          store: "graph",
        },
      ])
    ).split("\n");
    expect(lines.map(withoutDate)).toEqual([
      "• Ticket #610 passed — from: Ada (agent) · version a-sales-unnamed",
      "• release ships Friday — from: Ada (agent) · version a-sales-src",
    ]);
    await db.memoryChunk.delete({ where: { id: "a-sales-unnamed" } });
  });
});
