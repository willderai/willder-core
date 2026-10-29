// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// GET /api/sources/:id/records against a real database: what a source's sync wrote is
// counted in every store, the counts reach zero once the real disconnect has run, and
// the answer is refused to anyone who cannot read every scope it names.
//
// The records come from the real Drive `sourceSync` job, the one connector that writes
// all three Postgres kinds (`memory_chunks` rows with embeddings, sync records, change
// events), and are removed by the real DELETE /api/sources/:id. Access is decided by the
// real check() against real grant rows, and every decision lands on the real audit log.
// Doubles stand in for the remote services only: Drive and Blob, the embedding endpoint,
// and the memory service's graph, which holds episodes by scope and source the way the
// real one's stamps do (its own counting runs against Neo4j in
// memory-service/tests/test_source_records_integration.py).
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never the sandbox's inherited
// DATABASE_URL, which points at live Neon. Skips cleanly without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { toGid } from "@/services/memory/graphiti-store";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { stubEmbeddingService } from "@/services/memory/embedding-service-double.testsupport";
import { seedMember } from "@/services/access/member.testsupport";

/** The memory service's graph: episodes keyed by scope, each stamped with its source. */
const graph = vi.hoisted(() => {
  const episodes: { id: string; scopePath: string; sourceId: string | undefined }[] = [];
  /** Records every count reports at a graph group as well, as a retirement that missed them would leave. */
  const leftBehind: { groupId: string; episodes: number }[] = [];
  /** The graph's key for a scope (graphiti-store.ts toGid). */
  const gid = (scopePath: string) => toGid(scopePath);
  let nextId = 0;
  let failCount = false;
  return {
    episodes,
    reset() {
      episodes.length = 0;
      leftBehind.length = 0;
      nextId = 0;
      failCount = false;
    },
    leave(groupId: string, count: number) {
      leftBehind.push({ groupId, episodes: count });
    },
    gid,
    failNextCount() {
      failCount = true;
    },
    store: {
      extractFile: async ({ url }: { url: string }) => ({ chunks: blobs.get(url)!.split("\n\n") }),
      ingestBulk: async (inputs: { scopePath?: string; groupId: string; sourceId?: string }[]) =>
        inputs.map((input) => {
          const id = `episode-${++nextId}`;
          episodes.push({ id, scopePath: input.scopePath ?? input.groupId, sourceId: input.sourceId });
          return id;
        }),
      removeEpisode: async ({ episodeId }: { episodeId: string }) => {
        const i = episodes.findIndex((e) => e.id === episodeId);
        if (i >= 0) episodes.splice(i, 1);
        return { removed: i >= 0 };
      },
      removeGroupFacts: async ({ groupId, sourceId }: { groupId: string; sourceId?: string }) => {
        const before = episodes.length;
        for (let i = episodes.length - 1; i >= 0; i--) {
          if (episodes[i].scopePath === groupId && episodes[i].sourceId === sourceId) episodes.splice(i, 1);
        }
        return { removedCount: before - episodes.length };
      },
      dedupeNodes: async () => 0,
      sourceRecords: async ({ sourceId, scopePaths }: { orgId: string; sourceId: string; scopePaths: string[] }) => {
        if (failCount) {
          const { MemoryServiceError } = await import("@/services/memory/graphiti-store");
          throw new MemoryServiceError("memory service /sources/records failed: Not Found", 404);
        }
        const counts = new Map(scopePaths.map((p) => [toGid(p), 0]));
        for (const e of episodes)
          if (e.sourceId === sourceId) counts.set(toGid(e.scopePath), (counts.get(toGid(e.scopePath)) ?? 0) + 1);
        for (const l of leftBehind) counts.set(l.groupId, (counts.get(l.groupId) ?? 0) + l.episodes);
        return [...counts].map(([groupId, n]) => ({
          groupId,
          episodes: n,
          facts: 0,
          factEmbeddings: 0,
          verbatimNodes: 0,
          orphans: 0,
          danglingFacts: 0,
        }));
      },
    },
  };
});
const blobs = vi.hoisted(() => new Map<string, string>());
const drive = vi.hoisted(() => ({ text: "" }));

// A gdrive sync event seals its client token; the job opens it.
vi.mock("@/lib/crypto", () => ({ unsealSecret: () => ({ token: "drive-token" }) }));
vi.mock("@/services/memory/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory/store")>()),
  graphitiStore: graph.store,
}));
vi.mock("@/services/connectors/gdrive", () => ({
  listFolderFiles: async () => [
    { id: "drive-file-1", name: "Roadmap.pdf", mimeType: "application/pdf", checksum: "v1", fileType: "pdf" },
  ],
  downloadFile: async () => new Blob([drive.text]),
}));
vi.mock("@vercel/blob", () => ({
  put: async (pathname: string, body: Buffer) => {
    const url = `https://blob.test/${pathname}`;
    blobs.set(url, body.toString());
    return { url };
  },
  del: async (url: string) => {
    blobs.delete(url);
  },
}));
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qasourcerecords";
const ROOT = `org_${ORG}`;
const SCOPE = `${ROOT}.eng`;
const OTHER_SCOPE = `${ROOT}.sales`;
/** A label with a dash: its graph group id reads like a path one level deeper. */
const DASHED_SCOPE = `${ROOT}.field-ops`;
const SOURCE_ID = "src-qa-source-records";
/** Admin of the org root: can disconnect, and read every scope. */
const ADMIN = "user-qa-records-admin";
/** Reads the source's scope only. */
const READER = "user-qa-records-reader";
/** Reads another scope only. */
const OUTSIDER = "user-qa-records-outsider";

type StepCtx = {
  event: { data: unknown };
  step: { run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T> };
};

type Counts = Record<string, number | string>;

/** The route's per-org limit on reads in one minute. */
const RECORDS_READS_PER_MINUTE = 120;

describe.skipIf(!QA_URL)("GET /api/sources/:id/records", () => {
  let db: PrismaClient;
  let inngestModule: typeof import("@/lib/inngest");
  let GET: (typeof import("./route"))["GET"];
  let DELETE: (typeof import("../route"))["DELETE"];
  let requireAccessContext: (typeof import("@/lib/access-context"))["requireAccessContext"];

  const as = (userId: string) =>
    vi.mocked(requireAccessContext).mockResolvedValue({
      org: { id: ORG },
      user: { id: userId },
      ctx: { orgId: ORG, actor: { type: "human", id: userId, role: "member" } },
    } as never);

  const records = async (userId: string, id = SOURCE_ID) => {
    as(userId);
    const res = await GET(new Request(`http://test/api/sources/${id}/records`), { params: Promise.resolve({ id }) });
    return { status: res.status, body: (await res.json()) as { scopes?: Counts[]; error?: string } };
  };

  const disconnect = async () => {
    as(ADMIN);
    return DELETE(new Request(`http://test/api/sources/${SOURCE_ID}`, { method: "DELETE" }), {
      params: Promise.resolve({ id: SOURCE_ID }),
    });
  };

  const runSync = () => {
    const ctx: StepCtx = {
      event: { data: { sourceId: SOURCE_ID, orgId: ORG, sealedToken: "sealed-drive-token" } },
      step: { run: async (_name, fn) => fn() },
    };
    return (inngestModule.sourceSync as unknown as { fn: (ctx: StepCtx) => Promise<unknown> }).fn(ctx);
  };

  const readRows = (userId: string) =>
    db.auditLog.findMany({
      where: { orgId: ORG, actorId: userId, action: "memory.read" },
      orderBy: { at: "asc" },
      select: { target: true, decision: true },
    });

  const zero = (scopePath: string) => ({
    scopePath,
    chunks: 0,
    chunkEmbeddings: 0,
    syncRecords: 0,
    feedSummaries: 0,
    episodes: 0,
    facts: 0,
    factEmbeddings: 0,
    verbatimNodes: 0,
    orphans: 0,
    danglingFacts: 0,
  });

  beforeAll(async () => {
    // Before the imports, so the `@/lib/db` singleton is built against the QA database,
    // and the embedding double is in place before the sync's first chunk write.
    process.env.DATABASE_URL = QA_URL;
    stubEmbeddingService();
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    inngestModule = await import("@/lib/inngest");
    ({ GET } = await import("./route"));
    ({ DELETE } = await import("../route"));
    ({ requireAccessContext } = await import("@/lib/access-context"));
  });

  afterAll(async () => {
    await db.org.deleteMany({ where: { id: ORG } });
    await db.$disconnect();
    vi.unstubAllGlobals();
  });

  beforeEach(async () => {
    graph.reset();
    blobs.clear();
    drive.text = "Launch is in March.\n\nOwner is Priya.";
    await db.org.deleteMany({ where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: ORG } });
    const scopes = [
      ["sc-qa-rec-root", ROOT],
      ["sc-qa-rec-eng", SCOPE],
      ["sc-qa-rec-sales", OTHER_SCOPE],
      ["sc-qa-rec-dashed", DASHED_SCOPE],
    ] as const;
    for (const [id, path] of scopes) await db.scope.create({ data: { id, orgId: ORG, path, name: id } });
    const grants = [
      [ADMIN, "sc-qa-rec-root", "admin"],
      [READER, "sc-qa-rec-eng", "read"],
      [OUTSIDER, "sc-qa-rec-sales", "read"],
    ] as const;
    for (const [user, scopeId, permission] of grants) {
      await seedMember(db, { orgId: ORG, userId: user });
      await db.grant.create({ data: { orgId: ORG, scopeId, granteeType: "user", granteeId: user, permission } });
    }
    await db.source.create({
      data: {
        id: SOURCE_ID,
        orgId: ORG,
        type: "gdrive",
        externalId: "folder-qa-records",
        name: "Eng Drive",
        scopePath: SCOPE,
      },
    });
  });

  it("counts what the sync wrote in every store, and nothing once the source is disconnected", async () => {
    await runSync();

    const before = await records(READER);
    expect(before.status).toBe(200);
    expect(before.body.scopes).toEqual([
      { ...zero(SCOPE), chunks: 2, chunkEmbeddings: 2, syncRecords: 1, feedSummaries: 2, episodes: 2 },
    ]);

    expect((await disconnect()).status).toBe(200);

    const after = await records(READER);
    expect(after.status).toBe(200);
    expect(after.body).toMatchObject({ sourceId: SOURCE_ID, status: "disconnected", scopes: [zero(SCOPE)] });
    // One decision per read, each on the audit trail.
    expect(await readRows(READER)).toEqual([
      { target: `${SCOPE}/sources:records:${SOURCE_ID}`, decision: "allow" },
      { target: `${SCOPE}/sources:records:${SOURCE_ID}`, decision: "allow" },
    ]);
  });

  it("answers a caller who cannot read the source's scope as it answers an id never issued", async () => {
    await runSync();

    const hidden = await records(OUTSIDER);
    const unknown = await records(OUTSIDER, "src-never-issued");

    expect(hidden).toEqual({ status: 404, body: { error: "source not found" } });
    expect(unknown).toEqual(hidden);
    // The never-issued id is decided too, at the org root, so it costs the same.
    expect(await readRows(OUTSIDER)).toEqual([
      { target: `${SCOPE}/sources:records:${SOURCE_ID}`, decision: "deny" },
      { target: `${ROOT}/sources:records:src-never-issued`, decision: "deny" },
    ]);
  });

  it("refuses the whole answer when records remain in a scope the caller cannot read, without naming it", async () => {
    await runSync();
    expect((await disconnect()).status).toBe(200);
    graph.leave(graph.gid(OTHER_SCOPE), 3);

    const reader = await records(READER);
    const admin = await records(ADMIN);

    expect(reader.status).toBe(403);
    expect(JSON.stringify(reader.body)).not.toContain("sales");
    expect(reader.body.scopes).toBeUndefined();
    expect(admin.status).toBe(200);
    expect(admin.body.scopes).toEqual([zero(SCOPE), { ...zero(OTHER_SCOPE), episodes: 3 }]);
    expect(await readRows(READER)).toEqual([
      { target: `${SCOPE}/sources:records:${SOURCE_ID}`, decision: "allow" },
      { target: `${OTHER_SCOPE}/sources:records:${SOURCE_ID}`, decision: "deny" },
    ]);
  });

  it("places graph records at the scope whose group they are in, and at the org root when no one scope is", async () => {
    await runSync();
    expect((await disconnect()).status).toBe(200);
    graph.leave(graph.gid(DASHED_SCOPE), 1);
    // A group no scope row names, as a deleted scope's would be.
    graph.leave(graph.gid(`${ROOT}.gone`), 2);

    const admin = await records(ADMIN);

    expect(admin.status).toBe(200);
    expect(admin.body.scopes).toEqual([
      zero(SCOPE),
      { ...zero(ROOT), episodes: 2 },
      { ...zero(DASHED_SCOPE), episodes: 1 },
    ]);
  });

  it("says the graph could not be counted rather than answering with what Postgres alone holds", async () => {
    await runSync();
    graph.failNextCount();

    const answer = await records(READER);

    expect(answer.status).toBe(502);
    expect(answer.body.error).toMatch(/Could not count this source's records in the memory graph/);
  });

  it("refuses a read past the org's per-minute limit, before deciding or counting anything", async () => {
    let refused: { status: number; body: { scopes?: Counts[]; error?: string } } | null = null;
    let reads = 0;
    // Earlier cases in this file share the limit's window, so the refusal may come sooner.
    while (refused === null && reads <= RECORDS_READS_PER_MINUTE) {
      const answer = await records(READER);
      reads += 1;
      if (answer.status === 429) refused = answer;
    }

    expect(refused).toEqual({ status: 429, body: { error: "rate limit exceeded" } });
    expect((await readRows(READER)).length).toBe(reads - 1);
  });
});
