// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// memory_query names the connected source behind a graph fact, for every
// connector type, against a real Postgres.
//
// A connector's content reaches the graph tier through the memory service's
// /search, which returns each fact's `source_id` from the episode that ingested
// it (memory-service/tests/test_citation_provenance_integration.py proves that
// half against a real Neo4j). This file proves the other half: the real
// GraphitiMemoryStore maps that response and the real formatCitedFacts resolves
// each id against the caller's own `Source` rows. Only the HTTP call to the
// memory service is stubbed, with the response shape that half returns.
//
// Set QA_DATABASE_URL to an ISOLATED test database, never the inherited
// DATABASE_URL. Skips cleanly without it.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { SourceType } from "@/lib/generated/prisma/enums";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-connector-citation";
const OTHER_ORG = "org-qa-connector-citation-other";

/** One source per connector type that ingests into memory, as each names itself. */
const CONNECTORS: { type: SourceType; name: string }[] = [
  { type: "github", name: "acme/platform" },
  { type: "slack", name: "eng-updates" },
  { type: "figma", name: "Checkout redesign" },
  { type: "posthog", name: "Weekly activation" },
  { type: "gdrive", name: "Sales playbooks" },
];

describe.skipIf(!QA_URL)("memory_query cites the connector source of a graph fact", () => {
  let db: PrismaClient;
  let formatCitedFacts: (typeof import("./fact-citation"))["formatCitedFacts"];
  let GraphitiMemoryStore: (typeof import("@/services/memory/graphiti-store"))["GraphitiMemoryStore"];
  /** What the memory service's /search returns for the next call. */
  let searchFacts: {
    uuid: string;
    fact: string;
    valid_at: null;
    actor_type: null;
    actor_name: null;
    source_id: string | null;
  }[] = [];

  async function clear() {
    for (const orgId of [ORG, OTHER_ORG]) await db.source.deleteMany({ where: { orgId } });
    await deleteOrgsWithRetry(db, { where: { id: { in: [ORG, OTHER_ORG] } } });
  }

  async function answer(orgId: string): Promise<string[]> {
    const { facts } = await new GraphitiMemoryStore("http://memory.test").retrieve({ groupId: orgId, query: "status" });
    return (await formatCitedFacts(orgId, facts)).split("\n");
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ facts: searchFacts }) })),
    );
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ formatCitedFacts } = await import("./fact-citation"));
    ({ GraphitiMemoryStore } = await import("@/services/memory/graphiti-store"));
    await clear();
    for (const orgId of [ORG, OTHER_ORG]) await db.org.create({ data: { id: orgId, name: orgId } });
  });

  afterAll(async () => {
    if (!db) return;
    await clear();
    await db.$disconnect();
    vi.unstubAllGlobals();
  });

  it("renders `— source: <name> (<type>)` for a fact from each connector type", async () => {
    searchFacts = [];
    for (const { type, name } of CONNECTORS) {
      const source = await db.source.create({
        data: { orgId: ORG, type, externalId: `ext-${type}`, name, scopePath: `${ORG}.${type}` },
      });
      searchFacts.push({
        uuid: `fact-${type}`,
        fact: `${type} fact`,
        valid_at: null,
        actor_type: null,
        actor_name: null,
        source_id: source.id,
      });
    }

    expect(await answer(ORG)).toEqual(CONNECTORS.map(({ type, name }) => `• ${type} fact — source: ${name} (${type})`));
  });

  it("never names another org's source, even when the graph returns its id", async () => {
    const foreign = await db.source.create({
      data: {
        orgId: OTHER_ORG,
        type: "github",
        externalId: "rival/roadmap",
        name: "rival/secret-roadmap",
        scopePath: `${OTHER_ORG}.github`,
      },
    });
    searchFacts = [
      {
        uuid: "fact-planted",
        fact: "planted fact",
        valid_at: null,
        actor_type: null,
        actor_name: null,
        source_id: foreign.id,
      },
    ];

    expect(await answer(ORG)).toEqual(["• planted fact — uncited"]);
  });
});
