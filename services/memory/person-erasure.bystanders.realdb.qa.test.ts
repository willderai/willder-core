// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Person erasure's matching rules (services/memory/person-erasure.ts,
// textPatterns for a chunk's text, recordNamePatterns for the entity it is filed under):
// which chunks one erasure deletes. Deletion is irreversible, so the
// over-erasure cases (another person's facts) are the ones that matter most; the
// under-erasure cases check the person is still found in the shapes real text takes.
//
// Real: Postgres with pgvector, check() against live grants, the DELETE itself.
// Stand-in: the graph store, a spy (its own rule is proven on Neo4j in
// memory-service/tests/test_person_erasure_integration.py).
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

const ORG = "qa_erasure_bystanders";
const ROOT = `org_${ORG}`;
const ADMIN = "qa_erasure_bystanders_admin";
const DIMENSIONS = 384;

describe.skipIf(!QA_URL)("person erasure deletes the person's chunks and no one else's", () => {
  let db: PrismaClient;
  let erasePerson: (typeof import("./person-erasure"))["erasePerson"];
  const admin: AccessContext = { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "app" };

  async function wipe() {
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
    await db.contact.deleteMany({ where: { orgId: ORG } });
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.grant.deleteMany({ where: { orgId: ORG } });
    await db.scope.deleteMany({ where: { orgId: ORG } });
    await db.user.deleteMany({ where: { orgId: ORG } });
  }

  /** A fact as memory_ingest stores it: filed under `entityName`, at the org root. */
  const fact = (id: string, entityName: string, content: string) => db.$executeRaw`
    INSERT INTO memory_chunks ("id","orgId","content","source","actorType","entityName","scopePath","embedding","createdAt")
    VALUES (${id}, ${ORG}, ${content}, 'mcp', 'agent', ${entityName}, ${ROOT},
            ${`[${[1, ...Array(DIMENSIONS - 1).fill(0)].join(",")}]`}::vector, NOW())
  `;

  /** Seed `facts`, erase the contact, and return which of the seeded ids survived. */
  async function eraseAndList(
    contact: { id: string; name: string; email: string },
    facts: Record<string, [string, string]>,
  ) {
    await db.contact.create({ data: { ...contact, orgId: ORG } });
    for (const [id, [entityName, content]] of Object.entries(facts)) await fact(id, entityName, content);
    await erasePerson(admin, { contactId: contact.id });
    const ids = Object.keys(facts);
    return (await db.memoryChunk.findMany({ where: { orgId: ORG, id: { in: ids } }, select: { id: true } }))
      .map((c) => c.id)
      .sort();
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ erasePerson } = await import("./person-erasure"));
  });

  afterAll(async () => {
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await wipe();
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: "admin@bystanders.test", role: "admin", clerkId: "clerk-bystanders-admin" },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
  });

  // Each of these is another person's or another entity's fact whose text never names
  // the erased person; the erased name only sits inside a longer name.
  it("keeps a fact filed under another person whose name contains the erased name as whole words", async () => {
    const left = await eraseAndList(
      { id: "ann", name: "Ann Li", email: "ann.li@acme.example" },
      {
        "f-mary-ann": ["Mary Ann Li", "Signed the order on Friday."],
        "f-ann-li-wei": ["Ann Li Wei", "Owns the renewal."],
        "f-ann": ["Ann Li", "Wants SSO."],
      },
    );
    expect(left).toEqual(["f-ann-li-wei", "f-mary-ann"]);
  });

  it("keeps a fact filed under another entity named after the person", async () => {
    const left = await eraseAndList(
      { id: "dana", name: "Dana Whitfield", email: "dana@acme.example" },
      {
        "f-foundation": ["Dana Whitfield Foundation", "The budget for 2027 is two million."],
        "f-dana": ["Dana Whitfield", "Wants the annual plan."],
      },
    );
    expect(left).toEqual(["f-foundation"]);
  });

  it("keeps a fact filed under a hyphenated surname that starts with the person's", async () => {
    const left = await eraseAndList(
      { id: "dana", name: "Dana Whitfield", email: "dana@acme.example" },
      {
        "f-barnes": ["Dana Whitfield-Barnes", "Runs procurement."],
        "f-dana": ["Dana Whitfield", "Wants the annual plan."],
      },
    );
    expect(left).toEqual(["f-barnes"]);
  });

  it("keeps a bystander whose name continues past the person's with a non-ASCII letter", async () => {
    const left = await eraseAndList(
      { id: "al", name: "Al Li", email: "al@acme.example" },
      {
        "f-liu": ["Al Liú", "Signed the order."],
        "f-liu-text": ["Pricing", "Al Liú signed the order."],
        "f-al": ["Al Li", "Wants SSO."],
      },
    );
    expect(left).toEqual(["f-liu", "f-liu-text"]);
  });

  // Under-erasure: the person, written the ways real text writes them.
  it("still erases the person in possessives, punctuation, mail headers and any case", async () => {
    const left = await eraseAndList(
      { id: "al", name: "Al Li", email: "al@acme.example" },
      {
        "f-possessive": ["Pricing", "Al Li's team wants SSO."],
        "f-upper": ["Pricing", "CALL AL LI TOMORROW."],
        "f-sentence-end": ["Pricing", "The renewal owner is al li."],
        "f-header": ["Pricing", "From: Al Li <al@acme.example>"],
        "f-mailto": ["Pricing", "Write to mailto:AL@ACME.EXAMPLE, today."],
        "f-reversed": ["Li, Al", "Owner."],
        "f-newline": ["Pricing", "Owner:\nAl\nLi"],
      },
    );
    expect(left).toEqual([]);
  });
  // A record filed under the person's whole name goes even when its text only says "She":
  // the whole-name rule must still ignore case, outer spacing and order, and match an address.
  it("still erases a record filed under her whole name in any case, spacing or order, or her address", async () => {
    const left = await eraseAndList(
      { id: "dana", name: "Dana Whitfield", email: "dana@acme.example" },
      {
        "f-upper": ["  DANA WHITFIELD  ", "She wants the annual plan."],
        "f-reversed-tight": ["Whitfield,Dana", "She signs on Friday."],
        "f-address": ["Dana@Acme.Example", "She asked for SSO."],
        "f-longer-address": ["dana@acme.example.org", "Another mailbox."],
        "f-address-plus-word": ["dana@acme.example team", "A shared inbox."],
      },
    );
    expect(left).toEqual(["f-address-plus-word", "f-longer-address"]);
  });

  it("matches a name with regex metacharacters only literally", async () => {
    const left = await eraseAndList(
      { id: "jr", name: "J.R. Smith", email: "jr@acme.example" },
      {
        "f-literal": ["J.R. Smith", "Owns pricing."],
        "f-dot-wildcard": ["JXRY Smith", "Owns support."],
        "f-dot-text": ["Support", "JaRb Smith owns support."],
      },
    );
    expect(left).toEqual(["f-dot-text", "f-dot-wildcard"]);
  });
});
