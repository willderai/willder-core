import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { busySlackChannel, fakeSlack, slackMessage, slackTombstone, type FakeSlackState } from "./fixtures/slack-figma";

// Fixture-backed by default (SLACK_MOCK unset/"true"), read-only real
// branch only reached when SLACK_MOCK=false. These pin both: the mock shape the
// sync job depends on for idempotent re-sync, and that the real branch only ever
// reads (conversations.history and conversations.replies, never a write
// endpoint like chat.postMessage).

describe("services/connectors/slack — mock mode (default)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("returns fixture messages with stable, content-derived checksums", async () => {
    const { listChannelMessages } = await import("./slack");
    const a = await listChannelMessages("C_ANY", "unused-token");
    const b = await listChannelMessages("C_ANY", "unused-token");

    expect(a.items.length).toBeGreaterThan(0);
    for (const m of a.items) {
      expect(m.id).toBe(m.ts);
      expect(typeof m.text).toBe("string");
      expect(m.text.length).toBeGreaterThan(0);
    }
    // Deterministic across calls — the sync job's checksum-skip depends on this.
    expect(a).toEqual(b);
  });

  it("names a stored message the fixtures do not hold gone, since they are the whole channel", async () => {
    const { listChannelMessages } = await import("./slack");
    const { gone } = await listChannelMessages("C_ANY", "unused-token", {
      stored: ["1700000000.0000", "1600000000.0000"],
    });
    expect(gone).toEqual(["1600000000.0000"]);
  });
});

describe("services/connectors/slack — real branch (SLACK_MOCK=false)", () => {
  beforeEach(() => {
    vi.stubEnv("SLACK_MOCK", "false");
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("only calls conversations.history (GET), never a write endpoint", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        messages: [{ ts: "111.0001", text: "hi", user: "U1" }],
      }),
    } as Response);

    const { listChannelMessages } = await import("./slack");
    const { items: messages } = await listChannelMessages("C1", "tok_real");

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toContain("conversations.history");
    expect(String(url)).not.toContain("postMessage");
    expect((init as RequestInit)?.method ?? "GET").toBe("GET");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok_real" });

    expect(messages).toEqual([
      { id: "111.0001", ts: "111.0001", text: "hi", user: "U1", checksum: expect.any(String) },
    ]);
  });

  it("throws on a Slack API-level error instead of returning an empty list silently", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ ok: false, error: "channel_not_found" }),
    } as Response);

    const { listChannelMessages } = await import("./slack");
    await expect(listChannelMessages("C_BAD", "tok")).rejects.toThrow(/channel_not_found/);
  });

  it("filters out subtype messages (channel_join, bot edits, etc)", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        messages: [
          { ts: "1", text: "real message", user: "U1" },
          { ts: "2", text: "joined the channel", user: "U2", subtype: "channel_join" },
        ],
      }),
    } as Response);

    const { listChannelMessages } = await import("./slack");
    const { items: messages } = await listChannelMessages("C1", "tok");
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe("real message");
  });

  it("throws instead of calling the real API when no token is given", async () => {
    const { listChannelMessages } = await import("./slack");
    await expect(listChannelMessages("C1", "")).rejects.toThrow(/token is required/i);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("services/connectors/slack — reading changes since the last sync", () => {
  /** busySlackChannel's message n is posted at this second plus n. */
  const EPOCH = 1_791_000_000;
  const NOW = (EPOCH + 3600 * 3) * 1000;
  const listWith = async (channel: FakeSlackState) => {
    vi.stubGlobal("fetch", vi.fn(fakeSlack(channel).fetch));
    return (await import("./slack")).listChannelMessages;
  };

  beforeEach(() => vi.stubEnv("SLACK_MOCK", "false"));
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("names nothing gone because it is older than what the sync read", async () => {
    const channel = busySlackChannel(5);
    const listChannelMessages = await listWith(channel);
    const stored = channel.messages.map((m) => m.ts);
    const listing = await listChannelMessages("C1", "tok", {
      cursor: { oldest: `${EPOCH + 3600}.000000` },
      stored,
      now: NOW,
    });
    expect(listing.items).toEqual([]);
    expect(listing.gone).toEqual([]);
  });

  it("names a message deleted inside the range it read in full gone", async () => {
    const channel = busySlackChannel(5);
    const listChannelMessages = await listWith(channel);
    const stored = channel.messages.map((m) => m.ts);
    channel.messages.splice(2, 1);
    const listing = await listChannelMessages("C1", "tok", { cursor: { oldest: stored[0] }, stored, now: NOW });
    expect(listing.gone).toEqual([stored[2]]);
  });

  it("names nothing gone from a pass it did not finish", async () => {
    const channel = busySlackChannel(250);
    const listChannelMessages = await listWith(channel);
    const listing = await listChannelMessages("C1", "tok", { stored: ["1.000000", channel.messages[0].ts], now: NOW });
    expect(listing.cursor.page).toBeDefined();
    expect(listing.gone).toEqual([]);
  });

  it("names nothing gone when it finishes a pass an earlier sync started", async () => {
    // The pages the earlier sync read are not in this listing, so only a pass
    // one sync both started and finished proves a missing message deleted.
    const channel = busySlackChannel(250);
    const listChannelMessages = await listWith(channel);
    const stored = channel.messages.map((m) => m.ts);
    const first = await listChannelMessages("C1", "tok", { now: NOW });
    expect(first.cursor.page).toBeDefined();
    const rest = await listChannelMessages("C1", "tok", { cursor: first.cursor, stored, now: NOW + 1_800_000 });
    expect(rest.cursor.page).toBeUndefined();
    expect(rest.items).toHaveLength(50);
    expect(rest.gone).toEqual([]);
  });
});

describe("services/connectors/slack — reading threads", () => {
  /** busySlackChannel's message n is posted at this second plus n. */
  const EPOCH = 1_791_000_000;
  const NOW = (EPOCH + 3600 * 3) * 1000;
  const listWith = async (channel: FakeSlackState) => {
    vi.stubGlobal("fetch", vi.fn(fakeSlack(channel).fetch));
    return (await import("./slack")).listChannelMessages;
  };
  const replyCalls = () =>
    vi
      .mocked(fetch)
      .mock.calls.map(([input]) => new URL(String(input)))
      .filter((url) => url.pathname === "/api/conversations.replies");

  /** `threads` parents, posted a second apart, each with `repliesEach` replies. */
  const threadedChannel = (threads: number, repliesEach: number): FakeSlackState => {
    const channel = busySlackChannel(threads);
    channel.messages.forEach((parent, i) => {
      Object.assign(parent, { thread_ts: parent.ts, reply_count: repliesEach });
      const thread = { thread_ts: parent.ts, parent_user_id: parent.user };
      channel.replies.set(
        parent.ts,
        Array.from({ length: repliesEach }, (_, j) =>
          slackMessage(1000 + i * 300 + j, j % 2 ? "U0AVERY" : "U0CASEY", `Reply ${j + 1} to update ${i + 1}`, thread),
        ),
      );
    });
    return channel;
  };
  const replyIds = (channel: FakeSlackState, parent: string) =>
    (channel.replies.get(parent) ?? []).map((r) => `${parent}/${r.ts}`);

  beforeEach(() => vi.stubEnv("SLACK_MOCK", "false"));
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("reads a 250-reply thread whole, three pages, in one sync", async () => {
    const channel = threadedChannel(1, 250);
    const listChannelMessages = await listWith(channel);
    const listing = await listChannelMessages("C1", "tok", { now: NOW });
    const parent = channel.messages[0].ts;
    expect(listing.items.filter((m) => m.id.includes("/")).map((m) => m.id)).toEqual(replyIds(channel, parent));
    expect(replyCalls().map((url) => url.searchParams.get("cursor"))).toEqual([
      null,
      expect.any(String),
      expect.any(String),
    ]);
    expect(listing.cursor.threads).toBeUndefined();
  });

  it("spends at most 20 reply pages a sync and continues where it stopped, inside a thread too", async () => {
    const channel = threadedChannel(7, 250); // 3 pages a thread, 21 in all
    const listChannelMessages = await listWith(channel);
    const first = await listChannelMessages("C1", "tok", { now: NOW });
    expect(replyCalls()).toHaveLength(20);
    const last = channel.messages[6].ts;
    expect(first.cursor.threads).toEqual([{ ts: last, page: expect.any(String) }]);

    // A reply deleted from the thread the first sync stopped inside: the second
    // sync reads only that thread's last page, so it cannot show the reply gone.
    const stored = first.items.map((m) => m.id);
    const deleted = stored.find((id) => id.startsWith(`${last}/`))!;
    channel.replies.set(
      last,
      channel.replies.get(last)!.filter((r) => `${last}/${r.ts}` !== deleted),
    );
    const second = await listChannelMessages("C1", "tok", { cursor: first.cursor, stored, now: NOW + 3600_000 });
    expect(second.cursor.threads).toBeUndefined();
    expect(second.gone).toEqual([]);
    const read = new Set([...first.items, ...second.items].map((m) => m.id));
    for (const parent of channel.messages)
      for (const id of replyIds(channel, parent.ts)) expect(read.has(id)).toBe(true);
  });

  it("names a reply deleted from a thread it read whole gone", async () => {
    const channel = threadedChannel(2, 3);
    const listChannelMessages = await listWith(channel);
    const parent = channel.messages[1].ts;
    const stored = [
      ...channel.messages.map((m) => m.ts),
      ...replyIds(channel, channel.messages[0].ts),
      ...replyIds(channel, parent),
    ];
    const deleted = replyIds(channel, parent)[1];
    channel.replies.get(parent)!.splice(1, 1);
    const listing = await listChannelMessages("C1", "tok", { stored, now: NOW });
    expect(listing.gone).toEqual([deleted]);
  });

  it("neither reads nor names gone the replies of a thread older than what the sync read", async () => {
    const channel = threadedChannel(2, 3);
    const listChannelMessages = await listWith(channel);
    const stored = [...channel.messages.map((m) => m.ts), ...channel.messages.flatMap((m) => replyIds(channel, m.ts))];
    channel.replies.clear();
    const listing = await listChannelMessages("C1", "tok", {
      cursor: { oldest: `${EPOCH + 3600}.000000` },
      stored,
      now: NOW,
    });
    expect(replyCalls()).toEqual([]);
    expect(listing.gone).toEqual([]);
  });

  it("names every stored reply gone when the whole thread was deleted inside the range it read", async () => {
    const channel = threadedChannel(2, 3);
    const listChannelMessages = await listWith(channel);
    const [kept, deleted] = channel.messages.map((m) => m.ts);
    const stored = [kept, deleted, ...replyIds(channel, kept), ...replyIds(channel, deleted)];
    const deletedReplies = replyIds(channel, deleted);
    channel.messages.splice(1, 1);
    channel.replies.delete(deleted);
    const listing = await listChannelMessages("C1", "tok", { cursor: { oldest: kept }, stored, now: NOW });
    expect(listing.gone.sort()).toEqual([deleted, ...deletedReplies].sort());
  });

  it("keeps the replies of a parent deleted while it still had replies, and names the parent and a deleted reply gone", async () => {
    const channel = threadedChannel(1, 3);
    const listChannelMessages = await listWith(channel);
    const parent = channel.messages[0].ts;
    const [first, deleted, third] = replyIds(channel, parent);
    const stored = [parent, first, deleted, third];
    channel.messages[0] = slackTombstone(channel.messages[0]);
    channel.replies.get(parent)!.splice(1, 1);
    const listing = await listChannelMessages("C1", "tok", { cursor: { oldest: parent }, stored, now: NOW });
    expect(listing.items.map((m) => m.id)).toEqual([first, third]);
    expect(listing.gone).toEqual([parent, deleted]);
  });

  it("names a thread's stored replies gone once its parent lists no replies", async () => {
    const channel = threadedChannel(1, 2);
    const listChannelMessages = await listWith(channel);
    const parent = channel.messages[0];
    const stored = [parent.ts, ...replyIds(channel, parent.ts)];
    delete parent.reply_count;
    channel.replies.delete(parent.ts);
    const listing = await listChannelMessages("C1", "tok", { stored, now: NOW });
    expect(listing.gone).toEqual(replyIds(threadedChannel(1, 2), parent.ts));
  });

  it("probes no thread whose parent a pass it did not finish could have missed", async () => {
    const channel = busySlackChannel(250);
    const listChannelMessages = await listWith(channel);
    const missing = channel.messages[0].ts; // the oldest, on the page the first sync does not reach
    const listing = await listChannelMessages("C1", "tok", { stored: [`${missing}/${EPOCH + 5000}.000100`], now: NOW });
    expect(listing.cursor.page).toBeDefined();
    expect(replyCalls()).toEqual([]);
    expect(listing.gone).toEqual([]);
  });

  /** Answer `conversations.replies` with `reply(url)` when it returns a Response, and everything else as `channel` does. */
  const withReplies = async (channel: FakeSlackState, reply: (url: URL) => Response | undefined) => {
    const slack = fakeSlack(channel);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        return (url.pathname === "/api/conversations.replies" && reply(url)) || slack.fetch(input);
      }),
    );
    return (await import("./slack")).listChannelMessages;
  };
  const slackBody = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: status === 429 ? { "retry-after": "30" } : {} });

  it("fails on a refused replies read instead of returning the thread empty", async () => {
    const listChannelMessages = await withReplies(threadedChannel(1, 2), () =>
      slackBody({ ok: false, error: "missing_scope" }),
    );
    await expect(listChannelMessages("C1", "tok", { now: NOW })).rejects.toThrow(
      /conversations\.replies.*missing_scope/,
    );
  });

  it("fails on an answer that says ok but holds no messages, rather than reading the thread or channel as empty", async () => {
    const channel = threadedChannel(1, 3);
    const parent = channel.messages[0].ts;
    const stored = [parent, ...replyIds(channel, parent)];
    const listReplies = await withReplies(channel, () => slackBody({ ok: true }));
    await expect(listReplies("C1", "tok", { stored, now: NOW })).rejects.toThrow(
      /conversations\.replies answered ok with no messages/,
    );
    vi.resetModules();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => slackBody({ ok: true, has_more: false })),
    );
    const { listChannelMessages } = await import("./slack");
    await expect(listChannelMessages("C1", "tok", { stored, now: NOW })).rejects.toThrow(
      /conversations\.history answered ok with no messages/,
    );
  });

  it("names nothing gone from a thread or a channel Slack says has more but gives no cursor for", async () => {
    const channel = threadedChannel(1, 150);
    const parent = channel.messages[0].ts;
    const stored = [parent, ...replyIds(channel, parent)];
    const slack = fakeSlack(channel);
    const cursorless = async (input: RequestInfo | URL) => {
      const answer = await slack.fetch(input);
      const body = await answer.json();
      return slackBody({ ...body, response_metadata: { next_cursor: "" } });
    };
    vi.stubGlobal("fetch", vi.fn(cursorless));
    const { listChannelMessages } = await import("./slack");
    const listing = await listChannelMessages("C1", "tok", { stored, now: NOW });
    expect(listing.items.filter((m) => m.id.includes("/"))).toHaveLength(100);
    expect(listing.gone).toEqual([]);

    const busy = busySlackChannel(150);
    const busyFake = fakeSlack(busy);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const body = await (await busyFake.fetch(input)).json();
        return slackBody({ ...body, response_metadata: { next_cursor: "" } });
      }),
    );
    const history = await listChannelMessages("C1", "tok", { stored: busy.messages.map((m) => m.ts), now: NOW });
    expect(history.items).toHaveLength(100);
    expect(history.gone).toEqual([]);
  });

  it("keeps the channel's read and waits on a rate-limited replies read, then continues it next sync", async () => {
    const channel = threadedChannel(2, 2);
    let limited = true;
    const listChannelMessages = await withReplies(channel, () =>
      limited ? slackBody({ ok: false, error: "ratelimited" }, 429) : undefined,
    );
    const first = await listChannelMessages("C1", "tok", { now: NOW });
    expect(first.items.map((m) => m.id)).toEqual(channel.messages.map((m) => m.ts));
    expect(first.cursor.threads).toEqual(channel.messages.map((m) => ({ ts: m.ts })));
    expect(first.gone).toEqual([]);
    expect(replyCalls()).toHaveLength(1); // no second read into a rate limit

    limited = false;
    const second = await listChannelMessages("C1", "tok", { cursor: first.cursor, now: NOW + 3600_000 });
    expect(second.items.map((m) => m.id)).toEqual(channel.messages.flatMap((m) => replyIds(channel, m.ts)));
    expect(second.cursor.threads).toBeUndefined();
  });

  it("starts a waiting thread over when Slack no longer accepts its stored page cursor", async () => {
    const channel = threadedChannel(1, 3);
    const parent = channel.messages[0].ts;
    const stored = [parent, ...replyIds(channel, parent)];
    const deleted = stored[2];
    channel.replies.get(parent)!.splice(1, 1);
    const listChannelMessages = await withReplies(channel, (url) =>
      url.searchParams.get("cursor") === "stale" ? slackBody({ ok: false, error: "invalid_cursor" }) : undefined,
    );
    const listing = await listChannelMessages("C1", "tok", {
      cursor: { oldest: `${EPOCH + 3600}.000000`, threads: [{ ts: parent, page: "stale" }] },
      stored,
      now: NOW,
    });
    expect(listing.items.map((m) => m.id)).toEqual(replyIds(channel, parent));
    expect(listing.gone).toEqual([deleted]);
    expect(listing.cursor.threads).toBeUndefined();
  });

  it("keeps at most 200 threads waiting", async () => {
    const channel = threadedChannel(250, 1);
    const listChannelMessages = await listWith(channel);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // A cursor already holding 250 threads (none can be written now): the history is
    // held, 20 are read, and the cap cuts the rest to 200, saying how many it cut.
    const waiting = channel.messages.map((m) => ({ ts: m.ts }));
    const listing = await listChannelMessages("C1", "tok", { cursor: { threads: waiting }, now: NOW });
    expect(replyCalls()).toHaveLength(20);
    expect(listing.cursor.threads).toEqual(waiting.slice(20, 220));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("30 threads not kept waiting"));
    warn.mockRestore();
  });

  // History reads 200 messages a sync but replies only 20 pages, so a
  // first sync of a busy channel finds threads faster than it reads them. Threads
  // dropped past the 200 cap are never listed again (their parents are older than
  // the next sync's overlap), so their replies are never saved, whatever the number
  // of syncs: a rolling window, not an incremental history.
  it("eventually reads every thread of a channel whose threads outrun the reply budget", async () => {
    const channel = threadedChannel(600, 1);
    const listChannelMessages = await listWith(channel);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const seen = new Set<string>();
    let cursor: Awaited<ReturnType<typeof listChannelMessages>>["cursor"] | undefined;
    for (let sync = 0; sync < 60; sync++) {
      const listing = await listChannelMessages("C1", "tok", { cursor, now: NOW + sync * 2 * 3600_000 });
      for (const m of listing.items) if (m.id.includes("/")) seen.add(m.id);
      cursor = listing.cursor;
    }
    warn.mockRestore();
    const all = channel.messages.flatMap((m) => replyIds(channel, m.ts));
    expect(all.filter((id) => !seen.has(id))).toHaveLength(0);
  });

  const historyCalls = () =>
    vi
      .mocked(fetch)
      .mock.calls.map(([input]) => new URL(String(input)))
      .filter((url) => url.pathname === "/api/conversations.history");

  /** Run `syncs` syncs two hours apart, from `cursor`; every reply id the listings returned, and whether any sync dropped a thread. */
  const syncMany = async (
    listChannelMessages: Awaited<ReturnType<typeof listWith>>,
    syncs: number,
    { between }: { between?: (sync: number) => void } = {},
  ) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const seen = new Set<string>();
    let cursor: Awaited<ReturnType<typeof listChannelMessages>>["cursor"] | undefined;
    for (let sync = 0; sync < syncs; sync++) {
      between?.(sync);
      const listing = await listChannelMessages("C1", "tok", { cursor, now: NOW + sync * 2 * 3600_000 });
      for (const m of listing.items) if (m.id.includes("/")) seen.add(m.id);
      cursor = listing.cursor;
    }
    const dropped = warn.mock.calls.some(([message]) => String(message).includes("not kept waiting"));
    warn.mockRestore();
    return { seen, dropped, cursor };
  };

  it("holds the history read while the waiting threads leave no room for a page, and keeps its place in it", async () => {
    const channel = threadedChannel(250, 1);
    const waiting = channel.messages.slice(0, 150).map((m) => ({ ts: m.ts }));
    const listChannelMessages = await listWith(channel);

    const between = await listChannelMessages("C1", "tok", {
      cursor: { oldest: `${EPOCH}.000000`, threads: waiting },
      now: NOW,
    });
    expect(historyCalls()).toEqual([]);
    expect(between.cursor).toEqual({ oldest: `${EPOCH}.000000`, threads: waiting.slice(20) });

    const midPass = {
      oldest: `${EPOCH}.000000`,
      latest: `${EPOCH + 3600}.000000`,
      page: "bmV4dF90czox",
      threads: waiting,
    };
    const held = await listChannelMessages("C1", "tok", { cursor: midPass, now: NOW });
    expect(historyCalls()).toEqual([]);
    expect(held.cursor).toEqual({ ...midPass, threads: waiting.slice(20) });

    const { parseSlackCursor } = await import("./slack");
    for (const cursor of [between.cursor, held.cursor])
      expect(parseSlackCursor(JSON.parse(JSON.stringify(cursor)))).toEqual(cursor);
  });

  it("continues a pass a page at a time only while the waiting threads leave room for every thread a page can list", async () => {
    const channel = threadedChannel(350, 1);
    const listChannelMessages = await listWith(channel);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const first = await listChannelMessages("C1", "tok", { now: NOW });
    expect(first.cursor.page).toBeDefined();
    vi.mocked(fetch).mockClear();
    // 100 of the threads the first page listed, none of them on the next page.
    const waiting = channel.messages.slice(250).map((m) => ({ ts: m.ts }));
    const listing = await listChannelMessages("C1", "tok", {
      cursor: { ...first.cursor, threads: waiting },
      now: NOW + 3600_000,
    });
    expect(historyCalls()).toHaveLength(1);
    expect(listing.cursor.threads).toHaveLength(200 - 20);
    expect(listing.cursor.page).toBeDefined();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("starts a new pass only once no thread waits, so a pass that fits one sync still proves a deletion", async () => {
    const channel = busySlackChannel(151);
    const parent = channel.messages[0];
    Object.assign(parent, { thread_ts: parent.ts, reply_count: 1 });
    channel.replies.set(parent.ts, [
      slackMessage(9000, "U0CASEY", "On it.", { thread_ts: parent.ts, parent_user_id: parent.user }),
    ]);
    const listChannelMessages = await listWith(channel);
    const stored = channel.messages.slice(1).map((m) => m.ts);
    const deleted = stored[10];
    channel.messages.splice(
      channel.messages.findIndex((m) => m.ts === deleted),
      1,
    );

    const held = await listChannelMessages("C1", "tok", {
      cursor: { oldest: `${EPOCH}.000000`, threads: [{ ts: parent.ts }] },
      stored,
      now: NOW,
    });
    expect(historyCalls()).toEqual([]);
    expect(held.cursor).toEqual({ oldest: `${EPOCH}.000000` });
    const pass = await listChannelMessages("C1", "tok", { cursor: held.cursor, stored, now: NOW + 3600_000 });
    expect(historyCalls()).toHaveLength(2);
    expect(pass.gone).toEqual([deleted]);
  });

  it("starts a held pass over when Slack no longer accepts its stored history cursor", async () => {
    const channel = threadedChannel(300, 1);
    let stale = false;
    const slack = fakeSlack(channel);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (stale && url.pathname === "/api/conversations.history" && url.searchParams.get("cursor")) {
          stale = false; // only the cursor stored before this sync is refused
          return slackBody({ ok: false, error: "invalid_cursor" });
        }
        return slack.fetch(input);
      }),
    );
    const { listChannelMessages } = await import("./slack");
    const first = await listChannelMessages("C1", "tok", { now: NOW });
    const latest = first.cursor.latest;
    stale = true;
    const restarted = await listChannelMessages("C1", "tok", {
      cursor: { ...first.cursor, threads: undefined },
      now: NOW + 3600_000,
    });
    // Read again from the pass's first page, under the same `latest`.
    expect(
      historyCalls()
        .slice(-2)
        .map((url) => [url.searchParams.get("cursor"), url.searchParams.get("latest")]),
    ).toEqual([
      [null, latest],
      [expect.any(String), latest],
    ]);
    expect(restarted.cursor).toMatchObject({ latest, page: expect.any(String) });
    expect(restarted.gone).toEqual([]);
  });

  it("proves a deletion from a pass it started over and read whole", async () => {
    const channel = busySlackChannel(150);
    const stored = channel.messages.map((m) => m.ts);
    const deleted = stored[40];
    channel.messages.splice(40, 1);
    const slack = fakeSlack(channel);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        new URL(String(input)).searchParams.get("cursor") === "stale"
          ? slackBody({ ok: false, error: "invalid_cursor" })
          : slack.fetch(input),
      ),
    );
    const { listChannelMessages } = await import("./slack");
    const listing = await listChannelMessages("C1", "tok", {
      cursor: { oldest: `${EPOCH}.000000`, latest: `${EPOCH + 3600}.000000`, page: "stale" },
      stored,
      now: NOW,
    });
    expect(listing.cursor).toEqual({ oldest: `${EPOCH + 3600 - 3600}.000000` });
    expect(listing.gone).toEqual([deleted]);
  });

  it("reads the thread of a reply also sent to the channel when the history lists only the reply", async () => {
    const channel = threadedChannel(1, 1);
    const parent = channel.messages[0];
    const broadcast = slackMessage(3 * 3600 - 60, "U0CASEY", "Also posting here.", {
      thread_ts: parent.ts,
      parent_user_id: parent.user,
      subtype: "thread_broadcast",
    });
    channel.replies.get(parent.ts)!.push(broadcast);
    channel.messages.push(broadcast);
    const listChannelMessages = await listWith(channel);
    const listing = await listChannelMessages("C1", "tok", { cursor: { oldest: `${EPOCH + 3600}.000000` }, now: NOW });
    expect(listing.items.map((m) => m.id)).toEqual(replyIds(channel, parent.ts));
  });

  it("reads every reply of threads that span pages, and of threads posted while the history was held", async () => {
    const channel = threadedChannel(300, 120); // two reply pages a thread
    // Forty threads posted after the first pass started, while its threads are still waiting.
    const later = Array.from({ length: 40 }, (_, i) => {
      const parent = slackMessage(8 * 3600 + i, "U0BLAKE", `Late update ${i + 1}`, { reply_count: 3 });
      parent.thread_ts = parent.ts;
      channel.replies.set(
        parent.ts,
        Array.from({ length: 3 }, (_, j) =>
          slackMessage(200_000 + i * 10 + j, "U0CASEY", `Reply ${j + 1} to late update ${i + 1}`, {
            thread_ts: parent.ts,
            parent_user_id: parent.user,
          }),
        ),
      );
      return parent;
    });
    const listChannelMessages = await listWith(channel);
    const { seen, dropped } = await syncMany(listChannelMessages, 60, {
      between: (sync) => {
        if (sync === 5) channel.messages.push(...later);
      },
    });
    const all = channel.messages.flatMap((m) => replyIds(channel, m.ts));
    expect(all).toHaveLength(300 * 120 + 40 * 3);
    expect(all.filter((id) => !seen.has(id))).toHaveLength(0);
    expect(dropped).toBe(false);
  });

  it("drops no thread while its replies reads are rate-limited, and reads them all once the limit lifts", async () => {
    const channel = threadedChannel(400, 1);
    let limited = false;
    const listChannelMessages = await withReplies(channel, () =>
      limited ? slackBody({ ok: false, error: "ratelimited" }, 429) : undefined,
    );
    const { seen, dropped } = await syncMany(listChannelMessages, 60, {
      between: (sync) => {
        limited = sync >= 1 && sync < 8;
      },
    });
    expect(channel.messages.flatMap((m) => replyIds(channel, m.ts)).filter((id) => !seen.has(id))).toHaveLength(0);
    expect(dropped).toBe(false);
  });

  it("does not read a reply also sent to the channel as a thread of its own", async () => {
    const channel = threadedChannel(1, 1);
    const parent = channel.messages[0];
    channel.messages.push(
      slackMessage(9000, "U0CASEY", "Shipping at 4, posting here too.", {
        subtype: "thread_broadcast",
        thread_ts: parent.ts,
        reply_count: 1,
      }),
    );
    const listChannelMessages = await listWith(channel);
    await listChannelMessages("C1", "tok", { now: NOW });
    expect(replyCalls().map((url) => url.searchParams.get("ts"))).toEqual([parent.ts]);
  });

  it("keeps the threads still waiting in a cursor it can read back, and refuses a malformed one", async () => {
    const { parseSlackCursor } = await import("./slack");
    const cursor = {
      oldest: "1791000000.000100",
      threads: [{ ts: "1791000001.000100", page: "b2Zmc2V0OjEwMA==" }, { ts: "1791000002.000100" }],
    };
    expect(parseSlackCursor(JSON.parse(JSON.stringify(cursor)))).toEqual(cursor);
    for (const threads of ["1791000001.000100", [{ ts: "not-a-ts" }], [{ ts: "1791000001.000100", page: 5 }], [null]]) {
      expect(parseSlackCursor({ oldest: "1791000000.000100", threads })).toBeNull();
    }
  });
});

// Production always forces the real branch, regardless of the env var. A
// fixture mode that defaulted on in a real deployed org with SLACK_MOCK unset
// would let a bare unauthenticated POST silently ingest fabricated fixture
// content (including a fake "customer call recap") into a real tenant graph.
describe("services/connectors/slack — production gate", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("SLACK_MOCK is false in production even when the env var says otherwise", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("SLACK_MOCK", "true");
    const { SLACK_MOCK } = await import("./slack");
    expect(SLACK_MOCK).toBe(false);
  });

  it("a tokenless call in production throws rather than returning fabricated fixture content", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubGlobal("fetch", vi.fn());
    const { listChannelMessages } = await import("./slack");
    await expect(listChannelMessages("C1", "")).rejects.toThrow(/token is required/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("SLACK_MOCK still defaults true outside production (existing local/dev/test behavior preserved)", async () => {
    const { SLACK_MOCK } = await import("./slack");
    expect(SLACK_MOCK).toBe(true);
  });
});
