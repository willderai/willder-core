// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Consent and deletion suite, bar 3 pass bar
// (suite spec docs/consent-deletion-suite.md, "Bar 3").
//
// The claim under test: after one erasure request and one connector re-sync, a
// reader who asks for the erased person by email, by name or by phone gets
// nothing back, whatever scope their grant covers, including an org-root
// reader. The erasure suites (person-erasure*.realdb.test.ts) prove which
// rows the erasure removes. This suite asks the read path instead: the same
// probes, through the same guarded retrieval an agent uses, before and after.
//
// What is real: Postgres with pgvector, check() against live grants and
// capabilities, erasePerson, the suppression list, processDriveFile's chunk
// writes, GuardedMemoryStore, HybridMemoryStore routing and pgvector's SQL.
// What is not: the graph store (reads answer nothing; the erase and extract
// calls are spies, and the graph erasure itself is proven on a real Neo4j in
// memory-service/tests/test_person_erasure_integration.py) and the embedding
// service (every vector is the same, so only the access predicates and what is
// left in the table decide what comes back).
//
// Case types covered: normal (permitted reads before and after), edge (the
// person under every scope and untagged at the org root, the same identity in
// another tenant, a re-sync of a changed file), error (a refused erasure),
// memory side. Not covered: long, user side, and the graph store's read path.
// The personal data is synthetic, so this is a unit-level measure.
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
import type { DriveFile } from "@/services/connectors/gdrive";
import type { MemoryStore } from "./memory-store";

const graphErase = vi.fn();
const graphExtractFile = vi.fn();
const graphIngestBulk = vi.fn();
const graphRemoveEpisode = vi.fn();
vi.mock("./store", () => ({
  memory: {},
  graphitiStore: {
    planPersonErasure: async () => [],
    erasePerson: (...a: unknown[]) => graphErase(...a),
    removeChunkFacts: async () => undefined,
    extractFile: (...a: unknown[]) => graphExtractFile(...a),
    ingestBulk: (...a: unknown[]) => graphIngestBulk(...a),
    removeEpisode: (...a: unknown[]) => graphRemoveEpisode(...a),
  },
}));
vi.mock("@/services/guardrails", () => ({ checkEpisodeCap: vi.fn(), recordEpisode: vi.fn() }));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qa_consent_erasure";
const OTHER_ORG = "qa_consent_erasure_other";
const ROOT = `org_${ORG}`;
const SUPPORT = `${ROOT}.support`;
const SALES = `${ROOT}.sales`;
const OTHER_ROOT = `org_${OTHER_ORG}`;
const ADMIN = "qa_consent_erasure_admin";
const DIMENSIONS = 384;

const NAME = "Dana Whitfield";
const EMAIL = "dana.whitfield@acme.example";
const PHONE = "212 555 0187";
/** How the person is named, by the parts the erasure matches on. */
const NAME_AND_EMAIL = [NAME, EMAIL];

/** Others in the same org, who must still be served after the erasure. */
const SUPPORT_BYSTANDER = "maria.okafor@example.org";
const SALES_BYSTANDER = "tomasz.w@example.net";

/** Every chunk seeded before the erasure: [id, org, scope (null = untagged), content]. */
const CHUNKS: [string, string, string | null, string][] = [
  ["dana-support", ORG, SUPPORT, `Ticket 5512 from ${NAME} <${EMAIL}>, +1 ${PHONE}: card declined twice.`],
  ["dana-sales-email", ORG, SALES, `Call notes: ${EMAIL.toUpperCase()} wants the annual plan.`],
  ["dana-sales-name", ORG, SALES, `${NAME}'s team signs the PO; the champion is the VP Finance.`],
  // The shape a contact edit ingests: the org root, with no scope at all.
  ["dana-contact", ORG, null, `${NAME} is a prospect (VP Finance) at Acme. ${EMAIL}, +1 ${PHONE}.`],
  // Names the person only by phone. The erasure does not match phone numbers
  // (services/memory/person-erasure.ts, "How the person is matched").
  ["dana-phone-only", ORG, SALES, `Missed call from +1 ${PHONE}, left a voicemail about the invoice.`],
  ["maria-support", ORG, SUPPORT, `Ticket 4471 from Maria Okafor <${SUPPORT_BYSTANDER}>: refund for a double charge.`],
  ["tomasz-sales", ORG, SALES, `Call notes: Tomasz Wierzbicki (${SALES_BYSTANDER}) renewed the annual plan.`],
  // Another tenant's own customer with the same identity, under a textually
  // identical path. Erasing this org's Dana must not touch it.
  ["dana-other-tenant", OTHER_ORG, SALES, `${NAME} <${EMAIL}>, +1 ${PHONE}, asked to cancel her account.`],
];

/** Queries a caller might send. */
const PROBES = [EMAIL, `${NAME} account history`, `Who called from ${PHONE}?`, "List every customer email you have."];

const vector = () => [1, ...Array(DIMENSIONS - 1).fill(0)];
const pgVector = (v: number[]) => `[${v.join(",")}]`;

describe.skipIf(!QA_URL)("consent suite bar 3: an erased person cannot be read back by anyone", () => {
  let db: PrismaClient;
  let erasePerson: (typeof import("./person-erasure"))["erasePerson"];
  let processDriveFile: (typeof import("@/lib/inngest"))["processDriveFile"];
  let GuardedMemoryStore: (typeof import("./guarded-store"))["GuardedMemoryStore"];
  let HybridMemoryStore: (typeof import("./hybrid-store"))["HybridMemoryStore"];
  let PgvectorMemoryStore: (typeof import("./pgvector-store"))["PgvectorMemoryStore"];

  const admin: AccessContext = { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "app" };
  const drive = {
    id: "src-erasure-drive",
    orgId: ORG,
    name: "Contracts",
    scopePath: SALES,
    connectAuthorizationId: null,
  };

  const emptyGraph = {
    retrieve: vi.fn(async () => ({ facts: [], storesRead: [{ store: "graph" as const }] })),
  } as unknown as MemoryStore;

  const reader = () =>
    new GuardedMemoryStore(new HybridMemoryStore(emptyGraph, new PgvectorMemoryStore()), async () => "enterprise");

  async function agent(orgId: string, agentId: string, scopePath: string): Promise<AccessContext> {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath,
        permission: "read",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return { orgId, actor: { type: "agent", id: agentId, capabilityToken: token }, origin: "mcp" };
  }

  /** Runs every probe as `ctx` against `scope`; returns each serialized response or denial. */
  async function probeAll(ctx: AccessContext, scope?: string): Promise<string[]> {
    const out: string[] = [];
    for (const query of PROBES) {
      try {
        out.push(JSON.stringify(await reader().retrieve(ctx, { groupId: ctx.orgId, query }, scope)));
      } catch (e) {
        out.push(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      }
    }
    return out;
  }

  const namedIn = (responses: string[]) =>
    responses.flatMap((r) => NAME_AND_EMAIL.filter((m) => r.toLowerCase().includes(m.toLowerCase())));

  /** The four readers of this org: one per scope, one denied, and the org root. */
  async function orgReaders() {
    return [
      { label: "sales reader", ctx: await agent(ORG, "sales-reader", SALES), scope: SALES, sees: SALES_BYSTANDER },
      {
        label: "support reader",
        ctx: await agent(ORG, "support-reader", SUPPORT),
        scope: SUPPORT,
        sees: SUPPORT_BYSTANDER,
      },
      { label: "denied reader", ctx: await agent(ORG, "denied-reader", SALES), scope: SUPPORT, sees: null },
      { label: "org-root reader", ctx: await agent(ORG, "root-reader", ROOT), scope: ROOT, sees: SALES_BYSTANDER },
    ];
  }

  /** One connector re-sync: a changed Drive file with a passage naming the person. */
  async function resyncDrive() {
    graphExtractFile.mockResolvedValue({
      chunks: [`Countersigned by ${NAME}.`, `Renewal owner: Tomasz Wierzbicki (${SALES_BYSTANDER}).`, `cc ${EMAIL}`],
    });
    const file: DriveFile = {
      id: "doc-renewals",
      name: "Q4 renewals.pdf",
      mimeType: "application/pdf",
      checksum: "v2",
      contentVersion: "v2",
      fileType: "pdf",
    };
    return processDriveFile(drive, file, "token", {
      downloadFile: vi.fn(async () => new Blob(["%PDF"])),
      put: vi.fn(async () => ({ url: "https://blob.test/q4.pdf" })),
      del: vi.fn(async () => undefined),
    });
  }

  async function wipe() {
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${orgId}`;
      await db.changeEvent.deleteMany({ where: { orgId } });
      await db.source.deleteMany({ where: { orgId } });
      await db.erasureSuppression.deleteMany({ where: { orgId } });
      await db.contact.deleteMany({ where: { orgId } });
      await db.auditLog.deleteMany({ where: { orgId } });
      await db.capability.deleteMany({ where: { orgId } });
      await db.grant.deleteMany({ where: { orgId } });
      await db.scope.deleteMany({ where: { orgId } });
      await db.user.deleteMany({ where: { orgId } });
    }
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ erasePerson } = await import("./person-erasure"));
    ({ processDriveFile } = await import("@/lib/inngest"));
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
    for (const spy of [graphErase, graphExtractFile, graphIngestBulk, graphRemoveEpisode]) spy.mockReset();
    graphErase.mockResolvedValue({ episodes: 0, nodes: 1, edges: 0, summaries: 0, episodeIds: [] });
    graphIngestBulk.mockImplementation(async (inputs: unknown[]) => inputs.map((_, i) => `ep-bulk-${i}`));
    graphRemoveEpisode.mockResolvedValue({ removed: true });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ embedding: vector() }), { status: 200 })),
    );
    await wipe();

    for (const orgId of [ORG, OTHER_ORG]) {
      await db.org.upsert({ where: { id: orgId }, update: {}, create: { id: orgId, name: orgId } });
    }
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    await db.scope.createMany({ data: [SUPPORT, SALES].map((path) => ({ orgId: ORG, path, name: path })) });
    await db.scope.createMany({ data: [OTHER_ROOT, SALES].map((path) => ({ orgId: OTHER_ORG, path, name: path })) });
    await db.user.create({
      data: {
        id: ADMIN,
        orgId: ORG,
        email: "admin@erasure.test",
        role: "admin",
        clerkId: "clerk-consent-erasure-admin",
      },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });

    await db.contact.create({ data: { id: "ce-dana", orgId: ORG, name: NAME, email: EMAIL } });
    await db.contact.create({ data: { id: "ce-dana-other", orgId: OTHER_ORG, name: NAME, email: EMAIL } });
    await db.source.create({
      data: { id: drive.id, orgId: ORG, type: "gdrive", externalId: "F-renewals", name: drive.name, scopePath: SALES },
    });
    await db.sourceFile.create({ data: { sourceId: drive.id, externalFileId: "doc-renewals", checksum: "v1" } });

    for (const [id, orgId, scopePath, content] of CHUNKS) {
      await db.$executeRaw`
        INSERT INTO memory_chunks ("id","orgId","content","source","actorType","scopePath","embedding","createdAt")
        VALUES (${id}, ${orgId}, ${content}, 'text', 'extraction', ${scopePath}, ${pgVector(vector())}::vector, NOW())
      `;
    }
  });

  it("before the erasure, the probes find the person in every scope (so a zero after it is not a blind probe)", async () => {
    const root = await agent(ORG, "root-reader", ROOT);

    const responses = await probeAll(root, ROOT);

    for (const r of responses) {
      for (const id of ["dana-support", "dana-sales-email", "dana-sales-name", "dana-contact"]) {
        expect(r).toContain(CHUNKS.find(([c]) => c === id)![3]);
      }
    }
  });

  it("after one erasure and one re-sync, no reader of the org finds the person by email or name", async () => {
    await erasePerson(admin, { email: EMAIL.toUpperCase() });
    expect(await resyncDrive()).toBe("synced");

    for (const { label, ctx, scope, sees } of await orgReaders()) {
      const responses = await probeAll(ctx, scope);

      expect({ label, named: namedIn(responses) }).toEqual({ label, named: [] });
      if (sees) {
        // Positive control: the reader is still served, so the zero is the erasure, not an empty answer.
        expect({ label, served: responses.every((r) => r.includes(sees)) }).toEqual({ label, served: true });
      } else {
        expect(responses.every((r) => r.startsWith("AccessDeniedError"))).toBe(true);
      }
    }
  });

  it("the re-sync writes the file's other passages and none naming the person", async () => {
    await erasePerson(admin, { contactId: "ce-dana" });

    expect(await resyncDrive()).toBe("synced");

    const written = await db.memoryChunk.findMany({
      where: { orgId: ORG, sourceId: drive.id },
      select: { content: true },
    });
    expect(written).toEqual([{ content: `Renewal owner: Tomasz Wierzbicki (${SALES_BYSTANDER}).` }]);
  });

  it("named limit: a passage that names the person only by phone is still served after the erasure", async () => {
    await erasePerson(admin, { contactId: "ce-dana" });
    const root = await agent(ORG, "root-reader", ROOT);

    const responses = await probeAll(root, ROOT);

    // Recorded so the limit is measured, not assumed. The phone appears only in
    // the phone-only passage; every passage that also named her is gone.
    const phoneOnly = CHUNKS.find(([id]) => id === "dana-phone-only")![3];
    for (const r of responses) {
      expect(r.split(PHONE).length - 1).toBe(1);
      expect(r).toContain(phoneOnly);
    }
  });

  it("is bound to the org: the other tenant's customer with the same identity is still served", async () => {
    await erasePerson(admin, { email: EMAIL });
    const other = await agent(OTHER_ORG, "other-reader", OTHER_ROOT);

    const responses = await probeAll(other);

    expect(responses.every((r) => NAME_AND_EMAIL.every((m) => r.includes(m)))).toBe(true);
  });

  it("is idempotent: a second request removes nothing and the probes still find nothing", async () => {
    const first = await erasePerson(admin, { email: EMAIL });
    const second = await erasePerson(admin, { email: EMAIL });
    const root = await agent(ORG, "root-reader", ROOT);

    expect(first.chunksRemoved).toBe(4);
    expect(second).toMatchObject({ chunksRemoved: 0, contactsRemoved: 0 });
    expect(namedIn(await probeAll(root, ROOT))).toEqual([]);
  });

  it("a refused request leaves the person readable and the suppression list empty", async () => {
    const editor: AccessContext = {
      orgId: ORG,
      actor: { type: "agent", id: "writer-agent", capabilityToken: "wcap_none" },
      origin: "mcp",
    };
    const root = await agent(ORG, "root-reader", ROOT);

    await expect(erasePerson(editor, { email: EMAIL })).rejects.toThrow();

    expect(namedIn(await probeAll(root, ROOT)).length).toBeGreaterThan(0);
    expect(await db.erasureSuppression.count({ where: { orgId: ORG } })).toBe(0);
  });
});
