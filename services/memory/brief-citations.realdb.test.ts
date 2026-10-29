// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A brief's citations, re-checked against a real database.
//
// What runs for real: createBrief() writing the brief and its citations in one
// transaction, check() with a live capability and its audit row, the pgvector store's
// tenant- and scope-contained lookup of each cited chunk, and the dependency graph's
// `supersedes` edges. The graph store is a scripted double, because Graphiti needs
// Neo4j; it answers per fact id the way the memory service's resolve route does.
//
// Set QA_DATABASE_URL to an ISOLATED test database, never the inherited DATABASE_URL,
// which may point at a live database. Skips cleanly without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the `@/lib/db`
// singleton at import time, before beforeAll points DATABASE_URL at the QA database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import type { FindFactByIdInput, FindFactByIdResult } from "@/types/memory";

/** What the graph store answers for a fact id; an id it does not list falls through to pgvector. */
const graphAnswers = vi.hoisted(() => new Map<string, FindFactByIdResult | Error>());

vi.mock("./store", async () => {
  const { HybridMemoryStore } = await import("./hybrid-store");
  const { PgvectorMemoryStore } = await import("./pgvector-store");
  const graph = {
    findFactById: async (input: FindFactByIdInput) => {
      const answer = graphAnswers.get(input.factId);
      if (answer instanceof Error) throw answer;
      return answer ?? null;
    },
  };
  return { memory: new HybridMemoryStore(graph as never, new PgvectorMemoryStore()) };
});

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qa_brief_citations";
const OTHER_ORG = "qa_brief_citations_other";
const ROOT = `org_${ORG}`;
const ENG = `${ROOT}.eng`;
const SALES = `${ROOT}.sales`;

const QUOTED = "Deploys go out on Tuesdays";

describe.skipIf(!QA_URL)("brief citations against a real database", () => {
  let db: PrismaClient;
  let createBrief: (typeof import("@/services/memory/create-brief"))["createBrief"];
  let checkBriefCitations: (typeof import("./brief-citations"))["checkBriefCitations"];

  async function reader(scopePath: string): Promise<AccessContext> {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId: "brief-reader",
        tokenHash: hashCapabilityToken(token),
        scopePath,
        permission: "read",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return { orgId: ORG, actor: { type: "agent", id: "brief-reader", capabilityToken: token }, origin: "mcp" };
  }

  async function chunk(id: string, orgId: string, scopePath: string, content: string): Promise<void> {
    await db.memoryChunk.create({ data: { id, orgId, scopePath, content } });
  }

  async function briefCiting(factIds: string[]): Promise<{ id: string; orgId: string; scopePath: string }> {
    const brief = await createBrief(
      {
        orgId: ORG,
        type: "handoff",
        scopePath: ENG,
        title: "Handoff: eng",
        summary: "s",
        sections: [{ heading: "Ops", content: "c" }],
      },
      { actorType: "agent", actorId: "handoff-agent", origin: "agent-run" },
      factIds.map((factId) => ({ sectionIndex: 0, factId, factText: QUOTED })),
    );
    return { id: brief.id, orgId: ORG, scopePath: ENG };
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ createBrief } = await import("@/services/memory/create-brief"));
    ({ checkBriefCitations } = await import("./brief-citations"));
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  beforeEach(async () => {
    graphAnswers.clear();
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.auditLog.deleteMany({ where: { orgId } });
      await db.capability.deleteMany({ where: { orgId } });
      await db.factEdge.deleteMany({ where: { orgId } });
      await db.memoryChunk.deleteMany({ where: { orgId } });
      await db.changeEvent.deleteMany({ where: { orgId } });
      await db.brief.deleteMany({ where: { orgId } });
      await db.scope.deleteMany({ where: { orgId } });
      await db.org.upsert({ where: { id: orgId }, update: {}, create: { id: orgId, name: orgId } });
    }
    await db.scope.createMany({ data: [ROOT, ENG, SALES].map((path) => ({ orgId: ORG, path, name: path })) });
  });

  it("stores the citations with the brief, in the same transaction", async () => {
    const brief = await briefCiting(["c1", "c2"]);

    const stored = await db.briefCitation.findMany({ where: { briefId: brief.id }, orderBy: { factId: "asc" } });
    expect(stored.map((c) => [c.sectionIndex, c.factId, c.factText])).toEqual([
      [0, "c1", QUOTED],
      [0, "c2", QUOTED],
    ]);
  });

  it("reports a cited chunk that is unchanged as current", async () => {
    await chunk("c_same", ORG, ENG, QUOTED);
    const brief = await briefCiting(["c_same"]);

    const [result] = await checkBriefCitations(await reader(ENG), brief);

    expect(result).toEqual({ sectionIndex: 0, factId: "c_same", factText: QUOTED, status: "current" });
  });

  it("reports a chunk whose text no longer matches the quote as changed", async () => {
    await chunk("c_edit", ORG, ENG, "Deploys go out on Thursdays");
    const brief = await briefCiting(["c_edit"]);

    const [result] = await checkBriefCitations(await reader(ENG), brief);

    expect(result.status).toBe("changed");
    expect(result.factText).toBe(QUOTED);
  });

  it("reports a chunk a newer version superseded, even when its own text is unchanged", async () => {
    await chunk("c_old", ORG, ENG, QUOTED);
    await chunk("c_new", ORG, ENG, "Deploys go out on Thursdays");
    await db.factEdge.create({
      data: {
        orgId: ORG,
        fromId: "c_new",
        toId: "c_old",
        kind: "supersedes",
        scopePath: ENG,
        actorType: "agent",
        actorId: "writer",
      },
    });
    const brief = await briefCiting(["c_old"]);

    const [result] = await checkBriefCitations(await reader(ENG), brief);

    expect(result.status).toBe("superseded");
  });

  it("ignores a supersedes edge recorded in another tenant", async () => {
    await chunk("c_kept", ORG, ENG, QUOTED);
    await db.factEdge.create({
      data: {
        orgId: OTHER_ORG,
        fromId: "x",
        toId: "c_kept",
        kind: "supersedes",
        scopePath: "org_x",
        actorType: "agent",
        actorId: "w",
      },
    });
    const brief = await briefCiting(["c_kept"]);

    const [result] = await checkBriefCitations(await reader(ENG), brief);

    expect(result.status).toBe("current");
  });

  it.each([
    ["deleted", async () => {}],
    ["moved to a sibling scope", async () => chunk("c_gone", ORG, SALES, QUOTED)],
    ["held by another tenant under the same id", async () => chunk("c_gone", OTHER_ORG, ENG, QUOTED)],
  ])("reports a chunk %s as gone, without serving the quoted text", async (_label, seed) => {
    await seed();
    const brief = await briefCiting(["c_gone"]);

    const [result] = await checkBriefCitations(await reader(ENG), brief);

    expect(result).toEqual({ sectionIndex: 0, factId: "c_gone", factText: null, status: "gone" });
  });

  it.each([
    [
      "an edge the graph invalidated as superseded",
      { uuid: "g1", fact: QUOTED, invalidAt: "2026-10-01T09:30:00Z" },
      "superseded",
    ],
    ["an edge in force as current", { uuid: "g1", fact: QUOTED, invalidAt: null }, "current"],
    ["an edge from a service that cannot report invalidation as unknown", { uuid: "g1", fact: QUOTED }, "unknown"],
    ["a graph lookup that fails as unknown", new Error("memory service unreachable"), "unknown"],
  ])("reports %s", async (_label, answer, status) => {
    graphAnswers.set("g1", answer as FindFactByIdResult | Error);
    const brief = await briefCiting(["g1"]);

    const [result] = await checkBriefCitations(await reader(ENG), brief);

    expect(result.status).toBe(status);
  });

  it("checks at the brief's scope, not the reader's wider grant: an org-root reader still sees a moved chunk as gone", async () => {
    await chunk("c_moved", ORG, SALES, QUOTED);
    await chunk("c_root", ORG, ROOT, QUOTED);
    const brief = await briefCiting(["c_moved", "c_root"]);

    const results = await checkBriefCitations(await reader(ROOT), brief);

    expect(results.map((r) => [r.factId, r.status, r.factText])).toEqual([
      ["c_moved", "gone", null],
      ["c_root", "gone", null],
    ]);
  });

  it("reports a chunk no longer readable at the brief's scope as gone, even when a supersedes edge names it", async () => {
    await chunk("c_away", ORG, SALES, QUOTED);
    await chunk("c_away_new", ORG, SALES, "Deploys go out on Thursdays");
    await db.factEdge.create({
      data: {
        orgId: ORG,
        fromId: "c_away_new",
        toId: "c_away",
        kind: "supersedes",
        scopePath: SALES,
        actorType: "agent",
        actorId: "writer",
      },
    });
    const brief = await briefCiting(["c_away"]);

    const [result] = await checkBriefCitations(await reader(ENG), brief);

    expect(result).toEqual({ sectionIndex: 0, factId: "c_away", factText: null, status: "gone" });
  });

  it("makes one audited decision for the whole set, at the brief's scope", async () => {
    await chunk("c_a", ORG, ENG, QUOTED);
    await chunk("c_b", ORG, ENG, QUOTED);
    const brief = await briefCiting(["c_a", "c_b"]);

    await checkBriefCitations(await reader(ENG), brief);

    const rows = await db.auditLog.findMany({
      where: { orgId: ORG, target: { contains: `brief:${brief.id}/citations` } },
    });
    expect(rows.map((r) => [r.action, r.decision])).toEqual([["memory.read", "allow"]]);
  });

  it("refuses a reader without a grant on the brief's scope, before any lookup", async () => {
    graphAnswers.set("g1", new Error("must not be asked"));
    const brief = await briefCiting(["g1"]);

    await expect(checkBriefCitations(await reader(SALES), brief)).rejects.toMatchObject({ name: "AccessDeniedError" });
  });
});
