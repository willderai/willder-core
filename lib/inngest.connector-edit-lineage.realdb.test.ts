// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// What replaced a connector item's old version, and what its new version replaced, as the
// audit Timeline and the change feed answer it after an upstream edit.
//
// An edit retires the item's old episode and ingests its new content
// (lib/inngest/connector-text-items.ts, connector-drive-files.ts). The new episode's
// transaction records a `supersedes` edge to the old one, so GET /api/audit/timeline/:changeId
// names each version from the other (`replacedById`, `replacesIds`), and an agent's change
// feed marks the old version's create as superseded. Only when both versions are in one scope:
// an edit written after the source moved to another scope names nothing, exactly as an item
// deleted upstream does, so a reader of the old scope learns no id from the new one.
//
// Real: Postgres, the whole sourceSync job for a Slack channel and a Drive folder, the
// Timeline detail route under its real check() gates, the change feed, the erased-person
// check. Doubles: the signed-in session, the graph store (episodes per group, numbered per
// org, so two orgs hand out the same episode ids), Slack, Drive, Blob storage and the
// embedding service.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { ChangeOp } from "@/lib/generated/prisma/enums";
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

/** The graph store, reduced to what a sync uses: episodes keyed by group, numbered per org. */
const graph = vi.hoisted(() => {
  const episodes = new Map<string, string>();
  const counters = new Map<string, number>();
  const write = (input: { scopePath?: string; groupId: string; content: string }) => {
    const n = (counters.get(input.groupId) ?? 0) + 1;
    counters.set(input.groupId, n);
    const id = `ep-${n}`;
    episodes.set(`${input.scopePath ?? input.groupId}/${id}`, input.content);
    return id;
  };
  return {
    episodes,
    reset() {
      episodes.clear();
      counters.clear();
    },
    store: {
      ingest: async (input: { scopePath?: string; groupId: string; content: string }) => ({ episodeId: write(input) }),
      ingestBulk: async (inputs: { scopePath?: string; groupId: string; content: string }[]) => inputs.map(write),
      extractFile: async ({ url }: { url: string }) => ({ chunks: blobs.get(url)!.split("\n\n") }),
      removeEpisode: async ({ groupId, episodeId }: { groupId: string; episodeId: string }) => ({
        removed: episodes.delete(`${groupId}/${episodeId}`),
      }),
      dedupeNodes: async () => 0,
    },
  };
});
const blobs = vi.hoisted(() => new Map<string, string>());
/** What Slack lists per channel, and what Drive lists per folder. */
const upstream = vi.hoisted(() => ({
  channels: new Map<string, { id: string; text: string; checksum: string; user: string; ts: string }[]>(),
  folders: new Map<
    string,
    { id: string; name: string; mimeType: string; checksum: string; fileType: "pdf"; text: string }[]
  >(),
}));
const session = vi.hoisted(() => ({ current: null as unknown }));

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
vi.mock("@/lib/access-context", () => ({ requireAccessContext: async () => session.current }));
vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
}));

const QA_URL = process.env.QA_DATABASE_URL;
const DIMENSIONS = 384;

const ORG = "lineagesync";
const ROOT = `org_${ORG}`;
/** The handbook scope, and a sibling whose path starts with the same letters. */
const HB = `${ROOT}.hb`;
const HBX = `${ROOT}.hbx`;
const ADMIN = "u-lineagesync-admin";
/** A second org whose scopes and episode ids are spelled exactly like the first's. */
const OTHER = "lineagesync2";
const OTHER_ROOT = `org_${OTHER}`;
const OTHER_HB = `${OTHER_ROOT}.hb`;
const OTHER_ADMIN = "u-lineagesync2-admin";

const SLACK = { id: "src-lineage-slack", channel: "C-HANDBOOK" };
const OTHER_SLACK = { id: "src-lineage-slack-2", channel: "C-HANDBOOK" };
const DRIVE = { id: "src-lineage-drive", folder: "folder-handbook" };

type StepCtx = {
  event: { data: unknown };
  step: { run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T> };
};

/** The lineage half of a Timeline change detail. */
type Lineage = {
  replacedById: string | null;
  replacesIds: string[];
  replacedBy: { id: string; change: { id: string } | null } | null;
  replaces: { id: string; change: { id: string } | null }[];
};

describe.skipIf(!QA_URL)("a connector item edited upstream names what replaced it and what it replaced", () => {
  let db: PrismaClient;
  let sourceSync: { fn: (ctx: StepCtx) => Promise<unknown> };
  let timelineChange: (typeof import("@/app/api/audit/timeline/[changeId]/route"))["GET"];
  let readChanges: (typeof import("@/services/memory/change-feed"))["readChanges"];
  let recordSuppressions: (typeof import("@/services/memory/erasure-suppression"))["recordSuppressions"];

  const asAdmin = (orgId: string, userId: string) => {
    session.current = {
      org: { id: orgId, name: orgId },
      user: { id: userId, name: userId },
      ctx: { orgId, actor: { type: "human", id: userId, role: "admin" }, origin: "app" },
    };
  };

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

  /** The org's fact events, oldest first, as `op recordId@scope`. */
  async function feed(orgId: string): Promise<string[]> {
    const events = await db.changeEvent.findMany({ where: { orgId, recordType: "fact" }, orderBy: { seq: "asc" } });
    return events.map((e) => `${e.op} ${e.recordId}@${e.scopePath}`);
  }

  /** The id of the change event `op` recorded on `recordId`. */
  async function changeOn(orgId: string, op: ChangeOp, recordId: string): Promise<string> {
    return (await db.changeEvent.findFirstOrThrow({ where: { orgId, op, recordId }, select: { id: true } })).id;
  }

  /** GET /api/audit/timeline/:changeId as the org's admin, reading `scope`. */
  async function detail(
    orgId: string,
    changeId: string,
    scope: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    asAdmin(orgId, orgId === ORG ? ADMIN : OTHER_ADMIN);
    const res = await timelineChange(
      new Request(`http://t/api/audit/timeline/${changeId}?scope=${encodeURIComponent(scope)}`),
      { params: Promise.resolve({ changeId }) },
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  async function lineage(orgId: string, changeId: string, scope: string): Promise<Lineage> {
    const res = await detail(orgId, changeId, scope);
    expect(res.status).toBe(200);
    const { replacedById, replacesIds, replacedBy, replaces } = res.body as unknown as Lineage;
    return { replacedById, replacesIds, replacedBy, replaces };
  }

  /** An agent holding a read token on `scope` alone. */
  async function agentReading(orgId: string, agentId: string, scope: string): Promise<AccessContext> {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath: scope,
        permission: "read",
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    return { orgId, actor: { type: "agent", id: agentId, capabilityToken: token }, origin: "mcp" };
  }

  async function wipe(): Promise<void> {
    for (const orgId of [ORG, OTHER]) {
      await db.changeEvent.deleteMany({ where: { orgId } });
      await db.factEdge.deleteMany({ where: { orgId } });
      await db.memoryChunk.deleteMany({ where: { orgId } });
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
    ({ GET: timelineChange } = await import("@/app/api/audit/timeline/[changeId]/route"));
    ({ readChanges } = await import("@/services/memory/change-feed"));
    ({ recordSuppressions } = await import("@/services/memory/erasure-suppression"));
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
    for (const [orgId, root, admin, scopes] of [
      [ORG, ROOT, ADMIN, [HB, HBX]],
      [OTHER, OTHER_ROOT, OTHER_ADMIN, [OTHER_HB]],
    ] as const) {
      await db.org.create({ data: { id: orgId, name: orgId } });
      await db.user.create({
        data: { id: admin, orgId, email: `${admin}@lineage.test`, role: "admin", clerkId: `clerk-${admin}` },
      });
      const rootScope = await db.scope.create({ data: { orgId, path: root, name: "root" } });
      for (const path of scopes) await db.scope.create({ data: { orgId, path, name: path } });
      await db.grant.create({
        data: { orgId, scopeId: rootScope.id, granteeType: "user", granteeId: admin, permission: "admin" },
      });
    }
    await db.source.createMany({
      data: [
        { id: SLACK.id, orgId: ORG, type: "slack", externalId: SLACK.channel, name: "#handbook", scopePath: HB },
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

  it("an edited message: the old version names the new one as its replacement, and the new one names the old", async () => {
    say(SLACK.channel, [{ id: "m1", text: "Incidents get a channel within five minutes." }]);
    await sync(ORG, SLACK.id);
    say(SLACK.channel, [{ id: "m1", text: "Incidents get a channel within two minutes." }]);
    await sync(ORG, SLACK.id);

    expect(await feed(ORG)).toEqual([`create ep-1@${HB}`, `supersede ep-1@${HB}`, `create ep-2@${HB}`]);
    const [supersede, created, original] = await Promise.all([
      changeOn(ORG, "supersede", "ep-1"),
      changeOn(ORG, "create", "ep-2"),
      changeOn(ORG, "create", "ep-1"),
    ]);
    expect(await lineage(ORG, supersede, HB)).toEqual({
      replacedById: "ep-2",
      replacesIds: [],
      replacedBy: { id: "ep-2", change: expect.objectContaining({ id: created }) },
      replaces: [],
    });
    expect(await lineage(ORG, created, HB)).toEqual({
      replacedById: null,
      replacesIds: ["ep-1"],
      replacedBy: null,
      replaces: [{ id: "ep-1", change: expect.objectContaining({ id: original }) }],
    });
    // An agent reading the handbook sees the old version's create marked with what replaced it.
    const { changes } = await readChanges(await agentReading(ORG, "agent-reader", HB), HB, { limit: 50 });
    expect(changes.filter((c) => c.op === "create").map((c) => [c.recordId, c.supersededById])).toEqual([
      ["ep-1", "ep-2"],
      ["ep-2", null],
    ]);
  });

  it("edited twice: each version names its neighbours, and a re-run of the sync records nothing twice", async () => {
    for (const text of ["Deploys freeze on Friday.", "Deploys freeze on Thursday.", "Deploys freeze on Friday."]) {
      say(SLACK.channel, [{ id: "m1", text }]);
      await sync(ORG, SLACK.id);
    }
    await sync(ORG, SLACK.id);

    const edges = await db.factEdge.findMany({
      where: { orgId: ORG, kind: "supersedes" },
      select: { fromId: true, toId: true },
    });
    expect(edges.map((e) => `${e.fromId}>${e.toId}`).sort()).toEqual(["ep-2>ep-1", "ep-3>ep-2"]);
    expect(await lineage(ORG, await changeOn(ORG, "create", "ep-2"), HB)).toMatchObject({
      replacedById: "ep-3",
      replacesIds: ["ep-1"],
    });
    expect(await lineage(ORG, await changeOn(ORG, "supersede", "ep-2"), HB)).toMatchObject({
      replacedById: "ep-3",
      replacesIds: ["ep-1"],
    });
    expect(await lineage(ORG, await changeOn(ORG, "create", "ep-3"), HB)).toMatchObject({
      replacedById: null,
      replacesIds: ["ep-2"],
    });
  });

  it("an edit whose new episode fails to land names no replacement, and nor does the sync that retries it", async () => {
    say(SLACK.channel, [{ id: "m1", text: "Retros are on Fridays." }]);
    await sync(ORG, SLACK.id);
    say(SLACK.channel, [{ id: "m1", text: "Retros are on Thursdays." }]);
    const ingest = vi.spyOn(graph.store, "ingest").mockRejectedValueOnce(new Error("memory service unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await sync(ORG, SLACK.id);
    ingest.mockRestore();
    // The old episode is gone and announced as superseded, with nothing yet to name.
    expect(await feed(ORG)).toEqual([`create ep-1@${HB}`, `supersede ep-1@${HB}`]);
    expect(await db.factEdge.count({ where: { orgId: ORG } })).toBe(0);

    // The retry finds no episode on record to retire, so it writes the edit as a new item.
    await sync(ORG, SLACK.id);
    expect(await feed(ORG)).toEqual([`create ep-1@${HB}`, `supersede ep-1@${HB}`, `create ep-2@${HB}`]);
    expect(await db.factEdge.count({ where: { orgId: ORG } })).toBe(0);
    expect(await lineage(ORG, await changeOn(ORG, "supersede", "ep-1"), HB)).toMatchObject({ replacedById: null });
  });

  it("an edit synced after the source moved scope names no replacement, exactly as an item deleted upstream", async () => {
    say(SLACK.channel, [
      { id: "m1", text: "On-call hands over at nine." },
      { id: "m2", text: "Postmortems are due in a week." },
    ]);
    await sync(ORG, SLACK.id);
    // The records a sync leaves pinned to the old scope when a reconnect moves the source
    // under it (lib/inngest/connector-records.ts, isWrittenAt): the next sync writes the
    // edited message at the new scope and retires the old one from where it was.
    await db.source.update({ where: { id: SLACK.id }, data: { scopePath: HBX } });
    say(SLACK.channel, [{ id: "m1", text: "On-call hands over at ten." }]);
    await sync(ORG, SLACK.id);

    expect(await feed(ORG)).toEqual([
      `create ep-1@${HB}`,
      `create ep-2@${HB}`,
      `supersede ep-1@${HB}`,
      `create ep-3@${HBX}`,
      `delete ep-2@${HB}`,
    ]);
    expect(await db.factEdge.count({ where: { orgId: ORG, kind: "supersedes" } })).toBe(0);

    const nothing: Lineage = { replacedById: null, replacesIds: [], replacedBy: null, replaces: [] };
    const deleted = await lineage(ORG, await changeOn(ORG, "delete", "ep-2"), HB);
    expect(deleted).toEqual(nothing);
    expect(await lineage(ORG, await changeOn(ORG, "supersede", "ep-1"), HB)).toEqual(deleted);
    expect(await lineage(ORG, await changeOn(ORG, "create", "ep-3"), HBX)).toEqual(nothing);
    // A reader of the old scope is shown nothing from the new one: the old create is unmarked,
    // like the deleted message's.
    const { changes } = await readChanges(await agentReading(ORG, "agent-hb", HB), HB, { limit: 50 });
    expect(changes.filter((c) => c.op === "create").map((c) => [c.recordId, c.supersededById])).toEqual([
      ["ep-1", null],
      ["ep-2", null],
    ]);
  });

  it("two orgs with the same scope names and episode ids: each answers from its own edges, and neither reads the other's change", async () => {
    for (const [orgId, source] of [
      [ORG, SLACK],
      [OTHER, OTHER_SLACK],
    ] as const) {
      say(source.channel, [{ id: "m1", text: `${orgId}: standup is at nine.` }]);
      await sync(orgId, source.id);
    }
    // Only the other org edits its message.
    say(OTHER_SLACK.channel, [{ id: "m1", text: `${OTHER}: standup is at ten.` }]);
    await sync(OTHER, OTHER_SLACK.id);

    expect(await db.factEdge.count({ where: { orgId: ORG } })).toBe(0);
    expect(await db.factEdge.findMany({ where: { orgId: OTHER }, select: { fromId: true, toId: true } })).toEqual([
      { fromId: "ep-2", toId: "ep-1" },
    ]);
    // The same episode id in this org was never replaced.
    expect(await lineage(ORG, await changeOn(ORG, "create", "ep-1"), HB)).toMatchObject({
      replacedById: null,
      replacesIds: [],
    });
    expect(await lineage(OTHER, await changeOn(OTHER, "create", "ep-1"), OTHER_HB)).toMatchObject({
      replacedById: "ep-2",
    });
    // This org's admin, reading this org's scope of the same name, cannot read the other org's change.
    const foreign = await detail(ORG, await changeOn(OTHER, "supersede", "ep-1"), HB);
    expect(foreign.status).toBe(404);
  });

  it("an edit whose new text names an erased person writes nothing, and the old version names no replacement", async () => {
    say(SLACK.channel, [{ id: "m1", text: "Escalations go to the support lead." }]);
    await sync(ORG, SLACK.id);
    await recordSuppressions(db, ORG, "erasure-1", { emails: [], names: ["Dana Whitfield"], contactIds: [] });
    say(SLACK.channel, [{ id: "m1", text: "Escalations go to Dana Whitfield." }]);
    await sync(ORG, SLACK.id);

    expect(await feed(ORG)).toEqual([`create ep-1@${HB}`, `supersede ep-1@${HB}`]);
    expect(await db.factEdge.count({ where: { orgId: ORG } })).toBe(0);
    expect(await lineage(ORG, await changeOn(ORG, "supersede", "ep-1"), HB)).toEqual({
      replacedById: null,
      replacesIds: [],
      replacedBy: null,
      replaces: [],
    });
  });

  it("an edited Drive file: each old part names the new version's first part, which names every old part", async () => {
    shareFolder(DRIVE.folder, [{ id: "plan", checksum: "v1", text: "Launch is in March.\n\nOwner is Priya." }]);
    await sync(ORG, DRIVE.id);
    shareFolder(DRIVE.folder, [
      { id: "plan", checksum: "v2", text: "Launch moved to April.\n\nOwner is Priya.\n\nBudget is 40k." },
    ]);
    await sync(ORG, DRIVE.id);

    expect(await feed(ORG)).toEqual([
      `create ep-1@${HB}`,
      `create ep-2@${HB}`,
      `supersede ep-1@${HB}`,
      `supersede ep-2@${HB}`,
      `create ep-3@${HB}`,
      `create ep-4@${HB}`,
      `create ep-5@${HB}`,
    ]);
    for (const old of ["ep-1", "ep-2"]) {
      expect(await lineage(ORG, await changeOn(ORG, "supersede", old), HB)).toMatchObject({
        replacedById: "ep-3",
        replacesIds: [],
      });
    }
    const first = await lineage(ORG, await changeOn(ORG, "create", "ep-3"), HB);
    expect([...first.replacesIds].sort()).toEqual(["ep-1", "ep-2"]);
    expect(await lineage(ORG, await changeOn(ORG, "create", "ep-4"), HB)).toMatchObject({
      replacedById: null,
      replacesIds: [],
    });
  });

  it("a Drive edit whose every new part names an erased person writes no part, and the old parts name no replacement", async () => {
    shareFolder(DRIVE.folder, [{ id: "plan", checksum: "v1", text: "Launch is in March.\n\nOwner is Priya." }]);
    await sync(ORG, DRIVE.id);
    await recordSuppressions(db, ORG, "erasure-1", { emails: [], names: ["Dana Whitfield"], contactIds: [] });
    shareFolder(DRIVE.folder, [
      { id: "plan", checksum: "v2", text: "Launch is Dana Whitfield's call.\n\nDana Whitfield owns it." },
    ]);
    await sync(ORG, DRIVE.id);

    expect(await feed(ORG)).toEqual([
      `create ep-1@${HB}`,
      `create ep-2@${HB}`,
      `supersede ep-1@${HB}`,
      `supersede ep-2@${HB}`,
    ]);
    expect(await db.factEdge.count({ where: { orgId: ORG } })).toBe(0);
    // The edit was synced, not left pending for the next run to retry.
    expect(
      await db.sourceFile.findFirstOrThrow({
        where: { sourceId: DRIVE.id },
        select: { checksum: true, episodeIds: true },
      }),
    ).toEqual({ checksum: "v2", episodeIds: [] });
    expect(await lineage(ORG, await changeOn(ORG, "supersede", "ep-1"), HB)).toMatchObject({ replacedById: null });
  });

  it("a Drive file synced after the source moved scope names no replacement", async () => {
    shareFolder(DRIVE.folder, [{ id: "plan", checksum: "v1", text: "Launch is in March." }]);
    await sync(ORG, DRIVE.id);
    await db.source.update({ where: { id: DRIVE.id }, data: { scopePath: HBX } });
    shareFolder(DRIVE.folder, [{ id: "plan", checksum: "v2", text: "Launch moved to April." }]);
    await sync(ORG, DRIVE.id);

    expect(await feed(ORG)).toEqual([`create ep-1@${HB}`, `supersede ep-1@${HB}`, `create ep-2@${HBX}`]);
    expect(await db.factEdge.count({ where: { orgId: ORG } })).toBe(0);
    expect(await lineage(ORG, await changeOn(ORG, "supersede", "ep-1"), HB)).toMatchObject({
      replacedById: null,
      replacesIds: [],
    });
  });
});
