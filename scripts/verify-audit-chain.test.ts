// `npm run audit:verify`'s exit code, which an operator acts on: 1 means a
// chain is broken, 2 means nothing was proven. A read error must never hide a
// break found in another org, and a tool that cannot load must never exit 1.
// The real-database cases are in verify-audit-chain.realdb.test.ts.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AuditChainReport } from "@/services/access/audit-chain";
import { verifyOrgs } from "./lib/verify-audit-orgs";

const repoRoot = resolve(__dirname, "..");

const intact = (orgId: string): AuditChainReport => ({
  orgId,
  ok: true,
  verified: 3,
  unchained: 0,
  head: { seq: 3, hash: "a".repeat(64) },
  firstBreak: null,
});
const broken = (orgId: string): AuditChainReport => ({
  ...intact(orgId),
  ok: false,
  verified: 1,
  firstBreak: {
    position: 2,
    rowId: "r2",
    kind: "altered",
    message: `audit chain for org ${orgId}: row r2 at position 2 does not match its hash`,
  },
});

describe("verifyOrgs", () => {
  it.each([
    { label: "every org intact exits 0", orgs: ["ok"], status: 0, summary: "1 org(s) checked, 0 broken" },
    { label: "a break exits 1", orgs: ["ok", "broken"], status: 1, summary: "2 org(s) checked, 1 broken" },
    {
      label: "a read error after a break still exits 1",
      orgs: ["broken", "unreadable"],
      status: 1,
      summary: "2 org(s) checked, 1 broken, 1 could not be read",
    },
    {
      label: "a read error before a break still exits 1",
      orgs: ["unreadable", "broken"],
      status: 1,
      summary: "2 org(s) checked, 1 broken, 1 could not be read",
    },
    {
      label: "a read error with no break exits 2",
      orgs: ["ok", "unreadable"],
      status: 2,
      summary: "2 org(s) checked, 0 broken, 1 could not be read",
    },
  ])("$label", async ({ orgs, status, summary }) => {
    const log: string[] = [];
    const error: string[] = [];
    const verify = async (orgId: string) => {
      if (orgId === "unreadable") throw new Error("connection reset");
      return orgId === "broken" ? broken(orgId) : intact(orgId);
    };
    const code = await verifyOrgs(orgs, verify, { log: (l) => log.push(l), error: (l) => error.push(l) });
    expect(code).toBe(status);
    expect(log.at(-1)).toBe(summary);
    // Every org gets its line: the run goes on past an org it cannot read.
    if (orgs.includes("ok")) expect(log.some((l) => l.startsWith("ok      ok: 3 chained"))).toBe(true);
    if (orgs.includes("unreadable"))
      expect(error).toEqual(["audit:verify could not read the audit log of org unreadable: connection reset"]);
    if (orgs.includes("broken"))
      expect(log).toContain(
        "BROKEN  broken: audit chain for org broken: row r2 at position 2 does not match its hash; 1 row(s) verified before it",
      );
  });
});

describe("npm run audit:verify, when it cannot check anything", () => {
  /** Runs the real CLI against a database that does not answer, so no org can be read. */
  const run = (script: string, extraEnv: Record<string, string> = {}) =>
    spawnSync(join(repoRoot, "node_modules", ".bin", "tsx"), [script, "org-x"], {
      cwd: repoRoot,
      env: {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        NODE_ENV: "test",
        DATABASE_URL: "postgresql://unused@127.0.0.1:1/unused",
        ...extraEnv,
      },
      encoding: "utf8",
      timeout: 60_000,
    });

  it.each([
    {
      // As on a checkout where `prisma generate` never ran: the generated client
      // resolves to a directory that does not exist.
      label: "exits 2, not 1, when the Prisma client was never generated",
      stderr: "audit:verify could not read the audit log: Cannot find module",
      start: (dir: string) => {
        const tsconfig = join(dir, "tsconfig.json");
        writeFileSync(
          tsconfig,
          JSON.stringify({
            extends: join(repoRoot, "tsconfig.json"),
            compilerOptions: {
              baseUrl: repoRoot,
              paths: { "@/lib/generated/*": [join(dir, "missing", "*")], "@/*": ["./*"] },
            },
          }),
        );
        return run("scripts/verify-audit-chain.ts", { TSX_TSCONFIG_PATH: tsconfig });
      },
    },
    {
      // A cron job or release directory often reaches the script through a link.
      label: "runs, and exits 2 rather than a silent 0, when started through a symlinked path",
      stderr: "audit:verify could not read the audit log of org org-x",
      start: (dir: string) => {
        symlinkSync(repoRoot, join(dir, "checkout"));
        return run(join(dir, "checkout", "scripts", "verify-audit-chain.ts"));
      },
    },
  ])(
    "$label",
    ({ stderr, start }) => {
      const dir = mkdtempSync(join(tmpdir(), "audit-verify-"));
      try {
        const result = start(dir);
        expect(result.stderr).toContain(stderr);
        expect(result.stdout).not.toMatch(/^(ok|BROKEN) /m);
        expect(result.status).toBe(2);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    90_000,
  );
});
