// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// PgvectorMemoryStore.isStored is what a queued ingest job asks before and after its
// graph writes: is the row the request path stored for this ingest still there? A "yes"
// lets the job write the fact into the graph. The answer must be bound to the org and
// the exact scope the row was stored in, so a job carrying another tenant's row id, or
// the same id at another scope, is told "no" and writes nothing. The inngest suites
// (lib/inngest.delete-before-graph-write*.test.ts) only ever ask with the row's own org
// and scope, so they pass with either binding removed; this suite fails without each.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qa_is_stored";
const OTHER_ORG = "qa_is_stored_other";
const ROOT = `org_${ORG}`;
const DEAL_A = `${ROOT}.deal_a`;
const DEAL_B = `${ROOT}.deal_b`;
const SCOPED = "qa-is-stored-scoped";
const UNTAGGED = "qa-is-stored-untagged";

describe.skipIf(!QA_URL)("PgvectorMemoryStore.isStored is bound to the row's org and exact scope", () => {
  let db: PrismaClient;
  let store: InstanceType<(typeof import("./pgvector-store"))["PgvectorMemoryStore"]>;

  async function wipe() {
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" IN (${ORG}, ${OTHER_ORG})`;
    await deleteOrgsWithRetry(db, { where: { id: { in: [ORG, OTHER_ORG] } } });
  }

  async function insertRow(id: string, orgId: string, scopePath: string | null) {
    await db.$executeRaw`
      INSERT INTO memory_chunks ("id","orgId","content","actorType","scopePath","createdAt")
      VALUES (${id}, ${orgId}, 'Acme renewal is due in March', 'agent', ${scopePath}, now())`;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL! }) });
    const { PgvectorMemoryStore } = await import("./pgvector-store");
    store = new PgvectorMemoryStore();
    await wipe();
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.org.create({ data: { id: OTHER_ORG, name: OTHER_ORG } });
    await insertRow(SCOPED, ORG, DEAL_A);
    await insertRow(UNTAGGED, ORG, null);
  });

  afterAll(async () => {
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  it("finds a scoped row at its own org and scope", async () => {
    expect(await store.isStored({ groupId: ORG, chunkId: SCOPED, scopePath: DEAL_A })).toBe(true);
  });

  it("does not find the row when asked as another org", async () => {
    expect(await store.isStored({ groupId: OTHER_ORG, chunkId: SCOPED, scopePath: DEAL_A })).toBe(false);
  });

  it("does not find a scoped row at a sibling scope, its parent, or no scope", async () => {
    expect(await store.isStored({ groupId: ORG, chunkId: SCOPED, scopePath: DEAL_B })).toBe(false);
    expect(await store.isStored({ groupId: ORG, chunkId: SCOPED, scopePath: ROOT })).toBe(false);
    expect(await store.isStored({ groupId: ORG, chunkId: SCOPED, scopePath: null })).toBe(false);
  });

  it("finds an untagged row only when asked with no scope", async () => {
    expect(await store.isStored({ groupId: ORG, chunkId: UNTAGGED, scopePath: null })).toBe(true);
    expect(await store.isStored({ groupId: ORG, chunkId: UNTAGGED, scopePath: DEAL_A })).toBe(false);
    expect(await store.isStored({ groupId: OTHER_ORG, chunkId: UNTAGGED, scopePath: null })).toBe(false);
  });
});
