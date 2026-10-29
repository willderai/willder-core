// The claim under test: a process started without a variable it cannot run without
// stops with one line that names the variable and the fix, never a stack trace.
//
// The variables are not listed here by hand. docs/environment.md's Boot table is the
// classified list of what each process needs to start, and .env.example's
// "Required to boot" group is what a fresh clone is told to fill in; both are read
// below, so a variable added to either without a startup check fails this file.
// Each variable is then removed from a complete environment, one at a time, and the
// real entry point is run: the stdio MCP server as a child process, the web server's
// startup hook in process.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REQUIRED_ENV, STDIO_MCP_ENV, WEB_SERVER_ENV, missingEnvMessage, type RequiredEnvVar } from "./required-env";

const repoRoot = resolve(__dirname, "..");

/** Variable names in the first column of docs/environment.md's `## Boot` table. */
function bootTableNames(): string[] {
  const doc = readFileSync(join(repoRoot, "docs", "environment.md"), "utf8");
  const section = doc.split(/^## Boot$/m)[1]?.split(/^## /m)[0] ?? "";
  return [...section.matchAll(/^\| `([A-Z][A-Z0-9_]*)` \|/gm)].map((m) => m[1]);
}

/** Names assigned in .env.example's "Required to boot (web app, scripts, npm run mcp)" group. */
function envExampleBootNames(): string[] {
  const example = readFileSync(join(repoRoot, ".env.example"), "utf8");
  const group = example.split(/^# ---- Required to boot \(web app, scripts, npm run mcp\) ----$/m)[1] ?? "";
  const body = group.split(/^# ----/m)[0];
  return [...body.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
}

/** A value for every variable in `vars`, so removing one leaves exactly that one missing. */
function completeEnv(vars: readonly RequiredEnvVar[]): Record<string, string> {
  return Object.fromEntries(vars.map((v) => [v.name, v.name === "DATABASE_URL" ? CLOSED_PORT_URL : "set"]));
}

// Nothing listens on port 1, so a complete environment gets past the variable check
// and fails at the database instead, which proves the check let it through.
const CLOSED_PORT_URL = "postgresql://postgres:willder@127.0.0.1:1/willder";

describe("the required variables are the documented ones", () => {
  it("has a startup check for every variable docs/environment.md classifies as Boot", () => {
    const documented = bootTableNames();
    expect(documented.length).toBeGreaterThan(0);
    expect(new Set(REQUIRED_ENV.map((v) => v.name))).toEqual(new Set(documented));
  });

  it("checks every variable .env.example tells a fresh clone it needs to boot", () => {
    const told = envExampleBootNames().filter((name) => name !== "DATABASE_URL_UNPOOLED");
    expect(told.length).toBeGreaterThan(0);
    for (const name of told) expect(STDIO_MCP_ENV.map((v) => v.name)).toContain(name);
    for (const name of told) expect(WEB_SERVER_ENV.map((v) => v.name)).toContain(name);
  });

  // `next start` exits right after Ready when one of these is missing, so a CI boot
  // without them never lives long enough to report the collision the step checks for.
  it("sets every web server variable in CI's boot-check step", () => {
    expect(new Set(ciBootCheckEnvNames())).toEqual(new Set(WEB_SERVER_ENV.map((v) => v.name)));
  });
});

/** Variable names in the `env:` block of ci.yml's "Boot check" step. */
function ciBootCheckEnvNames(): string[] {
  const ci = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
  const step = ci.split(/^ {6}- name: Boot check\b.*$/m)[1]?.split(/^ {6}- |^ {2}\S/m)[0] ?? "";
  const env = step.split(/^ {8}env:$/m)[1]?.split(/^ {8}\S/m)[0] ?? "";
  return [...env.matchAll(/^ {10}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]);
}

describe("missingEnvMessage", () => {
  it("is null when everything is set", () => {
    expect(missingEnvMessage(STDIO_MCP_ENV, completeEnv(STDIO_MCP_ENV))).toBeNull();
  });

  it("treats a blank or whitespace value as missing, since .env.example ships blanks", () => {
    const env = { ...completeEnv(STDIO_MCP_ENV), GRAPHITI_SERVICE_API_KEY: "  " };
    expect(missingEnvMessage(STDIO_MCP_ENV, env)).toMatch(/^GRAPHITI_SERVICE_API_KEY is not set\./);
  });

  it("names every missing variable on one line when several are missing", () => {
    const message = missingEnvMessage(STDIO_MCP_ENV, {});
    expect(message).not.toContain("\n");
    for (const v of STDIO_MCP_ENV) expect(message).toContain(v.name);
  });

  it("only asks for the Clerk keys in production, where there is no keyless mode", () => {
    const local = completeEnv(WEB_SERVER_ENV.filter((v) => !v.productionOnly));
    expect(missingEnvMessage(WEB_SERVER_ENV, { ...local, NODE_ENV: "development" })).toBeNull();
    expect(missingEnvMessage(WEB_SERVER_ENV, { ...local, NODE_ENV: "production" })).toMatch(/CLERK/);
  });
});

function runMcpServer(env: Record<string, string>) {
  return spawnSync(join(repoRoot, "node_modules", ".bin", "tsx"), ["mcp/server.ts"], {
    cwd: repoRoot,
    env: { NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
}

describe("npm run mcp with one required variable missing", () => {
  it.each(STDIO_MCP_ENV.map((v) => [v.name, v] as const))(
    "exits 1 with one line naming %s and its fix",
    (_name, missing) => {
      const env = completeEnv(STDIO_MCP_ENV);
      delete env[missing.name];
      const result = runMcpServer(env);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      const lines = result.stderr.trim().split("\n");
      expect(lines).toEqual([`willder MCP server failed: ${missing.fix}`]);
      expect(lines[0]).toContain(missing.name);
    },
    60_000,
  );

  it("passes the check when every variable is set, and stops at the database instead", () => {
    const result = runMcpServer(completeEnv(STDIO_MCP_ENV));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Cannot reach a database at 127\.0\.0\.1:1/);
  }, 60_000);
});

describe("the web server's startup hook with one required variable missing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function runRegister(env: Record<string, string | undefined>) {
    for (const v of REQUIRED_ENV) vi.stubEnv(v.name, undefined);
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("VERCEL", undefined);
    // A valid public origin unless a case says otherwise, so only the missing variable is reported.
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example");
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const { register } = await import("../instrumentation");
    await register();
    return { errors: errors.mock.calls.map((call) => call.join(" ")), exit };
  }

  it.each(WEB_SERVER_ENV.map((v) => [v.name, v] as const))(
    "stops with one line naming %s and its fix",
    async (_name, missing) => {
      const env: Record<string, string | undefined> = { ...completeEnv(WEB_SERVER_ENV), NODE_ENV: "production" };
      delete env[missing.name];
      const { errors, exit } = await runRegister(env);
      // scripts/check-route-collision.sh fails a boot on this exact prefix.
      expect(errors).toEqual([`willder web server failed: ${missing.fix}`]);
      expect(exit).toHaveBeenCalledWith(1);
    },
  );

  it("starts when every variable is set", async () => {
    const { errors, exit } = await runRegister({ ...completeEnv(WEB_SERVER_ENV), NODE_ENV: "production" });
    expect(errors).toEqual([]);
    expect(exit).not.toHaveBeenCalled();
  });

  it.each(WEB_SERVER_ENV.map((v) => [v.name, v] as const))(
    "on Vercel, logs one line naming %s and keeps serving instead of exiting",
    async (_name, missing) => {
      // Exiting a Vercel function fails every request on that instance, the public
      // pages included, so a hosted deployment reports the gap and stays up.
      const env: Record<string, string | undefined> = {
        ...completeEnv(WEB_SERVER_ENV),
        NODE_ENV: "production",
        VERCEL: "1",
      };
      delete env[missing.name];
      const { errors, exit } = await runRegister(env);
      expect(errors).toEqual([`willder web server is running without required environment: ${missing.fix}`]);
      expect(exit).not.toHaveBeenCalled();
    },
  );

  it("on Vercel, logs nothing when every variable is set", async () => {
    const { errors, exit } = await runRegister({ ...completeEnv(WEB_SERVER_ENV), NODE_ENV: "production", VERCEL: "1" });
    expect(errors).toEqual([]);
    expect(exit).not.toHaveBeenCalled();
  });

  // NEXT_PUBLIC_APP_URL is not a boot variable: without it every page and every native MCP
  // client works. But /api/mcp then refuses the hosted clients that send an Origin, so a
  // production server says so at startup instead of refusing them silently.
  it.each([
    ["unset", undefined, "is not set"],
    ["not a URL", "willder.example", "is not an absolute URL"],
    ["plain http", "http://app.example", "is http://app.example, not an https origin on a public host"],
  ])(
    "in production, logs one line naming NEXT_PUBLIC_APP_URL when it is %s, and keeps serving",
    async (_label, value, state) => {
      for (const vercel of [undefined, "1"]) {
        vi.restoreAllMocks();
        const { errors, exit } = await runRegister({
          ...completeEnv(WEB_SERVER_ENV),
          NODE_ENV: "production",
          VERCEL: vercel,
          NEXT_PUBLIC_APP_URL: value,
        });
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatch(/^willder web server: NEXT_PUBLIC_APP_URL /);
        expect(errors[0]).toContain(state);
        expect(errors[0]).toContain("clients that send no Origin are unaffected");
        expect(errors[0]).toContain("docs/environment.md");
        expect(exit).not.toHaveBeenCalled();
      }
    },
  );

  it("says nothing about NEXT_PUBLIC_APP_URL outside production, where .env.example's loopback value is right", async () => {
    const { errors } = await runRegister({
      ...completeEnv(WEB_SERVER_ENV),
      NODE_ENV: "development",
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    });
    expect(errors).toEqual([]);
  });

  it("does not check during next build, which runs without the runtime's variables", async () => {
    const { errors, exit } = await runRegister({ NEXT_PHASE: "phase-production-build" });
    expect(errors).toEqual([]);
    expect(exit).not.toHaveBeenCalled();
  });
});
