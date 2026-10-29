// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// When two connected sources hold the same text, the graph can return a verbatim copy
// synced from one source while the vector store returns the stored chunk synced from the
// other. Both carry actorType "extraction", so the hybrid dedup treats them as one
// provenance. The served line must still name an item of the source it cites: an item id
// is what a caller passes back to find or remove the item, and an id from another source
// points at the wrong one.
//
// Everything below the checked read is real except the graph store and the embedding
// service, as in served-page.realdb.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the `@/lib/db`
// singleton at import time, before beforeAll points DATABASE_URL at the test database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import type { MemoryStore } from "@/services/memory/memory-store";
import type { MemoryFact } from "@/types/memory";

vi.mock("@/services/memory/store", () => ({ memory: {} }));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "servedprov";
const ROOT = `org_${ORG}`;
const DOCS = `${ROOT}.docs`;
const DIMENSIONS = 384;
const QUERY_VECTOR = `[${[1, ...Array(DIMENSIONS - 1).fill(0)].join(",")}]`;

const TEXT = "The Q3 launch moves to October 20 after the security review.";
const DRIVE = "src-drive";
const NOTION_LIKE = "src-site";
/** The episode the Drive sync wrote for the Drive item that holds TEXT. */
const DRIVE_ITEM = "ep-drive-item";

/** The graph's verbatim copy of TEXT, synced from the Drive source. */
const GRAPH_COPY: MemoryFact = {
  uuid: "g-verbatim",
  fact: TEXT,
  validAt: "2026-10-12T06:59:29+00:00",
  actorType: "extraction",
  sourceId: DRIVE,
  sourceEventIds: [DRIVE_ITEM],
  chunkIds: ["c-drive"],
  store: "graph",
};

describe.skipIf(!QA_URL)("a page never cites one source's item under another source", () => {
  let db: PrismaClient;
  let GuardedMemoryStore: (typeof import("@/services/memory/guarded-store"))["GuardedMemoryStore"];
  let HybridMemoryStore: (typeof import("@/services/memory/hybrid-store"))["HybridMemoryStore"];
  let PgvectorMemoryStore: (typeof import("@/services/memory/pgvector-store"))["PgvectorMemoryStore"];
  let formatCitedFacts: (typeof import("./fact-citation"))["formatCitedFacts"];

  const graph = {
    retrieve: vi.fn(async (input: { groupId: string }) => ({
      facts: input.groupId.endsWith(".docs") ? [GRAPH_COPY] : [],
      storesRead: [{ store: "graph" as const }],
    })),
  } as unknown as MemoryStore;

  /** A stored passage of TEXT synced from `sourceId`, one of several passages of its file. */
  const insertPassage = (id: string, sourceId: string) =>
    db.$executeRawUnsafe(
      `INSERT INTO memory_chunks ("id","orgId","content","source","actorType","scopePath","sourceId","embedding","createdAt")
       VALUES ($1, $2, $3, 'text', 'extraction', $4, $5, $6::vector, (NOW() AT TIME ZONE 'UTC'))`,
      id,
      ORG,
      TEXT,
      DOCS,
      sourceId,
      QUERY_VECTOR,
    );

  async function docsReader(): Promise<AccessContext> {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId: "docs-reader",
        tokenHash: hashCapabilityToken(token),
        scopePath: DOCS,
        permission: "read",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return { orgId: ORG, actor: { type: "agent", id: "docs-reader", capabilityToken: token }, origin: "mcp" };
  }

  async function servedLines(): Promise<string[]> {
    const reader = new GuardedMemoryStore(
      new HybridMemoryStore(graph, new PgvectorMemoryStore()),
      async () => "enterprise",
    );
    const { facts } = await reader.retrieve(
      await docsReader(),
      { groupId: ORG, query: "launch date", limit: 20 },
      DOCS,
    );
    return (await formatCitedFacts(ORG, facts)).split("\n");
  }

  async function clear() {
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
    await db.source.deleteMany({ where: { orgId: ORG } });
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.capability.deleteMany({ where: { orgId: ORG } });
    await db.scope.deleteMany({ where: { orgId: ORG } });
  }

  beforeAll(async () => {
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ GuardedMemoryStore } = await import("@/services/memory/guarded-store"));
    ({ HybridMemoryStore } = await import("@/services/memory/hybrid-store"));
    ({ PgvectorMemoryStore } = await import("@/services/memory/pgvector-store"));
    ({ formatCitedFacts } = await import("./fact-citation"));
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
    for (const path of [ROOT, DOCS]) await db.scope.create({ data: { orgId: ORG, path, name: path } });
    for (const [id, type, name] of [
      [DRIVE, "gdrive", "Launch folder"],
      [NOTION_LIKE, "website", "launch.example.com"],
    ] as const) {
      await db.source.create({ data: { id, orgId: ORG, type, externalId: id, name, scopePath: DOCS } });
    }
  });

  it("names the Drive item only on a line that cites the Drive source", async () => {
    await insertPassage("c-site", NOTION_LIKE);

    const lines = (await servedLines()).filter((l) => l.includes("October 20"));

    expect(lines).toHaveLength(1);
    const [line] = lines;
    if (line.includes(`item ${DRIVE_ITEM}`)) expect(line).toContain("source: Launch folder (gdrive)");
    expect(line).not.toMatch(/source: launch\.example\.com \(website\).*item ep-drive-item/);
  });

  it("serves the stored passage with the item the graph copy names when both came from the same source", async () => {
    await insertPassage("c-drive", DRIVE);

    const lines = (await servedLines()).filter((l) => l.includes("October 20"));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("source: Launch folder (gdrive)");
    expect(lines[0]).toContain(`· item ${DRIVE_ITEM}`);
    expect(lines[0]).toContain("· version c-drive");
  });
});
