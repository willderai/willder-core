// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The import's second line of defence and its edges in time (services/memory/org-import.ts):
//  - a person erased, added again and erased again: a brief written between the two
//    erasures, in an export taken before the second, stays out, because the second erasure
//    moves the time the name is suppressed from (erasure-suppression.ts, recordSuppressions);
//  - an erasure the import's first filter did not see (one recorded after the filter was
//    loaded) is caught by re-applying the org's erasures once the import is written;
//  - when that re-apply fails, the import is undone and says so, rather than landing
//    unchecked or failing as an unexplained error.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";
import { seedMember } from "@/services/access/member.testsupport";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

vi.mock("./store", () => ({
  memory: {},
  graphitiStore: {
    removeGroupFacts: async () => ({ removedCount: 0 }),
    planPersonErasure: async () => [],
    erasePerson: async () => ({ episodes: 0, nodes: 0, edges: 0, summaries: 0, episodeIds: [] }),
    removeChunkFacts: async () => undefined,
  },
}));

// Each a pass-through to the real function, so a test can replace one call.
vi.mock("./erasure-suppression", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./erasure-suppression")>();
  return { ...actual, loadErasedContentFilter: vi.fn(actual.loadErasedContentFilter) };
});
vi.mock("./erasure-reapply", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./erasure-reapply")>();
  return { ...actual, reapplyErasures: vi.fn(actual.reapplyErasures) };
});

const QA_URL = process.env.QA_DATABASE_URL;

// Alphanumeric, so orgRootPath(id) is a valid ltree label.
const ORG = "qaimportreapply";
const ROOT = `org_${ORG}`;
const ADMIN = "u-qa-import-reapply";
const NAME = "Orla Brennick";
const EMAIL = "orla@reapply.example";
const DIMENSIONS = 384;

function embed(text: string): number[] {
  const vector: number[] = [];
  for (let block = 0; vector.length < DIMENSIONS; block++) {
    for (const byte of createHash("sha256").update(`${block}:${text}`).digest()) vector.push(byte / 255 - 0.5);
  }
  const unit = vector.slice(0, DIMENSIONS);
  const norm = Math.hypot(...unit);
  return unit.map((x) => x / norm);
}

async function embeddingService(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const path = new URL(String(url instanceof Request ? url.url : url)).pathname;
  const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string; texts?: string[] };
  if (path === "/embed") return Response.json({ embedding: embed(body.text ?? "") });
  if (path === "/embed-batch") return Response.json({ embeddings: (body.texts ?? []).map(embed) });
  return new Response("not found", { status: 404 });
}

const admin: AccessContext = { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "app" };
const tick = () => new Promise((r) => setTimeout(r, 20));

describe.skipIf(!QA_URL)("the import's re-apply pass and repeated erasures, real Postgres", () => {
  let db: PrismaClient;
  let exportMemory: (typeof import("./org-export"))["exportMemory"];
  let importMemory: (typeof import("./org-import"))["importMemory"];
  let ImportIncompleteError: (typeof import("./org-import"))["ImportIncompleteError"];
  let erasePerson: (typeof import("./person-erasure"))["erasePerson"];
  let suppression: typeof import("./erasure-suppression");
  let reapply: typeof import("./erasure-reapply");

  async function collect(): Promise<string[]> {
    const lines: string[] = [];
    for await (const line of exportMemory(admin)) lines.push(line.trimEnd());
    return lines;
  }
  async function* stream(lines: string[]) {
    yield* lines;
  }

  async function clearMemory() {
    await db.factEdge.deleteMany({ where: { orgId: ORG } });
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
    await db.convention.deleteMany({ where: { orgId: ORG } });
    await db.workingNote.deleteMany({ where: { orgId: ORG } });
    await db.brief.deleteMany({ where: { orgId: ORG } });
    await db.source.deleteMany({ where: { orgId: ORG } });
  }

  async function addFact(id: string, content: string) {
    await db.$executeRaw`
      INSERT INTO memory_chunks (id, "orgId", content, source, "actorType", "actorId", "scopePath", "factVersion", embedding)
      VALUES (${id}, ${ORG}, ${content}, 'text', 'agent', 'agent-1', ${ROOT}, false, ${`[${embed(content).join(",")}]`}::vector)`;
  }

  async function addContact(id: string) {
    await db.contact.create({ data: { id, orgId: ORG, name: NAME, email: EMAIL } });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    vi.stubGlobal("fetch", vi.fn(embeddingService));
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ exportMemory } = await import("./org-export"));
    ({ importMemory, ImportIncompleteError } = await import("./org-import"));
    ({ erasePerson } = await import("./person-erasure"));
    suppression = await import("./erasure-suppression");
    reapply = await import("./erasure-reapply");
  });

  beforeEach(async () => {
    await clearMemory();
    await db.contact.deleteMany({ where: { orgId: ORG } });
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.erasureSuppression.deleteMany({ where: { orgId: ORG } });
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.user.deleteMany({ where: { id: ADMIN } });
    await db.org.create({ data: { id: ORG, name: ORG } });
    await seedMember(db, { orgId: ORG, userId: ADMIN, role: "admin" });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (!db) return;
    await clearMemory();
    await db.contact.deleteMany({ where: { orgId: ORG } });
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.erasureSuppression.deleteMany({ where: { orgId: ORG } });
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.user.deleteMany({ where: { id: ADMIN } });
    await db.$disconnect();
  });

  it("erased, added again and erased again: a brief and note from between the two erasures stay out", async () => {
    await addContact("orla-1");
    await erasePerson(admin, { contactId: "orla-1" });
    await tick();
    // Added again after the first erasure: deliberate, and served until the second.
    await addContact("orla-2");
    await db.brief.create({
      data: {
        orgId: ORG,
        type: "handoff",
        scopePath: ROOT,
        title: "Renewal",
        summary: `${NAME} owns the renewal.`,
        sections: [],
      },
    });
    await db.workingNote.create({
      data: {
        orgId: ORG,
        scopePath: ROOT,
        agentId: "agent-1",
        task: "acme",
        kind: "status",
        body: `Waiting on ${NAME}.`,
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    const between = await collect();
    expect(between.join("\n")).toContain(NAME);
    await tick();
    await erasePerson(admin, { contactId: "orla-2" });
    await clearMemory();

    const receipt = await importMemory(admin, stream(between));

    expect(receipt.erased).toMatchObject({ brief: 1, working_note: 1 });
    expect(await db.brief.count({ where: { orgId: ORG } })).toBe(0);
    expect(await db.workingNote.count({ where: { orgId: ORG } })).toBe(0);
  }, 30_000);

  it("keeps a contact id's first suppression time, which a retried erasure counts its steps from", async () => {
    await addContact("orla-1");
    await erasePerson(admin, { contactId: "orla-1" });
    const first = await suppression.firstSuppressedAt(ORG, ["orla-1"]);
    await tick();
    await suppression.recordSuppressions(db, ORG, "retry", { emails: [EMAIL], names: [NAME], contactIds: ["orla-1"] });
    expect(await suppression.firstSuppressedAt(ORG, ["orla-1"])).toEqual(first);
  });

  it("re-applies the org's erasures after writing, catching what the first filter did not see", async () => {
    await addFact("f-named", `${NAME} owns the Acme renewal.`);
    const before = await collect();
    await tick();
    await addContact("orla");
    await erasePerson(admin, { contactId: "orla" });
    await clearMemory();
    // As though the erasure was recorded only after the import loaded its filter.
    const actual = await vi.importActual<typeof import("./erasure-suppression")>("./erasure-suppression");
    vi.mocked(suppression.loadErasedContentFilter).mockImplementationOnce(async () =>
      actual.loadErasedContentFilter("no-such-org"),
    );

    const receipt = await importMemory(admin, stream(before));

    expect(receipt.imported.fact).toBe(1);
    expect(receipt.erased.fact).toBe(0);
    expect(receipt.erasuresReapplied.chunksRemoved).toBe(1);
    expect(await db.memoryChunk.count({ where: { orgId: ORG } })).toBe(0);
  }, 30_000);

  it("undoes the import when the re-apply fails, and says the file is fine", async () => {
    await addFact("f-kept", "Acme renews in March.");
    const before = await collect();
    await clearMemory();
    vi.mocked(reapply.reapplyErasures).mockRejectedValueOnce(new Error("memory service unavailable"));

    const failed = importMemory(admin, stream(before));

    await expect(failed).rejects.toBeInstanceOf(ImportIncompleteError);
    await expect(failed).rejects.toThrow(/import it again/);
    expect(await db.memoryChunk.count({ where: { orgId: ORG } })).toBe(0);
  }, 30_000);
});
