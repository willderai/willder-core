// The Claude Code page (/docs/claude-code) against the code it describes: the files a
// stranger downloads, the settings they paste and the server entry they write must be
// exactly what `willder init` installs, and the downloaded hook must run on its own.
import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOOK_FILES, SERVER_HEADERS, init, withWillderHook, withWillderServer } from "@/cli/willder.mjs";
import { CONTEXT_PREFIX } from "@/cli/hooks/willder-changes.mjs";
import { fillClientConfig, readClientConfigPage } from "@/tests/support/client-config";
import { GET, dynamic, dynamicParams, generateStaticParams } from "@/app/hooks/[file]/route";
import {
  CLAUDE_HOOK_SETTINGS,
  CLAUDE_MCP_ADD_COMMAND,
  CLAUDE_MCP_JSON,
  CLAUDE_MCP_JSON_WITH_TASK,
  HOOK_INSTALLED_LINE,
  HOOK_INSTALL_COMMAND,
  LOAD_TOKEN_COMMAND,
  MCP_URL,
  NAME_TASK_COMMAND,
  PUBLISHED_HOOK_FILES,
} from "@/lib/docs";
import { TASK_HEADER } from "@/mcp/task-start-notice";

const SPAWN_TEST_TIMEOUT_MS = 30_000;
const HOOKS_DIR = join(process.cwd(), "cli/hooks");

let workDir = "";
beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "willder-docs-claude-code-"));
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

async function served(file: string): Promise<Response> {
  return GET(new Request(`http://localhost/hooks/${file}`), { params: Promise.resolve({ file }) });
}

/** Runs `script` in `shell` with stdin, and resolves with what it printed. */
function runShell(shell: string, script: string, env: Record<string, string>, stdin = "") {
  return new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
    const child = execFile(
      shell,
      ["-c", script],
      { cwd: workDir, env: { NODE_ENV: "test", ...env } },
      (error, stdout, stderr) => done({ code: error ? (error.code as number) : 0, stdout, stderr }),
    );
    child.stdin!.end(stdin);
  });
}

/**
 * A `curl` stand-in that logs its flags and URL, and copies the file the site would serve
 * for that URL. Like `curl -f`, it fails with exit 22 when the site has no such file.
 */
function stubCurl(servedDir: string, log: string): string {
  const bin = join(workDir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "curl"),
    [
      "#!/bin/sh",
      'flags=""; url=""; out=""',
      'while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; -*) flags="$flags$1"; shift;; *) url="$1"; shift;; esac; done',
      `printf '%s %s\\n' "$flags" "$url" >> '${log}'`,
      `src='${servedDir}'/"\${url##*/}"`,
      '[ -f "$src" ] || exit 22',
      'cp "$src" "$out"',
    ].join("\n"),
  );
  chmodSync(join(bin, "curl"), 0o755);
  return bin;
}

const shells = ["/bin/bash", "/bin/zsh", "/bin/sh"].filter((shell) => existsSync(shell));

describe("what the page tells Claude Code users to install", () => {
  it("writes the same hook settings `willder init` writes", () => {
    expect(CLAUDE_HOOK_SETTINGS).toEqual(withWillderHook({}));
  });

  it("writes the same server entry `willder init` writes, without the optional task header", () => {
    const { headers, ...server } = withWillderServer({}).mcpServers.willder;
    const { "X-Willder-Task": _task, ...withoutTask } = headers;
    expect(CLAUDE_MCP_JSON.mcpServers.willder).toEqual({ ...server, headers: withoutTask });
    expect(server.url).toBe(MCP_URL);
  });

  it("names the task with the exact entry `willder init` writes, in the header the server reads", () => {
    const entry = CLAUDE_MCP_JSON_WITH_TASK.mcpServers.willder;
    expect(entry).toEqual(withWillderServer({}).mcpServers.willder);
    expect(Object.keys(entry.headers).map((name) => name.toLowerCase())).toContain(TASK_HEADER);
    expect(NAME_TASK_COMMAND).toMatch(/^export WILLDER_TASK=\S+\nclaude$/);
  });

  it("connects with the URL, Authorization and tool-set headers `willder init` writes, the token read from the shell", () => {
    const shape =
      /^claude mcp add --transport http willder (\S+) \\\n {2}--header "Authorization: (Bearer \$WILLDER_TOKEN)" \\\n {2}--header "X-Willder-Tools: (\w+)"$/.exec(
        CLAUDE_MCP_ADD_COMMAND,
      );
    expect(shape).not.toBeNull();
    expect(shape![1]).toBe(withWillderServer({}).mcpServers.willder.url);
    expect(shape![2].replace("$WILLDER_TOKEN", "${WILLDER_TOKEN}")).toBe(SERVER_HEADERS.Authorization);
    expect(shape![3]).toBe(SERVER_HEADERS["X-Willder-Tools"]);
  });

  it("gives a client that connects from the committed page the same coding tool set", () => {
    const page = readClientConfigPage(
      "docs/connect/claude-code.md",
      readFileSync(join(process.cwd(), "docs/connect/claude-code.md"), "utf8"),
    );
    expect(fillClientConfig(page, { baseUrl: "https://h", token: "t", taskKey: "T" }).headers["X-Willder-Tools"]).toBe(
      SERVER_HEADERS["X-Willder-Tools"],
    );
  });

  it("publishes exactly the files `willder init` copies into a project", () => {
    init({ projectDir: workDir });
    expect(readdirSync(join(workDir, ".claude/hooks")).sort()).toEqual([...PUBLISHED_HOOK_FILES].sort());
  });

  // The two lists are kept by hand in two files; a hook added to one and not the other
  // is either never copied by init or never served to a project installing without it.
  it("names the same hook files in cli/willder.mjs and lib/docs.ts", () => {
    expect(HOOK_FILES).toBeDefined();
    expect([...HOOK_FILES].sort()).toEqual([...PUBLISHED_HOOK_FILES].sort());
  });
});

describe("GET /hooks/<file>", () => {
  it("prerenders one page per published file, and no other path", () => {
    expect(generateStaticParams()).toEqual(PUBLISHED_HOOK_FILES.map((file) => ({ file })));
    expect({ dynamic, dynamicParams }).toEqual({ dynamic: "force-static", dynamicParams: false });
  });

  it.each(PUBLISHED_HOOK_FILES)("serves %s exactly as cli/hooks holds it", async (file) => {
    const res = await served(file);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await res.text()).toBe(readFileSync(join(HOOKS_DIR, file), "utf8"));
  });

  it.each(["willder.mjs", "willder-changes.test.ts", "../willder.mjs", "..%2Fwillder.mjs", "WILLDER-CHANGES.MJS", ""])(
    "serves nothing else: %j",
    async (file) => {
      expect((await served(file)).status).toBe(404);
    },
  );
});

describe("the no-repository install, run the way the page says", () => {
  async function serveInto(dir: string, files: readonly string[]) {
    mkdirSync(dir);
    for (const file of files) writeFileSync(join(dir, file), await (await served(file)).text());
  }

  it.each(shells)(
    "loads the token in %s",
    async (shell) => {
      const result = await runShell(
        shell,
        `${LOAD_TOKEN_COMMAND}\nprintf '[%s]' "$WILLDER_TOKEN"`,
        { PATH: "/usr/bin:/bin" },
        "wcap_docs_test\n",
      );
      expect(result.code).toBe(0);
      expect(result.stdout.endsWith("[wcap_docs_test]")).toBe(true);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it.each(shells)(
    "downloads every hook file into .claude/hooks with %s",
    async (shell) => {
      const servedDir = join(workDir, "served");
      await serveInto(servedDir, PUBLISHED_HOOK_FILES);
      const log = join(workDir, "curl.log");
      const bin = stubCurl(servedDir, log);

      const result = await runShell(shell, HOOK_INSTALL_COMMAND, { PATH: `${bin}:/usr/bin:/bin` });

      expect(result).toEqual({ code: 0, stdout: `${HOOK_INSTALLED_LINE}\n`, stderr: "" });
      expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(
        PUBLISHED_HOOK_FILES.map((file) => `-fsSL https://willder.ai/hooks/${file}`),
      );
      for (const file of PUBLISHED_HOOK_FILES) {
        expect(readFileSync(join(workDir, ".claude/hooks", file), "utf8")).toBe(
          readFileSync(join(HOOKS_DIR, file), "utf8"),
        );
      }
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it.each(PUBLISHED_HOOK_FILES)(
    "stops at a failed download of %s and never says it installed",
    async (missing) => {
      const servedDir = join(workDir, "served");
      await serveInto(
        servedDir,
        PUBLISHED_HOOK_FILES.filter((file) => file !== missing),
      );
      const bin = stubCurl(servedDir, join(workDir, "curl.log"));

      const result = await runShell("/bin/sh", HOOK_INSTALL_COMMAND, { PATH: `${bin}:/usr/bin:/bin` });

      expect(result.code).not.toBe(0);
      expect(result.stdout).not.toContain(HOOK_INSTALLED_LINE);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "runs the downloaded hook with the settings' own command and hands Claude Code the block",
    async () => {
      const hooksDir = join(workDir, ".claude/hooks");
      mkdirSync(hooksDir, { recursive: true });
      for (const file of PUBLISHED_HOOK_FILES) writeFileSync(join(hooksDir, file), await (await served(file)).text());

      let request: IncomingHttpHeaders | undefined;
      const notice =
        "Before you start: rules in scope and what earlier sessions left, unchecked.\nRules in your scope:\n- sessions in Postgres, not Redis";
      const server = createServer((req, res) => {
        request = { ...req.headers, path: req.url };
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ notice }));
      });
      await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
      const command = CLAUDE_HOOK_SETTINGS.hooks.UserPromptSubmit[0].hooks[0].command;
      let result;
      try {
        result = await runShell(
          "/bin/sh",
          command,
          {
            PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
            CLAUDE_PROJECT_DIR: workDir,
            WILLDER_TOKEN: "wcap_docs_test",
            WILLDER_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          },
          JSON.stringify({
            hook_event_name: "UserPromptSubmit",
            session_id: "session-2",
            prompt: "Should we store sessions in Redis or Postgres?",
          }),
        );
      } finally {
        server.close();
      }

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: `${CONTEXT_PREFIX}\n${notice}` },
      });
      expect(request).toMatchObject({
        path: "/api/changes/notice",
        authorization: "Bearer wcap_docs_test",
        "x-willder-session": "session-2",
      });
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});
