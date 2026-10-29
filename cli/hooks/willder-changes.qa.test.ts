// The hook's context cap (MAX_CONTEXT_CHARS).
//
// The cap exists for a server that sends more than its piggyback budget. That is not only
// a misbehaving server: a merged change line names its fact in full (formatMerged in
// mcp/change-notices.ts), and a fact's name has no length limit, so the notices after a
// full task-start block can run past the cap. What the hook cuts is the tail, the change
// lines and the "N more changes are waiting" line, whose feed cursor has already moved.
// A cut the model cannot see reads as a whole notice, so the cut has to say it is one,
// and it must not split a character in two.
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAX_CONTEXT_CHARS, hookOutput } from "./willder-changes.mjs";

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const contextOf = (notice: string): string =>
  (JSON.parse(hookOutput("UserPromptSubmit", notice)) as { hookSpecificOutput: { additionalContext: string } })
    .hookSpecificOutput.additionalContext;

describe("QA: the hook's context cap (MAX_CONTEXT_CHARS)", () => {
  it("marks a cut notice as cut, so the model does not read the rest as never written", () => {
    const lines = Array.from(
      { length: Math.ceil((2 * MAX_CONTEXT_CHARS) / 100) },
      (_, i) => `- update fact f${i} by agent-x: ${"detail ".repeat(10)}`,
    );
    const notice = [
      "Changed in your scope since your last call:",
      ...lines,
      "40 more changes are waiting: call memory_changes.",
    ].join("\n");

    const context = contextOf(notice);

    expect(context.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
    expect(context).not.toContain("40 more changes are waiting");
    const lastLine = context.slice(context.lastIndexOf("\n") + 1);
    expect(lastLine).toMatch(/…|\bcut\b|truncated|left out|memory_changes/i);
  });

  it("never splits a character outside the BMP at the cap", () => {
    // An emoji is two UTF-16 code units. One notice line with no line end to cut at, all
    // emoji after a filler of either parity, so wherever the prefix and cut mark put the cut,
    // some run lands it between the two halves of a pair.
    for (const filler of [0, 1]) {
      const context = contextOf(`${"a".repeat(filler)}${"\u{1F4E6}".repeat(MAX_CONTEXT_CHARS)}`);

      expect(context.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
      expect(context).toContain("\u{1F4E6}");
      expect(context).not.toMatch(LONE_SURROGATE);
    }
  });

  it("passes a notice that fits untouched, with no cut mark", () => {
    const notice = "Changed in your scope since your last call:\n- create fact f1 by agent-x: short";

    expect(contextOf(notice).endsWith(notice)).toBe(true);
  });
});

describe("QA: the hook as Claude Code runs it names Claude Code's session", () => {
  // The route keys the told-once claim on X-Willder-Session. Claude Code puts session_id in
  // the hook's stdin; if the running hook does not pass it on, every session of an agent on
  // one task and scope shares one claim, and a new session inside the idle window is told
  // nothing. fetchNotice taking a session argument does not show main() hands it one.
  const hookPath = fileURLToPath(new URL("./willder-changes.mjs", import.meta.url));

  it("sends the session_id from its input as X-Willder-Session", async () => {
    const seen: (string | undefined)[] = [];
    const server = createServer((req, res) => {
      seen.push(req.headers["x-willder-session"] as string | undefined);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ notice: null }));
    });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const { port } = server.address() as AddressInfo;
    try {
      await new Promise<void>((done) => {
        const child = execFile(
          process.execPath,
          [hookPath],
          { env: { NODE_ENV: "test", WILLDER_TOKEN: "wcap_test", WILLDER_URL: `http://127.0.0.1:${port}` } },
          () => done(),
        );
        child.stdin!.end(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "cc-session-7f2e" }));
      });
    } finally {
      server.close();
    }

    expect(seen).toEqual(["cc-session-7f2e"]);
  }, 30_000);
});
