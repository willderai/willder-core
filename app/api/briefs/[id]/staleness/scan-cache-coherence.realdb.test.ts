// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// [tests-only] The staleness route's contradiction cache (services/facts/scope-scan-cache.ts)
// must not serve fact text that the store no longer holds.
//
// The cache is keyed on briefId and validated by scanFingerprint() (it was changesFingerprint(changes) when this test was written), where
// `changes` is auditChangesUnderScope()'s answer (services/access/check.ts:1175-1202):
//   - it reads only `memory.write.applied` / `memory.delete.applied` rows, and a person
//     erasure writes neither (it writes `person.erasure_step` / `person.erased`), so an
//     erasure leaves the fingerprint unchanged;
//   - it is `ORDER BY "at" ASC LIMIT 20` (MAX_CHANGES, route.ts:89), so once a brief has 20
//     changes no later write or delete changes the fingerprint.
// Either way the cached factA/factB text is served for the life of the process.
//
// Real: Postgres, check(), authorizeBrief, checkBriefStaleness, auditChangesUnderScope,
// recordAppliedChange, erasePerson, the route itself. Stand-ins: the signed-in session
// (requireAccessContext), the graph store the erasure calls, and findScopeContradictions
// (a paid LLM call), which answers from `graphFacts` below as the graph would now: it is
// the source of truth the cache is supposed to stay coherent with.
//
// Written to fail before the fix it covers.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "qa_scan_cache";
const ROOT = `org_${ORG}`;
const SALES = `${ROOT}.sales`;
const ADMIN = "qa_scan_cache_admin";
const NAME = "Mara Quell";
const EMAIL = "mara.quell@scan-cache.example";
const DIMENSIONS = 384;

/** What the graph currently holds as contradicting pairs; findScopeContradictions answers from it. */
let graphFacts: { factA: string; factB: string; note: string }[] = [];

const ctxRef: { ctx: AccessContext | null } = { ctx: null };
vi.mock("@/lib/access-context", () => ({
  requireAccessContext: async () => (ctxRef.ctx ? { ctx: ctxRef.ctx, org: { id: ORG }, user: { id: ADMIN } } : null),
}));
vi.mock("@/services/facts/conflicts", () => ({
  findScopeContradictions: vi.fn(async () => graphFacts.map((f) => ({ ...f }))),
}));
// removeUpload() deletes the removed file's blob; there is no blob store here.
vi.mock("@/lib/blob-storage", () => ({ deletePrivateBlob: async () => undefined, readPrivateBlob: async () => null }));
vi.mock("@/services/memory/scope-dispute-scan", () => ({ fileSameTierScopeDisputes: async () => [] }));
vi.mock("@/services/memory/store", () => ({
  memory: { ingest: vi.fn() },
  graphitiStore: {
    planPersonErasure: async () => [],
    erasePerson: async () => ({ episodes: 0, nodes: 0, edges: 0, summaries: 0, episodeIds: [] }),
    removeChunkFacts: async () => undefined,
    removeEpisode: async () => ({ removed: true }),
    removeGroupFacts: async () => ({ removedCount: 1 }),
  },
}));

const vector = `[${[1, ...Array(DIMENSIONS - 1).fill(0)].join(",")}]`;

describe.skipIf(!QA_URL)("staleness contradiction cache stays coherent with the store", () => {
  let db: PrismaClient;
  let GET: (typeof import("./route"))["GET"];
  let erasePerson: (typeof import("@/services/memory/person-erasure"))["erasePerson"];
  let recordAppliedChange: (typeof import("@/services/access"))["recordAppliedChange"];
  let removeUpload: (typeof import("@/services/memory/uploads"))["removeUpload"];
  let scanMock: ReturnType<typeof vi.fn>;
  let briefId: string;
  const admin: AccessContext = { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "app" };
  const longAgo = new Date(Date.now() - 24 * 3600 * 1000);

  async function wipe() {
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
    await db.uploadedFile.deleteMany({ where: { orgId: ORG } });
    await db.brief.deleteMany({ where: { orgId: ORG } });
    await db.sourceFile.deleteMany({ where: { source: { orgId: ORG } } });
    await db.briefRetirement.deleteMany({ where: { brief: { orgId: ORG } } });
    await db.source.deleteMany({ where: { orgId: ORG } });
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.erasureSuppression.deleteMany({ where: { orgId: ORG } });
    await db.contact.deleteMany({ where: { orgId: ORG } });
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.grant.deleteMany({ where: { orgId: ORG } });
    await db.scope.deleteMany({ where: { orgId: ORG } });
    await db.user.deleteMany({ where: { orgId: ORG } });
  }

  const applied = (action: "memory.write" | "memory.delete", tag: string) =>
    recordAppliedChange({
      orgId: ORG,
      actorType: "human",
      actorId: ADMIN,
      action,
      scopePath: SALES,
      tag,
      origin: "app",
    });

  async function contradictions(): Promise<{ factA: string; factB: string }[]> {
    const res = await GET(new Request("http://t"), { params: Promise.resolve({ id: briefId }) });
    expect(res.status).toBe(200);
    return ((await res.json()) as { contradictions: { factA: string; factB: string }[] }).contradictions;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ GET } = await import("./route"));
    ({ erasePerson } = await import("@/services/memory/person-erasure"));
    ({ recordAppliedChange } = await import("@/services/access"));
    ({ removeUpload } = await import("@/services/memory/uploads"));
    scanMock = vi.mocked((await import("@/services/facts/conflicts")).findScopeContradictions) as unknown as ReturnType<
      typeof vi.fn
    >;
  });

  afterAll(async () => {
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await wipe();
    ctxRef.ctx = admin;
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    await db.scope.create({ data: { orgId: ORG, path: SALES, name: "sales" } });
    await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: "admin@scan-cache.test", role: "admin", clerkId: "clerk-scan-cache" },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    // A fresh brief id per test: the cache is per process and keyed on briefId.
    const brief = await db.brief.create({
      data: {
        orgId: ORG,
        type: "handoff",
        scopePath: SALES,
        title: "Renewal handoff",
        summary: "Renewal status",
        sections: [],
        createdAt: longAgo,
      },
    });
    briefId = brief.id;
  });

  it("(a) after a person erasure, the next GET in the same process no longer serves text naming the erased person", async () => {
    await db.contact.create({ data: { id: "mara", orgId: ORG, name: NAME, email: EMAIL, createdAt: longAgo } });
    await db.$executeRaw`
      INSERT INTO memory_chunks ("id","orgId","content","source","actorType","actorId","scopePath","embedding","createdAt")
      VALUES ('chunk-mara', ${ORG}, ${`${NAME} signs the renewal at 160k.`}, 'text', 'human', ${ADMIN}, ${SALES}, ${vector}::vector, now())`;
    await applied("memory.write", "fact:chunk-mara");
    graphFacts = [
      { factA: `${NAME} signs the renewal at 160k.`, factB: `${NAME} refuses any renewal above 120k.`, note: "price" },
    ];

    const before = await contradictions();
    expect(before.map((c) => c.factA)).toEqual([`${NAME} signs the renewal at 160k.`]);

    await erasePerson(admin, { email: EMAIL });
    // The erasure did its job on the store; the graph no longer holds her facts either.
    expect(await db.memoryChunk.count({ where: { orgId: ORG, id: "chunk-mara" } })).toBe(0);
    graphFacts = [];

    const after = await contradictions();
    expect(JSON.stringify(after)).not.toContain(NAME);
  });

  it("(b) a 21st change to a brief that already has 20 (here: deleting a fact) invalidates the cached scan", async () => {
    for (let i = 0; i < 20; i++) await applied("memory.write", `fact:filler-${i}`);
    graphFacts = [{ factA: "The floor price is 160k.", factB: "The floor price is 120k.", note: "price" }];

    const before = await contradictions();
    expect(before).toHaveLength(1);

    // The 120k fact is deleted: a real, applied delete under the brief's scope.
    await applied("memory.delete", "fact:floor-120k");
    graphFacts = [];

    const after = await contradictions();
    expect(JSON.stringify(after)).not.toContain("120k");
  });

  it("control: under 20 changes, a new applied delete does invalidate the cache", async () => {
    await applied("memory.write", "fact:one");
    graphFacts = [{ factA: "The floor price is 160k.", factB: "The floor price is 120k.", note: "price" }];
    expect(await contradictions()).toHaveLength(1);

    await applied("memory.delete", "fact:floor-120k");
    graphFacts = [];
    expect(await contradictions()).toEqual([]);
  });

  // Added with the fix: an uploaded file removed by its owner is the same leak
  // class. removeUpload() deletes the file's passages, so the scan must not keep serving them.
  it("(c) after an uploaded file is removed, the next GET no longer serves text from it", async () => {
    await db.uploadedFile.create({
      data: {
        id: "upload-terms",
        orgId: ORG,
        scopePath: SALES,
        filename: "terms.pdf",
        fileType: "pdf",
        blobUrl: "blob://qa_scan_cache/terms",
        actorId: ADMIN,
      },
    });
    await db.$executeRaw`
      INSERT INTO memory_chunks ("id","orgId","content","source","actorType","actorId","scopePath","uploadId","embedding","createdAt")
      VALUES ('chunk-terms', ${ORG}, 'Payment terms are net 90.', 'file', 'human', ${ADMIN}, ${SALES}, 'upload-terms', ${vector}::vector, now())`;
    await applied("memory.write", "fact:chunk-terms");
    graphFacts = [{ factA: "Payment terms are net 30.", factB: "Payment terms are net 90.", note: "terms" }];
    expect(await contradictions()).toHaveLength(1);

    expect(await removeUpload(admin, "upload-terms")).toMatchObject({ removed: true, passages: 1 });
    expect(await db.memoryChunk.count({ where: { orgId: ORG, uploadId: "upload-terms" } })).toBe(0);
    graphFacts = [];

    expect(JSON.stringify(await contradictions())).not.toContain("net 90");
  });

  // A documented limit, not a guarantee: the stamp is read before the scan runs, so a scan
  // already in flight when a removal commits still returns what it found, once, to that
  // one caller. Its result is cached under the old stamp, so the very next read misses.
  it("limit: a scan in flight when a removal commits returns its result once; the very next read misses", async () => {
    await applied("memory.write", "fact:one");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    graphFacts = [{ factA: "The floor price is 160k.", factB: "The floor price is 120k.", note: "price" }];
    const before = scanMock.mock.calls.length;
    scanMock.mockImplementationOnce(async () => {
      await gate;
      return [{ factA: "The floor price is 160k.", factB: "The floor price is 120k.", note: "price" }];
    });

    const inFlight = contradictions();
    await vi.waitFor(() => expect(scanMock.mock.calls.length).toBe(before + 1));
    // The removal commits while the scan is still running.
    await applied("memory.delete", "fact:floor-120k");
    graphFacts = [];
    release();

    expect(JSON.stringify(await inFlight)).toContain("120k");
    expect(JSON.stringify(await contradictions())).not.toContain("120k");
    expect(scanMock.mock.calls.length).toBe(before + 2);
  });

  // From QA: a disconnect
  // removes the source's facts from the graph and writes no removal row.
  it("QA (d): after a source is disconnected, the next GET no longer serves text from it", async () => {
    // The brief predates the source (createdAt longAgo), so retireBriefsFedBySource leaves it readable.
    const source = await db.source.create({
      data: { orgId: ORG, type: "website", externalId: "acme.example", name: "acme", scopePath: SALES },
    });
    await applied("memory.write", "fact:site-1");
    graphFacts = [
      { factA: "Support hours are 9-5.", factB: "Support hours are 24/7 per acme.example.", note: "hours" },
    ];
    expect(await contradictions()).toHaveLength(1);

    const { DELETE } = await import("@/app/api/sources/[id]/route");
    const res = await DELETE(new Request("http://t", { method: "DELETE" }), {
      params: Promise.resolve({ id: source.id }),
    });
    expect(res.status).toBe(200);
    graphFacts = [];

    expect(JSON.stringify(await contradictions())).not.toContain("24/7");
  });

  // The late-retire paths: a connector or file ingest that finds, after its last write,
  // that its source or passage was removed meanwhile, and retires what it wrote. Graph
  // only, or graph then chunks, with no removal row of their own.
  it("(e) a late retire of a disconnected source's write invalidates the cached scan", async () => {
    const source = await db.source.create({
      data: { orgId: ORG, type: "website", externalId: "late.example", name: "late", scopePath: SALES },
    });
    await applied("memory.write", "fact:late-1");
    graphFacts = [{ factA: "SLA is 4h.", factB: "SLA is 1h per late.example.", note: "sla" }];
    expect(await contradictions()).toHaveLength(1);

    const { retireLateSourceWrite } = await import("@/services/memory/source-retirement");
    await retireLateSourceWrite({ orgId: ORG, sourceId: source.id, scopePath: SALES });
    graphFacts = [];

    expect(JSON.stringify(await contradictions())).not.toContain("1h per late");
  });

  it("(f) retiring the graph episodes of a removed passage invalidates the cached scan", async () => {
    await applied("memory.write", "fact:passage-1");
    graphFacts = [{ factA: "Renewal date is May.", factB: "Renewal date is June per the deck.", note: "date" }];
    expect(await contradictions()).toHaveLength(1);

    const { retirePassageEpisodes } = await import("@/services/memory/uploads");
    await retirePassageEpisodes(ORG, [{ id: "chunk-gone", scopePath: SALES }]);
    graphFacts = [];

    expect(JSON.stringify(await contradictions())).not.toContain("June per the deck");
  });

  // One test per thing that moves the stamp, each the only one that moves it, so removing any
  // one trigger or bump turns a test red (found in QA).
  it("(g) a person erased while held only in the graph: the erasure's audit rows alone move the epoch", async () => {
    // No contact row and no chunk names her: nothing in Postgres is deleted.
    await applied("memory.write", "fact:graph-only");
    graphFacts = [{ factA: `${NAME} owns the renewal.`, factB: `${NAME} handed the renewal off.`, note: "owner" }];
    expect(await contradictions()).toHaveLength(1);

    await erasePerson(admin, { email: EMAIL });
    graphFacts = [];

    expect(JSON.stringify(await contradictions())).not.toContain(NAME);
  });

  it("(h) a connector delete announced on the change feed alone moves the epoch", async () => {
    await applied("memory.write", "fact:item-1");
    graphFacts = [{ factA: "Launch is Monday.", factB: "Launch is Friday per the channel.", note: "date" }];
    expect(await contradictions()).toHaveLength(1);

    const last = await db.changeEvent.aggregate({ where: { orgId: ORG }, _max: { seq: true } });
    await db.changeEvent.create({
      data: {
        orgId: ORG,
        seq: (last._max.seq ?? BigInt(0)) + BigInt(1),
        scopePath: SALES,
        recordType: "episode",
        recordId: "ep-1",
        op: "delete",
        actorId: "slack-sync:src-1",
        actorType: "agent",
        summary: "",
      },
    });
    graphFacts = [];

    expect(JSON.stringify(await contradictions())).not.toContain("per the channel");
  });

  it("(i) a chunk deleted with no audit row alone moves the epoch", async () => {
    await db.$executeRaw`
      INSERT INTO memory_chunks ("id","orgId","content","source","actorType","actorId","scopePath","embedding","createdAt")
      VALUES ('chunk-quiet', ${ORG}, 'The discount is 30%.', 'text', 'human', ${ADMIN}, ${SALES}, ${vector}::vector, now())`;
    await applied("memory.write", "fact:chunk-quiet");
    graphFacts = [{ factA: "The discount is 10%.", factB: "The discount is 30%.", note: "discount" }];
    expect(await contradictions()).toHaveLength(1);

    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG} AND id = 'chunk-quiet'`;
    graphFacts = [];

    expect(JSON.stringify(await contradictions())).not.toContain("30%");
  });

  it("(j) a chunk's text rewritten in place alone moves the epoch", async () => {
    await db.$executeRaw`
      INSERT INTO memory_chunks ("id","orgId","content","source","actorType","actorId","scopePath","embedding","createdAt")
      VALUES ('chunk-redact', ${ORG}, 'Call Mara on 555-0100.', 'text', 'human', ${ADMIN}, ${SALES}, ${vector}::vector, now())`;
    await applied("memory.write", "fact:chunk-redact");
    graphFacts = [{ factA: "Call Mara on 555-0100.", factB: "Call Mara on 555-0199.", note: "phone" }];
    expect(await contradictions()).toHaveLength(1);

    await db.$executeRaw`UPDATE memory_chunks SET content = 'Call [redacted].' WHERE "orgId" = ${ORG} AND id = 'chunk-redact'`;
    graphFacts = [];

    expect(JSON.stringify(await contradictions())).not.toContain("555-0100");
  });

  it("(k) an applied write alone moves the scope's change count: the next read re-scans", async () => {
    await applied("memory.write", "fact:first");
    graphFacts = [];
    expect(await contradictions()).toEqual([]);

    await applied("memory.write", "fact:second");
    graphFacts = [{ factA: "Owner is Ana.", factB: "Owner is Ben.", note: "owner" }];

    expect(await contradictions()).toHaveLength(1);
  });

  it("(l) removingFromGraph moves the epoch before the graph removal and again after it, also when it throws", async () => {
    const { removingFromGraph } = await import("@/services/access");
    const epoch = async () =>
      (
        await db.$queryRaw<{ e: bigint | null }[]>`SELECT "epoch" AS e FROM org_removal_epochs WHERE "orgId" = ${ORG}`
      )[0]?.e ?? BigInt(0);
    const start = await epoch();
    let during = BigInt(0);
    await removingFromGraph(ORG, async () => {
      during = await epoch();
    });
    expect(during).toBeGreaterThan(start);
    const done = await epoch();
    expect(done).toBeGreaterThan(during);

    await expect(
      removingFromGraph(ORG, async () => {
        throw new Error("graph down");
      }),
    ).rejects.toThrow("graph down");
    expect(await epoch()).toBe(done + BigInt(2));
  });
});
