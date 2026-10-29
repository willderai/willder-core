// The claim under test: a process that needs the database and cannot get it says
// so in one line that names the fix. The unit cases cover the error shapes
// node-postgres actually raises; the process cases run the real MCP entry point
// against a port nothing listens on and assert what a stranger would see.
//
// Every case here builds its own error, so none of them can tell whether the
// probe names a table the migrations create. That is lib/db-startup.realdb.test.ts,
// which runs the check against a migrated Postgres and an empty one.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { DatabaseUnavailableError, PROBE_TABLE, assertDatabaseReachable, describeDatabaseFailure } from "./db-startup";

const LOCAL_URL = "postgresql://postgres:willder@localhost:5432/willder";
const env = { DATABASE_URL: LOCAL_URL };

function pgError(code: string): Error & { code: string } {
  return Object.assign(new Error(`pg ${code}`), { code });
}

describe("describeDatabaseFailure", () => {
  it("names the missing variable before anything else", () => {
    expect(describeDatabaseFailure(pgError("ECONNREFUSED"), {})).toBe(
      "DATABASE_URL is not set. Copy .env.example to .env and fill it in (docs/development.md, Ten-minute path).",
    );
  });

  it("tells an unreachable host apart from a wrong password, a missing database and missing tables", () => {
    expect(describeDatabaseFailure(pgError("ECONNREFUSED"), env)).toBe(
      "Cannot reach a database at localhost:5432. Start Postgres (docs/development.md, Ten-minute path, step 1) or point DATABASE_URL at a running database.",
    );
    expect(describeDatabaseFailure(pgError("ENOTFOUND"), env)).toMatch(/^Cannot reach a database/);
    expect(describeDatabaseFailure(pgError("28P01"), env)).toMatch(/rejected the user or password/);
    expect(describeDatabaseFailure(pgError("3D000"), env)).toMatch(/does not exist at localhost:5432/);
    expect(describeDatabaseFailure(pgError("42P01"), env)).toBe(
      'Reached the database at localhost:5432, but it has no Willder tables (no "capabilities" table). ' +
        "Run: npx prisma migrate deploy (docs/development.md, Ten-minute path, step 3).",
    );
  });

  it("reads the code from node-postgres's per-address AggregateError", () => {
    const aggregate = Object.assign(new AggregateError([pgError("ECONNREFUSED")]), { code: undefined });
    expect(describeDatabaseFailure(aggregate, env)).toMatch(/^Cannot reach a database/);
  });

  it("names the connect timeout node-postgres raises without a code", () => {
    expect(describeDatabaseFailure(new Error("timeout expired"), env)).toMatch(/^Cannot reach a database/);
  });

  it("never prints the connection string", () => {
    const secret = { DATABASE_URL: "postgresql://admin:hunter2@db.internal:6543/prod" };
    const message = describeDatabaseFailure(pgError("28P01"), secret)!;
    expect(message).toContain("db.internal:6543");
    expect(message).not.toContain("hunter2");
    expect(message).not.toContain("admin");
  });

  // The failure this file could not see before: every case above builds its own
  // error, so the probe could name a table that does not exist and still pass.
  // lib/db-startup.realdb.test.ts runs the probe against a migrated database;
  // this is the cheap half of the same guard, and it runs everywhere.
  it("probes the physical table prisma/schema.prisma maps the model to", () => {
    const schema = readFileSync(join(resolve(__dirname, ".."), "prisma/schema.prisma"), "utf8");
    const model = schema.match(/^model Capability \{[\s\S]*?^\}/m)?.[0];
    expect(model, "prisma/schema.prisma no longer declares model Capability").toBeTruthy();
    expect(model!.match(/@@map\("([^"]+)"\)/)?.[1]).toBe(PROBE_TABLE);
  });

  it("leaves an error it cannot name alone", () => {
    expect(describeDatabaseFailure(new Error("syntax error"), env)).toBeNull();
    expect(describeDatabaseFailure(pgError("42601"), env)).toBeNull();
  });
});

// A closed port on the loopback interface: nothing listens on port 1.
const CLOSED_PORT_URL = "postgresql://postgres:willder@127.0.0.1:1/willder";

function runMcpServer(databaseUrl: string | undefined) {
  const repoRoot = resolve(__dirname, "..");
  const childEnv: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV,
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    WILLDER_CAPABILITY_TOKEN: "wcap_test",
    // The other required variables are set so these cases isolate the database
    // (lib/required-env.test.ts covers each variable missing on its own).
    GRAPHITI_SERVICE_URL: "http://127.0.0.1:1",
    GRAPHITI_SERVICE_API_KEY: "test",
  };
  if (databaseUrl !== undefined) childEnv.DATABASE_URL = databaseUrl;
  return spawnSync(join(repoRoot, "node_modules", ".bin", "tsx"), ["mcp/server.ts"], {
    cwd: repoRoot,
    env: childEnv,
    encoding: "utf8",
    timeout: 60_000,
  });
}

describe("npm run mcp without a database", () => {
  // Each test boots mcp/server.ts under tsx, bounded at 60 s by runMcpServer. The
  // test bound sits above the child's, so a slow boot on a loaded runner is
  // judged by its exit status and output, never cut off by Vitest's 5 s default.
  const SPAWN_TEST_TIMEOUT_MS = 75_000;

  it(
    "exits 1 with one line naming the fix when nothing listens on DATABASE_URL",
    () => {
      const result = runMcpServer(CLOSED_PORT_URL);
      expect(result.status).toBe(1);
      expect(result.stderr.trim().split("\n")).toEqual([
        "willder MCP server failed: Cannot reach a database at 127.0.0.1:1. Start Postgres (docs/development.md, Ten-minute path, step 1) or point DATABASE_URL at a running database.",
      ]);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "exits 1 with one line naming the variable when DATABASE_URL is unset",
    () => {
      const result = runMcpServer(undefined);
      expect(result.status).toBe(1);
      expect(result.stderr.trim().split("\n")).toEqual([
        "willder MCP server failed: DATABASE_URL is not set. Copy .env.example to .env and fill it in (docs/development.md, Ten-minute path).",
      ]);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});

// A server that accepts the socket and then never speaks. node-postgres's
// connectionTimeoutMillis covers the whole startup handshake, so that bound is
// what fires here; the separate query_timeout the probe sets covers the case
// after a successful handshake, which this test does not reproduce.
describe("assertDatabaseReachable against a server that never answers", () => {
  it("gives up with the named error instead of hanging", async () => {
    const sockets: import("node:net").Socket[] = [];
    const server = createServer((socket) => sockets.push(socket));
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const { port } = server.address() as { port: number };
    try {
      const started = Date.now();
      await expect(
        assertDatabaseReachable({ DATABASE_URL: `postgresql://postgres:willder@127.0.0.1:${port}/willder` }),
      ).rejects.toBeInstanceOf(DatabaseUnavailableError);
      expect(Date.now() - started).toBeLessThan(20_000);
    } finally {
      for (const socket of sockets) socket.destroy();
      server.close();
    }
  }, 30_000);
});
