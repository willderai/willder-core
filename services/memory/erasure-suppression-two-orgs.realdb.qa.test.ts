// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// An erasure's suppression list is one org's. Erasing a person in one org must not hide,
// or re-erase, anything in another org that names the same person: by text, by the name a
// fact is filed under, by a contact's name or by a contact's address.
//
// Real: Postgres with pgvector, check(), the erasure, the suppression list, the vector
// read, `reapplyErasures`. Stand-in: the graph store, a spy.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";

vi.mock("./store", () => ({
  memory: {},
  graphitiStore: {
    planPersonErasure: async () => [],
    erasePerson: vi.fn(async () => ({ episodes: 0, nodes: 0, edges: 0, summaries: 0, episodeIds: [] })),
    removeChunkFacts: async () => undefined,
  },
}));

const QA_URL = process.env.QA_DATABASE_URL;

const ERASING = "qa_two_orgs_erasing";
const OTHER = "qa_two_orgs_other";
const ORGS = [ERASING, OTHER];
const DIMENSIONS = 384;

const NAME = "Talvi Quenmor";
const EMAIL = "talvi.quenmor@two-orgs.example";

describe.skipIf(!QA_URL)("an erasure's suppression list reaches only its own org", () => {
  let db: PrismaClient;
  let erasePerson: (typeof import("./person-erasure"))["erasePerson"];
  let reapplyErasures: (typeof import("./erasure-reapply"))["reapplyErasures"];
  let loadErasedContentFilter: (typeof import("./erasure-suppression"))["loadErasedContentFilter"];
  let PgvectorMemoryStore: (typeof import("./pgvector-store"))["PgvectorMemoryStore"];

  const adminOf = (org: string): AccessContext => ({
    orgId: org,
    actor: { type: "human", id: `${org}_admin`, role: "admin" },
    origin: "app",
  });
  const vector = `[${[1, ...Array(DIMENSIONS - 1).fill(0)].join(",")}]`;
  const before = new Date(Date.now() - 24 * 3600 * 1000);

  async function wipe() {
    for (const org of ORGS) {
      await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${org}`;
      await db.erasureSuppression.deleteMany({ where: { orgId: org } });
      await db.contact.deleteMany({ where: { orgId: org } });
      await db.auditLog.deleteMany({ where: { orgId: org } });
      await db.grant.deleteMany({ where: { orgId: org } });
      await db.scope.deleteMany({ where: { orgId: org } });
      await db.user.deleteMany({ where: { orgId: org } });
    }
  }

  /** The same person's rows, as each org holds them before the erasure. */
  async function seed(org: string) {
    await db.org.upsert({ where: { id: org }, update: {}, create: { id: org, name: org } });
    const root = await db.scope.create({ data: { orgId: org, path: `org_${org}`, name: "root" } });
    await db.user.create({
      data: { id: `${org}_admin`, orgId: org, email: `admin@${org}.test`, role: "admin", clerkId: `clerk-${org}` },
    });
    await db.grant.create({
      data: { orgId: org, scopeId: root.id, granteeType: "user", granteeId: `${org}_admin`, permission: "admin" },
    });
    await db.contact.create({
      data: { id: `${org}-by-address`, orgId: org, name: NAME, email: EMAIL, createdAt: before },
    });
    await db.contact.create({ data: { id: `${org}-by-name`, orgId: org, name: NAME, email: null, createdAt: before } });
    const chunks = [
      { id: `${org}-text`, content: `${NAME} owns the renewal.`, entityName: null },
      { id: `${org}-filed`, content: "Prefers quarterly invoices.", entityName: NAME },
      { id: `${org}-filed-address`, content: "Asked for SSO.", entityName: EMAIL },
    ];
    for (const c of chunks) {
      await db.$executeRaw`
        INSERT INTO memory_chunks ("id","orgId","content","source","actorType","entityName","scopePath","embedding","createdAt")
        VALUES (${c.id}, ${org}, ${c.content}, 'mcp', 'agent', ${c.entityName}, ${`org_${org}`}, ${vector}::vector, ${before})
      `;
    }
    return chunks;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ erasePerson } = await import("./person-erasure"));
    ({ reapplyErasures } = await import("./erasure-reapply"));
    ({ loadErasedContentFilter } = await import("./erasure-suppression"));
    ({ PgvectorMemoryStore } = await import("./pgvector-store"));
  });

  afterAll(async () => {
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const embedding = [1, ...Array(DIMENSIONS - 1).fill(0)];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ embedding }), { status: 200 })),
    );
    await wipe();
  });

  it("hides and re-erases the person in the erasing org, and nothing in the other", async () => {
    await seed(ERASING);
    const otherChunks = await seed(OTHER);
    await erasePerson(adminOf(ERASING), { contactId: `${ERASING}-by-address` });

    // The other org's read filter names nobody: the digests were taken over the erasing org's id.
    const otherFilter = await loadErasedContentFilter(OTHER);
    for (const c of otherChunks) expect(otherFilter(c.content, before, c.entityName), c.id).toBe(false);
    expect(otherFilter.byRecordName(NAME, before)).toBe(false);
    expect(otherFilter.byRecordName(EMAIL, before)).toBe(false);

    // Positive control: the erasing org's filter hides the same rows, restored.
    const erasingFilter = await loadErasedContentFilter(ERASING);
    for (const c of otherChunks) expect(erasingFilter(c.content, before, c.entityName), c.id).toBe(true);
    expect(erasingFilter.byRecordName(EMAIL, before)).toBe(true);

    // The other org's vector read still serves all three.
    const read = (org: string) =>
      new PgvectorMemoryStore().retrieve({
        groupId: org,
        tenantId: org,
        query: NAME,
        limit: 50,
        scopePath: `org_${org}`,
        includeUntagged: true,
      });
    expect(JSON.stringify(await read(OTHER))).toContain("Prefers quarterly invoices.");
    expect(JSON.stringify(await read(OTHER))).toContain(`${NAME} owns the renewal.`);
    expect(JSON.stringify(await read(OTHER))).toContain("Asked for SSO.");

    // Re-apply in either org leaves the other org's rows alone.
    await reapplyErasures(adminOf(ERASING));
    const otherResult = await reapplyErasures(adminOf(OTHER));
    expect(otherResult.contactsErased).toBe(0);
    expect(await db.contact.count({ where: { orgId: OTHER } })).toBe(2);
    expect(await db.memoryChunk.count({ where: { orgId: OTHER } })).toBe(3);
  });
});
