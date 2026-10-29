// An import is a restore, so a person erased
// after the export was taken stays erased once that export is imported again.
//
// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The round-trip suite proves an export taken AFTER an erasure leaves the person out. This
// file covers the other order. An admin exports the org while it still names Orla, Orla is
// erased, which leaves the org holding no memory, and the admin imports the earlier export
// back into that same org. Every imported row keeps its original createdAt, which is before
// the erasure, so the org's suppression list must cover it. Search must serve nothing
// naming her, and a fresh export must leave her out, exactly as before the import. A second
// tenant that never erased her keeps her, which proves the filter is per org and not a
// blanket text match.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";
import type { MemoryStore } from "./memory-store";
import { stubEmbedService } from "./embed-service-stub.testsupport";
import { seedMember } from "@/services/access/member.testsupport";

vi.mock("./store", () => ({
  memory: {},
  graphitiStore: {
    removeGroupFacts: async () => ({ removedCount: 0 }),
    planPersonErasure: async () => [],
    erasePerson: async () => ({ episodes: 0, nodes: 0, edges: 0, summaries: 0, episodeIds: [] }),
    removeChunkFacts: async () => undefined,
  },
}));

const QA_URL = process.env.QA_DATABASE_URL;

// Alphanumeric, so orgRootPath(id) is a valid ltree label.
const ORG = "qaimporterasure";
const OTHER = "qaimporterasureb";
const ORGS = [ORG, OTHER];
const ADMIN = "u-qa-import-erasure-admin";
const ERASED_NAME = "Orla Brennick";
const QUESTION = "Who owns the Acme renewal?";
const NAMING = `${ERASED_NAME} owns the Acme renewal.`;
const CITING_TITLE = "Renewal status";
const DIMENSIONS = 384;

const vector = (...leading: number[]) => [...leading, ...Array(DIMENSIONS - leading.length).fill(0)];

describe.skipIf(!QA_URL)("QA #741: importing a pre-erasure export does not bring an erased person back", () => {
  let db: PrismaClient;
  let exportMemory: (typeof import("./org-export"))["exportMemory"];
  let importMemory: (typeof import("./org-import"))["importMemory"];
  let erasePerson: (typeof import("./person-erasure"))["erasePerson"];
  let GuardedMemoryStore: (typeof import("./guarded-store"))["GuardedMemoryStore"];
  let HybridMemoryStore: (typeof import("./hybrid-store"))["HybridMemoryStore"];
  let PgvectorMemoryStore: (typeof import("./pgvector-store"))["PgvectorMemoryStore"];
  let latestBriefAtScope: (typeof import("./briefs"))["latestBriefAtScope"];

  const admin = (orgId: string): AccessContext => ({
    orgId,
    actor: { type: "human", id: ADMIN, role: "admin" },
    origin: "app",
  });
  const emptyGraph = {
    retrieve: vi.fn(async () => ({ facts: [], storesRead: [{ store: "graph" as const }] })),
  } as unknown as MemoryStore;

  async function collect(ctx: AccessContext): Promise<string[]> {
    const lines: string[] = [];
    for await (const line of exportMemory(ctx)) lines.push(line.trimEnd());
    return lines;
  }
  async function* stream(lines: string[]) {
    yield* lines;
  }
  /** What a whole-org search serves, through the same guarded store the product reads with. */
  async function served(orgId: string): Promise<string[]> {
    const reader = new GuardedMemoryStore(
      new HybridMemoryStore(emptyGraph, new PgvectorMemoryStore()),
      async () => "enterprise",
    );
    const result = await reader.retrieve(admin(orgId), { groupId: orgId, query: QUESTION, limit: 10 }, `org_${orgId}`);
    return result.facts.map((f) => f.fact);
  }

  /** The brief a reader of the org root is served, as text; null when there is none. */
  async function briefServed(orgId: string): Promise<string | null> {
    const { brief } = await latestBriefAtScope(admin(orgId), `org_${orgId}`);
    return brief ? `${brief.title}\n${brief.summary}\n${JSON.stringify(brief.sections)}` : null;
  }

  async function wipe() {
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ANY(${ORGS})`;
    await db.changeEvent.deleteMany({ where: { orgId: { in: ORGS } } });
    await db.erasureSuppression.deleteMany({ where: { orgId: { in: ORGS } } });
    await db.org.deleteMany({ where: { id: { in: ORGS } } });
    await db.user.deleteMany({ where: { id: ADMIN } });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    stubEmbedService((text) => (text.includes(ERASED_NAME) || text === QUESTION ? vector(1) : vector(0.6, 0.8)));
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ exportMemory } = await import("./org-export"));
    ({ importMemory } = await import("./org-import"));
    ({ erasePerson } = await import("./person-erasure"));
    ({ GuardedMemoryStore } = await import("./guarded-store"));
    ({ HybridMemoryStore } = await import("./hybrid-store"));
    ({ PgvectorMemoryStore } = await import("./pgvector-store"));
    ({ latestBriefAtScope } = await import("./briefs"));
    await wipe();
    for (const org of ORGS) await db.org.create({ data: { id: org, name: org } });
    for (const org of ORGS) await seedMember(db, { orgId: org, userId: ADMIN, role: "admin" });
    for (const org of ORGS) {
      const root = await db.scope.create({ data: { orgId: org, path: `org_${org}`, name: "root" } });
      await db.grant.create({
        data: { orgId: org, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
      });
      await db.contact.create({
        data: { id: `orla-${org}`, orgId: org, name: ERASED_NAME, email: `orla@${org}.example` },
      });
      await new PgvectorMemoryStore().ingest({
        groupId: org,
        content: NAMING,
        actorType: "human",
        actorId: ADMIN,
        origin: "app",
        scopePath: `org_${org}`,
      });
      await db.brief.create({
        data: {
          orgId: org,
          type: "handoff",
          scopePath: `org_${org}`,
          title: "Acme handoff",
          summary: NAMING,
          sections: [{ heading: "Owner", body: NAMING }],
        },
      });
      // Names her only through a citation: the erasure deletes it, so a restore must too.
      await db.brief.create({
        data: {
          orgId: org,
          type: "handoff",
          scopePath: `org_${org}`,
          title: CITING_TITLE,
          summary: "The renewal has an owner.",
          sections: [{ heading: "Owner", body: "The renewal has an owner." }],
          citations: { create: [{ sectionIndex: 0, factId: `cited-${org}`, factText: NAMING }] },
          // Older than the Acme handoff, so the root's latest brief stays the one naming her.
          createdAt: new Date(Date.now() - 60_000),
        },
      });
    }
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  it("an export taken before the erasure, imported after it, serves and re-exports nothing naming her", async () => {
    const before = await collect(admin(ORG));
    expect(before.join("\n")).toContain(ERASED_NAME);
    // Wait a tick so the erasure is strictly later than the export's rows.
    await new Promise((r) => setTimeout(r, 20));

    const erased = await erasePerson(admin(ORG), { contactId: `orla-${ORG}` });
    expect(erased.chunksRemoved).toBeGreaterThanOrEqual(1);
    expect(erased.briefsRemoved).toBeGreaterThanOrEqual(1);
    expect(await served(ORG)).not.toContain(NAMING);
    expect(await briefServed(ORG)).toBeNull();

    // The erasure left the org holding no memory, so the import is allowed.
    const receipt = await importMemory(admin(ORG), stream(before));
    // Left out and counted, not silently dropped: the receipt says what the erasure kept out.
    expect(receipt.erased).toMatchObject({ fact: 1, brief: 2 });
    expect(receipt.imported).toMatchObject({ fact: 0, brief: 0 });

    expect(await served(ORG)).not.toContain(NAMING);
    expect((await collect(admin(ORG))).join("\n")).not.toContain(ERASED_NAME);
    // A brief has no read-time erasure filter, so a restored copy is served unless the import leaves it out.
    expect((await briefServed(ORG)) ?? "").not.toContain(ERASED_NAME);
    expect(await db.brief.count({ where: { orgId: ORG, title: CITING_TITLE } })).toBe(0);
  }, 30_000);

  it("the other tenant, which never erased her, still serves and exports her", async () => {
    expect(await served(OTHER)).toContain(NAMING);
    expect((await collect(admin(OTHER))).join("\n")).toContain(ERASED_NAME);
    expect(await briefServed(OTHER)).toContain(ERASED_NAME);
  });
});
