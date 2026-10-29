// Per-worker test databases: the naming rules, and, against a real Postgres,
// that the worker running this file really is on its own migrated copy.
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import {
  PLAN_ENV,
  type WorkerDatabasePlan,
  databaseName,
  isLocalServer,
  runDatabaseName,
  runPidOf,
  sameServer,
  withDatabase,
} from "./test-databases";

describe("test database naming", () => {
  const url = "postgresql:" + "//tester:secret@localhost:5433/willder_qa?sslmode=disable";

  it("reads and replaces the database a URL names, keeping everything else", () => {
    expect(databaseName(url)).toBe("willder_qa");
    expect(withDatabase(url, "willder_qa_r12_w3")).toBe(
      "postgresql:" + "//tester:secret@localhost:5433/willder_qa_r12_w3?sslmode=disable",
    );
  });

  it("tells local servers from remote ones, and one server from another", () => {
    expect(isLocalServer(url)).toBe(true);
    expect(isLocalServer("postgresql://u@127.0.0.1/db")).toBe(true);
    expect(isLocalServer("postgresql://u@ep-cool-name.neon.tech/db")).toBe(false);
  });

  it("reads a server named in the query string, which node-postgres connects to instead of the URL's host", () => {
    expect(isLocalServer("postgresql://u@127.0.0.1/db?host=ep-cool-name.neon.tech")).toBe(false);
    expect(isLocalServer("postgresql://u@localhost/db?sslmode=disable&host=db.example.com")).toBe(false);
    expect(isLocalServer("postgresql://u@127.0.0.1/db?hostaddr=10.1.2.3")).toBe(false);
    expect(isLocalServer("postgresql://u@127.0.0.1/db?host=localhost,db.example.com")).toBe(false);
    expect(isLocalServer("postgresql://u@127.0.0.1/db?host=%2Ftmp")).toBe(true);
    expect(isLocalServer("postgresql://u@127.0.0.1/db?host=localhost")).toBe(true);
  });

  it("is never fooled by a name that only starts like a local one, and refuses what it cannot parse", () => {
    expect(isLocalServer("postgresql://u@localhost.example.com/db")).toBe(false);
    expect(isLocalServer("postgresql://u@127.0.0.1.nip.io/db")).toBe(false);
    expect(isLocalServer("postgresql://u@127.0.0.1:5432,db.example.com:5432/db")).toBe(false);
    expect(isLocalServer("not a url")).toBe(false);
    expect(sameServer(url, "postgresql://other@localhost:5433/app")).toBe(true);
    // CI's DATABASE_URL: same host, a port with nothing listening.
    expect(sameServer(url, "postgresql://ci:ci@localhost:5432/ci")).toBe(false);
    expect(sameServer("postgresql://u@localhost/a", "postgresql://u@localhost:5432/b")).toBe(true);
  });

  it("names a run's databases so a later run can find and clear them", () => {
    expect(runDatabaseName("willder_qa", "r42", "w7")).toBe("willder_qa_r42_w7");
    expect(runPidOf("willder_qa", "willder_qa_r42_w7")).toBe(42);
    expect(runPidOf("willder_qa", "willder_qa_r42_tpl")).toBe(42);
    // Never the base database, another base, or a name that merely starts alike.
    expect(runPidOf("willder_qa", "willder_qa")).toBeNull();
    expect(runPidOf("willder_qa", "willder_qa2_r42_w7")).toBeNull();
    expect(runPidOf("willder_qa", "willder_qa_r42_w7_extra")).toBeNull();
  });

  it("refuses a name Postgres would silently truncate", () => {
    expect(() => runDatabaseName("d".repeat(55), "r123456", "w10")).toThrow(/63-byte limit/);
  });
});

const QA_URL = process.env.QA_DATABASE_URL;
const plan = process.env[PLAN_ENV] ? (JSON.parse(process.env[PLAN_ENV]) as WorkerDatabasePlan) : null;

describe.skipIf(!QA_URL)("this worker's real database", () => {
  it("is a migrated copy of the run's template made for this worker alone, not the database QA_DATABASE_URL named", async () => {
    expect(plan, "the global setup must publish a plan whenever QA_DATABASE_URL is set").not.toBeNull();
    const base = databaseName(plan!.qaBaseUrl);
    const expected = runDatabaseName(base, plan!.runId, `w${process.env.VITEST_POOL_ID}`);
    expect(databaseName(QA_URL!)).toBe(expected);

    const client = new Client({ connectionString: QA_URL });
    await client.connect();
    try {
      const { rows } = await client.query<{ name: string; probes: string; scopes: string }>(
        `SELECT current_database() AS name,
                current_setting('ivfflat.probes', true) AS probes,
                (SELECT count(*) FROM scopes)::text AS scopes`,
      );
      expect(rows[0].name).toBe(expected);
      // Built from the migrations: the schema is there.
      expect(Number(rows[0].scopes)).toBeGreaterThanOrEqual(0);
      // Exact vector search in tests: every IVFFlat list is probed (the
      // migrations build memory_chunks_embedding_idx with lists = 100).
      expect(rows[0].probes).toBe("100");
      // Database-level settings of the database QA_DATABASE_URL named, such as
      // a UTC timezone, carry over to the copy.
      for (const [name, value] of plan!.qaSettings) {
        const setting = await client.query<{ value: string }>(`SELECT current_setting($1) AS value`, [name]);
        expect(setting.rows[0].value, name).toBe(value);
      }
    } finally {
      await client.end();
    }
  });

  it("keeps DATABASE_URL apart from QA_DATABASE_URL, as every real-database suite requires", () => {
    expect(process.env.DATABASE_URL).not.toBe(QA_URL);
    if (plan!.appBaseUrl) {
      expect(databaseName(process.env.DATABASE_URL!)).toBe(
        runDatabaseName(databaseName(plan!.appBaseUrl), plan!.runId, `w${process.env.VITEST_POOL_ID}`),
      );
    }
  });
});
