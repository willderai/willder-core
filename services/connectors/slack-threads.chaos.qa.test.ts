// A seeded chaos run over the
// real listing code and the Slack fake. Between syncs the channel changes the way a
// busy one does: bursts of new threads (some long enough to span pages), plain posts,
// replies also sent to the channel on old threads, deleted replies, deleted parents
// (a tombstone when replies remain), and deleted posts. While it changes, Slack
// rate-limits some reads and rejects some stored cursors. Then the channel goes quiet.
//
// The claims under test, every seed:
//   (a) no reply is lost: every reply posted with its thread, and every reply also sent
//       to the channel, that still exists at the end is stored at the end;
//   (b) nothing that still exists is retired: no sync names an id gone that Slack still
//       holds at the time of that sync;
//   (c) the sync does not stall: once the faults stop, the threads drain and the
//       history read catches up (no thread waiting, no pass in progress).
// Not claimed (documented limits): a plain reply added to an older thread is read only
// when its parent is listed again.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSlack, slackTombstone, type FakeSlackState, type SlackMessagePayload } from "./fixtures/slack-figma";

const EPOCH = 1_791_000_000;
const SYNC_SECONDS = 2 * 3600;
const START = EPOCH + 3 * 3600;

/** A small seeded PRNG (mulberry32), so a failing seed replays exactly. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe.each([1, 2, 3, 4, 5, 6])("Slack thread read under chaos, seed %i", (seed) => {
  beforeEach(() => vi.stubEnv("SLACK_MOCK", "false"));
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("loses no reply, retires nothing that still exists, and drains once the faults stop", async () => {
    const random = rng(seed);
    const pick = <T>(xs: T[]) => xs[Math.floor(random() * xs.length)];
    const channel: FakeSlackState = { messages: [], replies: new Map(), error: null, rateLimited: false };

    // Time, in microseconds, so ts values never collide and always rise.
    let clock = (EPOCH + 1) * 1_000_000;
    const nextTs = () => {
      clock += 1000 + Math.floor(random() * 5000);
      return `${Math.floor(clock / 1_000_000)}.${String(clock % 1_000_000).padStart(6, "0")}`;
    };
    const byTs = (a: { ts: string }, b: { ts: string }) => Number(a.ts) - Number(b.ts);
    const post = (m: SlackMessagePayload) => {
      channel.messages.push(m);
      channel.messages.sort(byTs);
    };
    const message = (ts: string, text: string, extra: Partial<SlackMessagePayload> = {}): SlackMessagePayload => ({
      type: "message",
      ts,
      user: pick(["U0AVERY", "U0BLAKE", "U0CASEY"]),
      text,
      team: "T0EXAMPLE",
      ...extra,
    });

    /** Ids that must be stored at the end, if they still exist then. */
    const mustArrive = new Set<string>();
    const setReplyCount = (parentTs: string) => {
      const parent = channel.messages.find((m) => m.ts === parentTs);
      const count = channel.replies.get(parentTs)?.length ?? 0;
      if (parent) Object.assign(parent, { reply_count: count, thread_ts: parentTs });
    };
    const addReply = (parentTs: string, broadcast: boolean, expected: boolean) => {
      const ts = nextTs();
      const reply = message(ts, `reply ${ts}`, {
        thread_ts: parentTs,
        ...(broadcast ? { subtype: "thread_broadcast" } : {}),
      });
      channel.replies.set(parentTs, [...(channel.replies.get(parentTs) ?? []), reply].sort(byTs));
      if (broadcast) post({ ...reply });
      setReplyCount(parentTs);
      if (expected || broadcast) mustArrive.add(`${parentTs}/${ts}`);
    };
    const newThread = () => {
      const parentTs = nextTs();
      post(message(parentTs, `thread ${parentTs}`));
      const replies = pick([0, 1, 1, 2, 3, 5, 12, 101, 250]);
      for (let i = 0; i < replies; i++) addReply(parentTs, random() < 0.03, true);
      mustArrive.add(parentTs);
    };
    const parents = () =>
      channel.messages.filter((m) => m.subtype === undefined && (m.thread_ts === undefined || m.thread_ts === m.ts));

    const mutate = () => {
      const burst = random() < 0.15 ? 90 + Math.floor(random() * 60) : Math.floor(random() * 12);
      for (let i = 0; i < burst; i++) newThread();
      for (let i = Math.floor(random() * 10); i > 0; i--) {
        const ts = nextTs();
        post(message(ts, `post ${ts}`));
        mustArrive.add(ts);
      }
      // Replies to older threads: sent to the channel (must arrive), or not (may wait).
      for (let i = Math.floor(random() * 4); i > 0; i--) {
        const parent = pick(parents());
        if (parent) addReply(parent.ts, random() < 0.6, false);
      }
      // Deleted replies.
      for (let i = Math.floor(random() * 6); i > 0; i--) {
        const threadTs = pick([...channel.replies.keys()].filter((ts) => (channel.replies.get(ts)?.length ?? 0) > 0));
        if (!threadTs) continue;
        const replies = channel.replies.get(threadTs)!;
        const gone = pick(replies);
        channel.replies.set(
          threadTs,
          replies.filter((r) => r !== gone),
        );
        channel.messages = channel.messages.filter((m) => !(m.ts === gone.ts && m.subtype === "thread_broadcast"));
        setReplyCount(threadTs);
      }
      // Deleted parents and posts: a tombstone while replies remain.
      for (let i = Math.floor(random() * 3); i > 0; i--) {
        const victim = pick(parents());
        if (!victim) continue;
        const replies = channel.replies.get(victim.ts) ?? [];
        channel.messages = channel.messages.filter((m) => m !== victim);
        if (replies.length > 0) post(slackTombstone({ ...victim, reply_count: replies.length }));
      }
    };

    /** Whether Slack still holds a stored id right now. */
    const exists = (id: string) => {
      const slash = id.indexOf("/");
      if (slash === -1) return channel.messages.some((m) => m.ts === id && !m.subtype);
      return (channel.replies.get(id.slice(0, slash)) ?? []).some((r) => r.ts === id.slice(slash + 1));
    };

    // Faults: rate limits, and stored cursors (those not issued during this sync) rejected.
    let faults = true;
    let issuedThisSync = new Set<string>();
    const slack = fakeSlack(channel);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        const cursor = url.searchParams.get("cursor");
        const isReplies = url.pathname === "/api/conversations.replies";
        if (faults && random() < (isReplies ? 0.03 : 0.02)) {
          return new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
            status: 429,
            headers: { "retry-after": "30" },
          });
        }
        if (faults && cursor && !issuedThisSync.has(cursor) && random() < 0.3) {
          return new Response(JSON.stringify({ ok: false, error: "invalid_cursor" }), { status: 200 });
        }
        const res = await slack.fetch(input);
        const body = (await res.clone().json()) as { response_metadata?: { next_cursor?: string } };
        if (body.response_metadata?.next_cursor) issuedThisSync.add(body.response_metadata.next_cursor);
        return res;
      }),
    );
    const { listChannelMessages } = await import("./slack");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    // The store: what the sync job keeps, and the cursor it keeps only when the listing succeeds.
    const stored = new Set<string>();
    let cursor: Awaited<ReturnType<typeof listChannelMessages>>["cursor"] | undefined;
    const wrongRetirements: string[] = [];
    const CHAOS_SYNCS = 25;
    const QUIET_SYNCS = 160;
    for (let i = 0; i < 20; i++) newThread(); // the channel as connected
    for (let sync = 0; sync < CHAOS_SYNCS + QUIET_SYNCS; sync++) {
      if (sync === CHAOS_SYNCS) faults = false;
      if (sync > 0 && sync < CHAOS_SYNCS) {
        clock = Math.max(clock, (START + (sync - 1) * SYNC_SECONDS) * 1_000_000);
        mutate();
      }
      issuedThisSync = new Set();
      let listing;
      try {
        listing = await listChannelMessages("C1", "tok", {
          cursor,
          stored: [...stored],
          now: (START + sync * SYNC_SECONDS) * 1000,
        });
      } catch {
        continue; // a failed listing keeps the stored cursor, as connector-sync does
      }
      for (const id of listing.gone) {
        if (exists(id)) wrongRetirements.push(`sync ${sync}: ${id}`);
        stored.delete(id);
      }
      for (const m of listing.items) stored.add(m.id);
      cursor = listing.cursor;
    }

    const lost = [...mustArrive].filter((id) => exists(id) && !stored.has(id));
    expect(wrongRetirements, "(b) retired while it still exists").toEqual([]);
    expect(lost.length, `(a) lost: ${lost.slice(0, 5).join(", ")}`).toBe(0);
    expect(cursor?.threads, "(c) threads still waiting after the faults stopped").toBeUndefined();
    expect(cursor?.latest, "(c) a history pass still in progress after the faults stopped").toBeUndefined();
    expect(mustArrive.size).toBeGreaterThan(200);
  }, 120_000);
});
