// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A person erasure removes a connector item's version written in place of one that named the
// person (services/memory/erasure-lineage.ts): a Slack message edited to "She ..." after it
// named her, and a Drive file edited after one of its passages named her, whose whole new
// version goes, since its passages do not correspond one to one to the old ones. A Drive file
// named after her goes as well, as the sync already refuses to write it back. An unchanged
// item is not synced back afterwards, and nothing else is touched.
//
// Real: Postgres, the whole sourceSync job for a Slack channel and a Drive folder, the change
// feed, the suppression list and the person erasure. Doubles: the graph store (episodes per
// group, numbered per org; an edit retires an episode's facts but keeps its body, as the memory
// service does, and the person erasure removes the bodies that name her), Slack, Drive, Blob
// storage and the embedding service.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";

/** The graph store: live episodes by group, and every body written, which a retirement keeps. */
const graph = vi.hoisted(() => {
  const live = new Map<string, string>();
  const bodies = new Map<string, { orgId: string; content: string }>();
  const counters = new Map<string, number>();
  const removedEpisodes: string[] = [];
  /** When set, the next person erasure removes what it matched, then fails as a lost answer would. */
  const knobs = { loseEraseAnswer: false, planMissesAll: false };
  const write = (input: { scopePath?: string; groupId: string; content: string }) => {
    const n = (counters.get(input.groupId) ?? 0) + 1;
    counters.set(input.groupId, n);
    const id = `ep-${n}`;
    live.set(`${input.scopePath ?? input.groupId}/${id}`, input.content);
    bodies.set(`${input.groupId}/${id}`, { orgId: input.groupId, content: input.content });
    return id;
  };
  /** The bodies in `orgId` that name the person, as the memory service's erasure matches them. */
  const naming = (orgId: string, names: string[], emails: string[]) =>
    [...bodies.entries()].filter(
      ([, b]) =>
        b.orgId === orgId &&
        [...names, ...emails].some((value) => b.content.toLowerCase().includes(value.toLowerCase())),
    );
  return {
    live,
    removedEpisodes,
    knobs,
    reset() {
      live.clear();
      bodies.clear();
      counters.clear();
      removedEpisodes.length = 0;
      knobs.loseEraseAnswer = false;
      knobs.planMissesAll = false;
    },
    store: {
      ingest: async (input: { scopePath?: string; groupId: string; content: string }) => ({ episodeId: write(input) }),
      ingestBulk: async (inputs: { scopePath?: string; groupId: string; content: string }[]) => inputs.map(write),
      extractFile: async ({ url }: { url: string }) => ({ chunks: blobs.get(url)!.split("\n\n") }),
      removeEpisode: async ({ groupId, episodeId }: { groupId: string; episodeId: string }) => {
        removedEpisodes.push(`${groupId}/${episodeId}`);
        return { removed: live.delete(`${groupId}/${episodeId}`) };
      },
      removeChunkFacts: async () => undefined,
      dedupeNodes: async () => 0,
      // `planMissesAll`: every matching episode was written after the plan was read.
      planPersonErasure: async ({ orgId, names, emails }: { orgId: string; names: string[]; emails: string[] }) =>
        knobs.planMissesAll ? [] : naming(orgId, names, emails).map(([key]) => key.split("/")[1]!),
      erasePerson: async ({ orgId, names, emails }: { orgId: string; names: string[]; emails: string[] }) => {
        const erased = naming(orgId, names, emails);
        for (const [key] of erased) bodies.delete(key);
        if (knobs.loseEraseAnswer) {
          knobs.loseEraseAnswer = false;
          const { MemoryServiceError } = await import("@/services/memory/graphiti-store");
          throw new MemoryServiceError("memory service erasePerson timed out after 120000 ms", 504);
        }
        return {
          episodes: erased.length,
          nodes: 0,
          edges: 0,
          summaries: 0,
          episodeIds: erased.map(([key]) => key.split("/")[1]!),
        };
      },
    },
  };
});
const blobs = vi.hoisted(() => new Map<string, string>());
const upstream = vi.hoisted(() => ({
  channels: new Map<string, { id: string; text: string; checksum: string; user: string; ts: string }[]>(),
  folders: new Map<
    string,
    { id: string; name: string; mimeType: string; checksum: string; fileType: "pdf"; text: string }[]
  >(),
}));

// Every sync here carries a sealed client token, as a gdrive sync must; the job opens it.
vi.mock("@/lib/crypto", () => ({ unsealSecret: () => ({ token: "upstream-token" }) }));
vi.mock("@/services/memory/store", async () => {
  const { HybridMemoryStore } = await import("@/services/memory/hybrid-store");
  const { PgvectorMemoryStore } = await import("@/services/memory/pgvector-store");
  return { graphitiStore: graph.store, memory: new HybridMemoryStore(graph.store as never, new PgvectorMemoryStore()) };
});
// The channel as it is upstream, whole: a stored message it no longer holds was deleted.
vi.mock("@/services/connectors/slack", () => ({
  listChannelMessages: async (
    channel: string,
    _token: string,
    { stored = [] }: { stored?: readonly string[] } = {},
  ) => {
    const items = upstream.channels.get(channel) ?? [];
    return { items, gone: stored.filter((id) => !items.some((m) => m.id === id)), cursor: {} };
  },
  parseSlackCursor: () => null,
}));
vi.mock("@/services/connectors/gdrive", () => ({
  listFolderFiles: async (folder: string) => upstream.folders.get(folder) ?? [],
  downloadFile: async (file: { id: string; text?: string }) => new Blob([file.text ?? ""]),
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
vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
}));

const QA_URL = process.env.QA_DATABASE_URL;
const DIMENSIONS = 384;

const ORG = "erasesync";
const ROOT = `org_${ORG}`;
const HB = `${ROOT}.hb`;
const ADMIN = "u-erasesync-admin";
/** A second org whose scopes, channel and episode ids are spelled exactly like the first's. */
const OTHER = "erasesync2";
const OTHER_HB = `org_${OTHER}.hb`;
const OTHER_ADMIN = "u-erasesync2-admin";
const SLACK = { id: "src-erasesync-slack", channel: "C-HANDBOOK" };
const OTHER_SLACK = { id: "src-erasesync-slack-2", channel: "C-HANDBOOK" };
const DRIVE = { id: "src-erasesync-drive", folder: "folder-handbook" };
const DANA = { name: "Dana Whitfield", email: "dana@acme.test" };

type StepCtx = {
  event: { data: unknown };
  step: { run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T> };
};

describe.skipIf(!QA_URL)(
  "a person erasure removes a connector item's version written in place of one that named her",
  () => {
    let db: PrismaClient;
    let sourceSync: { fn: (ctx: StepCtx) => Promise<unknown> };
    let erasePerson: (typeof import("@/services/memory/person-erasure"))["erasePerson"];

    const admin = (orgId: string): AccessContext => ({
      orgId,
      actor: { type: "human", id: orgId === ORG ? ADMIN : OTHER_ADMIN, role: "admin" },
      origin: "app",
    });
    const sync = (orgId: string, sourceId: string) =>
      sourceSync.fn({
        event: { data: { sourceId, orgId, sealedToken: "sealed-upstream-token" } },
        step: { run: async (_n, fn) => fn() },
      });
    const say = (channel: string, messages: { id: string; text: string }[]) =>
      upstream.channels.set(
        channel,
        messages.map((m) => ({ ...m, checksum: m.text, user: "U-ANA", ts: "1760000000.000100" })),
      );
    const shareFolder = (folder: string, files: { id: string; checksum: string; text: string }[]) =>
      upstream.folders.set(
        folder,
        files.map((f) => ({ ...f, name: `${f.id}.pdf`, mimeType: "application/pdf", fileType: "pdf" as const })),
      );

    async function feedText(orgId: string): Promise<string> {
      const events = await db.changeEvent.findMany({ where: { orgId }, select: { summary: true } });
      return events.map((e) => e.summary).join("\n");
    }

    async function record(sourceId: string, externalFileId: string) {
      return db.sourceFile.findUniqueOrThrow({
        where: { sourceId_externalFileId: { sourceId, externalFileId } },
        select: { checksum: true, episodeId: true, episodeIds: true, chunkIds: true, episodeScopePath: true },
      });
    }

    async function wipe(): Promise<void> {
      for (const orgId of [ORG, OTHER]) {
        await db.changeEvent.deleteMany({ where: { orgId } });
        await db.factEdge.deleteMany({ where: { orgId } });
        await db.memoryChunk.deleteMany({ where: { orgId } });
        await db.erasureSuppression.deleteMany({ where: { orgId } });
        await db.auditLog.deleteMany({ where: { orgId } });
        await db.org.deleteMany({ where: { id: orgId } });
      }
      await db.user.deleteMany({ where: { id: { in: [ADMIN, OTHER_ADMIN] } } });
    }

    beforeAll(async () => {
      if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
      process.env.DATABASE_URL = QA_URL;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ embedding: new Array(DIMENSIONS).fill(0.01) }))),
      );
      db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
      sourceSync = (await import("./inngest")).sourceSync as unknown as typeof sourceSync;
      ({ erasePerson } = await import("@/services/memory/person-erasure"));
    }, 60_000);

    afterAll(async () => {
      if (db) {
        await wipe();
        await db.$disconnect();
      }
      vi.unstubAllGlobals();
    });

    beforeEach(async () => {
      graph.reset();
      blobs.clear();
      upstream.channels.clear();
      upstream.folders.clear();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      await wipe();
      for (const [orgId, root, hb, adminId] of [
        [ORG, ROOT, HB, ADMIN],
        [OTHER, `org_${OTHER}`, OTHER_HB, OTHER_ADMIN],
      ] as const) {
        await db.org.create({ data: { id: orgId, name: orgId } });
        await db.user.create({
          data: { id: adminId, orgId, email: `${adminId}@erasesync.test`, role: "admin", clerkId: `clerk-${adminId}` },
        });
        const rootScope = await db.scope.create({ data: { orgId, path: root, name: "root" } });
        await db.scope.create({ data: { orgId, path: hb, name: "hb" } });
        await db.grant.create({
          data: { orgId, scopeId: rootScope.id, granteeType: "user", granteeId: adminId, permission: "admin" },
        });
        await db.contact.create({
          data: {
            id: `dana-${orgId}`,
            orgId,
            name: DANA.name,
            email: DANA.email,
            createdAt: new Date(Date.now() - 86_400_000),
          },
        });
      }
      await db.source.createMany({
        data: [
          // Every event this source writes names its connect row, as a real connected source's do:
          // sharing it must not tie one item's versions to another's.
          {
            id: SLACK.id,
            orgId: ORG,
            type: "slack",
            externalId: SLACK.channel,
            name: "#handbook",
            scopePath: HB,
            connectAuthorizationId: "connect-row-1",
          },
          {
            id: OTHER_SLACK.id,
            orgId: OTHER,
            type: "slack",
            externalId: OTHER_SLACK.channel,
            name: "#handbook",
            scopePath: OTHER_HB,
          },
          { id: DRIVE.id, orgId: ORG, type: "gdrive", externalId: DRIVE.folder, name: "Handbook Drive", scopePath: HB },
        ],
      });
    });

    it("a Slack message edited to 'She ...' after it named her: the edit goes, and is not synced back", async () => {
      const before = [
        { id: "m1", text: `${DANA.name} joins the Tuesday call.` },
        { id: "m2", text: "Deploys freeze on Friday." },
      ];
      const after = [{ id: "m1", text: "She joins the Wednesday call instead." }, before[1]!];
      for (const [orgId, sourceId, channel] of [
        [ORG, SLACK.id, SLACK.channel],
        [OTHER, OTHER_SLACK.id, OTHER_SLACK.channel],
      ] as const) {
        say(channel, before);
        await sync(orgId, sourceId);
        say(channel, after);
        await sync(orgId, sourceId);
      }
      const edited = (await record(SLACK.id, "m1")).episodeId!;
      expect(graph.live.get(`${HB}/${edited}`)).toBe("She joins the Wednesday call instead.");

      const result = await erasePerson(admin(ORG), { contactId: `dana-${ORG}` });

      expect(graph.removedEpisodes).toContain(`${HB}/${edited}`);
      expect(graph.live.has(`${HB}/${edited}`)).toBe(false);
      expect(await record(SLACK.id, "m1")).toEqual({
        checksum: after[0]!.text,
        episodeId: null,
        episodeIds: [],
        chunkIds: [],
        episodeScopePath: null,
      });
      expect(await feedText(ORG)).not.toMatch(/Dana|Whitfield|Wednesday/);
      expect(result.replacementsRemoved).toBe(1);

      // The unchanged item is skipped by its checksum: nothing is written back.
      await sync(ORG, SLACK.id);
      expect(await feedText(ORG)).not.toMatch(/Wednesday/);
      expect((await record(SLACK.id, "m1")).episodeId).toBeNull();
      // The other message, and the other org's copy of the whole conversation, are untouched.
      expect(await feedText(ORG)).toMatch(/Deploys freeze on Friday/);
      expect((await record(SLACK.id, "m2")).episodeId).not.toBeNull();
      expect(await feedText(OTHER)).toMatch(/Wednesday/);
      const otherEdited = (await record(OTHER_SLACK.id, "m1")).episodeId!;
      expect(graph.live.has(`${OTHER_HB}/${otherEdited}`)).toBe(true);
    });

    it("a Drive file edited after a passage named her: its whole new version goes, passages and all", async () => {
      shareFolder(DRIVE.folder, [
        { id: "onboarding", checksum: "v1", text: `${DANA.name} runs onboarding.\n\nThe handbook covers leave.` },
      ]);
      await sync(ORG, DRIVE.id);
      shareFolder(DRIVE.folder, [
        { id: "onboarding", checksum: "v2", text: "She runs onboarding.\n\nThe handbook covers leave and travel." },
      ]);
      await sync(ORG, DRIVE.id);
      const v2 = await record(DRIVE.id, "onboarding");
      expect(v2.episodeIds).toHaveLength(2);
      expect(v2.chunkIds).toHaveLength(2);
      // An untouched file in the same folder.
      shareFolder(DRIVE.folder, [
        { id: "onboarding", checksum: "v2", text: "She runs onboarding.\n\nThe handbook covers leave and travel." },
        { id: "pricing", checksum: "v1", text: "The annual plan is 40k." },
      ]);
      await sync(ORG, DRIVE.id);

      const result = await erasePerson(admin(ORG), { contactId: `dana-${ORG}` });

      for (const episodeId of v2.episodeIds) expect(graph.live.has(`${HB}/${episodeId}`)).toBe(false);
      expect(await db.memoryChunk.count({ where: { id: { in: v2.chunkIds } } })).toBe(0);
      expect(await record(DRIVE.id, "onboarding")).toEqual({
        checksum: "v2",
        episodeId: null,
        episodeIds: [],
        chunkIds: [],
        episodeScopePath: null,
      });
      expect(result.replacementsRemoved).toBe(1);
      const pricing = await record(DRIVE.id, "pricing");
      expect(pricing.episodeIds).toHaveLength(1);
      expect(await db.memoryChunk.count({ where: { id: { in: pricing.chunkIds } } })).toBe(1);
    });

    it("a Drive file named after her, whose passages never name her, goes as well", async () => {
      shareFolder(DRIVE.folder, [
        {
          id: `${DANA.name} review`,
          checksum: "v1",
          text: "Exceeded every target this year.\n\nPromotion recommended.",
        },
        { id: "pricing", checksum: "v1", text: "The annual plan is 40k." },
      ]);
      await sync(ORG, DRIVE.id);
      const review = await record(DRIVE.id, `${DANA.name} review`);
      expect(review.chunkIds).toHaveLength(2);

      const result = await erasePerson(admin(ORG), { contactId: `dana-${ORG}` });

      for (const episodeId of review.episodeIds) expect(graph.live.has(`${HB}/${episodeId}`)).toBe(false);
      expect(await db.memoryChunk.count({ where: { id: { in: review.chunkIds } } })).toBe(0);
      expect(result.announcedVersionsRemoved).toBe(1);
      expect(await feedText(ORG)).not.toMatch(/Dana|Whitfield/);
      expect((await record(DRIVE.id, "pricing")).episodeIds).toHaveLength(1);
    });

    it("a request sent again after the graph erased her passage but its answer was lost still removes the file's edit", async () => {
      // The passage that named her is the only record of it: the file's announcements carry its name.
      shareFolder(DRIVE.folder, [
        { id: "onboarding", checksum: "v1", text: `${DANA.name} runs onboarding.\n\nThe handbook covers leave.` },
      ]);
      await sync(ORG, DRIVE.id);
      shareFolder(DRIVE.folder, [
        { id: "onboarding", checksum: "v2", text: "She runs onboarding.\n\nThe handbook covers leave and travel." },
      ]);
      await sync(ORG, DRIVE.id);
      const v2 = await record(DRIVE.id, "onboarding");
      graph.knobs.loseEraseAnswer = true;

      await expect(erasePerson(admin(ORG), { contactId: `dana-${ORG}` })).rejects.toMatchObject({
        name: "MemoryServiceError",
      });
      const retry = await erasePerson(admin(ORG), { email: DANA.email });

      for (const episodeId of v2.episodeIds) expect(graph.live.has(`${HB}/${episodeId}`)).toBe(false);
      expect(await db.memoryChunk.count({ where: { id: { in: v2.chunkIds } } })).toBe(0);
      expect(retry.replacementsRemoved).toBe(1);
    });

    it("an edit of a passage the graph erased beyond its plan goes too", async () => {
      shareFolder(DRIVE.folder, [
        { id: "onboarding", checksum: "v1", text: `${DANA.name} runs onboarding.\n\nThe handbook covers leave.` },
      ]);
      await sync(ORG, DRIVE.id);
      shareFolder(DRIVE.folder, [
        { id: "onboarding", checksum: "v2", text: "She runs onboarding.\n\nThe handbook covers leave and travel." },
      ]);
      await sync(ORG, DRIVE.id);
      const v2 = await record(DRIVE.id, "onboarding");
      graph.knobs.planMissesAll = true;

      const result = await erasePerson(admin(ORG), { contactId: `dana-${ORG}` });

      for (const episodeId of v2.episodeIds) expect(graph.live.has(`${HB}/${episodeId}`)).toBe(false);
      expect(result.replacementsRemoved).toBe(1);
    });

    it("a sync record never takes another source's passage with its file", async () => {
      shareFolder(DRIVE.folder, [
        { id: "onboarding", checksum: "v1", text: `${DANA.name} runs onboarding.\n\nThe handbook covers leave.` },
      ]);
      await sync(ORG, DRIVE.id);
      // A passage another source stored, which a damaged record of this file also lists.
      const foreign = await db.memoryChunk.create({
        data: {
          orgId: ORG,
          content: "Incidents get a channel within five minutes.",
          source: "document",
          actorType: "extraction",
          scopePath: HB,
          sourceId: SLACK.id,
        },
      });
      shareFolder(DRIVE.folder, [
        { id: "onboarding", checksum: "v2", text: "She runs onboarding.\n\nThe handbook covers leave and travel." },
      ]);
      await sync(ORG, DRIVE.id);
      await db.sourceFile.update({
        where: { sourceId_externalFileId: { sourceId: DRIVE.id, externalFileId: "onboarding" } },
        data: { chunkIds: { push: foreign.id } },
      });

      await erasePerson(admin(ORG), { contactId: `dana-${ORG}` });

      expect(await db.memoryChunk.count({ where: { id: foreign.id } })).toBe(1);
    });
  },
);
