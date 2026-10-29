// The Slack and Figma connectors' real branches against payloads in each
// provider's own shape (fixtures/slack-figma.ts). slack.test.ts and
// figma.test.ts cover the contract on minimal payloads; this file covers the
// mess, the scale and the error answers a live channel or file produces.
// Both modules read their mock flag at import, so each test imports fresh.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  busySlackChannel,
  fakeFigma,
  fakeSlack,
  messyFigmaFile,
  messySlackChannel,
  type FakeFigmaState,
  type FakeSlackState,
} from "./fixtures/slack-figma";

beforeEach(() => {
  vi.stubEnv("SLACK_MOCK", "false");
  vi.stubEnv("FIGMA_MOCK", "false");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function slackWith(state: FakeSlackState) {
  const slack = fakeSlack(state);
  vi.stubGlobal("fetch", vi.fn(slack.fetch));
  return { ...(await import("./slack")), requests: slack.requests };
}

async function figmaWith(state: FakeFigmaState) {
  vi.stubGlobal("fetch", vi.fn(fakeFigma(state).fetch));
  return import("./figma");
}

describe("listChannelMessages on a real-shaped channel", () => {
  it("returns people's messages oldest first, then the thread's replies, and drops joins, bot posts, file shares and empty text", async () => {
    const { listChannelMessages } = await slackWith(messySlackChannel());
    const { items: messages } = await listChannelMessages("C0EXAMPLE", "test-slack-token");
    expect(messages.map((m) => [m.user, m.text.slice(0, 24)])).toEqual([
      ["U0AVERY", "Deploy plan for Thursday"],
      ["U0BLAKE", "Can we move the freeze? "],
      ["U0CASEY", "Release notes draft is r"],
      ["unknown", "New issue ENG-42 created"],
      ["U0BLAKE", "東京チームも参加します :tada: — Zoë"],
      ["U0AVERY", "+1"],
      ["U0CASEY", "+1"],
      ["U0BLAKE", "Log from the failed job:"],
      ["U0AVERY", "Dry run is booked for We"],
      ["U0CASEY", "Freeze moves to 2pm Thur"],
      ["U0AVERY", "Confirmed: freeze at 2pm"],
    ]);
  });

  it("reads a thread parent's replies with conversations.replies, the reply also sent to the channel once, as a reply", async () => {
    const channel = messySlackChannel();
    const { listChannelMessages } = await slackWith(channel);
    const { items } = await listChannelMessages("C0EXAMPLE", "test-slack-token");
    const parent = items.find((m) => m.text.startsWith("Can we move"));
    expect(parent?.text).toContain("<@U0AVERY>"); // mentions stay in Slack's markup, unresolved
    const replies = channel.replies.get(parent?.ts ?? "") ?? [];
    expect(items.filter((m) => m.id.startsWith(`${parent?.ts}/`))).toEqual(
      [replies[0], replies[2], replies[3]].map((r) => ({
        id: `${parent?.ts}/${r.ts}`,
        ts: r.ts,
        user: r.user,
        text: r.text,
        checksum: expect.any(String),
      })),
    );
    expect(items.filter((m) => m.text.startsWith("Freeze moves to 2pm"))).toHaveLength(1);
    const calls = vi.mocked(fetch).mock.calls.map(([input]) => new URL(String(input)));
    expect(calls.map((url) => url.pathname)).toEqual(["/api/conversations.history", "/api/conversations.replies"]);
    expect(Object.fromEntries(calls[1].searchParams)).toEqual({ channel: "C0EXAMPLE", ts: parent?.ts, limit: "100" });
  });

  it("keeps two identical texts from two people as two messages by ts", async () => {
    const { listChannelMessages } = await slackWith(messySlackChannel());
    const plusOnes = (await listChannelMessages("C0EXAMPLE", "test-slack-token")).items.filter((m) => m.text === "+1");
    expect(new Set(plusOnes.map((m) => m.id)).size).toBe(2);
  });

  it("reads a 500-message channel two pages a sync, following next_cursor, and finishes it on later syncs", async () => {
    const { listChannelMessages, requests } = await slackWith(busySlackChannel(500));
    const now = (1_791_000_000 + 600) * 1000;
    const first = await listChannelMessages("C0EXAMPLE", "test-slack-token", { now });
    expect(first.items).toHaveLength(200);
    expect(first.items[0].text).toBe("Update 301");
    expect(first.items.at(-1)?.text).toBe("Update 500");
    expect(requests.map((r) => r.cursor)).toEqual([undefined, expect.any(String)]);

    const second = await listChannelMessages("C0EXAMPLE", "test-slack-token", { cursor: first.cursor, now });
    const third = await listChannelMessages("C0EXAMPLE", "test-slack-token", { cursor: second.cursor, now });
    expect([...third.items, ...second.items, ...first.items].map((m) => m.text)).toEqual(
      Array.from({ length: 500 }, (_, i) => `Update ${i + 1}`),
    );
    expect(third.cursor).toEqual({ oldest: `${1_791_000_000 + 600 - 3600}.000000` });
  });

  it("fails on a 429 rate limit and on an ok:false answer instead of returning no messages", async () => {
    const limited = busySlackChannel(3);
    limited.rateLimited = true;
    await expect((await slackWith(limited)).listChannelMessages("C0EXAMPLE", "test-slack-token")).rejects.toThrow(
      /429/,
    );
    vi.resetModules();

    const notInChannel = busySlackChannel(3);
    notInChannel.error = "not_in_channel";
    await expect((await slackWith(notInChannel)).listChannelMessages("C0EXAMPLE", "test-slack-token")).rejects.toThrow(
      /not_in_channel/,
    );
  });
});

describe("listFileComments on a real-shaped file", () => {
  it("returns replies and resolved comments as items of their own, in Figma's order", async () => {
    const { listFileComments } = await figmaWith(messyFigmaFile());
    const comments = await listFileComments("AbCdEf123456", "test-figma-token");
    expect(comments.map((c) => [c.id, c.author])).toEqual([
      ["901", "designer.dana"],
      ["902", "eng.eli"],
      ["903", "designer.dana"],
      ["904", "pm.pat"],
      ["905", "pm.pat"],
      ["906", "loc.zoe"],
      ["907", "research.rae"],
    ]);
    expect(comments.find((c) => c.id === "906")?.text).toBe("Libellé « Mémoire » trop long en français — Zoë");
  });

  it("does not clip a long comment", async () => {
    const { listFileComments } = await figmaWith(messyFigmaFile());
    const long = (await listFileComments("AbCdEf123456", "test-figma-token")).find((c) => c.id === "907");
    expect(long?.text.length).toBeGreaterThan(6_000);
  });

  it("fails with Figma's message on a 403, 404 or 429", async () => {
    for (const failWith of [
      { status: 403, message: "Invalid token" },
      { status: 404, message: "Not found" },
      { status: 429, message: "Rate limit exceeded" },
    ] as const) {
      const state = messyFigmaFile();
      state.failWith = failWith;
      const { listFileComments } = await figmaWith(state);
      await expect(listFileComments("AbCdEf123456", "test-figma-token")).rejects.toThrow(failWith.message);
      vi.resetModules();
    }
  });
});
