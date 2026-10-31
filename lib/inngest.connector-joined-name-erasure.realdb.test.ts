// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// An erased person's name written without spaces, as Drive file names and chat messages write
// it ("Dana_Whitfield_offer.pdf", "Dana.Whitfield.offer.pdf", "DanaWhitfield offer.pdf"), is
// found on every path that decides whether her copy is kept: the sync's check before it writes
// (lib/inngest/connector-drive-files.ts, connector-text-items.ts), the erasure itself
// (services/memory/person-erasure.ts), the read filter and the re-apply after a backup restore
// (services/memory/erasure-suppression.ts, erasure-reapply.ts). Bystanders' files ("Danaher",
// "Diana Whitfield", "Ana Dana-Whitfield") and another org's copies are kept.
//
// Real: Postgres, the whole sourceSync job for a Drive folder and a Slack channel, the change
// feed, the suppression list, the person erasure, the read filter and the re-apply. Doubles: the
// graph store (episodes per group, numbered per org; its own name rule is proven on Neo4j in
// memory-service/tests/test_person_erasure_integration.py, so here it matches nothing itself),
// Slack, Drive, Blob storage and the embedding service.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

/** The graph store: live episodes by scope, numbered per org. */
const graph = vi.hoisted(() => {
  const live = new Map<string, string>();
  const counters = new Map<string, number>();
  const write = (input: { scopePath?: string; groupId: string; content: string }) => {
    const n = (counters.get(input.groupId) ?? 0) + 1;
    counters.set(input.groupId, n);
    const id = `ep-${n}`;
    live.set(`${input.scopePath ?? input.groupId}/${id}`, input.content);
    return id;
  };
  return {
    live,
    reset() {
      live.clear();
      counters.clear();
    },
    store: {
      ingest: async (input: { scopePath?: string; groupId: string; content: string }) => ({ episodeId: write(input) }),
      ingestBulk: async (inputs: { scopePath?: string; groupId: string; content: string }[]) => inputs.map(write),
      extractFile: async ({ url }: { url: string }) => ({ chunks: blobs.get(url)!.split("\n\n") }),
      removeEpisode: async ({ groupId, episodeId }: { groupId: string; episodeId: string }) => ({
        removed: live.delete(`${groupId}/${episodeId}`),
      }),
      removeChunkFacts: async () => undefined,
      dedupeNodes: async () => 0,
      planPersonErasure: async () => [],
      erasePerson: async () => ({ episodes: 0, nodes: 0, edges: 0, summaries: 0, episodeIds: [] }),
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

const ORG = "joinedname";
const HB = `org_${ORG}.hb`;
const ADMIN = "u-joinedname-admin";
/** A second org whose scopes, folder, channel and Dana are spelled exactly like the first's. */
const OTHER = "joinedname2";
const OTHER_HB = `org_${OTHER}.hb`;
const OTHER_ADMIN = "u-joinedname2-admin";
const DRIVE = { id: "src-joinedname-drive", folder: "folder-offers" };
const OTHER_DRIVE = { id: "src-joinedname-drive-2", folder: "folder-offers" };
const SLACK = { id: "src-joinedname-slack", channel: "C-HIRING" };
const DANA = { name: "Dana Whitfield", email: "dana@acme.test" };

/** Her name as Drive file names write it. */
const HER_FILES = [
  "Dana_Whitfield_offer.pdf",
  "Dana.Whitfield.offer.pdf",
  "dana_whitfield-approved.pdf",
  "DanaWhitfield offer.pdf",
  "DanaWhitfieldOffer.pdf",
  "DANA_WHITFIELD_OFFER.PDF",
  "Dana Whitfield2.pdf",
  "dana_whitfield\u2011approved.pdf",
];
/** Other people's files, named close to hers. */
const BYSTANDER_FILES = [
  "Danaher_offer.pdf",
  "Diana_Whitfield_offer.pdf",
  "Ana Dana-Whitfield.pdf",
  "Ana_Dana-Whitfield_CV.pdf",
  "Dana_Whitfield-Barnes_CV.pdf",
  "Dana-Whitfield_CV.pdf",
  "dana\u2011whitfield\u2011barnes.pdf",
  "Dana_Whitfeld.pdf",
  "Dana/Whitfield.pdf",
];
/** What every file holds: nothing that names anyone. */
const OFFER_TEXT = "Base salary is 140k.\n\nStart date is in March.";

type StepCtx = {
  event: { data: unknown };
  step: { run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T> };
};

describe.skipIf(!QA_URL)("an erased person's name written without spaces is found on every path", () => {
  let db: PrismaClient;
  let sourceSync: { fn: (ctx: StepCtx) => Promise<unknown> };
  let erasePerson: (typeof import("@/services/memory/person-erasure"))["erasePerson"];
  let reapplyErasures: (typeof import("@/services/memory/erasure-reapply"))["reapplyErasures"];
  let loadErasedContentFilter: (typeof import("@/services/memory/erasure-suppression"))["loadErasedContentFilter"];

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
  /** Every file named as given, with the same text, under its name as its id. */
  const shareFolder = (folder: string, names: string[]) =>
    upstream.folders.set(
      folder,
      names.map((name) => ({
        id: name,
        name,
        mimeType: "application/pdf",
        checksum: "v1",
        fileType: "pdf" as const,
        text: OFFER_TEXT,
      })),
    );

  async function record(sourceId: string, externalFileId: string) {
    return db.sourceFile.findUniqueOrThrow({
      where: { sourceId_externalFileId: { sourceId, externalFileId } },
      select: { episodeId: true, episodeIds: true, chunkIds: true },
    });
  }

  /** How many passages each file has stored, by file name. */
  async function storedPassages(sourceId: string, names: string[]): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const name of names) {
      const { chunkIds } = await record(sourceId, name);
      counts[name] = await db.memoryChunk.count({ where: { id: { in: chunkIds } } });
    }
    return counts;
  }

  const each = (names: string[], n: number) => Object.fromEntries(names.map((name) => [name, n]));

  async function feedText(orgId: string): Promise<string> {
    const events = await db.changeEvent.findMany({ where: { orgId }, select: { summary: true } });
    return events.map((e) => e.summary).join("\n");
  }

  async function wipe(): Promise<void> {
    for (const orgId of [ORG, OTHER]) {
      await db.changeEvent.deleteMany({ where: { orgId } });
      await db.factEdge.deleteMany({ where: { orgId } });
      await db.memoryChunk.deleteMany({ where: { orgId } });
      await db.erasureSuppression.deleteMany({ where: { orgId } });
      await db.auditLog.deleteMany({ where: { orgId } });
      await deleteOrgsWithRetry(db, { where: { id: orgId } });
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
    ({ reapplyErasures } = await import("@/services/memory/erasure-reapply"));
    ({ loadErasedContentFilter } = await import("@/services/memory/erasure-suppression"));
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
    for (const [orgId, hb, adminId] of [
      [ORG, HB, ADMIN],
      [OTHER, OTHER_HB, OTHER_ADMIN],
    ] as const) {
      await db.org.create({ data: { id: orgId, name: orgId } });
      await db.user.create({
        data: { id: adminId, orgId, email: `${adminId}@joinedname.test`, role: "admin", clerkId: `clerk-${adminId}` },
      });
      const rootScope = await db.scope.create({ data: { orgId, path: `org_${orgId}`, name: "root" } });
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
        { id: DRIVE.id, orgId: ORG, type: "gdrive", externalId: DRIVE.folder, name: "Offers Drive", scopePath: HB },
        {
          id: OTHER_DRIVE.id,
          orgId: OTHER,
          type: "gdrive",
          externalId: OTHER_DRIVE.folder,
          name: "Offers Drive",
          scopePath: OTHER_HB,
        },
        { id: SLACK.id, orgId: ORG, type: "slack", externalId: SLACK.channel, name: "#hiring", scopePath: HB },
      ],
    });
  });

  it("after her erasure, a file named her way in any spelling is never written, and bystanders' files are", async () => {
    await erasePerson(admin(ORG), { contactId: `dana-${ORG}` });
    shareFolder(DRIVE.folder, [...HER_FILES, ...BYSTANDER_FILES]);
    shareFolder(OTHER_DRIVE.folder, [...HER_FILES, ...BYSTANDER_FILES]);
    upstream.channels.set(SLACK.channel, [
      {
        id: "m1",
        text: "Signed copy is Dana_Whitfield_offer.pdf",
        checksum: "a",
        user: "U-ANA",
        ts: "1760000000.000100",
      },
      {
        id: "m2",
        text: "Ping @dana.whitfield about the start date",
        checksum: "b",
        user: "U-ANA",
        ts: "1760000000.000200",
      },
      { id: "m3", text: "Danaher_offer.pdf is signed too", checksum: "c", user: "U-ANA", ts: "1760000000.000300" },
      {
        id: "m4",
        text: "Draft at https://drive.example/Dana%20Whitfield%20offer.pdf",
        checksum: "d",
        user: "U-ANA",
        ts: "1760000000.000400",
      },
    ]);

    await sync(ORG, DRIVE.id);
    await sync(OTHER, OTHER_DRIVE.id);
    await sync(ORG, SLACK.id);

    expect(await storedPassages(DRIVE.id, HER_FILES)).toEqual(each(HER_FILES, 0));
    for (const name of HER_FILES) expect((await record(DRIVE.id, name)).episodeIds).toEqual([]);
    expect(await storedPassages(DRIVE.id, BYSTANDER_FILES)).toEqual(each(BYSTANDER_FILES, 2));
    // The other org erased nobody: every file is written there.
    expect(await storedPassages(OTHER_DRIVE.id, [...HER_FILES, ...BYSTANDER_FILES])).toEqual(
      each([...HER_FILES, ...BYSTANDER_FILES], 2),
    );
    // A Slack message is one episode, recorded as `episodeId`.
    for (const id of ["m1", "m2", "m4"]) expect((await record(SLACK.id, id)).episodeId).toBeNull();
    expect((await record(SLACK.id, "m3")).episodeId).not.toBeNull();
    const slackEpisodes = [...graph.live.values()].filter(
      (content) => content.includes("start date") || content.includes("signed"),
    );
    expect(slackEpisodes.some((content) => /Danaher_offer/.test(content))).toBe(true);
    expect(slackEpisodes.some((content) => /Dana_Whitfield|dana\.whitfield|Dana%20Whitfield/.test(content))).toBe(
      false,
    );
    const feed = await feedText(ORG);
    for (const name of HER_FILES) expect(feed).not.toContain(name);
    for (const name of BYSTANDER_FILES) expect(feed).toContain(name);
  });

  it("a file named her way before her erasure goes with it in every spelling, and stays gone on the next sync", async () => {
    shareFolder(DRIVE.folder, [...HER_FILES, ...BYSTANDER_FILES]);
    shareFolder(OTHER_DRIVE.folder, [...HER_FILES, ...BYSTANDER_FILES]);
    await sync(ORG, DRIVE.id);
    await sync(OTHER, OTHER_DRIVE.id);
    const hers = await Promise.all(HER_FILES.map((name) => record(DRIVE.id, name)));
    expect(hers.every((file) => file.chunkIds.length === 2)).toBe(true);

    await erasePerson(admin(ORG), { contactId: `dana-${ORG}` });

    expect(await storedPassages(DRIVE.id, HER_FILES)).toEqual(each(HER_FILES, 0));
    for (const file of hers)
      for (const episodeId of file.episodeIds) expect(graph.live.has(`${HB}/${episodeId}`)).toBe(false);
    expect(await storedPassages(DRIVE.id, BYSTANDER_FILES)).toEqual(each(BYSTANDER_FILES, 2));
    expect(await storedPassages(OTHER_DRIVE.id, HER_FILES)).toEqual(each(HER_FILES, 2));
    const feed = await feedText(ORG);
    for (const name of HER_FILES) expect(feed).not.toContain(name);
    for (const name of BYSTANDER_FILES) expect(feed).toContain(name);
    expect(await feedText(OTHER)).toContain(HER_FILES[0]);

    // Unchanged upstream: skipped by checksum, nothing written back.
    await sync(ORG, DRIVE.id);
    expect(await storedPassages(DRIVE.id, HER_FILES)).toEqual(each(HER_FILES, 0));
  });

  it("a backup restored after her erasure: the read filter hides her copies and re-apply removes them, in that org only", async () => {
    const before = new Date(Date.now() - 3_600_000);
    const contents = {
      hers: [
        "Offer letter: Dana_Whitfield_offer.pdf",
        "Owner: dana_whitfield",
        "Review DanaWhitfieldOffer.pdf",
        "Mail dana.whitfield@acme.test",
      ],
      bystanders: [
        "Owner Danaher_offer.pdf",
        "Owner Diana_Whitfield",
        "Owner Ana Dana-Whitfield",
        "Owner Dana/Whitfield",
      ],
    };
    const vector = `[${[1, ...Array(DIMENSIONS - 1).fill(0)].join(",")}]`;
    const insert = async (orgId: string, scopePath: string, id: string, content: string, createdAt: Date) =>
      db.$executeRaw`
        INSERT INTO memory_chunks ("id","orgId","content","source","actorType","entityName","scopePath","embedding","createdAt")
        VALUES (${id}, ${orgId}, ${content}, 'mcp', 'agent', 'Offers', ${scopePath}, ${vector}::vector, ${createdAt})`;
    const all = [...contents.hers, ...contents.bystanders];
    const backup = async () => {
      for (const [i, content] of all.entries()) {
        await insert(ORG, HB, `restored-${i}`, content, before);
        await insert(OTHER, OTHER_HB, `other-restored-${i}`, content, before);
      }
    };
    await backup();
    await erasePerson(admin(ORG), { contactId: `dana-${ORG}` });
    // What the erasure removed comes back from the backup, as it stood before.
    await db.memoryChunk.deleteMany({ where: { id: { startsWith: "restored-" } } });
    await db.memoryChunk.deleteMany({ where: { id: { startsWith: "other-restored-" } } });
    await backup();
    // Written after the erasure on purpose: a new act, served as usual.
    await insert(ORG, HB, "after-erasure", "Rehired: Dana_Whitfield_offer_2.pdf", new Date(Date.now() + 1000));

    const filter = await loadErasedContentFilter(ORG);
    expect(all.map((content) => filter(content, before))).toEqual([
      ...contents.hers.map(() => true),
      ...contents.bystanders.map(() => false),
    ]);
    const otherFilter = await loadErasedContentFilter(OTHER);
    expect(all.some((content) => otherFilter(content, before))).toBe(false);

    const result = await reapplyErasures(admin(ORG));

    expect(result.chunksRemoved).toBe(contents.hers.length);
    const left = (await db.memoryChunk.findMany({ where: { orgId: ORG }, select: { content: true } }))
      .map((c) => c.content)
      .sort();
    expect(left).toEqual([...contents.bystanders, "Rehired: Dana_Whitfield_offer_2.pdf"].sort());
    expect(await db.memoryChunk.count({ where: { orgId: OTHER, id: { startsWith: "other-restored-" } } })).toBe(
      all.length,
    );
    // Idempotent: a second run finds nothing.
    expect((await reapplyErasures(admin(ORG))).chunksRemoved).toBe(0);
  });

  // The rule is that over-erasure is worse than under-erasure.
  // Another person's file whose name continues hers with a hyphen-joined word, and a report whose
  // bibliography cites an author with the double surname Dana-Whitfield, are not hers. The
  // spaced rule already keeps "Dana Whitfield-Barnes"; a slug or a citation must not undo that.
  it("QA: another person's kebab-named file and a report citing a double surname survive her erasure, before and after", async () => {
    const othersFiles = ["dana-whitfield-barnes-cv.pdf"];
    const reportName = "Pricing_report_2019.pdf";
    const reportText = "Prices grew in every region.\n\n[3] Dana-Whitfield, A. Pricing at scale. 2019.";
    upstream.folders.set(DRIVE.folder, [
      ...othersFiles.map((name) => ({
        id: name,
        name,
        mimeType: "application/pdf",
        checksum: "v1",
        fileType: "pdf" as const,
        text: OFFER_TEXT,
      })),
      {
        id: reportName,
        name: reportName,
        mimeType: "application/pdf",
        checksum: "v1",
        fileType: "pdf" as const,
        text: reportText,
      },
    ]);
    await sync(ORG, DRIVE.id);
    expect(await storedPassages(DRIVE.id, [...othersFiles, reportName])).toEqual(each([...othersFiles, reportName], 2));

    await erasePerson(admin(ORG), { contactId: `dana-${ORG}` });

    expect(await storedPassages(DRIVE.id, [...othersFiles, reportName])).toEqual(each([...othersFiles, reportName], 2));
    const filter = await loadErasedContentFilter(ORG);
    expect(filter("[3] Dana-Whitfield, A. Pricing at scale. 2019.", new Date(Date.now() - 3_600_000))).toBe(false);
  });
});
