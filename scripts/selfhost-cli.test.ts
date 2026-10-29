// The self-host CLIs never run in a hosted configuration: in a Vercel environment, in
// production, or with a live Clerk key, each one refuses before it imports the database
// client, with the remote-database flag set or not. Nothing in the served application
// imports them either, so the hosted deployment has no path to them at all.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");

function run(script: string, env: Record<string, string>, args: string[] = []) {
  return spawnSync(process.execPath, [require.resolve("tsx/cli"), script, ...args], {
    cwd: REPO,
    // A TEST-NET address (RFC 5737): nothing answers there, so a CLI that tried to connect
    // would hang until the timeout instead of printing its refusal.
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://u:p@192.0.2.1:5432/willder",
      ...env,
    },
    encoding: "utf8",
    timeout: 30_000,
  });
}

describe("the self-host CLIs in a hosted configuration", () => {
  // Each CLI against one hosted signal; selfhostTargetRefusal's own test covers every signal.
  it.each([
    ["scripts/selfhost-token.ts", "a Vercel environment", { VERCEL: "1" }, "this is a Vercel environment"],
    ["scripts/selfhost-export.ts", "production", { NODE_ENV: "production" }, "NODE_ENV is production"],
    [
      "scripts/selfhost-smoke.ts",
      "a live Clerk key",
      { CLERK_SECRET_KEY: "sk_live_x" },
      "CLERK_SECRET_KEY is a production Clerk key",
    ],
  ])(
    "%s refuses to run in %s, even with the remote-database flag",
    { timeout: 60_000 },
    (script, _label, hosted, reason) => {
      const result = run(script, { WILLDER_SELFHOST_ALLOW_REMOTE_DB: "1", ...hosted });
      expect(result.status, `${script}: ${result.stderr}`).toBe(1);
      expect(result.stderr).toContain(`refusing to run: ${reason}.`);
    },
  );

  it("are imported by nothing the hosted deployment serves", () => {
    const served = ["app", "lib", "services", "mcp", "components", "proxy.ts", "instrumentation.ts"];
    const importers: string[] = [];
    const visit = (entry: string) => {
      const full = path.join(REPO, entry);
      if (statSync(full).isDirectory()) {
        for (const child of readdirSync(full)) visit(path.join(entry, child));
      } else if (/\.(ts|tsx|mjs|js)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
        if (/scripts\/(lib\/)?(selfhost|egress-guard)/.test(readFileSync(full, "utf8"))) importers.push(entry);
      }
    };
    for (const entry of served) visit(entry);
    expect(importers).toEqual([]);
  });
});

describe("selfhost:token --revoke arguments", () => {
  // Refused while reading the arguments, before any connection: the database below is unreachable.
  it("refuses --revoke given twice rather than revoking only the last agent named", { timeout: 60_000 }, () => {
    const result = run("scripts/selfhost-token.ts", { WILLDER_SELFHOST_ALLOW_REMOTE_DB: "1" }, [
      "--revoke",
      "a",
      "--revoke",
      "b",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--revoke names one agent; run it once per agent");
  });
});
