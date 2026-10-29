// withChangeNotices at its seam: a tool handler in, a tool handler out. The feed
// it reads is exercised against a real database in change-notices.realdb.test.ts;
// this file pins the rule that a notice can never break the call it rides on, and
// how one notice line reads.
import { describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { MAX_NOTICES_PER_CALL, formatChange, noticeLines, noticeTake, withChangeNotices } from "./change-notices";
import type { Change } from "@/services/memory/change-feed";

const answer: CallToolResult = { content: [{ type: "text", text: "the tool's own answer" }] };
const handler = async (_args: { q: string }) => answer;

describe("withChangeNotices", () => {
  it("appends the notice after the tool's own content", async () => {
    const wrapped = withChangeNotices(handler, async () => "a notice");

    expect(await wrapped({ q: "x" })).toEqual({
      content: [
        { type: "text", text: "the tool's own answer" },
        { type: "text", text: "a notice" },
      ],
    });
  });

  it("returns the result unchanged when there is nothing to say", async () => {
    const wrapped = withChangeNotices(handler, async () => null);

    expect(await wrapped({ q: "x" })).toBe(answer);
  });

  it("returns the result unchanged when reading the feed fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const wrapped = withChangeNotices(handler, async () => {
      throw new Error("database unreachable");
    });

    expect(await wrapped({ q: "x" })).toBe(answer);
    expect(warn).toHaveBeenCalledWith("[change-notices] notice skipped:", "database unreachable");
    warn.mockRestore();
  });

  it("reads the feed before the handler, so a write never consumes its own notice", async () => {
    // The order the losing writer of a conflict depends on: its ingest announces a
    // `supersede` event about itself, and if the notice were read afterwards that same
    // call would swallow it (mcp/conflict-notice.realdb.test.ts).
    const order: string[] = [];
    const wrapped = withChangeNotices(
      async () => {
        order.push("handler");
        return answer;
      },
      async () => {
        order.push("notice");
        return "a notice";
      },
    );

    await wrapped();

    expect(order).toEqual(["notice", "handler"]);
  });

  it("with readAlongside, starts the handler while the notice is still being read and still appends it", async () => {
    let finishNotice!: (text: string) => void;
    const handlerRan = vi.fn(async () => answer);
    const wrapped = withChangeNotices(handlerRan, () => new Promise<string>((resolve) => (finishNotice = resolve)), {
      readAlongside: true,
    });

    const calling = wrapped();
    await vi.waitFor(() => expect(handlerRan).toHaveBeenCalled());
    finishNotice("a notice");

    expect((await calling).content).toEqual([...answer.content, { type: "text", text: "a notice" }]);
  });

  it("keeps the tool's error flag, so a failed call still reads as failed", async () => {
    const failed: CallToolResult = { content: [{ type: "text", text: "Access denied" }], isError: true };
    const wrapped = withChangeNotices(
      async () => failed,
      async () => "a notice",
    );

    expect((await wrapped()).isError).toBe(true);
  });
});

describe("formatChange", () => {
  const change: Change = {
    id: "c1",
    scopePath: "org_1.eng",
    recordType: "fact",
    recordId: "fact-1",
    op: "supersede",
    actorId: "agent-editor",
    summary: "Release freeze moved to Thursdays.",
    createdAt: new Date(0),
    supersededById: null,
  };

  it("names the change and carries its summary", () => {
    expect(formatChange(change)).toBe("- supersede fact fact-1 by agent-editor: Release freeze moved to Thursdays.");
  });

  it("ends at the actor when there is no summary", () => {
    expect(formatChange({ ...change, op: "delete", summary: "" })).toBe("- delete fact fact-1 by agent-editor");
  });
});

describe("noticeTake and noticeLines (unit)", () => {
  const READER = "agent-reader";
  const notReader = (c: Pick<Change, "actorId">) => c.actorId !== READER;
  const NO_NAMES = new Map<string, string>();
  const change = (
    recordId: string,
    actorId: string,
    op: Change["op"] = "create",
    summary = `${recordId} text`,
  ): Change => ({
    id: `${recordId}-${actorId}-${op}`,
    scopePath: "org_1.sales",
    recordType: "fact",
    recordId,
    op,
    actorId,
    summary,
    createdAt: new Date(0),
    supersededById: null,
  });
  /** Six fact versions v0..v5, all of the fact named `name`. */
  const versionsOf = (name: string, count: number, prefix = "v") =>
    new Map(Array.from({ length: count }, (_, i) => [`${prefix}${i}`, name]));

  it("gives each change its own line while they fit", () => {
    const changes = Array.from({ length: MAX_NOTICES_PER_CALL }, (_, i) => change(`v${i}`, `agent-${i}`));
    expect(noticeTake(changes, notReader, versionsOf("Acme", 5))).toBe(changes.length);
    expect(noticeLines(changes, notReader, versionsOf("Acme", 5))).toEqual(changes.map(formatChange));
  });

  it("merges the versions of one fact into one line, naming the fact and its latest version", () => {
    const changes = [
      ...Array.from({ length: 5 }, (_, i) => change(`v${i}`, `agent-${i % 2}`)),
      change("v5", "agent-0", "supersede", ""),
    ];
    expect(noticeLines(changes, notReader, versionsOf("Acme renewal", 6))).toEqual([
      '- 6 changes to fact "Acme renewal" by 2 actors; latest: supersede fact v5',
    ]);
  });

  it("names the latest operation when one record is changed again, so a delete is never hidden", () => {
    const changes = [
      ...Array.from({ length: 5 }, (_, i) => change(`v${i}`, "agent-a")),
      change("v0", "agent-a", "delete", ""),
    ];
    expect(noticeLines(changes, notReader, NO_NAMES)[0]).toBe(
      "- 2 changes to fact v0 by agent-a; latest: delete fact v0",
    );
  });

  it("takes changes up to the first fact past the line cap, the reader's own included", () => {
    const names = new Map([
      ...versionsOf("A", 2, "a"),
      ...versionsOf("F", 1, "f"),
      ["b0", "B"],
      ["c0", "C"],
      ["d0", "D"],
      ["e0", "E"],
    ]);
    const page = [
      ...["a0", "b0", "c0", "d0", "e0"].map((id) => change(id, "agent-w")),
      change("a1", "agent-w"),
      change("own", READER),
      change("f0", "agent-w"),
      change("a2", "agent-w"),
    ];
    expect(noticeTake(page, notReader, names)).toBe(7);
  });

  it("keeps facts of the same name in two scopes apart", () => {
    const sales = Array.from({ length: 3 }, (_, i) => change(`s${i}`, "agent-a"));
    const eng = Array.from({ length: 3 }, (_, i) => ({ ...change(`e${i}`, "agent-a"), scopePath: "org_1.eng" }));
    const names = new Map([...versionsOf("Acme", 3, "s"), ...versionsOf("Acme", 3, "e")]);
    expect(noticeLines([...sales, ...eng], notReader, names)).toHaveLength(2);
  });

  it("leaves the reader's own changes out of the lines", () => {
    expect(noticeLines([change("v0", READER), change("v1", "agent-a")], notReader, NO_NAMES)).toEqual([
      "- create fact v1 by agent-a: v1 text",
    ]);
  });
});
