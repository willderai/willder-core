import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_TOUCHES,
  RENEW_INTERVAL_MS,
  SEND_INTERVAL_MS,
  captureTouches,
  editedPath,
  fileNode,
  originUrl,
  overlapSection,
  remoteUrlIn,
  repositoryName,
  sendDue,
} from "./willder-touches.mjs";

const ENV = { WILLDER_TOKEN: "wcap_test_token", WILLDER_TASK: "WEB-412", WILLDER_CLAIM_TOUCHES: "on" };
const MCP = new URL("https://willder.test/api/mcp");
const CONFIG =
  '[core]\n\tbare = false\n[remote "upstream"]\n\turl = https://github.com/other/fork.git\n[remote "origin"]\n\turl = git@github.com:Acme/App.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n\tremote = origin\n';

describe("editedPath", () => {
  it.each([
    ["Edit", { file_path: "/repo/a.ts" }, "/repo/a.ts"],
    ["Write", { file_path: "lib/b.ts" }, "/repo/lib/b.ts"],
    ["MultiEdit", { file_path: "/repo/c.ts" }, "/repo/c.ts"],
    ["NotebookEdit", { notebook_path: "/repo/n.ipynb" }, "/repo/n.ipynb"],
    ["Read", { file_path: "/repo/a.ts" }, null],
    ["Bash", { command: "echo hi > /repo/a.ts" }, null],
    ["Edit", {}, null],
    ["toString", { file_path: "/repo/a.ts" }, null],
  ])("%s %j edits %s", (tool, toolInput, expected) => {
    expect(editedPath({ hook_event_name: "PostToolUse", tool_name: tool, tool_input: toolInput }, "/repo")).toBe(
      expected,
    );
  });

  it("reads only PostToolUse", () => {
    expect(
      editedPath(
        { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "/repo/a.ts" } },
        "/repo",
      ),
    ).toBeNull();
  });
});

describe("repositoryName", () => {
  it.each([
    ["git@github.com:Acme/App.git", "acme/app"],
    ["https://github.com/acme/app", "acme/app"],
    ["https://github.com/acme/app.git/", "acme/app"],
    ["https://x-access-token:ghs_secret@github.com/acme/app.git", "acme/app"],
    ["ssh://git@gitlab.example.com:2222/group/sub/app.git", "sub/app"],
    ["not a url", null],
  ])("%s is %s", (url, expected) => {
    expect(repositoryName(url)).toBe(expected);
  });
});

describe("originUrl", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "willder-touches-origin-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads the origin remote of a checkout, not another remote", () => {
    mkdirSync(join(dir, "repo", ".git"), { recursive: true });
    writeFileSync(join(dir, "repo", ".git", "config"), CONFIG);
    expect(originUrl(join(dir, "repo"))).toBe("git@github.com:Acme/App.git");
  });

  it("reads a worktree's shared config through its git directory's commondir", () => {
    mkdirSync(join(dir, "main", ".git", "worktrees", "wt"), { recursive: true });
    writeFileSync(join(dir, "main", ".git", "config"), CONFIG);
    writeFileSync(join(dir, "main", ".git", "worktrees", "wt", "commondir"), "../..\n");
    mkdirSync(join(dir, "wt"));
    writeFileSync(join(dir, "wt", ".git"), `gitdir: ${join(dir, "main", ".git", "worktrees", "wt")}\n`);
    expect(originUrl(join(dir, "wt"))).toBe("git@github.com:Acme/App.git");
  });

  it("is null without an origin remote or a git directory", () => {
    mkdirSync(join(dir, "repo", ".git"), { recursive: true });
    writeFileSync(join(dir, "repo", ".git", "config"), "[core]\n\tbare = false\n");
    expect(originUrl(join(dir, "repo"))).toBeNull();
    expect(originUrl(join(dir, "none"))).toBeNull();
  });
});

describe("remoteUrlIn", () => {
  it.each([
    ["a plain value", '[remote "origin"]\n\turl = git@github.com:acme/app.git\n'],
    ["a quoted value", '[remote "origin"]\n\turl = "git@github.com:acme/app.git"\n'],
    ["an upper-case key", '[remote "origin"]\n\tURL = git@github.com:acme/app.git\n'],
    ["an upper-case section", '[Remote "origin"]\n\turl = git@github.com:acme/app.git\n'],
    ["a trailing comment", '[remote "origin"]\n\turl = git@github.com:acme/app.git ; mirror\n'],
    [
      "a # comment and another remote first",
      '[remote "fork"]\n\turl = git@github.com:me/app.git\n[remote "origin"] # main\n\turl = git@github.com:acme/app.git # main\n',
    ],
  ])("reads the origin url from %s", (_case, config) => {
    expect(repositoryName(remoteUrlIn(config, "origin") ?? "")).toBe("acme/app");
  });

  it("is null for a remote that is not there", () => {
    expect(remoteUrlIn('[remote "fork"]\n\turl = x\n', "origin")).toBeNull();
  });
});

describe("fileNode", () => {
  it("writes the path from the repository root with forward slashes", () => {
    expect(fileNode("acme/app", "lib/a.ts", {})).toBe("file:acme/app/lib/a.ts");
  });

  it.each([
    ["a path redaction would change", "config/gh" + "p_abcdefghijklmnopqrstuvwxyz0123456789.json", {}],
    [
      "a path holding a secret-named variable's value",
      "tmp/supersecretvalue123/a.ts",
      { DB_PASSWORD: "supersecretvalue123" },
    ],
    ["a .. segment", "../outside.ts", {}],
    ["an empty path", "", {}],
  ])("leaves out %s", (_case, file, env) => {
    expect(fileNode("acme/app", file, env)).toBeNull();
  });
});

describe("sendDue", () => {
  const sent = { sentAt: 1_000_000, sentDigest: "d1" };
  it.each([
    ["never sent", {}, "d1", 0, true],
    ["changed inside the interval", sent, "d2", SEND_INTERVAL_MS - 1, false],
    ["changed after the interval", sent, "d2", SEND_INTERVAL_MS, true],
    ["unchanged before the renewal", sent, "d1", RENEW_INTERVAL_MS - 1, false],
    ["unchanged at the renewal", sent, "d1", RENEW_INTERVAL_MS, true],
  ])("%s: %s", (_case, state, digest, after, due) => {
    expect(sendDue(state, digest, 1_000_000 + after)).toBe(due);
  });
});

describe("overlapSection", () => {
  it("is the reply from its overlap heading on, or null", () => {
    const reply =
      'Posted claim n1 on "WEB-412" in org_1.crew, live until 2026-10-17T23:00:00Z.\n\nOverlapping files detected with 1 other live claim on other work.\n- north\'s claim n0';
    expect(overlapSection(reply)).toBe(
      "Overlapping files detected with 1 other live claim on other work.\n- north's claim n0",
    );
    expect(overlapSection("Posted claim n1.")).toBeNull();
  });
});

describe("captureTouches", () => {
  let stateDir = "";
  let repo = "";
  type SentBody = { params: { name: string; arguments: { touches: string[] }; _meta: Record<string, string> } };
  let sent: { body: SentBody; headers: Record<string, string> }[] = [];
  let reply: { isError?: boolean; text: string } = { text: "Posted claim n1." };

  const fetchImpl = (async (_url: URL, init: { body: string; headers: Record<string, string> }) => {
    sent.push({ body: JSON.parse(init.body), headers: init.headers });
    return new Response(
      JSON.stringify({ result: { isError: reply.isError, content: [{ type: "text", text: reply.text }] } }),
    );
  }) as unknown as typeof fetch;
  const edit = (file: string, now: number, env: Record<string, string> = ENV, tool = "Edit") =>
    captureTouches(
      {
        hook_event_name: "PostToolUse",
        session_id: "s-1",
        cwd: repo,
        tool_name: tool,
        tool_input: { file_path: file },
      },
      env,
      { fetchImpl, mcpUrl: MCP, now, stateDir },
    );

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "willder-touches-state-"));
    repo = mkdtempSync(join(tmpdir(), "willder-touches-repo-"));
    mkdirSync(join(repo, ".git"));
    writeFileSync(join(repo, ".git", "config"), CONFIG);
    sent = [];
    reply = { text: "Posted claim n1." };
  });
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  it("is off unless WILLDER_CLAIM_TOUCHES is on and a task is named", async () => {
    await edit(join(repo, "a.ts"), 0, { ...ENV, WILLDER_CLAIM_TOUCHES: "" });
    await edit(join(repo, "a.ts"), 0, { ...ENV, WILLDER_TASK: "" });
    expect(sent).toEqual([]);
  });

  it("sends the first edit at once, as a claim on the task carrying paths and nothing else", async () => {
    await edit(join(repo, "lib", "a.ts"), 0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers["x-willder-task"]).toBe("WEB-412");
    expect(sent[0]!.body.params).toEqual({
      name: "memory_note",
      arguments: { kind: "claim", task: "WEB-412", touches: ["file:acme/app/lib/a.ts"] },
      _meta: { "willder/capture": "touches", "willder/session": "s-1", "willder/task": "WEB-412" },
    });
  });

  it("batches edits inside a minute, then sends them together, most recent last", async () => {
    await edit(join(repo, "a.ts"), 0);
    await edit(join(repo, "b.ts"), SEND_INTERVAL_MS - 1);
    await edit(join(repo, "a.ts"), SEND_INTERVAL_MS);
    expect(sent.map((s) => s.body.params.arguments.touches)).toEqual([
      ["file:acme/app/a.ts"],
      ["file:acme/app/b.ts", "file:acme/app/a.ts"],
    ]);
  });

  it(`keeps the ${MAX_TOUCHES} files edited most recently`, async () => {
    for (let i = 0; i <= MAX_TOUCHES; i++) await edit(join(repo, `f${i}.ts`), i);
    await edit(join(repo, "last.ts"), SEND_INTERVAL_MS);
    const touches = sent.at(-1)!.body.params.arguments.touches;
    expect(touches).toHaveLength(MAX_TOUCHES);
    expect(touches[0]).toBe("file:acme/app/f2.ts");
    expect(touches.at(-1)).toBe("file:acme/app/last.ts");
  });

  it("sends nothing for a file outside the repository or a tool that edits none", async () => {
    await edit(join(tmpdir(), "elsewhere.ts"), 0);
    await edit(join(repo, "a.ts"), 0, ENV, "Read");
    expect(sent).toEqual([]);
  });

  it("keeps one list per claim across repositories, so a session's files in two repositories go to its one claim", async () => {
    const other = mkdtempSync(join(tmpdir(), "willder-touches-repo-"));
    mkdirSync(join(other, ".git"));
    writeFileSync(join(other, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:acme/api.git\n');
    try {
      await edit(join(repo, "a.ts"), 0);
      await captureTouches(
        {
          hook_event_name: "PostToolUse",
          session_id: "s-1",
          cwd: other,
          tool_name: "Edit",
          tool_input: { file_path: join(other, "route.ts") },
        },
        ENV,
        { fetchImpl, mcpUrl: MCP, now: SEND_INTERVAL_MS, stateDir },
      );
      expect(sent.at(-1)!.body.params.arguments.touches).toEqual(["file:acme/app/a.ts", "file:acme/api/route.ts"]);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("hands back the reply's overlap section", async () => {
    reply = {
      text: "Posted claim n1.\n\nOverlapping files detected with 1 other live claim on other work.\n- north's claim n0",
    };
    expect(await edit(join(repo, "a.ts"), 0)).toBe(
      "Overlapping files detected with 1 other live claim on other work.\n- north's claim n0",
    );
  });

  it.each(["claim_overlap_off: Claim overlap is off for this org", "Access denied: read-only token"])(
    "stops for the session after %s",
    async (text) => {
      reply = { isError: true, text };
      await edit(join(repo, "a.ts"), 0);
      await edit(join(repo, "b.ts"), SEND_INTERVAL_MS * 2);
      expect(sent).toHaveLength(1);
    },
  );

  it("waits out the interval after a released claim, then asks again", async () => {
    reply = { isError: true, text: "claim_released: You released your claim" };
    await edit(join(repo, "a.ts"), 0);
    await edit(join(repo, "b.ts"), 1);
    await edit(join(repo, "c.ts"), SEND_INTERVAL_MS);
    expect(sent).toHaveLength(2);
  });

  it("tries again after another error, without waiting out the interval", async () => {
    reply = { isError: true, text: "Memory service error: down" };
    await edit(join(repo, "a.ts"), 0);
    reply = { text: "Posted claim n1." };
    await edit(join(repo, "b.ts"), 1);
    expect(sent).toHaveLength(2);
  });
});
