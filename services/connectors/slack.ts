// Slack connector — read-only ingestion of a user-picked channel's message
// history into memory: scoped, read-only, no autonomous writes, no new
// subscriptions. OAuth is not wired up, so the real branch below is written to
// the documented Slack Web API shape but has not been exercised against a live
// workspace — do not treat it as verified until an OAuth token exists to test
// it with.
//
// The one rule this file enforces: a message leaves memory only on evidence that
// it is gone upstream, never because it is older than what one sync reads. Each
// sync reads the history since the previous one (paged, from a cursor), and a
// stored message counts as deleted only when it falls inside a range the sync
// read in full and is missing from it. A thread reply counts as deleted only
// when the sync read its whole thread and the reply is missing from it, or Slack
// says the thread no longer exists. Without a per-message probe, a message
// deleted long after it was posted stays until the source is reconnected.
//
// MOCK (default outside production): set SLACK_MOCK=false to use the real
// Slack Web API. Production always uses the real API branch, full stop — the
// env var only selects mock vs. real outside production (local/dev/preview/
// test). A fixture mode that defaulted on in a real deployed org would let a
// bare, unauthenticated POST /api/sources silently ingest fabricated fixture
// content (a fake "customer call recap" among it) into a real tenant graph,
// indistinguishable from genuine extracted content.

import { createHash } from "node:crypto";

export const SLACK_MOCK = process.env.VERCEL_ENV === "production" ? false : process.env.SLACK_MOCK !== "false";

export interface SlackMessage {
  /**
   * The message's `ts` (channel-unique, sortable, stable across edits); for a
   * thread reply, `<thread ts>/<reply ts>`, so a stored reply names the thread
   * whose listing can show it deleted.
   */
  id: string;
  text: string;
  /** Slack user id of the sender. */
  user: string;
  ts: string;
  /** Hash of the message text — changes if the message is edited. */
  checksum: string;
}

function checksumOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Where a channel's listing stands between syncs. History is read newest first,
 * a page at a time, between `oldest` and `latest`; a channel longer than one
 * sync's pages is finished by the syncs after it.
 */
export type SlackSyncCursor = {
  /** Read nothing older: the start of the last finished pass, less `OVERLAP_SECONDS`. Absent until one finishes. */
  oldest?: string;
  /** Set while a pass is unfinished: when it started, and Slack's cursor for its next page. */
  latest?: string;
  page?: string;
  /**
   * Threads whose replies are still to be read, in the order they were found;
   * `page` is Slack's cursor inside the one a sync stopped partway through.
   * Absent when none are waiting.
   */
  threads?: SlackThreadCursor[];
};

/** One thread waiting to be read: its parent's `ts`, and where to continue in it. */
export type SlackThreadCursor = { ts: string; page?: string };

export interface SlackListing {
  /** The messages this sync read: the channel's oldest first, then each thread's replies oldest first. */
  items: SlackMessage[];
  /** Stored message ids Slack shows are gone. The only ones a sync may retire. */
  gone: string[];
  /** Where the next sync continues from. */
  cursor: SlackSyncCursor;
}

/** Messages per page, and pages per sync: bounds one sync's API calls and Inngest steps. */
const PAGE_SIZE = 100;
const MAX_PAGES = 2;
/** `conversations.replies` pages per sync, across every thread it reads. */
const MAX_THREAD_PAGES = 20;
/**
 * Threads a cursor keeps waiting, at most. The history is read only while the
 * threads waiting leave room for every thread it can list (see `roomForPage`),
 * so a thread the history found is never dropped; it waits, and the history
 * read waits with it.
 */
const MAX_WAITING_THREADS = 200;
/**
 * How far before the previous sync's start the next one reads again. An edit
 * keeps its message's `ts`, so an edit to an older message is picked up only
 * while the message is inside this window; one made later waits for a reconnect.
 */
const OVERLAP_SECONDS = 60 * 60;

const isTs = (v: unknown): v is string => typeof v === "string" && /^\d+(\.\d+)?$/.test(v);

/** A cursor this file wrote, or null. */
export function parseSlackCursor(value: unknown): SlackSyncCursor | null {
  if (!value || typeof value !== "object") return null;
  const { oldest, latest, page, threads } = value as Record<string, unknown>;
  const isOptionalTs = (v: unknown) => v === undefined || isTs(v);
  if (!isOptionalTs(oldest) || !isOptionalTs(latest) || (page !== undefined && typeof page !== "string")) return null;
  if ((latest === undefined) !== (page === undefined)) return null;
  const parsedThreads = threads === undefined ? undefined : parseThreads(threads);
  if (parsedThreads === null) return null;
  return {
    oldest: oldest as string | undefined,
    latest: latest as string | undefined,
    page: page as string | undefined,
    ...(parsedThreads ? { threads: parsedThreads } : {}),
  };
}

function parseThreads(value: unknown): SlackThreadCursor[] | null {
  if (!Array.isArray(value)) return null;
  const threads: SlackThreadCursor[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const { ts, page } = entry as Record<string, unknown>;
    if (!isTs(ts) || (page !== undefined && typeof page !== "string")) return null;
    threads.push(page === undefined ? { ts } : { ts, page });
  }
  return threads;
}

function toMessage(m: { ts: string; text: string; user?: string }, thread?: string): SlackMessage {
  const id = thread ? `${thread}/${m.ts}` : m.ts;
  return { id, ts: m.ts, text: m.text, user: m.user ?? "unknown", checksum: checksumOf(m.text) };
}

/** The thread a stored reply id names, or null for a top-level message's id. */
function threadOf(id: string): string | null {
  const slash = id.indexOf("/");
  return slash === -1 ? null : id.slice(0, slash);
}

/** One message as `conversations.history` and `conversations.replies` return it, with the fields read here. */
type SlackMessageRow = {
  ts: string;
  text?: string;
  user?: string;
  subtype?: string;
  thread_ts?: string;
  reply_count?: number;
};

/** One page of `conversations.history` or `conversations.replies`. */
type SlackPage = {
  ok: boolean;
  error?: string;
  messages?: SlackMessageRow[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
};

/** Slack answered 429. */
class SlackRateLimited extends Error {}

/**
 * One page of a Slack listing. An answer that says `ok` but carries no
 * `messages` list throws: it read nothing, and must never be taken for an empty
 * channel or thread.
 */
async function getSlackPage(method: string, params: URLSearchParams, token: string): Promise<SlackPage> {
  const res = await fetch(`https://slack.com/api/${method}?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const message = `Slack ${method} failed: ${res.status} ${res.statusText}`;
    throw res.status === 429 ? new SlackRateLimited(message) : new Error(message);
  }
  const data = (await res.json()) as SlackPage;
  if (data.ok && !Array.isArray(data.messages)) throw new Error(`Slack ${method} answered ok with no messages list`);
  return data;
}

/**
 * List a channel's messages changed since `cursor`, with the replies of the
 * threads among them, read-only (`conversations.history` and
 * `conversations.replies` only, never posts or reacts), and name the `stored`
 * message ids Slack shows are gone.
 *
 * Absence proves deletion only inside a range one sync read in full: Slack's
 * history between two timestamps is complete, so a stored message in that range
 * that the listing lacks was deleted. Outside it, absence means nothing. A
 * thread's replies are read only when its parent is in the history this sync
 * reads, so a reply added to an older thread waits, as an edit to an older
 * message does, for a reconnect.
 */
export async function listChannelMessages(
  channelId: string,
  token: string,
  {
    cursor = null,
    stored = [],
    now = Date.now(),
  }: {
    cursor?: SlackSyncCursor | null;
    stored?: readonly string[];
    now?: number;
  } = {},
): Promise<SlackListing> {
  if (SLACK_MOCK) {
    const fixtures = [
      { text: "Standup notes: shipped the audit trail filter, starting on connector work next.", user: "U_MOCK_ALICE" },
      { text: "Heads up, the nightly sync job failed once last night but retried clean.", user: "U_MOCK_BOB" },
      {
        text: "Customer call recap: they want source citations on every answer, not just document uploads.",
        user: "U_MOCK_ALICE",
      },
    ];
    const items = fixtures.map((f, i) => toMessage({ ts: `${1700000000 + i}.000${i}`, ...f }));
    const listed = new Set(items.map((m) => m.id));
    return { items, gone: stored.filter((id) => !listed.has(id)), cursor: {} };
  }

  if (!token) {
    throw new Error("Slack token is required outside fixture mode (SLACK_MOCK)");
  }

  const from = cursor ?? {};
  const latest = from.latest ?? (now / 1000).toFixed(6);
  const rows: SlackMessageRow[] = [];
  let page = from.page;
  // Whether this sync reads the pass from its first page, so a finished read is its whole range.
  let fromStart = from.page === undefined;
  let pagesRead = 0;
  let finished = false;
  let unreadRest = false;
  // A page lists at most PAGE_SIZE rows, and each adds at most one thread to the
  // queue: as a parent with replies, as the thread of a reply also sent to the
  // channel, or as the parent of a stored reply. A pass in progress continues a
  // page at a time while the threads waiting leave room for that. A new pass
  // starts only with room for all its pages, which is with no thread waiting, so
  // a pass that fits one sync is read whole in it and can prove a deletion.
  const waitingBefore = from.threads?.length ?? 0;
  const roomForPage = () =>
    from.latest === undefined && pagesRead === 0
      ? waitingBefore + MAX_PAGES * PAGE_SIZE <= MAX_WAITING_THREADS
      : waitingBefore + (pagesRead + 1) * PAGE_SIZE <= MAX_WAITING_THREADS;
  while (pagesRead < MAX_PAGES && !finished && roomForPage()) {
    const params = new URLSearchParams({ channel: channelId, limit: String(PAGE_SIZE), latest, inclusive: "true" });
    if (from.oldest) params.set("oldest", from.oldest);
    if (page) params.set("cursor", page);
    const data = await getSlackPage("conversations.history", params, token);
    // Only the stored cursor can have gone stale, and nothing was read before it:
    // the pass starts over from its first page, under the same `latest`.
    if (!data.ok && data.error === "invalid_cursor" && page !== undefined && pagesRead === 0) {
      page = undefined;
      fromStart = true;
      continue;
    }
    if (!data.ok) {
      throw new Error(`Slack conversations.history error: ${data.error ?? "unknown"}`);
    }
    pagesRead++;
    rows.push(...(data.messages ?? []));
    page = data.response_metadata?.next_cursor || undefined;
    finished = !data.has_more || !page;
    // Slack says there is more but gives no cursor for it: the pass ends, but it
    // did not read its range whole.
    if (data.has_more && !page) unreadRest = true;
  }

  const topLevel = rows
    // Skip bot/system subtypes (channel_join, etc.) — not user-authored content.
    .filter(isAuthored)
    .map((m) => toMessage(m))
    .reverse(); // Slack returns newest-first; ingest oldest-first like Drive's listing order.

  // Only a pass this sync both started and finished read its whole range. A
  // stored message listed now as something no person wrote, such as the
  // tombstone of a deleted thread parent, is gone too.
  const listed = new Set(topLevel.map((m) => m.id));
  const listedTs = new Set(rows.map((m) => m.ts));
  const covered = finished && !unreadRest && fromStart;
  const oldest = Number(from.oldest ?? 0);
  const inRange = (ts: string) => Number(ts) >= oldest && Number(ts) <= Number(latest);
  const gone = covered ? stored.filter((id) => threadOf(id) === null && !listed.has(id) && inRange(id)) : [];

  // Threads to read: those still waiting, then each parent this read listed
  // with replies (a deleted parent that still has replies is listed too, as
  // Slack's tombstone), then each thread a stored reply names whose parent this
  // read listed, whatever its reply count now, or should have listed and did
  // not. Reading those is what shows their stored replies deleted.
  const queue: SlackThreadCursor[] = [...(from.threads ?? [])];
  const enqueue = (ts: string) => {
    if (!queue.some((t) => t.ts === ts)) queue.push({ ts });
  };
  for (const row of [...rows].reverse()) {
    if (isThreadParent(row)) enqueue(row.ts);
    else if (row.subtype === "thread_broadcast" && isTs(row.thread_ts)) enqueue(row.thread_ts);
  }
  for (const id of stored) {
    const thread = threadOf(id);
    if (thread !== null && (listedTs.has(thread) || (covered && inRange(thread)))) enqueue(thread);
  }
  const threads = await readThreads(channelId, token, queue, stored);
  gone.push(...threads.gone);

  // A sync that held the history read keeps its place in it unchanged.
  const next: SlackSyncCursor =
    pagesRead === 0
      ? {
          ...(from.oldest ? { oldest: from.oldest } : {}),
          ...(from.latest ? { latest: from.latest, page: from.page } : {}),
        }
      : finished
        ? { oldest: (Number(latest) - OVERLAP_SECONDS).toFixed(6) }
        : { ...(from.oldest ? { oldest: from.oldest } : {}), latest, page };
  if (threads.waiting.length > 0) next.threads = threads.waiting;
  return { items: [...topLevel, ...threads.items], gone, cursor: next };
}

/** A thread's parent with replies; a reply also sent to the channel is listed with its thread's `thread_ts`. */
function isThreadParent(m: SlackMessageRow): boolean {
  return (m.reply_count ?? 0) > 0 && (m.thread_ts === undefined || m.thread_ts === m.ts);
}

/** A message a person wrote, as opposed to a join notice, a bot post or a file share. */
function isAuthored(m: SlackMessageRow): m is SlackMessageRow & { text: string } {
  return !m.subtype && Boolean(m.text);
}

/** A reply a person wrote, including one also sent to the channel. */
function isReply(m: SlackMessageRow): m is SlackMessageRow & { text: string } {
  return isAuthored(m) || (m.subtype === "thread_broadcast" && Boolean(m.text));
}

/**
 * Read the replies of the threads in `queue`, in order, until
 * `MAX_THREAD_PAGES` pages are spent or Slack rate-limits a read, and name the
 * `stored` replies Slack shows are gone: those of a thread this call read whole,
 * from its first page to its last, that the thread no longer holds, and every
 * stored reply of a thread Slack says no longer exists. A reply also sent to the
 * channel (`thread_broadcast`) is read here, as a reply, and not from the
 * history. What is left waits for the next sync, at most
 * `MAX_WAITING_THREADS` of it: the history read leaves room for every thread it
 * lists, so only a vanished thread's probe, or a cursor already past the cap,
 * is cut here.
 */
async function readThreads(
  channelId: string,
  token: string,
  queue: readonly SlackThreadCursor[],
  stored: readonly string[],
): Promise<{ items: SlackMessage[]; gone: string[]; waiting: SlackThreadCursor[] }> {
  const items: SlackMessage[] = [];
  const gone: string[] = [];
  const storedIn = (thread: string) => stored.filter((id) => threadOf(id) === thread);
  const waiting: SlackThreadCursor[] = [];
  let budget = MAX_THREAD_PAGES;
  let index = 0;
  while (index < queue.length && budget > 0) {
    const thread = queue[index++];
    const read = await readThread(channelId, token, thread, budget);
    budget -= read.pages;
    items.push(...read.replies);
    if (read.outcome === "missing") {
      gone.push(...storedIn(thread.ts));
    } else if (read.outcome === "whole") {
      const readIds = new Set(read.replies.map((m) => m.id));
      gone.push(...storedIn(thread.ts).filter((id) => !readIds.has(id)));
    } else if (read.outcome === "paused") {
      waiting.push({ ts: thread.ts, ...(read.page ? { page: read.page } : {}) });
      if (read.rateLimited) break;
    }
    // "partial": read to its end, but not from its start in this call, or Slack
    // gave no cursor for the rest. Nothing it lacks is evidence of a deletion.
  }
  waiting.push(...queue.slice(index));
  if (waiting.length > MAX_WAITING_THREADS) {
    console.warn(
      `[slack] channel ${channelId}: ${waiting.length - MAX_WAITING_THREADS} threads not kept waiting; read when their parent is listed again`,
    );
  }
  return { items, gone, waiting: waiting.slice(0, MAX_WAITING_THREADS) };
}

/** One thread's read: what it found, and whether that is the whole thread. */
type ThreadRead = {
  replies: SlackMessage[];
  pages: number;
  outcome: "whole" | "partial" | "missing" | "paused";
  /** Where a paused read continues; absent to start the thread over. */
  page?: string;
  rateLimited?: boolean;
};

/**
 * Read one thread's replies, at most `budget` pages, from where `thread`
 * stands. A stored page cursor Slack no longer accepts restarts the thread from
 * its first page; a rate limit pauses the read where it stands.
 */
async function readThread(
  channelId: string,
  token: string,
  thread: SlackThreadCursor,
  budget: number,
): Promise<ThreadRead> {
  const replies: SlackMessage[] = [];
  let fromStart = thread.page === undefined;
  let page = thread.page;
  let pages = 0;
  while (pages < budget) {
    const params = new URLSearchParams({ channel: channelId, ts: thread.ts, limit: String(PAGE_SIZE) });
    if (page) params.set("cursor", page);
    pages++;
    let data: SlackPage;
    try {
      data = await getSlackPage("conversations.replies", params, token);
    } catch (e) {
      if (e instanceof SlackRateLimited) return { replies, pages, outcome: "paused", page, rateLimited: true };
      throw e;
    }
    if (!data.ok && data.error === "thread_not_found") return { replies, pages, outcome: "missing" };
    // Only the stored cursor can have gone stale, and nothing was read before it.
    if (!data.ok && data.error === "invalid_cursor" && page !== undefined && page === thread.page) {
      fromStart = true;
      page = undefined;
      continue;
    }
    if (!data.ok) throw new Error(`Slack conversations.replies error: ${data.error ?? "unknown"}`);
    for (const m of data.messages ?? []) {
      // The parent leads every page; it is read from the history.
      if (m.ts === thread.ts) continue;
      if (isReply(m)) replies.push(toMessage(m, thread.ts));
    }
    page = data.response_metadata?.next_cursor || undefined;
    if (!data.has_more) return { replies, pages, outcome: fromStart ? "whole" : "partial" };
    if (!page) return { replies, pages, outcome: "partial" };
  }
  return { replies, pages, outcome: "paused", page };
}
