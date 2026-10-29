// The change-feed hook's contract with Claude Code and with the network, without
// a server. The real route and database are exercised end to end in
// app/api/changes/notice/route.realdb.test.ts.
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { MAX_NOTICES_PER_CALL } from "@/mcp/change-notices";
import { BOUNDARY_TASK_START_MAX_TOKENS, PIGGYBACK_TOKEN_BUDGET, TASK_START_MAX_TOKENS } from "@/mcp/task-start-notice";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  CONTEXT_PREFIX,
  CUT_MARK,
  MAX_CONTEXT_CHARS,
  PROMPT_SENT_CHARS,
  fetchNotice,
  hookOutput,
  noticeUrl,
  promptHeaderValue,
} from "./willder-changes.mjs";

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("hookOutput", () => {
  it("frames a notice as additional context for the event Claude Code is running", () => {
    const output = JSON.parse(hookOutput("UserPromptSubmit", "- update fact f1 by agent-b: new price"));

    expect(output).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: `${CONTEXT_PREFIX}\n- update fact f1 by agent-b: new price`,
      },
    });
  });

  it("prints nothing for no notice or an event it does not answer", () => {
    expect(hookOutput("PostToolUse", null)).toBe("");
    expect(hookOutput("PostToolUse", "  ")).toBe("");
    expect(hookOutput("PreToolUse", "- something changed")).toBe("");
  });

  it("bounds what a server can push into the agent's context, and says where it cut", () => {
    const output = JSON.parse(hookOutput("PostToolUse", "x".repeat(2 * MAX_CONTEXT_CHARS)));

    expect(output.hookSpecificOutput.additionalContext).toHaveLength(MAX_CONTEXT_CHARS);
    expect(output.hookSpecificOutput.additionalContext.endsWith(CUT_MARK)).toBe(true);
  });

  it("cuts a long notice at a line end, so no change line is shown half written", () => {
    const lines = Array.from(
      { length: Math.ceil((2 * MAX_CONTEXT_CHARS) / 80) },
      (_, i) => `- update fact f${i} by agent-x: ${"y".repeat(60)}`,
    );
    const context = JSON.parse(hookOutput("PostToolUse", lines.join("\n"))).hookSpecificOutput.additionalContext;

    const shown = context.slice(CONTEXT_PREFIX.length + 1, -CUT_MARK.length).split("\n");
    expect(shown).toEqual(lines.slice(0, shown.length));
  });

  it("passes a whole piggyback through: a full first block and its change notices are never cut", () => {
    // PIGGYBACK_TOKEN_BUDGET is the server's estimate of a full piggyback, counted at four
    // characters to a token (estimateTokens in mcp/task-start-notice.ts). It holds the block at its
    // longest and five notice lines of typical length; a merged line naming a long fact can run past it.
    expect(PIGGYBACK_TOKEN_BUDGET).toBeGreaterThanOrEqual(TASK_START_MAX_TOKENS + MAX_NOTICES_PER_CALL * 75);
    const fullPiggyback = "x".repeat(PIGGYBACK_TOKEN_BUDGET * 4);
    const output = JSON.parse(hookOutput("UserPromptSubmit", fullPiggyback));

    expect(output.hookSpecificOutput.additionalContext).toBe(`${CONTEXT_PREFIX}\n${fullPiggyback}`);
  });

  it("passes a boundary block at its longest through whole; only the notices after it are cut", () => {
    const block = "x".repeat(BOUNDARY_TASK_START_MAX_TOKENS * 4);
    const notices = Array.from({ length: 40 }, (_, i) => `- update fact f${i} by agent-x: ${"y".repeat(60)}`).join(
      "\n",
    );
    const context = JSON.parse(hookOutput("SessionStart", `${block}\n${notices}`)).hookSpecificOutput.additionalContext;

    expect(context.startsWith(`${CONTEXT_PREFIX}\n${block}\n`)).toBe(true);
    expect(context.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
    expect(context.endsWith(CUT_MARK)).toBe(true);
  });

  it("puts what the hook itself says first, outside the data prefix, and cuts only the notice to make room for it", () => {
    const own = "Willder handoff: record where the task stands.";
    expect(JSON.parse(hookOutput("PostToolUse", null, own)).hookSpecificOutput.additionalContext).toBe(own);
    const context = JSON.parse(hookOutput("PostToolUse", "x".repeat(2 * MAX_CONTEXT_CHARS), own)).hookSpecificOutput
      .additionalContext;
    expect(context.startsWith(`${own}\n\n${CONTEXT_PREFIX}\n`)).toBe(true);
    expect(context).toHaveLength(MAX_CONTEXT_CHARS);
    expect(context.endsWith(CUT_MARK)).toBe(true);
  });
});

describe("noticeUrl", () => {
  it("accepts https anywhere and plain http only on this machine", () => {
    expect(noticeUrl("https://willder.ai")?.href).toBe("https://willder.ai/api/changes/notice");
    expect(noticeUrl("http://localhost:3000")?.href).toBe("http://localhost:3000/api/changes/notice");
    expect(noticeUrl("http://willder.example")).toBeNull();
    expect(noticeUrl("not a url")).toBeNull();
  });
});

describe("fetchNotice", () => {
  const env = { WILLDER_TOKEN: "wcap_test", WILLDER_URL: "https://willder.example" };

  it("sends the token as a bearer header and returns the notice", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { notice: "- create fact f1 by b" }));

    expect(await fetchNotice(env, fetchImpl)).toBe("- create fact f1 by b");
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL("https://willder.example/api/changes/notice"),
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer wcap_test" }) }),
    );
  });

  it("names the session's task from WILLDER_TASK in the X-Willder-Task header, as the MCP connection does", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { notice: null }));

    await fetchNotice({ ...env, WILLDER_TASK: " WEB-412 " }, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ headers: expect.objectContaining({ "x-willder-task": "WEB-412" }) }),
    );
  });

  it("names Claude Code's session in the X-Willder-Session header, and sends none it could not send", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { notice: null }));

    await fetchNotice(env, fetchImpl, "3f1c9a2e-session");
    await fetchNotice(env, fetchImpl, undefined);
    await fetchNotice(env, fetchImpl, { id: "not a string" });
    await fetchNotice(env, fetchImpl, "sessão ✓");

    const sessions = (fetchImpl.mock.calls as unknown as [URL, { headers: Record<string, string> }][]).map(
      ([, init]) => init.headers["x-willder-session"],
    );
    expect(sessions).toEqual(["3f1c9a2e-session", undefined, undefined, undefined]);
  });

  it("sends the prompt, redacted and percent-encoded, in the X-Willder-Prompt header, and none without one", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { notice: null }));
    const prompt =
      "Fix the ledger retry (ünïcode ✓); the key is sk-" + "ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCD";

    await fetchNotice(env, fetchImpl, "s-1", prompt);
    await fetchNotice(env, fetchImpl, "s-1", undefined);
    await fetchNotice(env, fetchImpl, "s-1", "   ");

    const sent = (fetchImpl.mock.calls as unknown as [URL, { headers: Record<string, string> }][]).map(
      ([, init]) => init.headers["x-willder-prompt"],
    );
    expect(sent[1]).toBeUndefined();
    expect(sent[2]).toBeUndefined();
    const decoded = decodeURIComponent(sent[0]!);
    expect(decoded).toMatch(/^Fix the ledger retry \(ünïcode ✓\); the key is \[redacted\]/);
    expect(decoded).not.toContain("sk-ant");
    expect(sent[0]).toMatch(/^[\x20-\x7e]+$/);
  });

  it("cuts the prompt to its bound after redacting, so a secret the cut runs through is still removed", () => {
    const secret = "ghp_" + "a1B2c3D4e5".repeat(4);
    const prompt = `${"word ".repeat(100)}${secret} and more`;
    const sent = decodeURIComponent(promptHeaderValue(prompt, {})!);
    expect(Array.from(sent)).toHaveLength(PROMPT_SENT_CHARS);
    expect(sent).not.toContain("ghp_a1B2");
    expect(promptHeaderValue("x".repeat(10_000), {})).toBe("x".repeat(PROMPT_SENT_CHARS));
    expect(promptHeaderValue(42, {})).toBeUndefined();
  });

  it("still asks when the prompt holds a lone surrogate, which percent-encoding refuses", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { notice: "- create fact f1 by b" }));

    expect(await fetchNotice(env, fetchImpl, "s-1", "broken \uD800 half")).toBe("- create fact f1 by b");
    const [[, init]] = fetchImpl.mock.calls as unknown as [URL, { headers: Record<string, string> }][];
    expect(decodeURIComponent(init.headers["x-willder-prompt"]!)).toBe("broken \uFFFD half");
  });

  it("sends no task header when WILLDER_TASK is unset, blank, or not printable ASCII", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { notice: null }));

    await fetchNotice(env, fetchImpl);
    await fetchNotice({ ...env, WILLDER_TASK: "  " }, fetchImpl);
    // fetch refuses a header outside Latin-1; the hook must still ask, without the task.
    await fetchNotice({ ...env, WILLDER_TASK: "Händler-Logs ✓" }, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(3);

    for (const [, init] of fetchImpl.mock.calls as unknown as [URL, { headers: Record<string, string> }][]) {
      expect(Object.keys(init.headers)).not.toContain("x-willder-task");
    }
  });

  it("makes no request without a token, or to an origin it would leak the token to", async () => {
    const fetchImpl = vi.fn();

    expect(await fetchNotice({}, fetchImpl)).toBeNull();
    expect(await fetchNotice({ ...env, WILLDER_URL: "http://willder.example" }, fetchImpl)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns null for an error status, a malformed body, or a network failure", async () => {
    expect(await fetchNotice(env, async () => jsonResponse(401, { error: "Invalid" }))).toBeNull();
    expect(await fetchNotice(env, async () => jsonResponse(200, { notice: 42 }))).toBeNull();
    expect(await fetchNotice(env, async () => new Response("<html>", { status: 200 }))).toBeNull();
    expect(
      await fetchNotice(env, async () => {
        throw new TypeError("fetch failed");
      }),
    ).toBeNull();
  });
});

describe("the hook as Claude Code runs it", () => {
  // Each test starts a node process; on a loaded CI runner that can outlast
  // Vitest's 5 s default, so the bound is explicit.
  const SPAWN_TEST_TIMEOUT_MS = 30_000;
  const hookPath = fileURLToPath(new URL("./willder-changes.mjs", import.meta.url));
  const run = (stdin: string, extraEnv: Record<string, string> = {}) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
      const child = execFile(
        process.execPath,
        [hookPath],
        { env: { NODE_ENV: "test", ...extraEnv } },
        (error, stdout, stderr) => done({ code: error ? (error.code as number) : 0, stdout, stderr }),
      );
      child.stdin!.end(stdin);
    });

  it(
    "exits 0 silently on unreadable input",
    async () => {
      expect(await run("not json")).toEqual({ code: 0, stdout: "", stderr: "" });
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "exits 0 silently when no server answers",
    async () => {
      // Port 9 (discard) on loopback: nothing listens, the connection is refused.
      const result = await run(JSON.stringify({ hook_event_name: "PostToolUse" }), {
        WILLDER_TOKEN: "wcap_test",
        WILLDER_URL: "http://127.0.0.1:9",
      });

      expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "sends the prompt of a UserPromptSubmit to the server, and no prompt after a tool call",
    async () => {
      const received: (string | undefined)[] = [];
      const server = createServer((req, res) => {
        const header = req.headers["x-willder-prompt"];
        received.push(typeof header === "string" ? header : undefined);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ notice: null }));
      });
      await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
      const env = {
        WILLDER_TOKEN: "wcap_test",
        WILLDER_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      };
      try {
        await run(
          JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s-1", prompt: "Fix the ledger retry" }),
          env,
        );
        await run(
          JSON.stringify({ hook_event_name: "PostToolUse", session_id: "s-1", prompt: "not a prompt event" }),
          env,
        );
      } finally {
        server.close();
      }
      expect(received).toEqual([encodeURIComponent("Fix the ledger retry"), undefined]);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "asks at a SessionStart only after a compaction or a /clear, naming which in X-Willder-Reason, and hands the block back for SessionStart",
    async () => {
      const received: (string | null)[] = [];
      const server = createServer((req, res) => {
        const reason = req.headers["x-willder-reason"];
        received.push(typeof reason === "string" ? reason : null);
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ notice: "Before you start: the block" }));
      });
      await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
      const env = {
        WILLDER_TOKEN: "wcap_test",
        WILLDER_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      };
      const cases: [input: Record<string, unknown>, asked: string | null | "no request"][] = [
        [{ hook_event_name: "SessionStart", source: "compact" }, "compact"],
        [{ hook_event_name: "SessionStart", source: "clear" }, "clear"],
        [{ hook_event_name: "SessionStart", source: "startup" }, "no request"],
        [{ hook_event_name: "SessionStart", source: "resume" }, "no request"],
        [{ hook_event_name: "SessionStart", source: "Compact" }, "no request"],
        [{ hook_event_name: "SessionStart" }, "no request"],
        [{ hook_event_name: "UserPromptSubmit", source: "compact", prompt: "go" }, null],
        [{ hook_event_name: "PostToolUse", source: "clear" }, null],
      ];
      const outputs: string[] = [];
      try {
        for (const [input, asked] of cases) {
          const before = received.length;
          const { stdout } = await run(JSON.stringify({ session_id: "s-1", ...input }), env);
          expect(
            asked === "no request"
              ? received.length === before
              : received.at(-1) === asked && received.length === before + 1,
            JSON.stringify(input),
          ).toBe(true);
          if (input.hook_event_name === "SessionStart" && stdout)
            outputs.push(JSON.parse(stdout).hookSpecificOutput.hookEventName);
        }
      } finally {
        server.close();
      }
      expect(outputs).toEqual(["SessionStart", "SessionStart"]);
    },
    SPAWN_TEST_TIMEOUT_MS * 2,
  );

  it(
    "with capture on, exits 0 silently on Stop when no server answers, and prints nothing that would keep the agent going",
    async () => {
      const result = await run(
        JSON.stringify({ hook_event_name: "Stop", session_id: "s-1", last_assistant_message: "Done." }),
        {
          WILLDER_TOKEN: "wcap_test",
          WILLDER_URL: "http://127.0.0.1:9",
          WILLDER_CAPTURE: "session-state",
          TMPDIR: tmpdir(),
        },
      );

      expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});
