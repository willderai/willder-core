// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// How long a raw file stays in Vercel Blob (lib/blob-storage.ts) depends on whether it has
// another home. A Drive file does: the raw file is deleted right after extraction, so an
// edit, a file leaving the folder or a disconnect never has a raw copy to miss. An upload
// does not: its raw file is kept until the upload is removed, by the person who removes it,
// by a person erasure, or with its org, because export needs it
// (services/memory/uploads.ts). And a re-synced edit of a Drive file, or a second upload
// of the same filename, is a new blob rather than an overwrite the SDK refuses: before
// that, a Drive file edited once lost its old passages and then failed on every later sync.
//
// Real: Postgres, check() against live grants, the whole sourceSync job for a Drive folder,
// the file-ingest job for an upload, the upload record and its removal paths, erasePerson,
// the change feed. Doubles: the graph store (episodes per group), Drive, the embedding
// service, and Vercel Blob, which behaves as @vercel/blob 2.4.0 does: a put to a pathname
// that exists throws unless the caller allows an overwrite, and `addRandomSuffix` makes
// the stored pathname unique.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

/** The Blob store: stored bodies by URL, and every pathname ever written. */
const blobStore = vi.hoisted(() => {
  const bodies = new Map<string, string>();
  const written: string[] = [];
  let suffix = 0;
  return {
    bodies,
    written,
    reset() {
      bodies.clear();
      written.length = 0;
      suffix = 0;
    },
    sdk: {
      put: async (
        pathname: string,
        body: Buffer | File,
        options: { addRandomSuffix?: boolean; allowOverwrite?: boolean },
      ) => {
        const stored = options.addRandomSuffix
          ? pathname.replace(/(\.[^./]*)?$/, (ext) => `-r${++suffix}${ext}`)
          : pathname;
        const url = `https://blob.test/${stored}`;
        if (bodies.has(url) && !options.allowOverwrite) throw new Error("Vercel Blob: This blob already exists");
        bodies.set(url, Buffer.isBuffer(body) ? body.toString() : await body.text());
        written.push(stored);
        return { url };
      },
      del: async (url: string) => {
        bodies.delete(url);
      },
      get: async (url: string) => {
        const body = bodies.get(url);
        return body === undefined ? null : { statusCode: 200, stream: new Blob([body]).stream() };
      },
    },
  };
});

/**
 * The graph store: live episodes by group, each with the chunk id it was stamped with, as the
 * memory service keeps them (`chunk_id` in the episode's provenance). `removeChunkFacts` retires
 * the episodes stamped with one chunk id in one group, as `DELETE /chunks/{id}` does; `retrieve`
 * answers every live episode in the groups asked. `failExtract` makes the next extraction fail;
 * `beforeBulkWrite` runs once inside the next bulk write, before its episodes land.
 * `afterRetire` runs once at the end of the next chunk retirement, as a write landing just after it;
 * `beforeIngest` runs once inside the next single-episode write, before the episode lands;
 * `failRetire` makes every retirement throw; `silentRetire` makes it name no episode it retired, as a
 * service older than `removed_episode_ids` answers. `write` stores an episode as ingest would.
 * `graph` answers one node per name in `nodes`, for linking an enriched record to its entity.
 */
const graph = vi.hoisted(() => {
  type Episode = { scopePath?: string; groupId: string; content: string; readableId?: string };
  const live = new Map<string, string>();
  const stamps = new Map<string, string>();
  let n = 0;
  const knobs: {
    failExtract: boolean;
    failRetire: boolean;
    silentRetire: boolean;
    nodes: string[];
    beforeBulkWrite?: () => Promise<void>;
    afterRetire?: () => Promise<void>;
    beforeIngest?: () => Promise<void>;
  } = {
    failExtract: false,
    failRetire: false,
    silentRetire: false,
    nodes: [],
  };
  const write = (input: Episode) => {
    const id = `ep-${++n}`;
    const key = `${input.scopePath ?? input.groupId}/${id}`;
    live.set(key, input.content);
    if (input.readableId) stamps.set(key, input.readableId);
    return id;
  };
  return {
    live,
    knobs,
    write,
    reset() {
      live.clear();
      stamps.clear();
      n = 0;
      Object.assign(knobs, {
        failExtract: false,
        failRetire: false,
        silentRetire: false,
        nodes: [],
        beforeBulkWrite: undefined,
        afterRetire: undefined,
        beforeIngest: undefined,
      });
    },
    store: {
      ingest: async (input: Episode) => {
        const hook = knobs.beforeIngest;
        knobs.beforeIngest = undefined;
        await hook?.();
        return { episodeId: write(input) };
      },
      ingestBulk: async (inputs: Episode[]) => {
        const hook = knobs.beforeBulkWrite;
        knobs.beforeBulkWrite = undefined;
        await hook?.();
        return inputs.map(write);
      },
      retrieve: async ({ groupId, groupIds }: { groupId: string; groupIds?: string[] }) => {
        const asked = new Set([groupId, ...(groupIds ?? [])]);
        const facts = [...live]
          .filter(([key]) => asked.has(key.slice(0, key.lastIndexOf("/"))))
          .map(([key, fact]) => ({
            uuid: key,
            fact,
            validAt: null,
            store: "graph",
            chunkIds: stamps.has(key) ? [stamps.get(key)!] : [],
          }));
        return { facts };
      },
      removeFact: async () => ({ removed: false }),
      findFactById: async () => null,
      extractFile: async ({ url }: { url: string }) => {
        if (knobs.failExtract) {
          knobs.failExtract = false;
          throw new Error("memory service extract failed");
        }
        const body = blobStore.bodies.get(url);
        if (body === undefined) throw new Error(`no blob at ${url}`);
        return { chunks: body.split("\n\n") };
      },
      removeEpisode: async ({ groupId, episodeId }: { groupId: string; episodeId: string }) => ({
        removed: live.delete(`${groupId}/${episodeId}`),
      }),
      graph: async () => ({ nodes: knobs.nodes.map((name, i) => ({ uuid: `ent-${i}`, name })), edges: [] }),
      removeChunkFacts: async ({ groupId, chunkId }: { groupId: string; chunkId: string }) => {
        if (knobs.failRetire) throw new Error("memory service unavailable");
        const episodeIds: string[] = [];
        for (const [key, stamp] of stamps) {
          if (stamp === chunkId && key.startsWith(`${groupId}/`)) {
            live.delete(key);
            stamps.delete(key);
            episodeIds.push(key.slice(key.lastIndexOf("/") + 1));
          }
        }
        const hook = knobs.afterRetire;
        knobs.afterRetire = undefined;
        await hook?.();
        // As the service answers; one that predates `removed_episode_ids` names none.
        return { episodeIds: knobs.silentRetire ? [] : episodeIds };
      },
      dedupeNodes: async () => 0,
      planPersonErasure: async () => [],
      erasePerson: async () => ({ episodes: 0, nodes: 0, edges: 0, summaries: 0, episodeIds: [] }),
    },
  };
});
const folder = vi.hoisted(() => ({
  files: [] as { id: string; name: string; mimeType: string; checksum: string; fileType: "pdf"; text: string }[],
}));

// A gdrive sync event seals its client token; the job opens it.
vi.mock("@/lib/crypto", () => ({ unsealSecret: () => ({ token: "drive-token" }) }));
vi.mock("@vercel/blob", () => blobStore.sdk);
vi.mock("@/services/memory/store", async () => {
  const { HybridMemoryStore } = await import("@/services/memory/hybrid-store");
  const { PgvectorMemoryStore } = await import("@/services/memory/pgvector-store");
  return { graphitiStore: graph.store, memory: new HybridMemoryStore(graph.store as never, new PgvectorMemoryStore()) };
});
vi.mock("@/services/connectors/gdrive", () => ({
  listFolderFiles: async () => folder.files,
  downloadFile: async (file: { text: string }) => new Blob([file.text]),
}));
const enrichment = vi.hoisted(() => ({
  enrich: async (): Promise<{ hasFindings: boolean; content: string; results: unknown[] }> => ({
    hasFindings: false,
    content: "",
    results: [],
  }),
}));
vi.mock("@/services/enrichment", () => ({ enrich: () => enrichment.enrich() }));
vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
}));

const QA_URL = process.env.QA_DATABASE_URL;
const DIMENSIONS = 384;
const ORG = "rawfilelife";
const ROOT = `org_${ORG}`;
const HB = `${ROOT}.hb`;
const OPS = `${ROOT}.ops`;
const OTHER_ORG = "rawfilelife2";
const OWNER = "u-rawfilelife-owner";
const OPS_EDITOR = "u-rawfilelife-ops";
const STRANGER = "u-rawfilelife2-admin";
const owner: AccessContext = { orgId: ORG, actor: { type: "human", id: OWNER, role: "admin" }, origin: "app" };
const opsEditor: AccessContext = {
  orgId: ORG,
  actor: { type: "human", id: OPS_EDITOR, role: "member" },
  origin: "app",
};
const stranger: AccessContext = {
  orgId: OTHER_ORG,
  actor: { type: "human", id: STRANGER, role: "admin" },
  origin: "app",
};
const DRIVE = { id: "src-rawfilelife-drive", folder: "folder-rawfilelife" };

type StepCtx = {
  event: { id?: string; data: unknown };
  runId?: string;
  step: { run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T> };
};

describe.skipIf(!QA_URL)("a raw file in Blob lives only until it is extracted", () => {
  let db: PrismaClient;
  let sourceSync: { fn: (ctx: StepCtx) => Promise<unknown> };
  let fileIngest: { fn: (ctx: StepCtx) => Promise<unknown> };
  let uploads: typeof import("@/services/memory/uploads");
  let erasePerson: (typeof import("@/services/memory/person-erasure"))["erasePerson"];
  let findOrphans: (typeof import("@/scripts/blob-orphans"))["findOrphans"];

  const steps = { run: async <T>(_name: string, fn: () => Promise<T> | T) => fn() };
  const sync = () =>
    sourceSync.fn({
      event: { data: { sourceId: DRIVE.id, orgId: ORG, sealedToken: "sealed-drive-token" } },
      step: steps,
    });
  const share = (files: { id: string; checksum: string; text: string }[]) => {
    folder.files = files.map((f) => ({
      ...f,
      name: `${f.id}.pdf`,
      mimeType: "application/pdf",
      fileType: "pdf" as const,
    }));
  };
  const passages = async () =>
    (
      await db.memoryChunk.findMany({ where: { orgId: ORG }, select: { content: true }, orderBy: { content: "asc" } })
    ).map((c) => c.content);
  /**
   * What an agent with read on the org's root is served for `query`, as memory_query asks the
   * store: each text once, whichever store answered it (a graph fact extracted from one passage
   * is served as that passage while it is stored).
   */
  const agentReads = async (query: string) => {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId: "agent-rawfilelife",
        tokenHash: hashCapabilityToken(token),
        scopePath: ROOT,
        permission: "read",
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    const agent: AccessContext = {
      orgId: ORG,
      actor: { type: "agent", id: "agent-rawfilelife", capabilityToken: token },
      origin: "mcp",
    };
    const { guardedMemory } = await import("@/services/memory/guarded-store");
    const { facts } = await guardedMemory.retrieve(agent, { groupId: ORG, query, limit: 50 }, ROOT);
    return [...new Set(facts.map((f) => f.fact))].sort();
  };

  async function wipe(): Promise<void> {
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.changeEvent.deleteMany({ where: { orgId } });
      await db.factEdge.deleteMany({ where: { orgId } });
      await db.memoryChunk.deleteMany({ where: { orgId } });
      await db.erasureSuppression.deleteMany({ where: { orgId } });
      await db.auditLog.deleteMany({ where: { orgId } });
      await db.capability.deleteMany({ where: { orgId } });
      await db.grant.deleteMany({ where: { orgId } });
      await db.user.deleteMany({ where: { orgId } });
      await deleteOrgsWithRetry(db, { where: { id: orgId } });
    }
  }

  beforeAll(async () => {
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ embedding: new Array(DIMENSIONS).fill(0.01) }))),
    );
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    const jobs = await import("./inngest");
    sourceSync = jobs.sourceSync as unknown as typeof sourceSync;
    fileIngest = jobs.fileIngest as unknown as typeof fileIngest;
    uploads = await import("@/services/memory/uploads");
    ({ erasePerson } = await import("@/services/memory/person-erasure"));
    ({ findOrphans } = await import("@/scripts/blob-orphans"));
  }, 60_000);

  afterAll(async () => {
    if (db) {
      await wipe();
      await db.$disconnect();
    }
    vi.unstubAllGlobals();
  });

  beforeEach(async () => {
    blobStore.reset();
    graph.reset();
    folder.files = [];
    vi.spyOn(console, "error").mockImplementation(() => {});
    await wipe();
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    await db.scope.create({ data: { orgId: ORG, path: HB, name: "hb" } });
    const ops = await db.scope.create({ data: { orgId: ORG, path: OPS, name: "ops" } });
    await db.org.create({ data: { id: OTHER_ORG, name: OTHER_ORG } });
    const otherRoot = await db.scope.create({ data: { orgId: OTHER_ORG, path: `org_${OTHER_ORG}`, name: "root" } });
    const root = await db.scope.findFirstOrThrow({ where: { orgId: ORG, path: ROOT } });
    await db.user.createMany({
      data: [
        { id: OWNER, orgId: ORG, email: "owner@rawfilelife.test", role: "admin", clerkId: "clerk-rawfilelife-owner" },
        { id: OPS_EDITOR, orgId: ORG, email: "ops@rawfilelife.test", role: "member", clerkId: "clerk-rawfilelife-ops" },
        {
          id: STRANGER,
          orgId: OTHER_ORG,
          email: "admin@rawfilelife2.test",
          role: "admin",
          clerkId: "clerk-rawfilelife2-admin",
        },
      ],
    });
    await db.grant.createMany({
      data: [
        { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: OWNER, permission: "admin" },
        { orgId: ORG, scopeId: ops.id, granteeType: "user", granteeId: OPS_EDITOR, permission: "write" },
        { orgId: OTHER_ORG, scopeId: otherRoot.id, granteeType: "user", granteeId: STRANGER, permission: "admin" },
      ],
    });
    await db.source.create({
      data: {
        id: DRIVE.id,
        orgId: ORG,
        type: "gdrive",
        externalId: DRIVE.folder,
        name: "Handbook Drive",
        scopePath: HB,
      },
    });
  });

  describe("a Drive file", () => {
    it("edited twice: every sync succeeds, memory holds only the latest version, and no raw file is left", async () => {
      const versions = [
        { checksum: "v1", text: "Leave is 20 days.\n\nTravel needs approval." },
        { checksum: "v2", text: "Leave is 25 days.\n\nTravel needs approval." },
        { checksum: "v3", text: "Leave is 30 days.\n\nTravel is pre-approved." },
      ];
      for (const version of versions) {
        share([{ id: "handbook", ...version }]);
        expect(await sync()).toMatchObject({ synced: 1, failed: 0 });
        expect(await passages()).toEqual(version.text.split("\n\n").sort());
        expect(blobStore.bodies.size).toBe(0);
      }
      const record = await db.sourceFile.findUniqueOrThrow({
        where: { sourceId_externalFileId: { sourceId: DRIVE.id, externalFileId: "handbook" } },
      });
      expect(record.checksum).toBe("v3");
      // One blob per version, each under the file's own prefix, never the same pathname twice.
      expect(blobStore.written).toHaveLength(3);
      expect(new Set(blobStore.written).size).toBe(3);
      for (const pathname of blobStore.written)
        expect(pathname).toMatch(new RegExp(`^sources/${ORG}/${DRIVE.id}/handbook-`));
    });

    it("an edit whose extraction fails keeps the previous version searchable, and its raw file still goes", async () => {
      share([{ id: "handbook", checksum: "v1", text: "Leave is 20 days." }]);
      await sync();

      share([{ id: "handbook", checksum: "v2", text: "Leave is 25 days." }]);
      graph.knobs.failExtract = true;
      expect(await sync()).toMatchObject({ synced: 0, failed: 1 });

      expect(await passages()).toEqual(["Leave is 20 days."]);
      expect(blobStore.bodies.size).toBe(0);

      // The next sync, with the memory service back, replaces it.
      await sync();
      expect(await passages()).toEqual(["Leave is 25 days."]);
      expect(blobStore.bodies.size).toBe(0);
    });

    it("W3a-2: removing one of its passages as a fact retires that passage's graph episode, and only that one", async () => {
      share([{ id: "handbook", checksum: "v1", text: "Leave is 20 days.\n\nTravel needs approval." }]);
      await sync();
      const leave = await db.memoryChunk.findFirstOrThrow({ where: { orgId: ORG, content: "Leave is 20 days." } });
      const { guardedMemory } = await import("@/services/memory/guarded-store");

      expect(await guardedMemory.removeFact(owner, { groupId: ORG, factId: leave.id }, HB)).toMatchObject({
        removed: true,
      });

      expect([...graph.live.values()]).toEqual(["Travel needs approval."]);
      expect(await agentReads("leave")).not.toContain("Leave is 20 days.");
    });

    it("after one passage is deleted as a fact, an edit of the file still syncs", async () => {
      share([{ id: "handbook", checksum: "v1", text: "Leave is 20 days.\n\nTravel needs approval." }]);
      await sync();
      const leave = await db.memoryChunk.findFirstOrThrow({ where: { orgId: ORG, content: "Leave is 20 days." } });
      const { guardedMemory } = await import("@/services/memory/guarded-store");
      expect(await guardedMemory.removeFact(owner, { groupId: ORG, factId: leave.id }, HB)).toMatchObject({
        removed: true,
      });
      share([{ id: "handbook", checksum: "v2", text: "Leave is 25 days.\n\nTravel needs no approval." }]);
      expect(await sync()).toMatchObject({ synced: 1, failed: 0 });
      expect((await passages()).sort()).toEqual(["Leave is 25 days.", "Travel needs no approval."]);
      expect(await agentReads("travel")).not.toContain("Travel needs approval.");
    });

    it("the record drops its pointer to an episode retired with its passage", async () => {
      share([{ id: "handbook", checksum: "v1", text: "Leave is 20 days.\n\nTravel needs approval." }]);
      await sync();
      const record = () =>
        db.sourceFile.findFirstOrThrow({ where: { sourceId: DRIVE.id, externalFileId: "handbook" } });
      expect((await record()).episodeIds).toHaveLength(2);
      const leave = await db.memoryChunk.findFirstOrThrow({ where: { orgId: ORG, content: "Leave is 20 days." } });
      const { guardedMemory } = await import("@/services/memory/guarded-store");

      await guardedMemory.removeFact(owner, { groupId: ORG, factId: leave.id }, HB);

      const left = (await record()).episodeIds;
      expect(left).toHaveLength(1);
      expect(graph.live.get(`${HB}/${left[0]}`)).toBe("Travel needs approval.");
    });

    it("with no pointer dropped (a service that names no retired episode), an edit still syncs: a gone passage explains the gone episode", async () => {
      graph.knobs.silentRetire = true;
      share([{ id: "handbook", checksum: "v1", text: "Leave is 20 days.\n\nTravel needs approval." }]);
      await sync();
      const leave = await db.memoryChunk.findFirstOrThrow({ where: { orgId: ORG, content: "Leave is 20 days." } });
      const { guardedMemory } = await import("@/services/memory/guarded-store");
      await guardedMemory.removeFact(owner, { groupId: ORG, factId: leave.id }, HB);
      expect(
        (await db.sourceFile.findFirstOrThrow({ where: { sourceId: DRIVE.id, externalFileId: "handbook" } }))
          .episodeIds,
      ).toHaveLength(2);

      share([{ id: "handbook", checksum: "v2", text: "Leave is 25 days.\n\nTravel needs no approval." }]);
      expect(await sync()).toMatchObject({ synced: 1, failed: 0 });

      expect([...graph.live.values()].sort()).toEqual(["Leave is 25 days.", "Travel needs no approval."]);
    });

    it("an episode missing with every passage still stored is still a failure, not a silent no-op", async () => {
      share([{ id: "handbook", checksum: "v1", text: "Leave is 20 days." }]);
      await sync();
      graph.live.clear();

      share([{ id: "handbook", checksum: "v2", text: "Leave is 25 days." }]);
      expect(await sync()).toMatchObject({ synced: 0, failed: 1 });
    });

    it("after a person named in one passage is erased, an edit of the file still syncs", async () => {
      await db.contact.create({ data: { id: "c-dana", orgId: ORG, name: "Dana Whitfield", email: "dana@acme.test" } });
      share([{ id: "renewals", checksum: "v1", text: "Renewal owner is Dana Whitfield.\n\nRenewal date is March." }]);
      await sync();
      await erasePerson(owner, { email: "dana@acme.test" });
      share([{ id: "renewals", checksum: "v2", text: "Renewal owner is Sam.\n\nRenewal date is April." }]);
      expect(await sync()).toMatchObject({ synced: 1, failed: 0 });
      expect((await passages()).sort()).toEqual(["Renewal date is April.", "Renewal owner is Sam."]);
    });

    it("a passage removed as a fact, then its file edited: the resync leaves only the new version's episodes", async () => {
      share([{ id: "handbook", checksum: "v1", text: "Leave is 20 days.\n\nTravel needs approval." }]);
      await sync();
      const leave = await db.memoryChunk.findFirstOrThrow({ where: { orgId: ORG, content: "Leave is 20 days." } });
      const ep = [...graph.live.entries()].find(([, c]) => c === "Leave is 20 days.");
      expect(ep).toBeDefined();
      const { guardedMemory } = await import("@/services/memory/guarded-store");
      expect(await guardedMemory.removeFact(owner, { groupId: ORG, factId: leave.id }, HB)).toMatchObject({
        removed: true,
      });
      expect([...graph.live.values()]).toEqual(["Travel needs approval."]);
      share([{ id: "handbook", checksum: "v2", text: "Leave is 25 days.\n\nTravel needs no approval." }]);
      const r1 = await sync();
      // Later syncs of the same version change nothing and fail nothing.
      expect(await sync()).toMatchObject({ failed: 0 });
      expect(await sync()).toMatchObject({ failed: 0 });
      expect(r1).toMatchObject({ failed: 0 });
      expect([...graph.live.values()].sort()).toEqual(["Leave is 25 days.", "Travel needs no approval."]);
      expect((await passages()).sort()).toEqual(["Leave is 25 days.", "Travel needs no approval."]);
      // The new rows' ids are the ones their episodes carry: removing one retires only it.
      const travel = await db.memoryChunk.findFirstOrThrow({
        where: { orgId: ORG, content: "Travel needs no approval." },
      });
      expect(await guardedMemory.removeFact(owner, { groupId: ORG, factId: travel.id }, HB)).toMatchObject({
        removed: true,
      });
      expect([...graph.live.values()]).toEqual(["Leave is 25 days."]);
    });

    it("W3a-2: erasing a person retires the graph episodes of the passages that name her, even where the graph's text match misses them", async () => {
      await db.contact.create({ data: { id: "c-dana", orgId: ORG, name: "Dana Whitfield", email: "dana@acme.test" } });
      share([{ id: "renewals", checksum: "v1", text: "Renewal owner is Dana Whitfield.\n\nRenewal date is March." }]);
      await sync();

      await erasePerson(owner, { email: "dana@acme.test" });

      // The graph double's own person erasure removes nothing, so only the chunk stamp can.
      expect([...graph.live.values()]).toEqual(["Renewal date is March."]);
    });

    it("leaving the folder retires its passages and leaves no raw file behind", async () => {
      share([
        { id: "handbook", checksum: "v1", text: "Leave is 20 days." },
        { id: "travel", checksum: "t1", text: "Travel needs approval." },
      ]);
      await sync();
      share([{ id: "travel", checksum: "t1", text: "Travel needs approval." }]);
      await sync();

      expect(await passages()).toEqual(["Travel needs approval."]);
      expect(blobStore.written).toHaveLength(2);
      expect(blobStore.bodies.size).toBe(0);
    });
  });

  describe("an upload", () => {
    const text = async (stream: ReadableStream<Uint8Array> | undefined) => new Response(stream).text();
    const fileOf = async (ctx: AccessContext, id: string) => {
      const file = await uploads.readUploadFile(ctx, id);
      return file && { filename: file.filename, body: await text(file.body) };
    };

    /** What the upload route does before its job runs: store the blob and record it. `extract` then runs the job. */
    async function stage(
      filename: string,
      body: string,
      scopePath = HB,
    ): Promise<{ id: string; blobUrl: string; extract: () => Promise<unknown> }> {
      const { putPrivateBlob } = await import("@/lib/blob-storage");
      const { url: blobUrl } = await putPrivateBlob(`memory/${ORG}/${filename}`, Buffer.from(body));
      const { id } = await uploads.recordUpload({
        orgId: ORG,
        scopePath,
        filename,
        fileType: "pdf",
        blobUrl,
        actorId: OWNER,
      });
      const documentId = `doc-${id}`;
      await uploads.recordUploadDocument(ORG, id, documentId);
      const extract = () =>
        fileIngest.fn({
          event: {
            id: documentId,
            data: {
              groupId: ORG,
              blobUrl,
              filename,
              fileType: "pdf",
              actorId: OWNER,
              origin: "app",
              scopePath,
              uploadId: id,
            },
          },
          runId: `run-${id}`,
          step: steps,
        });
      return { id, blobUrl, extract };
    }

    /** What the upload route does: store the blob, record it, run its job. */
    async function upload(filename: string, body: string, scopePath = HB): Promise<{ id: string; blobUrl: string }> {
      const { id, blobUrl, extract } = await stage(filename, body, scopePath);
      await extract();
      return { id, blobUrl };
    }

    it("keeps its raw file after extraction, and its passages name the upload", async () => {
      const { id, blobUrl } = await upload("notes.pdf", "Q3 targets: 40 logos.\n\nQ4 targets: 55 logos.");

      expect(blobStore.bodies.get(blobUrl)).toBe("Q3 targets: 40 logos.\n\nQ4 targets: 55 logos.");
      const rows = await db.memoryChunk.findMany({ where: { orgId: ORG }, select: { uploadId: true } });
      expect(rows).toEqual([{ uploadId: id }, { uploadId: id }]);
    });

    it("the same filename uploaded twice is two kept blobs, both ingested", async () => {
      await upload("notes.pdf", "Q3 targets: 40 logos.");
      await upload("notes.pdf", "Q4 targets: 55 logos.");

      expect(await passages()).toEqual(["Q3 targets: 40 logos.", "Q4 targets: 55 logos."]);
      expect(new Set(blobStore.written).size).toBe(2);
      expect(blobStore.bodies.size).toBe(2);
    });

    it("a job that gives up keeps the raw file, which is all the person has of it", async () => {
      const { putPrivateBlob } = await import("@/lib/blob-storage");
      const { url } = await putPrivateBlob(`memory/${ORG}/notes.pdf`, Buffer.from("Q3 targets: 40 logos."));
      const { id } = await uploads.recordUpload({
        orgId: ORG,
        scopePath: HB,
        filename: "notes.pdf",
        fileType: "pdf",
        blobUrl: url,
        actorId: OWNER,
      });
      graph.knobs.failExtract = true;
      const data = {
        groupId: ORG,
        blobUrl: url,
        filename: "notes.pdf",
        fileType: "pdf",
        actorId: OWNER,
        origin: "app",
        scopePath: HB,
        uploadId: id,
      };
      await expect(fileIngest.fn({ event: { id: "upload-x", data }, runId: "run-x", step: steps })).rejects.toThrow();

      expect(blobStore.bodies.has(url)).toBe(true);
      expect(await fileOf(owner, id)).toEqual({ filename: "notes.pdf", body: "Q3 targets: 40 logos." });
    });

    describe("export", () => {
      it("lists the kept uploads a reader may read, and hands back each raw file as uploaded", async () => {
        const handbook = await upload("handbook.pdf", "Leave is 20 days.");
        const runbook = await upload("runbook.pdf", "Page the on-call.", OPS);

        const listed = await uploads.listReadableUploads(owner);
        expect(listed.map((u) => u.id).sort()).toEqual([handbook.id, runbook.id].sort());
        expect(JSON.stringify(listed)).not.toContain("blob.test");
        expect(await fileOf(owner, handbook.id)).toEqual({ filename: "handbook.pdf", body: "Leave is 20 days." });
        expect(await fileOf(owner, runbook.id)).toEqual({ filename: "runbook.pdf", body: "Page the on-call." });
      });

      it("shows a reader of one scope only that scope's uploads, and another org none", async () => {
        const handbook = await upload("handbook.pdf", "Leave is 20 days.");
        const runbook = await upload("runbook.pdf", "Page the on-call.", OPS);

        expect((await uploads.listReadableUploads(opsEditor)).map((u) => u.id)).toEqual([runbook.id]);
        expect(await fileOf(opsEditor, handbook.id)).toBeNull();
        expect(await uploads.listReadableUploads(stranger)).toEqual([]);
        expect(await fileOf(stranger, runbook.id)).toBeNull();
      });
    });

    describe("removal", () => {
      it("removes the raw file, the passages and the record, announces the document's delete, and leaves Drive alone", async () => {
        share([{ id: "handbook", checksum: "v1", text: "Leave is 20 days." }]);
        await sync();
        const kept = await upload("keep.pdf", "Travel needs approval.");
        const gone = await upload("notes.pdf", "Q3 targets: 40 logos.\n\nQ4 targets: 55 logos.");

        expect(await uploads.removeUpload(owner, gone.id)).toEqual({ removed: true, passages: 2 });

        expect(blobStore.bodies.has(gone.blobUrl)).toBe(false);
        expect(blobStore.bodies.has(kept.blobUrl)).toBe(true);
        expect(await passages()).toEqual(["Leave is 20 days.", "Travel needs approval."]);
        expect(await db.uploadedFile.findMany({ where: { orgId: ORG }, select: { id: true } })).toEqual([
          { id: kept.id },
        ]);
        expect(await fileOf(owner, gone.id)).toBeNull();
        const removal = await db.changeEvent.findFirstOrThrow({
          where: { orgId: ORG, recordId: `doc-${gone.id}`, op: "delete" },
        });
        expect(removal).toMatchObject({ recordType: "document", scopePath: HB, actorId: OWNER });
        expect(removal.authorizedById).not.toBeNull();
        expect(await db.sourceFile.count({ where: { sourceId: DRIVE.id } })).toBe(1);
      });

      it("W3: retires the graph episodes of its passages, so an agent is no longer served them, and leaves another upload's", async () => {
        await upload("keep.pdf", "Travel needs approval.");
        const gone = await upload("notes.pdf", "Q3 targets: 40 logos.\n\nQ4 targets: 55 logos.");
        expect(await agentReads("targets")).toEqual([
          "Q3 targets: 40 logos.",
          "Q4 targets: 55 logos.",
          "Travel needs approval.",
        ]);

        expect(await uploads.removeUpload(owner, gone.id)).toEqual({ removed: true, passages: 2 });

        expect(await agentReads("targets")).toEqual(["Travel needs approval."]);
        expect([...graph.live.values()]).toEqual(["Travel needs approval."]);
      });

      it("W3: an upload removed while its job writes its graph episodes: the job retires what it wrote", async () => {
        const pending = await stage("notes.pdf", "Q3 targets: 40 logos.");
        graph.knobs.beforeBulkWrite = async () => {
          expect(await uploads.removeUpload(owner, pending.id)).toMatchObject({ removed: true });
        };

        expect(await pending.extract()).toMatchObject({ ingested: 0, uploadRemoved: true });

        expect(await passages()).toEqual([]);
        expect([...graph.live.values()]).toEqual([]);
      });

      it("W3a-2: a graph failure before the delete leaves the upload kept and its passages stored, so a retry removes it all", async () => {
        const kept = await upload("notes.pdf", "Q3 targets: 40 logos.");
        graph.knobs.failRetire = true;

        await expect(uploads.removeUpload(owner, kept.id)).rejects.toThrow(/unavailable/);

        expect(await passages()).toEqual(["Q3 targets: 40 logos."]);
        expect((await uploads.listReadableUploads(owner)).map((u) => u.id)).toEqual([kept.id]);
        graph.knobs.failRetire = false;
        expect(await uploads.removeUpload(owner, kept.id)).toEqual({ removed: true, passages: 1 });
        expect([...graph.live.values()]).toEqual([]);
      });

      it("W3a-2: an episode its job writes after the first retirement and before the delete is retired after the delete", async () => {
        const gone = await upload("notes.pdf", "Q3 targets: 40 logos.");
        const passage = await db.memoryChunk.findFirstOrThrow({ where: { orgId: ORG, uploadId: gone.id } });
        graph.knobs.afterRetire = async () => {
          graph.write({ groupId: ORG, scopePath: HB, content: "Q3 targets: 40 logos.", readableId: passage.id });
        };

        expect(await uploads.removeUpload(owner, gone.id)).toEqual({ removed: true, passages: 1 });

        expect([...graph.live.values()]).toEqual([]);
      });

      it("W3a-2: a passage stored after the removal read the upload's passages is deleted and retired with them", async () => {
        const gone = await upload("notes.pdf", "Q3 targets: 40 logos.");
        const { pgvectorStore } = await import("@/services/memory/pgvector-store");
        graph.knobs.afterRetire = async () => {
          // Committed before the removal's mark, as a write the removal's read did not see.
          const [late] = await pgvectorStore.ingestAll([
            {
              groupId: ORG,
              content: "Q4 targets: 55 logos.",
              source: "document",
              actorType: "human",
              origin: "app",
              actorId: OWNER,
              scopePath: HB,
              uploadId: gone.id,
            },
          ]);
          graph.write({ groupId: ORG, scopePath: HB, content: "Q4 targets: 55 logos.", readableId: late });
        };

        expect(await uploads.removeUpload(owner, gone.id)).toEqual({ removed: true, passages: 2 });

        expect(await passages()).toEqual([]);
        expect([...graph.live.values()]).toEqual([]);
      });

      it("W3a-2: a passage removed while the inline graph write runs: extractFileGraph retires its late episode", async () => {
        const { storeFilePassages, extractFileGraph } = await import("./inngest/file-ingest");
        const file = { groupId: ORG, filename: "notes.pdf", actorId: OWNER, origin: "app" as const, scopePath: HB };
        const chunks = ["Q3 targets: 40 logos.", "Q4 targets: 55 logos."];
        const { chunkIds } = await storeFilePassages(file, chunks, "doc-inline");
        const { guardedMemory } = await import("@/services/memory/guarded-store");
        // Both of removeFact's retirements run before the episodes land, and find nothing.
        graph.knobs.beforeBulkWrite = async () => {
          expect(await guardedMemory.removeFact(owner, { groupId: ORG, factId: chunkIds![0]! }, HB)).toMatchObject({
            removed: true,
          });
        };

        await extractFileGraph(file, chunks, chunkIds);

        expect([...graph.live.values()]).toEqual(["Q4 targets: 55 logos."]);
      });

      it("W3: a file stored without an upload record (no Blob storage): removing one passage retires its graph episode", async () => {
        const { storeFilePassages, extractFileGraph } = await import("./inngest/file-ingest");
        const file = { groupId: ORG, filename: "notes.pdf", actorId: OWNER, origin: "app" as const, scopePath: HB };
        const chunks = ["Q3 targets: 40 logos.", "Q4 targets: 55 logos."];
        const { chunkIds } = await storeFilePassages(file, chunks, "doc-inline");
        await extractFileGraph(file, chunks, chunkIds);
        const q3 = await db.memoryChunk.findFirstOrThrow({ where: { orgId: ORG, content: "Q3 targets: 40 logos." } });
        const { guardedMemory } = await import("@/services/memory/guarded-store");

        expect(await guardedMemory.removeFact(owner, { groupId: ORG, factId: q3.id }, HB)).toMatchObject({
          removed: true,
        });

        expect(await agentReads("targets")).toEqual(["Q4 targets: 55 logos."]);
        expect([...graph.live.values()]).toEqual(["Q4 targets: 55 logos."]);
      });

      it("an upload removed while its job runs gets no passages from that job", async () => {
        const { putPrivateBlob } = await import("@/lib/blob-storage");
        const { url } = await putPrivateBlob(`memory/${ORG}/notes.pdf`, Buffer.from("Q3 targets: 40 logos."));
        const marked = await uploads.recordUpload({
          orgId: ORG,
          scopePath: HB,
          filename: "notes.pdf",
          fileType: "pdf",
          blobUrl: url,
          actorId: OWNER,
        });
        // Marked by a removal whose blob delete has not run yet, then a removal that finished.
        await db.uploadedFile.update({ where: { id: marked.id }, data: { removedAt: new Date() } });
        const job = (id: string) =>
          fileIngest.fn({
            event: {
              id: `doc-${id}`,
              data: {
                groupId: ORG,
                blobUrl: url,
                filename: "notes.pdf",
                fileType: "pdf",
                actorId: OWNER,
                origin: "app",
                scopePath: HB,
                uploadId: id,
              },
            },
            runId: `run-${id}`,
            step: steps,
          });

        expect(await job(marked.id)).toMatchObject({ ingested: 0, uploadRemoved: true });
        // A retry after the row is gone replays the memoized extraction and reaches the write.
        await uploads.deleteRemovedUploads(ORG);
        const { storeFilePassages } = await import("./inngest/file-ingest");
        const file = {
          groupId: ORG,
          filename: "notes.pdf",
          actorId: OWNER,
          origin: "app" as const,
          scopePath: HB,
          uploadId: marked.id,
        };
        expect(await storeFilePassages(file, ["Q3 targets: 40 logos."])).toEqual({
          outcome: "upload-removed",
          stored: 0,
        });

        expect(await passages()).toEqual([]);
        expect(graph.live.size).toBe(0);
      });

      it("QA #772: an upload removed after its passages are stored gets no graph episodes and no create event after its delete", async () => {
        const { putPrivateBlob } = await import("@/lib/blob-storage");
        const { url } = await putPrivateBlob(`memory/${ORG}/notes.pdf`, Buffer.from("Q3 targets: 40 logos."));
        const { id } = await uploads.recordUpload({
          orgId: ORG,
          scopePath: HB,
          filename: "notes.pdf",
          fileType: "pdf",
          blobUrl: url,
          actorId: OWNER,
        });
        const documentId = `doc-${id}`;
        await uploads.recordUploadDocument(ORG, id, documentId);
        // The person removes the upload while the job is between its pgvector step and its graph step.
        const racing = {
          run: async <T>(name: string, fn: () => Promise<T> | T) => {
            const out = await fn();
            if (name === "pgvector-store-chunks")
              expect(await uploads.removeUpload(owner, id)).toMatchObject({ removed: true });
            return out;
          },
        };
        await fileIngest.fn({
          event: {
            id: documentId,
            data: {
              groupId: ORG,
              blobUrl: url,
              filename: "notes.pdf",
              fileType: "pdf",
              actorId: OWNER,
              origin: "app",
              scopePath: HB,
              uploadId: id,
            },
          },
          runId: `run-${id}`,
          step: racing,
        });

        expect(await passages()).toEqual([]);
        expect(blobStore.bodies.has(url)).toBe(false);
        // Content written after the removal: graph episodes of a removed upload, still retrievable.
        expect([...graph.live.values()]).toEqual([]);
        // The feed's last word on the document must be its delete, not a create after it.
        const events = await db.changeEvent.findMany({
          where: { orgId: ORG, recordId: documentId },
          orderBy: { seq: "asc" },
          select: { op: true },
        });
        expect(events.at(-1)?.op).toBe("delete");
      });

      it("an upload removed after its graph episodes are written gets no create event after its delete", async () => {
        const { putPrivateBlob } = await import("@/lib/blob-storage");
        const { url } = await putPrivateBlob(`memory/${ORG}/notes.pdf`, Buffer.from("Q3 targets: 40 logos."));
        const { id } = await uploads.recordUpload({
          orgId: ORG,
          scopePath: HB,
          filename: "notes.pdf",
          fileType: "pdf",
          blobUrl: url,
          actorId: OWNER,
        });
        const documentId = `doc-${id}`;
        await uploads.recordUploadDocument(ORG, id, documentId);
        // The person removes the upload while the job is between its graph step and its announcement.
        const racing = {
          run: async <T>(name: string, fn: () => Promise<T> | T) => {
            const out = await fn();
            if (name === "ingest-chunks-bulk")
              expect(await uploads.removeUpload(owner, id)).toMatchObject({ removed: true });
            return out;
          },
        };
        const result = await fileIngest.fn({
          event: {
            id: documentId,
            data: {
              groupId: ORG,
              blobUrl: url,
              filename: "notes.pdf",
              fileType: "pdf",
              actorId: OWNER,
              origin: "app",
              scopePath: HB,
              uploadId: id,
            },
          },
          runId: `run-${id}`,
          step: racing,
        });

        expect(result).toMatchObject({ ingested: 0, uploadRemoved: true });
        expect(await passages()).toEqual([]);
        const events = await db.changeEvent.findMany({
          where: { orgId: ORG, recordId: documentId },
          orderBy: { seq: "asc" },
          select: { op: true },
        });
        expect(events.map((e) => e.op)).toEqual(["delete"]);
      });

      it("treats another org's upload id as one that does not exist: no decision, so no trace in the caller's audit log", async () => {
        const { id } = await upload("notes.pdf", "Q3 targets: 40 logos.");
        const traces = () => db.auditLog.count({ where: { orgId: OTHER_ORG, target: { contains: "upload:" } } });

        expect(await fileOf(stranger, "no-such-upload")).toBeNull();
        expect(await uploads.removeUpload(stranger, "no-such-upload")).toEqual({ removed: false, passages: 0 });
        expect(await traces()).toBe(0);

        expect(await fileOf(stranger, id)).toBeNull();
        expect(await uploads.removeUpload(stranger, id)).toEqual({ removed: false, passages: 0 });
        expect(await traces()).toBe(0);
      });

      it("refuses a caller who may not delete in the upload's scope, or is in another org, and changes nothing", async () => {
        const { id, blobUrl } = await upload("notes.pdf", "Q3 targets: 40 logos.");

        expect(await uploads.removeUpload(opsEditor, id)).toEqual({ removed: false, passages: 0 });
        expect(await uploads.removeUpload(stranger, id)).toEqual({ removed: false, passages: 0 });

        expect(blobStore.bodies.has(blobUrl)).toBe(true);
        expect(await passages()).toEqual(["Q3 targets: 40 logos."]);
        expect(await fileOf(owner, id)).toEqual({ filename: "notes.pdf", body: "Q3 targets: 40 logos." });
      });

      it("a blob delete that fails leaves the upload marked and unserved, and the next removal in the org finishes it", async () => {
        const first = await upload("a.pdf", "Alpha.");
        const second = await upload("b.pdf", "Beta.");
        const del = vi.spyOn(blobStore.sdk, "del").mockRejectedValueOnce(new Error("Blob unavailable"));

        await expect(uploads.removeUpload(owner, first.id)).rejects.toThrow("Blob unavailable");
        expect(await fileOf(owner, first.id)).toBeNull();
        expect((await uploads.listReadableUploads(owner)).map((u) => u.id)).toEqual([second.id]);

        await uploads.removeUpload(owner, second.id);
        del.mockRestore();
        expect(blobStore.bodies.size).toBe(0);
        expect(await db.uploadedFile.count({ where: { orgId: ORG } })).toBe(0);
      });
    });

    describe("erasure", () => {
      it("deletes the raw file of every upload that names the person, by a passage or its filename, and keeps the rest", async () => {
        await db.contact.create({
          data: { id: "c-dana", orgId: ORG, name: "Dana Whitfield", email: "dana@acme.test" },
        });
        const byPassage = await upload("renewals.pdf", "Renewal owner is Dana Whitfield.\n\nRenewal date is March.");
        const byName = await upload("Dana Whitfield.pdf", "Quarterly review.");
        const unrelated = await upload("travel.pdf", "Travel needs approval.");

        await erasePerson(owner, { email: "dana@acme.test" });

        expect(blobStore.bodies.has(byPassage.blobUrl)).toBe(false);
        expect(blobStore.bodies.has(byName.blobUrl)).toBe(false);
        expect(blobStore.bodies.has(unrelated.blobUrl)).toBe(true);
        expect(
          (await db.uploadedFile.findMany({ where: { orgId: ORG }, select: { id: true } })).map((u) => u.id),
        ).toEqual([unrelated.id]);
        // The raw file cannot be redacted, so it goes whole; its passages that do not name her stay.
        expect(await passages()).toEqual(["Quarterly review.", "Renewal date is March.", "Travel needs approval."]);
      });

      it("W3: a passage that names the person loses its graph episodes with it, even where the graph's own text match misses them", async () => {
        await db.contact.create({
          data: { id: "c-dana", orgId: ORG, name: "Dana Whitfield", email: "dana@acme.test" },
        });
        await upload("renewals.pdf", "Renewal owner is Dana Whitfield.\n\nRenewal date is March.");

        await erasePerson(owner, { email: "dana@acme.test" });

        // The graph double's own person erasure removes nothing, so only the chunk stamp can.
        expect([...graph.live.values()]).toEqual(["Renewal date is March."]);
        expect(await agentReads("renewal")).toEqual(["Renewal date is March."]);
      });

      it("W3: any fact the erasure removes loses the graph facts distilled from it, which need not name her", async () => {
        await db.contact.create({
          data: { id: "c-dana", orgId: ORG, name: "Dana Whitfield", email: "dana@acme.test" },
        });
        const { pgvectorStore } = await import("@/services/memory/pgvector-store");
        const [chunkId] = await pgvectorStore.ingestAll([
          {
            groupId: ORG,
            content: "Dana Whitfield moved to Denver.",
            scopePath: HB,
            actorType: "human",
            actorId: OWNER,
            origin: "app",
          },
        ]);
        // What extraction distilled from it, stamped with its chunk id as ingest stamps it.
        await graph.store.ingest({
          groupId: ORG,
          scopePath: HB,
          content: "Moved to Denver in May.",
          readableId: chunkId,
        });

        await erasePerson(owner, { email: "dana@acme.test" });

        expect(await passages()).toEqual([]);
        expect([...graph.live.values()]).toEqual([]);
      });

      describe("an upload made before the erasure and extracted after it", () => {
        const DANA = { email: "dana@acme.test", name: "Dana Whitfield" };
        const exported = async () => {
          const { exportMemory } = await import("@/services/memory/org-export");
          const lines: { type: string; [k: string]: unknown }[] = [];
          for await (const line of exportMemory(owner)) lines.push(JSON.parse(line));
          return lines;
        };
        const episodes = () => [...graph.live.values()].sort();

        beforeEach(async () => {
          await db.contact.create({ data: { id: "c-dana", orgId: ORG, name: DANA.name, email: DANA.email } });
        });

        it("loses its raw file and the passages that name her, keeps the rest, and is never exported", async () => {
          const pending = await stage("renewals.pdf", "Renewal owner is Dana Whitfield.\n\nRenewal date is March.");
          await erasePerson(owner, { email: DANA.email });
          // Nothing was extracted yet, so the erasure had no passage to find it by.
          expect(blobStore.bodies.has(pending.blobUrl)).toBe(true);

          expect(await pending.extract()).toMatchObject({ ingested: 1, uploadErased: true });

          expect(blobStore.bodies.has(pending.blobUrl)).toBe(false);
          expect(await db.uploadedFile.count({ where: { orgId: ORG } })).toBe(0);
          expect(await fileOf(owner, pending.id)).toBeNull();
          // As the erasure leaves an upload it finds: the raw file goes whole, the passages that do not name her stay.
          expect(await passages()).toEqual(["Renewal date is March."]);
          expect(episodes()).toEqual([]);
          const lines = await exported();
          expect(lines.filter((l) => l.type.startsWith("upload"))).toEqual([]);
          expect(JSON.stringify(lines)).not.toContain("Dana Whitfield");
        });

        it("loses its raw file when every passage names her, and stores none of them", async () => {
          const pending = await stage("call.pdf", "Dana Whitfield called.\n\nDANA  WHITFIELD will sign.");
          await erasePerson(owner, { email: DANA.email });

          expect(await pending.extract()).toMatchObject({ ingested: 0, uploadErased: true });

          expect(blobStore.bodies.size).toBe(0);
          expect(await passages()).toEqual([]);
        });

        it("keeps the upload of a bystander whose name holds hers, and every passage of it", async () => {
          const body = "Renewal owner is Dana Whitfield-Barnes.\n\nAna Dana-Whitfield signed.";
          const pending = await stage("Dana_Whitfield-Barnes_CV.pdf", body);
          await erasePerson(owner, { email: DANA.email });

          expect(await pending.extract()).toMatchObject({ ingested: 2 });

          expect(blobStore.bodies.get(pending.blobUrl)).toBe(body);
          expect(await passages()).toEqual(["Ana Dana-Whitfield signed.", "Renewal owner is Dana Whitfield-Barnes."]);
          expect(await fileOf(owner, pending.id)).toEqual({ filename: "Dana_Whitfield-Barnes_CV.pdf", body });
          expect((await exported()).filter((l) => l.type === "upload").map((l) => l.id)).toEqual([pending.id]);
        });

        it("keeps an upload made after the erasure that names her: a new, deliberate act", async () => {
          await erasePerson(owner, { email: DANA.email });
          const { id, blobUrl } = await upload("renewals.pdf", "Renewal owner is Dana Whitfield.");

          expect(blobStore.bodies.has(blobUrl)).toBe(true);
          expect(await passages()).toEqual(["Renewal owner is Dana Whitfield."]);
          expect((await exported()).filter((l) => l.type === "upload").map((l) => l.id)).toEqual([id]);
        });

        it("an erasure listed while the job embeds its passages still takes the raw file", async () => {
          const pending = await stage("renewals.pdf", "Renewal owner is Dana Whitfield.\n\nRenewal date is March.");
          const { recordSuppressions } = await import("@/services/memory/erasure-suppression");
          const embedding = vi.mocked(fetch).getMockImplementation()!;
          // After the job has judged its passages, before it writes them.
          vi.mocked(fetch).mockImplementationOnce(async (...args) => {
            await recordSuppressions(db, ORG, "listed-mid-write", {
              emails: [DANA.email],
              names: [DANA.name],
              contactIds: [],
            });
            return embedding(...args);
          });

          expect(await pending.extract()).toMatchObject({ uploadErased: true });

          expect(blobStore.bodies.has(pending.blobUrl)).toBe(false);
          expect(await passages()).toEqual(["Renewal date is March."]);
        });

        it("loses its raw file when its filename names her though the erasure never saw it, as a restored record", async () => {
          // Listed, not run: the erasure that would have marked this record by its filename did not see it.
          const { recordSuppressions } = await import("@/services/memory/erasure-suppression");
          const pending = await stage("Dana_Whitfield_offer.pdf", "The offer is final.");
          await recordSuppressions(db, ORG, "listed-only", {
            emails: [DANA.email],
            names: [DANA.name],
            contactIds: [],
          });

          expect(await pending.extract()).toMatchObject({ ingested: 1, uploadErased: true });

          expect(blobStore.bodies.has(pending.blobUrl)).toBe(false);
          expect(await passages()).toEqual(["The offer is final."]);
        });

        it("an upload with no text is judged by its filename: one naming her loses its raw file, another keeps it", async () => {
          const { recordSuppressions } = await import("@/services/memory/erasure-suppression");
          const named = await stage("Dana_Whitfield_offer.pdf", "scan");
          const other = await stage("Dana_Whitfield-Barnes_offer.pdf", "scan");
          await recordSuppressions(db, ORG, "listed-only", {
            emails: [DANA.email],
            names: [DANA.name],
            contactIds: [],
          });
          const noText = vi.spyOn(graph.store, "extractFile").mockResolvedValue({ chunks: [] });

          expect(await named.extract()).toMatchObject({ ingested: 0, uploadErased: true });
          expect(await other.extract()).toEqual({ ingested: 0, filename: "Dana_Whitfield-Barnes_offer.pdf" });
          noText.mockRestore();

          expect(blobStore.bodies.has(named.blobUrl)).toBe(false);
          expect(await fileOf(owner, named.id)).toBeNull();
          expect(await fileOf(owner, other.id)).toEqual({ filename: "Dana_Whitfield-Barnes_offer.pdf", body: "scan" });
        });

        it("a raw-file delete that fails after the mark still reports the upload erased, never serves it, and the next removal deletes it", async () => {
          const pending = await stage("renewals.pdf", "Renewal owner is Dana Whitfield.\n\nRenewal date is March.");
          await erasePerson(owner, { email: DANA.email });
          const del = vi.spyOn(blobStore.sdk, "del").mockRejectedValueOnce(new Error("Blob unavailable"));

          expect(await pending.extract()).toMatchObject({ ingested: 1, uploadErased: true });
          del.mockRestore();

          expect(await fileOf(owner, pending.id)).toBeNull();
          expect(await uploads.listReadableUploads(owner)).toEqual([]);
          expect((await exported()).filter((l) => l.type.startsWith("upload"))).toEqual([]);
          expect(await uploads.deleteRemovedUploads(ORG)).toBe(1);
          expect(blobStore.bodies.has(pending.blobUrl)).toBe(false);
        });

        it("a listing dated before the job's write but committed after it starts is waited for, and takes the raw file", async () => {
          const pending = await stage("renewals.pdf", "Renewal owner is Dana Whitfield.\n\nRenewal date is March.");
          const { recordSuppressions } = await import("@/services/memory/erasure-suppression");
          let release!: () => void;
          const held = new Promise<void>((resolve) => (release = resolve));
          let dated!: () => void;
          const isDated = new Promise<void>((resolve) => (dated = resolve));
          // The real listing, its time taken and its commit held back until released.
          const holding = {
            $transaction: (fn: (tx: unknown) => Promise<Date>) =>
              db.$transaction(
                async (tx) => {
                  const at = await fn(tx);
                  dated();
                  await held;
                  return at;
                },
                { timeout: 30_000 },
              ),
          };
          const listing = recordSuppressions(holding as never, ORG, "held", {
            emails: [DANA.email],
            names: [DANA.name],
            contactIds: [],
          });
          await isDated;

          const job = pending.extract();
          await new Promise((resolve) => setTimeout(resolve, 300));
          release();
          await listing;

          expect(await job).toMatchObject({ ingested: 1, uploadErased: true });
          expect(blobStore.bodies.has(pending.blobUrl)).toBe(false);
          expect(await passages()).toEqual(["Renewal date is March."]);
        });

        it("re-applying erasures takes the raw file of an upload extracted after the erasure before the job judged it", async () => {
          const late = await stage("renewals.pdf", "unused");
          const bystander = await stage("bystander.pdf", "unused");
          await erasePerson(owner, { email: DANA.email });
          // What the job wrote before it judged an upload's passages: each dated after the erasure.
          const { sqlUtcNow } = await import("@/lib/sql-utc-now");
          const passage = (id: string, uploadId: string, content: string) => db.$executeRaw`
            INSERT INTO memory_chunks (id, "orgId", content, source, "actorType", "actorId", "scopePath", "uploadId", "factVersion", embedding, "createdAt")
            VALUES (${id}, ${ORG}, ${content}, 'document', 'human', ${OWNER}, ${HB}, ${uploadId}, false,
              ${`[${new Array(DIMENSIONS).fill(0.01).join(",")}]`}::vector, ${sqlUtcNow} + interval '1 second')`;
          await passage("p-late-named", late.id, "Renewal owner is Dana Whitfield.");
          await passage("p-late-kept", late.id, "Renewal date is March.");
          await passage("p-bystander", bystander.id, "Renewal owner is Dana Whitfield-Barnes.");
          // A record named after her that a restore put back, dated before the erasure.
          const restored = await stage("Dana Whitfield.pdf", "unused");
          await db.uploadedFile.update({
            where: { id: restored.id },
            data: { createdAt: new Date("2026-01-01T00:00:00Z") },
          });
          const { reapplyErasures } = await import("@/services/memory/erasure-reapply");

          expect(await reapplyErasures(owner)).toMatchObject({ uploadsRemoved: 2, chunksRemoved: 1 });

          expect(blobStore.bodies.has(late.blobUrl)).toBe(false);
          expect(blobStore.bodies.has(restored.blobUrl)).toBe(false);
          expect(blobStore.bodies.has(bystander.blobUrl)).toBe(true);
          expect(
            (await db.uploadedFile.findMany({ where: { orgId: ORG }, select: { id: true } })).map((u) => u.id),
          ).toEqual([bystander.id]);
          expect(await passages()).toEqual(["Renewal date is March.", "Renewal owner is Dana Whitfield-Barnes."]);
          expect(await reapplyErasures(owner)).toMatchObject({ uploadsRemoved: 0, chunksRemoved: 0 });
        });
      });
    });

    describe("org deletion", () => {
      it("takes the org's upload records with it, so the sweep deletes their raw files and no other org's", async () => {
        const gone = await upload("notes.pdf", "Q3 targets: 40 logos.");
        const { putPrivateBlob } = await import("@/lib/blob-storage");
        const { url: otherUrl } = await putPrivateBlob(`memory/${OTHER_ORG}/kept.pdf`, Buffer.from("Theirs."));
        await uploads.recordUpload({
          orgId: OTHER_ORG,
          scopePath: `org_${OTHER_ORG}`,
          filename: "kept.pdf",
          fileType: "pdf",
          blobUrl: otherUrl,
          actorId: STRANGER,
        });
        const listed = [gone.blobUrl, otherUrl].map((url) => ({
          url,
          pathname: url,
          size: 1,
          uploadedAt: new Date(0),
        }));

        expect(findOrphans(listed, new Date(), 24, await uploads.keptUploadBlobUrls())).toEqual([]);
        await db.memoryChunk.deleteMany({ where: { orgId: ORG } });
        await db.org.delete({ where: { id: ORG } });

        expect(findOrphans(listed, new Date(), 24, await uploads.keptUploadBlobUrls()).map((b) => b.url)).toEqual([
          gone.blobUrl,
        ]);
      });
    });
  });

  describe("W3a-2: enrichment findings", () => {
    const research = async () => {
      await db.contact.create({ data: { id: "c-dana", orgId: ORG, name: "Dana Whitfield", email: "dana@acme.test" } });
      graph.knobs.nodes = ["Dana Whitfield"];
      enrichment.enrich = async () => ({ hasFindings: true, content: "Dana Whitfield is CFO at Acme.", results: [] });
      const { runEnrichment } = await import("./inngest/enrichment");
      await runEnrichment({
        orgId: ORG,
        target: { kind: "contact", name: "Dana Whitfield" },
        recordId: "c-dana",
        actorId: OWNER,
        origin: "app",
      });
      return db.memoryChunk.findFirstOrThrow({ where: { orgId: ORG, content: "Dana Whitfield is CFO at Acme." } });
    };

    it("a finding removed as a fact takes its graph episode with it", async () => {
      const finding = await research();
      expect([...graph.live.values()]).toEqual(["Dana Whitfield is CFO at Acme."]);
      const { guardedMemory } = await import("@/services/memory/guarded-store");

      expect(await guardedMemory.removeFact(owner, { groupId: ORG, factId: finding.id }, ROOT)).toMatchObject({
        removed: true,
      });

      expect([...graph.live.values()]).toEqual([]);
    });

    it("erasing the person takes the finding's graph episode, which the graph's text match can miss", async () => {
      await research();

      await erasePerson(owner, { email: "dana@acme.test" });

      expect(await passages()).toEqual([]);
      expect([...graph.live.values()]).toEqual([]);
    });

    it("a vector-leg failure still writes the finding's episode (unstamped) and the job succeeds", async () => {
      const { PgvectorMemoryStore } = await import("@/services/memory/pgvector-store");
      const spy = vi.spyOn(PgvectorMemoryStore.prototype, "ingest").mockRejectedValueOnce(new Error("embedder down"));
      try {
        await db.contact.create({
          data: { id: "c-dana", orgId: ORG, name: "Dana Whitfield", email: "dana@acme.test" },
        });
        graph.knobs.nodes = ["Dana Whitfield"];
        enrichment.enrich = async () => ({ hasFindings: true, content: "Dana Whitfield is CFO at Acme.", results: [] });
        const { runEnrichment } = await import("./inngest/enrichment");
        await runEnrichment({
          orgId: ORG,
          target: { kind: "contact", name: "Dana Whitfield" },
          recordId: "c-dana",
          actorId: OWNER,
          origin: "app",
        });
        expect(await passages()).toEqual([]);
        expect([...graph.live.values()]).toEqual(["Dana Whitfield is CFO at Acme."]);
      } finally {
        spy.mockRestore();
      }
    });

    it("a finding that stays stored keeps its episode (the post-write check retires nothing)", async () => {
      const finding = await research();
      expect(finding.id).toBeTruthy();
      expect([...graph.live.values()]).toEqual(["Dana Whitfield is CFO at Acme."]);
    });

    it("a finding removed while its graph episode is written: the store retires the late episode", async () => {
      const { guardedMemory } = await import("@/services/memory/guarded-store");
      graph.knobs.beforeIngest = async () => {
        const finding = await db.memoryChunk.findFirstOrThrow({
          where: { orgId: ORG, content: "Dana Whitfield is CFO at Acme." },
        });
        expect(await guardedMemory.removeFact(owner, { groupId: ORG, factId: finding.id }, ROOT)).toMatchObject({
          removed: true,
        });
      };
      await db.contact.create({ data: { id: "c-dana", orgId: ORG, name: "Dana Whitfield", email: "dana@acme.test" } });
      graph.knobs.nodes = ["Dana Whitfield"];
      enrichment.enrich = async () => ({ hasFindings: true, content: "Dana Whitfield is CFO at Acme.", results: [] });
      const { runEnrichment } = await import("./inngest/enrichment");

      await runEnrichment({
        orgId: ORG,
        target: { kind: "contact", name: "Dana Whitfield" },
        recordId: "c-dana",
        actorId: OWNER,
        origin: "app",
      });

      expect(await passages()).toEqual([]);
      expect([...graph.live.values()]).toEqual([]);
    });
  });
});
