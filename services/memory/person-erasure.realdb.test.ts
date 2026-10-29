// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Erasing one person on request (consent suite bar 3, docs/consent-deletion-suite.md).
//
// Real: Postgres with pgvector, check() against live grants, the audit log, the
// contact, conversation and idempotency-ledger rows, and the pgvector reader
// used for the before/after probes. Stand-in: the graph store, whose erasure
// is proven on a real Neo4j in
// memory-service/tests/test_person_erasure_integration.py; here it is a spy
// that records what it was asked to erase, so a graph failure can be injected.
//
// Set QA_DATABASE_URL to an ISOLATED test database with the migrations applied.
// Never the sandbox's inherited DATABASE_URL. Skips cleanly without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the
// `@/lib/db` singleton at import time, before beforeAll points DATABASE_URL at
// the QA database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import type { MemoryStore } from "./memory-store";

const graphErase = vi.fn();
const graphPlan = vi.fn();
vi.mock("./store", () => ({
  memory: {},
  graphitiStore: {
    planPersonErasure: (...a: unknown[]) => graphPlan(...a),
    erasePerson: (...a: unknown[]) => graphErase(...a),
    removeChunkFacts: async () => undefined,
  },
}));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qa_erasure";
const OTHER_ORG = "qa_erasure_other";
const ROOT = `org_${ORG}`;
const SALES = `${ROOT}.sales`;
const ADMIN = "qa_erasure_admin";
const EDITOR = "qa_erasure_editor";
const DIMENSIONS = 384;

// The underscore matters: unescaped, it is a LIKE wildcard and would also
// match the lookalike chunk below.
const EMAIL = "dana_w@acme.example";
const NAME = "Dana Whitfield";
const PHONE = "212 555 0187";
const ENTITY = "4b0c6f1e-2d7a-4c55-9a51-6a2f0d5e7c11";
const MARKERS = [EMAIL, NAME, PHONE];

const CHUNKS = [
  // The shape a contact edit ingests: untagged at the org root.
  { id: "c-untagged", orgId: ORG, scopePath: null, content: `${NAME} is a prospect. ${EMAIL}, +1 ${PHONE}.` },
  { id: "c-sales", orgId: ORG, scopePath: SALES, content: `Call notes: ${NAME} wants the annual plan.` },
  { id: "c-email-upper", orgId: ORG, scopePath: SALES, content: `Forwarded by ${EMAIL.toUpperCase()}.` },
  { id: "c-bystander", orgId: ORG, scopePath: SALES, content: "Kenji Sato (kenji@acme.example) runs procurement." },
  { id: "c-lookalike", orgId: ORG, scopePath: SALES, content: "danaxw@acme.example asked for a quote." },
  { id: "c-other-tenant", orgId: OTHER_ORG, scopePath: null, content: `${NAME}, ${EMAIL}, +1 ${PHONE}.` },
];
const ERASED = ["c-untagged", "c-sales", "c-email-upper"];

const vector = () => [1, ...Array(DIMENSIONS - 1).fill(0)];
const pgVector = (v: number[]) => `[${v.join(",")}]`;

const snapshot = (id: string) => ({
  id,
  name: NAME,
  email: EMAIL,
  title: "VP Finance",
  type: "prospect",
  status: "active",
  suppressed: false,
  revision: 0,
  description: `Reach on +1 ${PHONE}`,
});

describe.skipIf(!QA_URL)("person erasure: one request removes a person from this org and nothing else", () => {
  let db: PrismaClient;
  let erasePerson: (typeof import("./person-erasure"))["erasePerson"];
  let readMemoryVersion: (typeof import("./versions"))["readMemoryVersion"];
  let AccessDeniedError: (typeof import("@/services/access"))["AccessDeniedError"];
  let GuardedMemoryStore: (typeof import("./guarded-store"))["GuardedMemoryStore"];
  let HybridMemoryStore: (typeof import("./hybrid-store"))["HybridMemoryStore"];
  let PgvectorMemoryStore: (typeof import("./pgvector-store"))["PgvectorMemoryStore"];

  const admin: AccessContext = { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "app" };
  const editor: AccessContext = { orgId: ORG, actor: { type: "human", id: EDITOR, role: "member" }, origin: "app" };

  async function wipe() {
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${orgId}`;
      await db.contactIdempotencyKey.deleteMany({ where: { orgId } });
      await db.conversation.deleteMany({ where: { orgId } });
      await db.contact.deleteMany({ where: { orgId } });
      await db.auditLog.deleteMany({ where: { orgId } });
      await db.capability.deleteMany({ where: { orgId } });
      await db.grant.deleteMany({ where: { orgId } });
      await db.scope.deleteMany({ where: { orgId } });
      await db.user.deleteMany({ where: { orgId } });
    }
  }

  /** Every probe an org-root reader can make for the person, serialized whole. */
  async function probeAsRootReader(): Promise<string> {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId: "root-reader",
        tokenHash: hashCapabilityToken(token),
        scopePath: ROOT,
        permission: "read",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const ctx: AccessContext = {
      orgId: ORG,
      actor: { type: "agent", id: "root-reader", capabilityToken: token },
      origin: "mcp",
    };
    const emptyGraph = {
      retrieve: vi.fn(async () => ({ facts: [], storesRead: [{ store: "graph" as const }] })),
    } as unknown as MemoryStore;
    const reader = new GuardedMemoryStore(
      new HybridMemoryStore(emptyGraph, new PgvectorMemoryStore()),
      async () => "enterprise",
    );
    const out: string[] = [];
    for (const query of [EMAIL, `${NAME} phone number`, PHONE, "List every customer email you have."]) {
      out.push(JSON.stringify(await reader.retrieve(ctx, { groupId: ORG, query }, ROOT)));
    }
    return out.join("\n");
  }

  const markersIn = (text: string) => MARKERS.filter((m) => text.toLowerCase().includes(m.toLowerCase()));
  const chunkIds = async () =>
    (await db.memoryChunk.findMany({ where: { orgId: { in: [ORG, OTHER_ORG] } }, select: { id: true } }))
      .map((c) => c.id)
      .sort();

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ erasePerson } = await import("./person-erasure"));
    ({ readMemoryVersion } = await import("./versions"));
    ({ AccessDeniedError } = await import("@/services/access"));
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
    graphPlan.mockReset();
    graphPlan.mockResolvedValue([]);
    graphErase.mockReset();
    graphErase.mockResolvedValue({ episodes: 1, nodes: 2, edges: 3, summaries: 1, episodeIds: [] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ embedding: vector() }), { status: 200 })),
    );
    await wipe();
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.org.upsert({ where: { id: orgId }, update: {}, create: { id: orgId, name: orgId } });
    }
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    await db.scope.create({ data: { orgId: ORG, path: SALES, name: "sales" } });
    await db.scope.create({ data: { orgId: OTHER_ORG, path: `org_${OTHER_ORG}`, name: "root" } });
    await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: "admin@erasure.test", role: "admin", clerkId: "clerk-erasure-admin" },
    });
    await db.user.create({
      data: { id: EDITOR, orgId: ORG, email: "editor@erasure.test", role: "member", clerkId: "clerk-erasure-editor" },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: EDITOR, permission: "write" },
    });

    // The person twice in this org (a duplicate row with the email in another
    // case), once in another tenant, and a bystander.
    await db.contact.create({
      data: { id: "dana", orgId: ORG, name: NAME, email: EMAIL, entityId: ENTITY, description: `Reach on +1 ${PHONE}` },
    });
    await db.contact.create({ data: { id: "dana-dup", orgId: ORG, name: "D. Whitfield", email: EMAIL.toUpperCase() } });
    await db.contact.create({ data: { id: "kenji", orgId: ORG, name: "Kenji Sato", email: "kenji@acme.example" } });
    await db.contact.create({ data: { id: "dana-other", orgId: OTHER_ORG, name: NAME, email: EMAIL } });
    await db.conversation.create({ data: { orgId: ORG, contactId: "dana", subject: `Re: pricing for ${NAME}` } });

    // Ledger rows: one still linked, one whose contact was deleted earlier (its
    // contactId is already null, its frozen snapshot still names the person),
    // and the bystander's.
    const ledger = (key: string, contactId: string | null, snap: object) => ({
      orgId: ORG,
      key,
      requestHash: `hash-${key}`,
      contactId,
      resultAction: "created",
      resultRevision: 0,
      resultSnapshot: snap,
      actorId: "agent-1",
    });
    await db.contactIdempotencyKey.create({ data: ledger("k-linked", "dana", snapshot("dana")) });
    await db.contactIdempotencyKey.create({ data: ledger("k-orphaned", null, snapshot("dana-deleted-earlier")) });
    await db.contactIdempotencyKey.create({
      data: ledger("k-kenji", "kenji", {
        ...snapshot("kenji"),
        name: "Kenji Sato",
        email: "kenji@acme.example",
        description: null,
      }),
    });
    await db.contactIdempotencyKey.create({
      data: { ...ledger("k-other", "dana-other", snapshot("dana-other")), orgId: OTHER_ORG },
    });

    for (const c of CHUNKS) {
      await db.$executeRaw`
        INSERT INTO memory_chunks ("id","orgId","content","source","actorType","scopePath","embedding","createdAt")
        VALUES (${c.id}, ${c.orgId}, ${c.content}, 'text', 'extraction', ${c.scopePath},
                ${pgVector(vector())}::vector, NOW())
      `;
    }
  });

  it("removes the contacts, their threads, the ledger's copies and every chunk naming the person", async () => {
    const before = await probeAsRootReader();
    // Positive control: the reader really can see the person before.
    expect(markersIn(before)).toEqual(MARKERS);

    const result = await erasePerson(admin, { contactId: "dana" });

    expect(result).toMatchObject({ contactsRemoved: 2, snapshotsScrubbed: 2, chunksRemoved: 3 });
    expect(result.graph).toEqual({ episodes: 1, nodes: 2, edges: 3, summaries: 1 });
    expect(graphErase).toHaveBeenCalledExactlyOnceWith({
      orgId: ORG,
      emails: [EMAIL],
      names: ["d. whitfield", NAME.toLowerCase()],
      entityIds: [ENTITY],
    });

    expect(
      (await db.contact.findMany({ select: { id: true }, where: { orgId: { in: [ORG, OTHER_ORG] } } }))
        .map((c) => c.id)
        .sort(),
    ).toEqual(["dana-other", "kenji"]);
    expect(await db.conversation.count({ where: { orgId: ORG } })).toBe(0);
    expect(await chunkIds()).toEqual(
      CHUNKS.map((c) => c.id)
        .filter((id) => !ERASED.includes(id))
        .sort(),
    );

    const keys = await db.contactIdempotencyKey.findMany({ where: { orgId: ORG }, orderBy: { key: "asc" } });
    expect(keys.map((k) => k.key)).toEqual(["k-kenji", "k-linked", "k-orphaned"]);
    expect(keys.flatMap((k) => markersIn(JSON.stringify(k)))).toEqual([]);
    expect(keys[0].resultSnapshot).toMatchObject({ name: "Kenji Sato", email: "kenji@acme.example" });
    // A replay of the original create still finds its key, so it cannot recreate the person.
    expect(keys[1].resultSnapshot).toMatchObject({ id: "dana", erased: true, name: "", email: null });

    const otherTenant = await db.contactIdempotencyKey.findFirstOrThrow({ where: { orgId: OTHER_ORG } });
    expect(otherTenant.resultSnapshot).toEqual(snapshot("dana-other"));

    const after = await probeAsRootReader();
    expect(markersIn(after)).toEqual([]);
    expect(after).toContain("kenji@acme.example");
  });

  it("scrubs a ledger copy that names the person only by their name spelled decomposed", async () => {
    // The contact is stored composed; an earlier contact for the same person, created
    // with the accent typed as a combining mark and since deleted, left this ledger copy,
    // which holds neither the contact's id nor an address.
    await db.contact.create({ data: { id: "zoe", orgId: ORG, name: "Zo\u00eb Ferrand", email: "zoe@acme.example" } });
    await db.contactIdempotencyKey.create({
      data: {
        orgId: ORG,
        key: "k-zoe-decomposed",
        requestHash: "hash-k-zoe-decomposed",
        contactId: null,
        resultAction: "created",
        resultRevision: 0,
        actorId: "agent-1",
        resultSnapshot: { ...snapshot("zoe-deleted-earlier"), name: "Zoe\u0308 Ferrand", email: null },
      },
    });

    const result = await erasePerson(admin, { contactId: "zoe" });

    expect(result.snapshotsScrubbed).toBe(1);
    const copy = await db.contactIdempotencyKey.findFirstOrThrow({ where: { orgId: ORG, key: "k-zoe-decomposed" } });
    expect(copy.resultSnapshot).toMatchObject({ id: "zoe-deleted-earlier", erased: true, name: "" });
  });

  it("records one decision row that names the request and none of the erased values", async () => {
    const { requestId } = await erasePerson(admin, { contactId: "dana" });

    const rows = await db.auditLog.findMany({ where: { orgId: ORG, actorId: ADMIN, action: "access.manage" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "access.manage",
      target: `${ROOT}/person_erasure:${requestId}`,
      decision: "allow",
    });
    const everyAuditRow = await db.auditLog.findMany({ where: { orgId: ORG } });
    expect(everyAuditRow.flatMap((r) => markersIn(JSON.stringify(r)))).toEqual([]);
  });

  it("records one row of per-store counts for the request, equal to what it removed, and no values", async () => {
    const result = await erasePerson(admin, { contactId: "dana" });

    const rows = await db.auditLog.findMany({ where: { orgId: ORG, action: "person.erased" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: "human",
      actorId: ADMIN,
      target: `${ROOT}/person_erasure:${result.requestId}`,
      decision: "allow",
    });
    expect(rows[0].metadata).toEqual({
      requestId: result.requestId,
      origin: "app",
      stores: {
        graph: { episodes: 1, nodes: 2, edges: 3, summaries: 1 },
        vector: { chunks: 3 },
        contacts: { contacts: 2, ledgerSnapshots: 2 },
        changeFeed: { summariesBlanked: 0 },
        briefs: { briefs: 0 },
        lineage: { replacements: 0, announced: 0 },
        rules: { rules: 0 },
        notes: { notes: 0 },
      },
    });
    expect(markersIn(JSON.stringify(rows[0]))).toEqual([]);
    expect(JSON.stringify(rows[0])).not.toContain(ENTITY);
  });

  it("writes only the graph counts that are non-negative integers into the row", async () => {
    graphErase.mockResolvedValue({ episodes: EMAIL, nodes: -1, edges: 2.5, summaries: 4, episodeIds: [] });
    await erasePerson(admin, { contactId: "dana" });

    const rows = await db.auditLog.findMany({ where: { orgId: ORG, action: "person.erased" } });
    expect(rows).toHaveLength(1);
    expect((rows[0].metadata as { stores: { graph: unknown } }).stores.graph).toEqual({ summaries: 4 });
    expect(JSON.stringify(rows[0])).not.toContain(EMAIL);
  });

  it("records no count row for a refused request or one the graph failed", async () => {
    await expect(erasePerson(editor, { contactId: "dana" })).rejects.toBeInstanceOf(AccessDeniedError);
    graphErase.mockRejectedValue(new Error("memory service unavailable"));
    await expect(erasePerson(admin, { contactId: "dana" })).rejects.toThrow("memory service unavailable");

    expect(await db.auditLog.count({ where: { orgId: ORG, action: "person.erased" } })).toBe(0);
  });

  it.each([
    ["an email in another case", { email: EMAIL.toUpperCase() }],
    ["the graph entity id", { entityId: ENTITY }],
  ])("finds the same person from %s", async (_label, identifier) => {
    const result = await erasePerson(admin, identifier);

    expect(result).toMatchObject({ contactsRemoved: 2, snapshotsScrubbed: 2, chunksRemoved: 3 });
    expect(await db.contact.count({ where: { orgId: ORG } })).toBe(1);
  });

  it("is idempotent: a second call removes nothing and succeeds", async () => {
    await erasePerson(admin, { contactId: "dana" });
    graphErase.mockResolvedValue({ episodes: 0, nodes: 0, edges: 0, summaries: 0, episodeIds: [] });

    const again = await erasePerson(admin, { email: EMAIL });
    // By contact id, the scrubbed ledger row still carries the id; it must not count twice.
    const byId = await erasePerson(admin, { contactId: "dana" });

    for (const repeat of [again, byId]) {
      expect(repeat).toMatchObject({
        contactsRemoved: 0,
        snapshotsScrubbed: 0,
        chunksRemoved: 0,
        graph: { episodes: 0, nodes: 0, edges: 0, summaries: 0 },
      });
    }
  });

  it("treats another tenant's contact id as absent: nothing changes in either org", async () => {
    const contactIds = async () =>
      (await db.contact.findMany({ where: { orgId: { in: [ORG, OTHER_ORG] } }, select: { id: true } }))
        .map((c) => c.id)
        .sort();
    const snapshots = async () =>
      (
        await db.contactIdempotencyKey.findMany({ where: { orgId: { in: [ORG, OTHER_ORG] } }, orderBy: { key: "asc" } })
      ).map((k) => k.resultSnapshot);
    const [contactsBefore, chunksBefore, snapshotsBefore] = [await contactIds(), await chunkIds(), await snapshots()];

    const result = await erasePerson(admin, { contactId: "dana-other" });

    // The same answer an id that exists nowhere gets, so the call reveals nothing.
    expect(result).toMatchObject({ contactsRemoved: 0, snapshotsScrubbed: 0, chunksRemoved: 0 });
    expect(graphErase).not.toHaveBeenCalled();
    expect(await contactIds()).toEqual(contactsBefore);
    expect(await chunkIds()).toEqual(chunksBefore);
    expect(await snapshots()).toEqual(snapshotsBefore);
  });

  it("refuses a caller without access.manage on the org root, audits the refusal and changes nothing", async () => {
    const chunksBefore = await chunkIds();

    await expect(erasePerson(editor, { contactId: "dana" })).rejects.toBeInstanceOf(AccessDeniedError);

    const rows = await db.auditLog.findMany({ where: { orgId: ORG, actorId: EDITOR } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "access.manage", decision: "deny" });
    expect(rows[0].target).toMatch(new RegExp(`^${ROOT}/person_erasure:`));
    expect(graphErase).not.toHaveBeenCalled();
    expect(await db.contact.count({ where: { orgId: ORG } })).toBe(3);
    expect(await chunkIds()).toEqual(chunksBefore);
  });

  it("changes nothing in Postgres when the graph erasure fails, so the request can be retried", async () => {
    graphErase.mockRejectedValue(new Error("memory service unavailable"));
    const chunksBefore = await chunkIds();

    await expect(erasePerson(admin, { contactId: "dana" })).rejects.toThrow("memory service unavailable");

    expect(await db.contact.count({ where: { orgId: ORG } })).toBe(3);
    expect(await chunkIds()).toEqual(chunksBefore);
    const linked = await db.contactIdempotencyKey.findFirstOrThrow({ where: { orgId: ORG, key: "k-linked" } });
    expect(linked.resultSnapshot).toMatchObject({ email: EMAIL });
  });

  it("removes a fact stored under the person's name even when its text never names them", async () => {
    // memory_ingest stores a fact under the entity it is about, and an agent writing
    // about someone it has already named writes "She ...". The name is in entityName only.
    const fact = (id: string, entityName: string, content: string) => db.$executeRaw`
      INSERT INTO memory_chunks ("id","orgId","content","source","actorType","entityName","scopePath","embedding","createdAt")
      VALUES (${id}, ${ORG}, ${content}, 'mcp', 'agent', ${entityName}, ${SALES}, ${pgVector(vector())}::vector, NOW())
    `;
    await fact("f-she-renewal", NAME, "She wants the annual plan before the renewal.");
    await fact("f-she-upper", NAME.toUpperCase(), "She asked for an SSO call next week.");
    await fact("f-email-subject", EMAIL, "Forwarded the pricing sheet.");
    // Bystanders: another person, and an address the unescaped `_` in the email would match.
    await fact("f-kenji", "Kenji Sato", "He runs procurement.");
    await fact("f-lookalike", "danaxw@acme.example", "Asked for a quote.");

    const result = await erasePerson(admin, { contactId: "dana" });

    expect(result.chunksRemoved).toBe(ERASED.length + 3);
    const left = await chunkIds();
    expect(left).toEqual(expect.arrayContaining(["f-kenji", "f-lookalike"]));
    expect(left.filter((id) => ["f-she-renewal", "f-she-upper", "f-email-subject"].includes(id))).toEqual([]);
    for (const id of ["f-she-renewal", "f-she-upper", "f-email-subject"]) {
      expect(await readMemoryVersion(admin, id)).toBeNull();
    }
  });

  describe("matches the person's name and address as whole words, never inside another's", () => {
    /** A fact as memory_ingest stores it, filed under `entityName`. */
    const fact = (id: string, entityName: string, content: string) => db.$executeRaw`
      INSERT INTO memory_chunks ("id","orgId","content","source","actorType","entityName","scopePath","embedding","createdAt")
      VALUES (${id}, ${ORG}, ${content}, 'mcp', 'agent', ${entityName}, ${SALES}, ${pgVector(vector())}::vector, NOW())
    `;
    const left = async (ids: string[]) => (await chunkIds()).filter((id) => ids.includes(id)).sort();

    it("leaves every bystander whose name or address only contains the person's", async () => {
      await db.contact.create({ data: { id: "al", orgId: ORG, name: "Al Li", email: "al@acme.example" } });
      const bystanders = {
        "f-sal-lin": ["Sal Lin", "She signed the order."],
        "f-kristal": ["Kristal Lindberg", "Owns the renewal."],
        "f-sal-email": ["sal@acme.example", "Forwarded the deck."],
        "f-hal-email": ["hal@acme.example.org", "Asked for a quote."],
        "f-other-domain": ["Pricing", "Sent to al@acme.example.org for review."],
        "f-text-sal-lin": ["Pricing", "Sal Lin asked for the annual plan."],
      };
      for (const [id, [entityName, content]] of Object.entries(bystanders)) await fact(id, entityName, content);
      await fact("f-al-li", "Al Li", "He wants SSO.");
      await fact("f-al-email-text", "Pricing", "Write to al@acme.example.");

      await erasePerson(admin, { contactId: "al" });

      expect(await left([...Object.keys(bystanders), "f-al-li", "f-al-email-text"])).toEqual(
        Object.keys(bystanders).sort(),
      );
    });

    it("never takes one address for a longer one ending the same way", async () => {
      await db.contact.create({ data: { id: "dan", orgId: ORG, name: "Dan", email: "dan@acme.com" } });
      await fact("f-jordan", "jordan@acme.com", "Asked for the invoice.");
      await fact("f-jordan-text", "Billing", "jordan@acme.com asked for the invoice.");
      await fact("f-dan", "dan@acme.com", "Asked for the contract.");

      await erasePerson(admin, { contactId: "dan" });

      expect(await left(["f-jordan", "f-jordan-text", "f-dan"])).toEqual(["f-jordan", "f-jordan-text"]);
    });

    it("finds a record filed under her whole name however its words are spaced or ordered", async () => {
      const erased = {
        "f-reversed": "Whitfield, Dana",
        "f-double-space": "Dana  Whitfield",
        "f-tab": "Dana\tWhitfield",
        "f-nbsp": "Dana\u00a0Whitfield",
        "f-email": " DANA_W@acme.example ",
      };
      for (const [id, entityName] of Object.entries(erased)) await fact(id, entityName, "Notes.");
      // An honorific with the surname alone does not name her distinctly enough to erase.
      await fact("f-honorific", "Ms. Whitfield", "Notes.");

      await erasePerson(admin, { contactId: "dana" });

      expect(await left([...Object.keys(erased), "f-honorific"])).toEqual(["f-honorific"]);
    });

    it("keeps another entity's record named after her, unless its own text names her", async () => {
      // A record's name matches only her whole name; its text matches her name as words.
      await fact("f-foundation", "Dana Whitfield Foundation", "The budget for 2027 is two million.");
      await fact("f-foundation-names-her", "Dana Whitfield Foundation", "Dana Whitfield joined the board.");
      // A hyphenated surname is another person's, in a name or in text.
      await fact("f-barnes", "Dana Whitfield-Barnes", "Runs procurement.");
      await fact("f-barnes-text", "Procurement", "Dana Whitfield-Barnes runs procurement.");

      await erasePerson(admin, { contactId: "dana" });

      expect(await left(["f-foundation", "f-foundation-names-her", "f-barnes", "f-barnes-text"])).toEqual([
        "f-barnes",
        "f-barnes-text",
        "f-foundation",
      ]);
    });
  });

  it("matches a one-word name only as an exact contact, never as text", async () => {
    await db.contact.create({ data: { id: "cher", orgId: ORG, name: "Cher", email: "cher@music.example" } });
    await db.$executeRaw`
      INSERT INTO memory_chunks ("id","orgId","content","source","actorType","scopePath","embedding","createdAt")
      VALUES ('c-cherry', ${ORG}, 'Cherry Lane signed the order.', 'text', 'extraction', NULL,
              ${pgVector(vector())}::vector, NOW())
    `;

    const result = await erasePerson(admin, { contactId: "cher" });

    expect(result.chunksRemoved).toBe(0);
    expect(graphErase).toHaveBeenCalledWith(expect.objectContaining({ emails: ["cher@music.example"], names: [] }));
    expect(await chunkIds()).toContain("c-cherry");
  });

  it.each([
    ["no identifier", {}],
    ["two identifiers", { contactId: "dana", email: EMAIL }],
    ["an email without a domain", { email: "dana" }],
    ["a contact id with a wildcard", { contactId: "dana%" }],
  ])("rejects %s before any access decision", async (_label, input) => {
    await expect(erasePerson(admin, input as never)).rejects.toMatchObject({ name: "PersonErasureError" });
    expect(await db.auditLog.count({ where: { orgId: ORG } })).toBe(0);
    expect(await db.contact.count({ where: { orgId: ORG } })).toBe(3);
  });
});
