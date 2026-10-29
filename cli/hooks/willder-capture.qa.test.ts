// Session-state capture: secrets that must not pass `redact`, inputs that could make it
// quadratic, and guards no other test fails without.
//
// What `redact` promises, from its own comments and docs/connect/claude-code.md: token and
// key shapes, "a value assigned to a secret-named key, in any case and in env, YAML, JSON,
// or URL query form", and the values of environment variables "whose names say they are
// secret". Each case below is one of those three promises, in a form an agent's last message
// or a test command really carries: an HTTP header in a curl line, a JSON or YAML config
// excerpt, a connection string, a key pasted whole.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LAST_MESSAGE_MAX_CHARS, captureSessionState, redact } from "./willder-capture.mjs";

const SECRET = "Zq8vN3pLw2Rt6YxK9mB4";

describe("redact: secret-named keys in header, JSON, YAML and connection-string form", () => {
  it.each([
    ["an X-Api-Key header in a curl line", `curl -H "X-Api-Key: ${SECRET}" https://api.example.com/v1`],
    ["an Authorization header with a non-Bearer scheme", `Authorization: Token ${SECRET}`],
    ["a raw Authorization header", `Authorization: ${SECRET}`],
    ["a Cookie header", `Cookie: session=${SECRET}`],
    ["a hyphenated JSON key", `{"api-key": "${SECRET}"}`],
    ["a hyphenated key in a URL query", `https://api.example.com/v1?api-key=${SECRET}`],
    ["a camelCase privateKey", `privateKey: "${SECRET}"`],
    ["a passphrase", `passphrase=${SECRET}`],
    ["a Pwd= in a connection string", `Server=db;Uid=sa;Pwd=${SECRET};`],
    ["a DB_PASS assignment", `DB_PASS=${SECRET} npm test`],
    ["a Ruby or PHP arrow", `password => "${SECRET}"`],
  ])("removes %s", (_, text) => {
    expect(redact(`before ${text} after`, {})).not.toContain(SECRET);
  });

  it("removes a YAML block scalar's value, not only its indicator", () => {
    expect(redact(`db:\n  password: |\n    ${SECRET}\n  host: x`, {})).not.toContain(SECRET);
  });

  it("removes the whole of a JSON string value that has an escaped quote in it", () => {
    expect(redact(`{"password": "ab\\"${SECRET}"}`, {})).not.toContain(SECRET);
  });
});

describe("redact: credentials in a URL", () => {
  it.each([
    ["a password with a slash", "postgres:" + `//app:pa/${SECRET}@db.example.com/app`],
    ["a password with an @", "postgres:" + `//app:p@${SECRET}@db.example.com/app`],
    ["a token as the whole userinfo", `https://${SECRET}${SECRET}@github.com/acme/repo.git`],
  ])("removes %s", (_, text) => {
    expect(redact(`clone ${text} now`, {})).not.toContain(SECRET);
  });
});

describe("redact: private keys", () => {
  it("removes a PGP private key block", () => {
    const key = `-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nlQOYBGMx5Q0BCAC${SECRET}\n=abcd\n-----END PGP PRIVATE KEY BLOCK-----`;
    expect(redact(`key:\n${key}\nend`, {})).not.toContain(SECRET);
  });
});

describe("redact: values of environment variables whose names say they are secret", () => {
  it.each(["OPENAI_KEY", "STRIPE_KEY", "ENCRYPTION_KEY", "SIGNING_KEY", "DB_PASS"])(
    "removes the value of %s",
    (name) => {
      expect(redact(`connected with ${SECRET} ok`, { [name]: SECRET })).not.toContain(SECRET);
    },
  );
});

describe("redact: no input makes it slow", () => {
  // The hook redacts the agent's whole last message before cutting it. On Stop that is
  // `last_assistant_message`, unbounded; from a transcript it is up to 256 KB. The hook
  // runs under a 15 s Claude Code timeout, so a quadratic pattern turns one long message
  // into a stalled Stop and a lost capture. Plain prose of this length takes a few ms.
  const N = 100_000;
  const repeat = (unit: string) => unit.repeat(Math.ceil(N / unit.length)).slice(0, N);

  it.each([
    ["dotted letters (the URL-scheme pattern)", repeat("a.")],
    ["hyphenated letters (the URL-scheme pattern)", repeat("a-")],
    ["plus-joined words (the URL-scheme pattern)", repeat("ab+")],
    ["JWT-looking heads with no dots (the JWT pattern)", repeat("eyJaaaaaaaa-")],
  ])("redacts 100,000 chars of %s in under a second", (_, text) => {
    const started = performance.now();
    redact(text, {});
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("captureSessionState: guards no other test fails without", () => {
  const MCP_URL = new URL("https://willder.example/api/mcp");
  const ENV = {
    WILLDER_TOKEN: "wcap_" + "capture_qa_token_0001",
    WILLDER_CAPTURE: "session-state",
    WILLDER_TASK: "WEB-412",
  };
  const SESSION = "5b2c0d1e-qa-session";
  const T0 = Date.parse("2026-10-12T09:00:00Z");
  const git = (_cwd: string, args: string[]) => (args[0] === "rev-parse" ? "abc123\n" : "");
  let stateDir = "";
  let fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;
  let versions = 0;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "willder-capture-qa-"));
    versions = 0;
    fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { content: [{ type: "text", text: `Stored and readable now. Version: v${++versions}.` }] },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
  });
  afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

  const hook = (input: Record<string, unknown>, env: Record<string, string | undefined> = ENV, now = T0) =>
    captureSessionState({ session_id: SESSION, cwd: "/work/project", ...input }, env, {
      fetchImpl,
      mcpUrl: MCP_URL,
      now,
      stateDir,
      git,
    });
  const written = () =>
    (fetchImpl.mock.calls as unknown as [URL, RequestInit][]).map(
      ([, init]) => JSON.parse(String(init.body)).params.arguments.content as string,
    );

  it("redacts the failing run's result line, which is the first line of the error when no summary line matches", async () => {
    await hook({
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      error: `Error: connect ECONNREFUSED with Bearer ${SECRET}${SECRET}`,
    });
    await hook({ hook_event_name: "Stop", last_assistant_message: "Stopped." });

    expect(written()[0]).toContain("Last test command: npm test -> failed");
    expect(written()[0]).not.toContain(SECRET);
  });

  it("removes a Bearer token of no known shape from the last message", async () => {
    await hook({
      hook_event_name: "Stop",
      last_assistant_message: `Called the API with Authorization: Bearer ${SECRET}.`,
    });

    expect(written()[0]).toContain("Bearer [redacted]");
    expect(written()[0]).not.toContain(SECRET);
  });

  it("redacts before it cuts the last message: a token that straddles the cut leaves no prefix behind", async () => {
    const token = `ghp_${"Q".repeat(36)}`;
    const message = `${"w".repeat(LAST_MESSAGE_MAX_CHARS - 12)} ${token} done`;
    await hook({ hook_event_name: "Stop", last_assistant_message: message });

    expect(written()[0]).not.toContain("ghp_");
    expect(written()[0]).not.toContain("QQQQ");
  });

  it("keeps its state file readable by its owner only, with no token or secret in it", async () => {
    await hook({
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_input: { command: `API_TOKEN=${SECRET} npm test` },
      error: "Exit code 1\nTests  1 failed (1)",
    });
    await hook({ hook_event_name: "Stop", last_assistant_message: "Stopped." });

    const [file] = readdirSync(stateDir);
    const path = join(stateDir, file!);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const state = readFileSync(path, "utf8");
    expect(state).not.toContain(SECRET);
    expect(state).not.toContain(ENV.WILLDER_TOKEN);
  });
});
