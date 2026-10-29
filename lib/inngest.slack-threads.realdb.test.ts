// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A Slack channel's thread replies reach memory, and leave it only when Slack
// shows them gone. `conversations.history` lists a thread's parent and not its
// replies, so a sync that read only the history never stored a reply. The claim
// under test: a sync stores each reply as an item of its own, retires a reply
// deleted from a thread it read whole, and keeps the replies of a thread whose
// parent is older than what the sync reads, since nothing it read shows them gone.
//
// Real: Postgres, the whole sourceSync job, the Slack connector's own listing
// code (services/connectors/slack.ts) against Web API payloads in Slack's shape
// (services/connectors/fixtures/slack-figma.ts), the stored cursor and the change
// feed. Doubles: the memory store's ingest and the graph store's episode delete.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import {
  fakeSlack,
  slackMessage,
  type FakeSlackState,
  type SlackMessagePayload,
} from "@/services/connectors/fixtures/slack-figma";

// SLACK_MOCK is read when slack.ts is imported; the real branch is the one under test.
vi.hoisted(() => vi.stubEnv("SLACK_MOCK", "false"));

/** The stores: live episodes by group and id, with the text each holds. */
const graph = vi.hoisted(() => {
  const live = new Map<string, string>(); // `${group}/${id}` -> content
  let nextId = 0;
  return {
    live,
    reset() {
      live.clear();
      nextId = 0;
    },
    texts: () => [...live.values()].sort(),
    memory: {
      ingest: async (input: { scopePath?: string; groupId: string; content: string }) => {
        const episodeId = `episode-${++nextId}`;
        live.set(`${input.scopePath ?? input.groupId}/${episodeId}`, input.content);
        return { episodeId };
      },
    },
    graphitiStore: {
      removeEpisode: async ({ groupId, episodeId }: { groupId: string; episodeId: string }) => ({
        removed: live.delete(`${groupId}/${episodeId}`),
      }),
      dedupeNodes: async () => 0,
    },
  };
});

vi.mock("@/lib/crypto", () => ({ unsealSecret: () => ({ token: "slack-token" }) }));
vi.mock("@/services/memory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory")>()),
  memory: graph.memory,
  graphitiStore: graph.graphitiStore,
}));
vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
}));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-slack-threads";
const SOURCE_ID = "src-qa-slack-threads";
const CHANNEL = "C0THREADS";
const SCOPE = "org_qa_slack.eng";
/** `slackMessage` posts message n at 1_791_000_000 + n seconds; this many seconds ago is `ago(seconds)`. */
const ago = (seconds: number) => Math.floor(Date.now() / 1000) - 1_791_000_000 - seconds;

type StepCtx = {
  event: { data: unknown };
  step: { run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T> };
};

describe.skipIf(!QA_URL)("Slack sync of a channel's thread replies", () => {
  let db: PrismaClient;
  let inngestModule: typeof import("./inngest");
  let channel: FakeSlackState;
  let recent: SlackMessagePayload;
  let old: SlackMessagePayload;

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith("https://slack.com/api/")) throw new Error(`unexpected fetch to ${url}`);
      return fakeSlack(channel).fetch(input);
    });
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    inngestModule = await import("./inngest");
  });

  afterAll(async () => {
    await db.$disconnect();
    vi.unstubAllGlobals();
  });

  beforeEach(async () => {
    graph.reset();
    // A thread started two hours ago, older than what a sync after the first
    // reads again, and one started ten minutes ago, which every sync reads.
    old = slackMessage(ago(7200), "U0BLAKE", "Which region do we launch in first?", { reply_count: 2 });
    recent = slackMessage(ago(600), "U0AVERY", "Freeze moves to Thursday?", { reply_count: 3 });
    for (const parent of [old, recent]) parent.thread_ts = parent.ts;
    const reply = (parent: SlackMessagePayload, second: number, user: string, text: string) =>
      slackMessage(second, user, text, { thread_ts: parent.ts, parent_user_id: parent.user });
    channel = {
      messages: [old, recent],
      replies: new Map([
        [
          old.ts,
          [
            reply(old, ago(7000), "U0AVERY", "EU first, the DPA is signed."),
            reply(old, ago(6900), "U0CASEY", "Agreed, EU first."),
          ],
        ],
        [
          recent.ts,
          [
            reply(recent, ago(500), "U0BLAKE", "Yes, Thursday 2pm."),
            reply(recent, ago(400), "U0CASEY", "Dry run Wednesday at 10."),
            reply(recent, ago(300), "U0AVERY", "Confirmed, Thursday 2pm."),
          ],
        ],
      ]),
      error: null,
      rateLimited: false,
    };
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
    await db.source.deleteMany({ where: { id: SOURCE_ID } });
    await db.source.create({
      data: { id: SOURCE_ID, orgId: ORG, type: "slack", externalId: CHANNEL, name: "#launch", scopePath: SCOPE },
    });
  });

  const runSync = () => {
    const ctx: StepCtx = {
      event: { data: { sourceId: SOURCE_ID, orgId: ORG, sealedToken: "sealed-slack-token" } },
      step: { run: async (_name, fn) => fn() },
    };
    return (inngestModule.sourceSync as unknown as { fn: (ctx: StepCtx) => Promise<unknown> }).fn(ctx);
  };

  const storedIds = async () =>
    (await db.sourceFile.findMany({ where: { sourceId: SOURCE_ID }, select: { externalFileId: true } }))
      .map((f) => f.externalFileId)
      .sort();

  it("stores every reply of both threads as an item of its own, under its thread", async () => {
    await runSync();

    const replyIds = [old, recent].flatMap((p) => channel.replies.get(p.ts)!.map((r) => `${p.ts}/${r.ts}`));
    expect(await storedIds()).toEqual([old.ts, recent.ts, ...replyIds].sort());
    expect(graph.texts()).toEqual([
      "Agreed, EU first.",
      "Confirmed, Thursday 2pm.",
      "Dry run Wednesday at 10.",
      "EU first, the DPA is signed.",
      "Freeze moves to Thursday?",
      "Which region do we launch in first?",
      "Yes, Thursday 2pm.",
    ]);
    const source = await db.source.findUniqueOrThrow({ where: { id: SOURCE_ID } });
    expect(source.status).toBe("active");
  });

  it("retires a reply deleted from a thread it read whole, and keeps the replies of an older thread it did not read", async () => {
    await runSync();
    const deleted = channel.replies.get(recent.ts)![1];
    channel.replies.set(
      recent.ts,
      channel.replies.get(recent.ts)!.filter((r) => r !== deleted),
    );
    // Every reply of the older thread is gone too, but this sync does not read
    // back to its parent, so nothing it reads shows them gone.
    channel.replies.set(old.ts, []);

    await runSync();

    expect(await storedIds()).not.toContain(`${recent.ts}/${deleted.ts}`);
    expect(graph.texts()).not.toContain("Dry run Wednesday at 10.");
    expect(graph.texts()).toEqual(
      expect.arrayContaining(["EU first, the DPA is signed.", "Agreed, EU first.", "Yes, Thursday 2pm."]),
    );
    const deletes = await db.changeEvent.findMany({ where: { orgId: ORG, op: "delete" } });
    expect(deletes).toHaveLength(1);
  });

  it("stores every reply of a channel whose threads outrun one sync's reply reads, resuming from the stored cursor", async () => {
    // 250 threads started over two hours ago: once the first pass ends, no later
    // pass reads back to their parents, so a thread not kept waiting is never read.
    const parents = Array.from({ length: 250 }, (_, i) => {
      const parent = slackMessage(ago(7200 + i), "U0BLAKE", `Update ${i + 1}`, { reply_count: 1 });
      parent.thread_ts = parent.ts;
      return parent;
    });
    channel.messages = [...parents].reverse(); // oldest first, as the fixture keeps a channel
    channel.replies = new Map(
      parents.map((parent, i) => [
        parent.ts,
        [
          slackMessage(ago(3000 + i), "U0CASEY", `Reply to update ${i + 1}`, {
            thread_ts: parent.ts,
            parent_user_id: parent.user,
          }),
        ],
      ]),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    for (let sync = 0; sync < 20; sync++) await runSync();

    const replyIds = parents.map((p) => `${p.ts}/${channel.replies.get(p.ts)![0].ts}`);
    const stored = new Set(await storedIds());
    expect(replyIds.filter((id) => !stored.has(id))).toEqual([]);
    expect(warn.mock.calls.filter(([message]) => String(message).includes("not kept waiting"))).toEqual([]);
    warn.mockRestore();
  }, 30_000);
});
