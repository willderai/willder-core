// Slack Web API and Figma REST payloads in the shape each provider returns
// them, and a `fetch` for each that answers like the provider.
//
// Slack: `conversations.history` lists newest first, at most `limit` messages,
// between `oldest` and `latest` (exclusive unless `inclusive` is true), with
// `has_more` and `response_metadata.next_cursor`; thread replies are not in
// it, only their parent with `reply_count`, and a reply also sent to the channel
// (`thread_broadcast`). `conversations.replies` lists one thread oldest first,
// its parent leading every page, paged the same way; a thread that no longer
// exists answers `thread_not_found`. Bot posts carry `bot_id` and often no
// `user`. A rate limit is HTTP 429 with `Retry-After`.
//
// Figma: `GET /v1/files/:key/comments` returns every comment, replies included
// (a reply carries its parent's id in `parent_id`, a top-level comment an
// empty string), resolved ones too.
//
// Every user id, handle and team is made up.

import { providerResponse, requestUrl } from "./provider-response";
import type { ReadLog } from "./read-tracker";

export interface SlackMessagePayload {
  type: "message";
  ts: string;
  text: string;
  user?: string;
  subtype?: string;
  bot_id?: string;
  username?: string;
  team?: string;
  client_msg_id?: string;
  thread_ts?: string;
  parent_user_id?: string;
  reply_count?: number;
  reply_users?: string[];
  latest_reply?: string;
  edited?: { user: string; ts: string };
  blocks?: unknown[];
  files?: { id: string; name: string; mimetype: string }[];
}

export interface FakeSlackState {
  /** Oldest first; the fake lists them newest first, as Slack does. */
  messages: SlackMessagePayload[];
  /** Each thread's replies by its parent's `ts`, oldest first, as `conversations.replies` lists them. */
  replies: Map<string, SlackMessagePayload[]>;
  error: "not_in_channel" | "channel_not_found" | "invalid_auth" | null;
  rateLimited: boolean;
}

function slackTs(second: number, micro = 100): string {
  return `${1_791_000_000 + second}.${String(micro).padStart(6, "0")}`;
}

function richText(text: string): unknown[] {
  return [
    {
      type: "rich_text",
      block_id: "b1",
      elements: [{ type: "rich_text_section", elements: [{ type: "text", text }] }],
    },
  ];
}

/** A message a person posted, with the fields Slack attaches to one. */
export function slackMessage(
  second: number,
  user: string,
  text: string,
  extra: Partial<SlackMessagePayload> = {},
): SlackMessagePayload {
  return {
    type: "message",
    ts: slackTs(second),
    user,
    text,
    team: "T0EXAMPLE",
    client_msg_id: `00000000-0000-4000-8000-${String(second).padStart(12, "0")}`,
    blocks: richText(text),
    ...extra,
  };
}

/** What Slack leaves of a thread parent deleted while it still has replies. */
export function slackTombstone(parent: SlackMessagePayload): SlackMessagePayload {
  return {
    type: "message",
    subtype: "tombstone",
    ts: parent.ts,
    thread_ts: parent.ts,
    user: "USLACKBOT",
    text: "This message was deleted.",
    reply_count: parent.reply_count,
    reply_users: parent.reply_users,
    latest_reply: parent.latest_reply,
  };
}

/**
 * A channel with what a real one holds: a thread parent with replies, an
 * edited message, a bot post with no user, a join notice, a file share, an
 * empty-text message, user mentions and links in Slack's markup, unicode and
 * emoji shortcodes, a duplicate text from two people, and a long paste.
 */
export function messySlackChannel(): FakeSlackState {
  const thread = { thread_ts: slackTs(3), parent_user_id: "U0BLAKE" };
  const broadcast = slackMessage(30, "U0CASEY", "Freeze moves to 2pm Thursday, posting here too.", {
    ...thread,
    subtype: "thread_broadcast",
  });
  const replies = [
    slackMessage(20, "U0AVERY", "Dry run is booked for Wednesday at 10.", thread),
    slackMessage(25, "U0CASEY", "", {
      ...thread,
      subtype: "file_share",
      files: [{ id: "F0RUN", name: "dry-run.log", mimetype: "text/plain" }],
    }),
    broadcast,
    slackMessage(40, "U0AVERY", "Confirmed: freeze at 2pm, ship at 4.", thread),
  ];
  const messages: SlackMessagePayload[] = [
    {
      type: "message",
      subtype: "channel_join",
      ts: slackTs(1),
      user: "U0AVERY",
      text: "<@U0AVERY> has joined the channel",
    },
    slackMessage(2, "U0AVERY", "Deploy plan for Thursday: freeze at noon, ship at 3."),
    slackMessage(3, "U0BLAKE", "Can we move the freeze? <@U0AVERY> the migration needs a dry run first.", {
      thread_ts: slackTs(3),
      reply_count: 4,
      reply_users: ["U0AVERY", "U0CASEY"],
      latest_reply: slackTs(40),
    }),
    slackMessage(4, "U0CASEY", "Release notes draft is ready", { edited: { user: "U0CASEY", ts: slackTs(9) } }),
    {
      type: "message",
      subtype: "bot_message",
      ts: slackTs(5),
      bot_id: "B0DEPLOY",
      username: "deploy-bot",
      text: "Production deploy dpl_123 succeeded :white_check_mark:",
    },
    {
      type: "message",
      ts: slackTs(6),
      bot_id: "B0LINEAR",
      text: "New issue ENG-42 created by an integration that posts as an app user",
      team: "T0EXAMPLE",
    },
    slackMessage(7, "U0AVERY", "", {
      subtype: "file_share",
      files: [{ id: "F0SPEC", name: "spec.pdf", mimetype: "application/pdf" }],
    }),
    slackMessage(8, "U0BLAKE", "東京チームも参加します :tada: — Zoë confirmed <https://example.test/plan|the plan>"),
    slackMessage(10, "U0AVERY", "+1"),
    slackMessage(11, "U0CASEY", "+1"),
    slackMessage(12, "U0BLAKE", `Log from the failed job:\n${"ERROR worker-3 timeout after 30000ms\n".repeat(200)}`),
    broadcast,
  ];
  return { messages, replies: new Map([[slackTs(3), replies]]), error: null, rateLimited: false };
}

/** A channel of `count` plain messages, one a second. */
export function busySlackChannel(count: number): FakeSlackState {
  return {
    messages: Array.from({ length: count }, (_, i) =>
      slackMessage(i + 1, i % 2 ? "U0AVERY" : "U0BLAKE", `Update ${i + 1}`),
    ),
    replies: new Map(),
    error: null,
    rateLimited: false,
  };
}

/**
 * Page through `items` with Slack's opaque `next_cursor`, which names the `ts`
 * the next page starts at (`next_ts:<ts>`), so a message deleted between two
 * pages shifts nothing. `items` are in listing order: newest first for the
 * history, oldest first for a thread.
 */
function slackPage<T extends { ts: string }>(
  items: T[],
  url: URL,
  newestFirst: boolean,
): { slice: T[]; hasMore: boolean; nextCursor: string } {
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "100", 10) || 100, 999);
  const cursor = url.searchParams.get("cursor");
  const from = cursor ? Number(Buffer.from(cursor, "base64").toString().replace("next_ts:", "")) : null;
  const offset =
    from === null ? 0 : items.findIndex((m) => (newestFirst ? Number(m.ts) <= from : Number(m.ts) >= from));
  const start = offset === -1 ? items.length : offset;
  const slice = items.slice(start, start + limit);
  const next = items[start + limit];
  return {
    slice,
    hasMore: next !== undefined,
    nextCursor: next ? Buffer.from(`next_ts:${next.ts}`).toString("base64") : "",
  };
}

/**
 * A `fetch` that answers `conversations.history` and `conversations.replies`
 * like Slack. Tracked as `conversations.history` and `conversations.replies`.
 */
export function fakeSlack(state: FakeSlackState, log?: ReadLog) {
  const requests: Record<string, string>[] = [];
  const fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = requestUrl(input);
    requests.push(Object.fromEntries(url.searchParams));
    if (state.rateLimited)
      return providerResponse({ ok: false, error: "ratelimited" }, { status: 429, headers: { "retry-after": "30" } });
    if (url.pathname !== "/api/conversations.history" && url.pathname !== "/api/conversations.replies") {
      return providerResponse({ ok: false, error: "unknown_method" });
    }
    if (state.error) return providerResponse({ ok: false, error: state.error });

    if (url.pathname === "/api/conversations.replies") {
      const ts = url.searchParams.get("ts") ?? "";
      // A parent deleted while it still has replies stays in `messages` as a tombstone (`slackTombstone`).
      const parent = state.messages.find((m) => m.ts === ts);
      if (!parent) return providerResponse({ ok: false, error: "thread_not_found" });
      const { slice, hasMore, nextCursor } = slackPage(state.replies.get(ts) ?? [], url, false);
      const body = {
        ok: true,
        messages: [parent, ...slice],
        has_more: hasMore,
        response_metadata: { next_cursor: nextCursor },
      };
      return providerResponse(body, { track: log ? { root: "conversations.replies", log } : undefined });
    }

    const inclusive = url.searchParams.get("inclusive") === "true";
    const bound = (name: string, fallback: number) => Number(url.searchParams.get(name) ?? fallback);
    const [oldest, latest] = [bound("oldest", 0), bound("latest", Infinity)];
    const newestFirst = [...state.messages].reverse().filter((m) => {
      const ts = Number(m.ts);
      return inclusive ? ts >= oldest && ts <= latest : ts > oldest && ts < latest;
    });
    const { slice, hasMore, nextCursor } = slackPage(newestFirst, url, true);
    const body = {
      ok: true,
      messages: slice,
      has_more: hasMore,
      pin_count: 0,
      channel_actions_ts: null,
      channel_actions_count: 0,
      response_metadata: { next_cursor: nextCursor },
    };
    return providerResponse(body, { track: log ? { root: "conversations.history", log } : undefined });
  };
  return { fetch, requests };
}

export interface FigmaCommentPayload {
  id: string;
  file_key: string;
  /** Empty string on a top-level comment, the parent's id on a reply. */
  parent_id: string;
  user: { id: string; handle: string; img_url: string };
  created_at: string;
  resolved_at: string | null;
  message: string;
  client_meta: { node_id: string; node_offset: { x: number; y: number } } | { x: number; y: number } | null;
  order_id: string | null;
  reactions: { emoji: string; created_at: string; user: { id: string; handle: string; img_url: string } }[];
}

export interface FakeFigmaState {
  fileKey: string;
  comments: FigmaCommentPayload[];
  failWith: { status: 403 | 404 | 429; message: string } | null;
}

function figmaUser(handle: string) {
  return { id: String(1_000 + handle.length), handle, img_url: `https://s3-alpha.figma.com/profile/${handle}` };
}

/**
 * One file's comments with what a real file has: a thread with replies, a
 * resolved comment, a comment pinned to a node and one placed on the canvas,
 * reactions, an emoji-only comment, unicode, and a long comment.
 */
export function messyFigmaFile(fileKey = "AbCdEf123456"): FakeFigmaState {
  const comment = (
    id: string,
    fields: Partial<FigmaCommentPayload> & { message: string; handle: string; at: string },
  ): FigmaCommentPayload => {
    const { handle, at, ...rest } = fields;
    return {
      id,
      file_key: fileKey,
      parent_id: "",
      user: figmaUser(handle),
      created_at: at,
      resolved_at: null,
      client_meta: { node_id: "12:345", node_offset: { x: 24, y: 8 } },
      order_id: id,
      reactions: [],
      ...rest,
    };
  };
  return {
    fileKey,
    failWith: null,
    comments: [
      comment("901", {
        message: "Spacing on the citation chip is 6px, the spec says 8.",
        handle: "designer.dana",
        at: "2026-10-10T10:00:00.000Z",
      }),
      comment("902", {
        message: "Fixed in the next frame.",
        handle: "eng.eli",
        at: "2026-10-10T10:05:00.000Z",
        parent_id: "901",
        order_id: null,
      }),
      comment("903", {
        message: "Thanks!",
        handle: "designer.dana",
        at: "2026-10-10T10:06:00.000Z",
        parent_id: "901",
        order_id: null,
      }),
      comment("904", {
        message: "Old empty state, superseded.",
        handle: "pm.pat",
        at: "2026-10-09T09:00:00.000Z",
        resolved_at: "2026-10-11T12:00:00.000Z",
      }),
      comment("905", {
        message: "🚀",
        handle: "pm.pat",
        at: "2026-10-11T09:00:00.000Z",
        client_meta: { x: 1200, y: -40 },
      }),
      comment("906", {
        message: "Libellé « Mémoire » trop long en français — Zoë",
        handle: "loc.zoe",
        at: "2026-10-12T09:00:00.000Z",
        reactions: [{ emoji: ":+1:", created_at: "2026-10-12T09:10:00.000Z", user: figmaUser("eng.eli") }],
      }),
      comment("907", {
        message: `Full audit of the onboarding flow:\n${"- step copy is unclear\n".repeat(300)}`,
        handle: "research.rae",
        at: "2026-10-13T09:00:00.000Z",
      }),
    ],
  };
}

/** A `fetch` that answers `GET /v1/files/:key/comments` like Figma. Tracked as `comments`. */
export function fakeFigma(state: FakeFigmaState, log?: ReadLog) {
  const fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = requestUrl(input);
    if (state.failWith)
      return providerResponse(
        { status: state.failWith.status, err: state.failWith.message },
        { status: state.failWith.status },
      );
    if (url.pathname !== `/v1/files/${state.fileKey}/comments`)
      return providerResponse({ status: 404, err: "Not found" }, { status: 404 });
    return providerResponse({ comments: state.comments }, { track: log ? { root: "comments", log } : undefined });
  };
  return { fetch };
}
