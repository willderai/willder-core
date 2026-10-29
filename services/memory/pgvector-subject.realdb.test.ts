// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Which stored chunks a read treats as versions of one fact. A guarded read lets the
// newest version of a fact take the best place any of its versions holds
// (services/memory/guarded-store.ts, breakTiesByRecency), so the vector store names the
// fact each chunk is a version of: its scope and entity name, for rows the fact path
// stored as versions (`factVersion`). Rows that merely share a name are not versions and
// carry no subject. Only the embedding HTTP call is stubbed.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { IngestInput } from "@/types/memory";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "chunksubject";
const ROOT = `org_${ORG}`;
const EMBEDDING = Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));

const write = (content: string, name: string, scopePath = ROOT): IngestInput => ({
  groupId: ORG,
  content,
  name,
  actorType: "agent",
  actorId: "writer",
  origin: "mcp",
  scopePath,
});

describe.skipIf(!QA_URL)("the fact a stored chunk is a version of", () => {
  let db: PrismaClient;
  let PgvectorMemoryStore: (typeof import("./pgvector-store"))["PgvectorMemoryStore"];

  const subjects = async () => {
    const { facts } = await new PgvectorMemoryStore().retrieve({
      groupId: ORG,
      tenantId: ORG,
      query: "q",
      scopePath: ROOT,
      includeUntagged: true,
    });
    return new Map(facts.map((f) => [f.fact, f.subject]));
  };

  beforeAll(async () => {
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ PgvectorMemoryStore } = await import("./pgvector-store"));
  });

  beforeEach(async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ embedding: EMBEDDING }), { status: 200 })),
    );
    await db.memoryChunk.deleteMany({ where: { orgId: ORG } });
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await db.memoryChunk.deleteMany({ where: { orgId: ORG } });
    await db.$disconnect();
  });

  it("gives two versions of one fact the same subject, and another fact's version another", async () => {
    const store = new PgvectorMemoryStore();
    await store.ingestOnce(write("Running 20 miles a week", "Weekly mileage"));
    await store.ingestOnce(write("Running 35 miles a week", "Weekly mileage"));
    await store.ingestOnce(write("Lives in Denver", "Home city"));

    const subject = await subjects();
    expect(subject.get("Running 20 miles a week")).toBeDefined();
    expect(subject.get("Running 35 miles a week")).toBe(subject.get("Running 20 miles a week"));
    expect(subject.get("Lives in Denver")).not.toBe(subject.get("Running 20 miles a week"));
  });

  it("tells the same name in two scopes apart", async () => {
    const store = new PgvectorMemoryStore();
    await store.ingestOnce(write("Sales owns the renewal", "Renewal", `${ROOT}.sales`));
    await store.ingestOnce(write("Support owns the renewal", "Renewal", `${ROOT}.support`));

    const subject = await subjects();
    expect(subject.get("Sales owns the renewal")).not.toBe(subject.get("Support owns the renewal"));
  });

  it("gives no subject to a row that only shares a name", async () => {
    await new PgvectorMemoryStore().ingest(write("An uploaded passage", "Weekly mileage"));

    expect((await subjects()).get("An uploaded passage")).toBeUndefined();
  });
});
