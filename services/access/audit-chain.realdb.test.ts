// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The audit log against a real Postgres: the application's role cannot UPDATE,
// DELETE or TRUNCATE audit rows (as a plain grantee and as the table's owner),
// an org deletion still cascades, every insert is chained by the database, and
// the verifier names the first position an attacker altered, deleted or
// reordered. The attacker is this file's superuser connection, which the
// append-only trigger exempts because a superuser could disable it anyway.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { AUDIT_CHAIN_GENESIS_HASH, auditRowHash, verifyAuditChain } from "./audit-chain";

const QA_URL = process.env.QA_DATABASE_URL;
const PREFIX = "achain-";
const APP_ROLE = `audit_chain_app_${randomUUID().slice(0, 8)}`;

describe.skipIf(!QA_URL)("audit log append-only and hash chain, real Postgres", () => {
  let db: PrismaClient;
  let pool: Pool;

  const newOrg = async () => {
    const id = `${PREFIX}${randomUUID()}`;
    await db.org.create({ data: { id, name: id } });
    return id;
  };

  const writeRows = async (orgId: string, count: number) => {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const row = await db.auditLog.create({
        data: {
          orgId,
          actorType: "agent",
          actorId: `agent-${i}`,
          action: "memory.read",
          target: `org_x.scope_${i}`,
          decision: i % 2 ? "deny" : "allow",
          reason: i % 2 ? "no grant" : null,
          metadata: { i, note: "café ☕" },
        },
      });
      ids.push(row.id);
    }
    return ids;
  };

  /** Runs `sql` as the application role inside a transaction that is always rolled back. */
  const asApp = async <T>(fn: (c: PoolClient) => Promise<T>, opts: { owner?: boolean } = {}): Promise<T> => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      if (opts.owner) {
        await c.query(`ALTER TABLE "audit_log" OWNER TO ${APP_ROLE}`);
        await c.query(`ALTER TABLE "audit_chain_heads" OWNER TO ${APP_ROLE}`);
      }
      await c.query(`SET LOCAL ROLE ${APP_ROLE}`);
      return await fn(c);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  };

  const refused = (p: Promise<unknown>) =>
    expect(p).rejects.toThrow(/audit_log is append-only|audit_chain_heads is written only/);

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    pool = new Pool({ connectionString: QA_URL, max: 4 });
    await pool.query(`CREATE ROLE ${APP_ROLE} NOLOGIN`);
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
    await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "audit_log", "audit_chain_heads", "orgs" TO ${APP_ROLE}`);
    await pool.query(`GRANT TRUNCATE ON "audit_log" TO ${APP_ROLE}`);
  });

  afterAll(async () => {
    await db.org.deleteMany({ where: { id: { startsWith: PREFIX } } });
    await pool.query(`DROP OWNED BY ${APP_ROLE}`);
    await pool.query(`DROP ROLE ${APP_ROLE}`);
    await pool.end();
    await db.$disconnect();
  });

  describe("the application role", () => {
    it("can INSERT, and the row is chained from genesis whatever the writer passed", async () => {
      const org = await newOrg();
      const forged = await db.auditLog.create({
        data: {
          orgId: org,
          actorType: "human",
          actorId: "u1",
          action: "memory.read",
          decision: "allow",
          chainSeq: 999,
          prevHash: "f".repeat(64),
          rowHash: "e".repeat(64),
        },
      });
      expect(forged.chainSeq).toBe(1);
      expect(forged.prevHash).toBe(AUDIT_CHAIN_GENESIS_HASH);
      expect(forged.rowHash).toMatch(/^[0-9a-f]{64}$/);
      expect(forged.rowHash).not.toBe("e".repeat(64));

      const inserted = await asApp(async (c) => {
        const r = await c.query(
          `INSERT INTO "audit_log" ("id","orgId","actorType","actorId","action","decision")
           VALUES ($1,$2,'agent','a','memory.write','allow') RETURNING "chainSeq"`,
          [randomUUID(), org],
        );
        return r.rows[0].chainSeq as number;
      });
      expect(inserted).toBe(2);
    });

    it.each([
      ["as a grantee", false],
      ["as the table owner", true],
    ])("is refused UPDATE, DELETE and TRUNCATE on audit rows %s", async (_label, owner) => {
      const org = await newOrg();
      const [id] = await writeRows(org, 1);
      await refused(
        asApp((c) => c.query(`UPDATE "audit_log" SET "reason" = 'rewritten' WHERE "id" = $1`, [id]), { owner }),
      );
      await refused(
        asApp((c) => c.query(`DELETE FROM "audit_log" WHERE "id" = $1 AND "orgId" = $2`, [id, org]), { owner }),
      );
      await refused(asApp((c) => c.query(`DELETE FROM "audit_log" WHERE "orgId" = $1`, [org]), { owner }));
      await refused(asApp((c) => c.query(`TRUNCATE "audit_log"`), { owner }));
      expect(await db.auditLog.count({ where: { id, reason: null } })).toBe(1);
    });

    it("cannot make an org look deleted by shadowing orgs or the chain head with a temporary table", async () => {
      const org = await newOrg();
      const [id] = await writeRows(org, 2);
      await refused(
        asApp(async (c) => {
          await c.query(`CREATE TEMP TABLE "orgs" ("id" TEXT)`);
          return c.query(`DELETE FROM "audit_log" WHERE "id" = $1 AND "orgId" = $2`, [id, org]);
        }),
      );
      await refused(
        asApp(async (c) => {
          await c.query(`CREATE TEMP TABLE "orgs" ("id" TEXT)`);
          return c.query(`DELETE FROM "audit_chain_heads" WHERE "orgId" = $1`, [org]);
        }),
      );
      const seq = await asApp(async (c) => {
        await c.query(`CREATE TEMP TABLE "audit_chain_heads" (LIKE public."audit_chain_heads" INCLUDING DEFAULTS)`);
        await c.query(`INSERT INTO pg_temp."audit_chain_heads" ("orgId","seq","hash") VALUES ($1, 40, $2)`, [
          org,
          "b".repeat(64),
        ]);
        const r = await c.query(
          `INSERT INTO "audit_log" ("id","orgId","actorType","actorId","action","decision")
           VALUES ($1,$2,'agent','a','memory.write','allow') RETURNING "chainSeq"`,
          [randomUUID(), org],
        );
        return r.rows[0].chainSeq as number;
      });
      expect(seq).toBe(3);
    });

    it("cannot make an org look deleted when row-level security hides it", async () => {
      const org = await newOrg();
      const [id] = await writeRows(org, 1);
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query(`ALTER TABLE "orgs" ENABLE ROW LEVEL SECURITY`);
        await c.query(`SET LOCAL ROLE ${APP_ROLE}`);
        await expect(c.query(`SELECT count(*)::int AS n FROM "orgs" WHERE "id" = $1`, [org])).resolves.toMatchObject({
          rows: [{ n: 0 }],
        });
        await refused(c.query(`DELETE FROM "audit_log" WHERE "id" = $1 AND "orgId" = $2`, [id, org]));
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
    });

    it("is refused writing the chain head directly", async () => {
      const org = await newOrg();
      await writeRows(org, 2);
      await refused(asApp((c) => c.query(`UPDATE "audit_chain_heads" SET "seq" = 1 WHERE "orgId" = $1`, [org])));
      await refused(asApp((c) => c.query(`DELETE FROM "audit_chain_heads" WHERE "orgId" = $1`, [org])));
      const other = await newOrg();
      await refused(
        asApp((c) =>
          c.query(`INSERT INTO "audit_chain_heads" ("orgId","seq","hash") VALUES ($1, 7, $2)`, [other, "a".repeat(64)]),
        ),
      );
    });

    it.each([
      ["as a grantee", false],
      ["as the table owner", true],
    ])("can still delete an org, and its audit rows and chain head cascade %s", async (_label, owner) => {
      const org = await newOrg();
      await writeRows(org, 3);
      const left = await asApp(
        async (c) => {
          // Deleting the org row, located through its chain head so the statement names the org it scopes to.
          await c.query(
            `DELETE FROM "orgs" WHERE "id" = (SELECT "orgId" FROM "audit_chain_heads" WHERE "orgId" = $1)`,
            [org],
          );
          const rows = await c.query(`SELECT count(*)::int AS n FROM "audit_log" WHERE "orgId" = $1`, [org]);
          const heads = await c.query(`SELECT count(*)::int AS n FROM "audit_chain_heads" WHERE "orgId" = $1`, [org]);
          return [rows.rows[0].n, heads.rows[0].n];
        },
        { owner },
      );
      expect(left).toEqual([0, 0]);
    });
  });

  describe("the verifier", () => {
    it("passes an intact chain, and the database's hash matches the verifier's", async () => {
      const org = await newOrg();
      await writeRows(org, 6);
      const report = await verifyAuditChain(org, db);
      expect(report).toMatchObject({ ok: true, verified: 6, unchained: 0, firstBreak: null, head: { seq: 6 } });

      const { rows } = await pool.query(
        `SELECT "id","orgId","chainSeq","prevHash","rowHash","actorType","actorId","action","target",
                "decision"::text AS "decision","reason","metadata"::text AS "metadata",
                to_char("at", 'YYYY-MM-DD"T"HH24:MI:SS.US') AS "at","runId"
           FROM "audit_log" WHERE "orgId" = $1 ORDER BY "chainSeq"`,
        [org],
      );
      for (const row of rows) expect(auditRowHash(row)).toBe(row.rowHash);
    });

    it("agrees with the database on awkward values: precision, JSON order, separators, unicode", async () => {
      const org = await newOrg();
      const awkward: [string, string | null, string | null, string, string][] = [
        // at (more precision than the column keeps), target, reason, metadata (unordered, duplicate key, big and signed numbers), actorId
        [
          "2026-03-01 12:34:56.1234567",
          "a;b",
          "N;",
          `{"b":1,"a":[1.50,-0,1e30],"a":"dup","x;y":"S3:N;"}`,
          "é ☕ 𝄞 e\u0301",
        ],
        ["1999-12-31 23:59:59.9995", "", null, `{"nested":{"z":null,"y":[]}, "\\u00e9": "\\\\"}`, "tab\there"],
        ["2026-03-01 12:34:56", null, "", `{}`, "S1:x;"],
      ];
      // The writer's session settings must not leak into the hash: the verifier runs with different ones.
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query(`SET LOCAL TimeZone = 'Pacific/Chatham'`);
        await c.query(`SET LOCAL DateStyle = 'SQL, DMY'`);
        await c.query(`SET LOCAL extra_float_digits = -15`);
        for (const [at, target, reason, metadata, actorId] of awkward) {
          await c.query(
            `INSERT INTO "audit_log" ("id","orgId","actorType","actorId","action","target","decision","reason","metadata","at")
             VALUES ($1,$2,'agent',$3,'memory.read',$4,'deny',$5,$6::jsonb,$7::timestamp)`,
            [randomUUID(), org, actorId, target, reason, metadata, at],
          );
        }
        await c.query("COMMIT");
      } catch (err) {
        await c.query("ROLLBACK");
        throw err;
      } finally {
        c.release();
      }
      await writeRows(org, 1);
      expect(await verifyAuditChain(org, db)).toMatchObject({ ok: true, verified: 4, unchained: 0 });
    });

    it("reports rows written before the chain as unchained, not broken", async () => {
      const org = await newOrg();
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SET LOCAL session_replication_role = replica");
        await c.query(
          `INSERT INTO "audit_log" ("id","orgId","actorType","actorId","action","decision") VALUES ($1,$2,'human','u','memory.read','allow')`,
          [randomUUID(), org],
        );
        await c.query("COMMIT");
      } finally {
        c.release();
      }
      await writeRows(org, 2);
      expect(await verifyAuditChain(org, db)).toMatchObject({ ok: true, verified: 2, unchained: 1 });
    });

    it("names the first position of an altered row", async () => {
      const org = await newOrg();
      const ids = await writeRows(org, 5);
      await pool.query(`UPDATE "audit_log" SET "decision" = 'allow', "reason" = NULL WHERE "id" = $1`, [ids[3]]);
      const report = await verifyAuditChain(org, db);
      expect(report.ok).toBe(false);
      expect(report.firstBreak).toMatchObject({ position: 4, rowId: ids[3], kind: "altered" });
    });

    it("names the row after an altered row whose own hash was recomputed", async () => {
      const org = await newOrg();
      const ids = await writeRows(org, 5);
      await pool.query(`UPDATE "audit_log" SET "reason" = 'quietly changed' WHERE "id" = $1`, [ids[1]]);
      const { rows } = await pool.query(
        `SELECT "id","orgId","chainSeq","prevHash","actorType","actorId","action","target",
                "decision"::text AS "decision","reason","metadata"::text AS "metadata",
                to_char("at", 'YYYY-MM-DD"T"HH24:MI:SS.US') AS "at","runId"
           FROM "audit_log" WHERE "id" = $1`,
        [ids[1]],
      );
      await pool.query(`UPDATE "audit_log" SET "rowHash" = $2 WHERE "id" = $1`, [ids[1], auditRowHash(rows[0])]);
      expect((await verifyAuditChain(org, db)).firstBreak).toMatchObject({
        position: 3,
        rowId: ids[2],
        kind: "unlinked",
      });
    });

    it("names the first missing position of a deleted row", async () => {
      const org = await newOrg();
      const ids = await writeRows(org, 5);
      await pool.query(`DELETE FROM "audit_log" WHERE "id" = $1 AND "orgId" = $2`, [ids[2], org]);
      expect((await verifyAuditChain(org, db)).firstBreak).toMatchObject({ position: 3, rowId: null, kind: "missing" });
    });

    it("detects a deleted last row against the chain head", async () => {
      const org = await newOrg();
      const ids = await writeRows(org, 5);
      await pool.query(`DELETE FROM "audit_log" WHERE "id" = $1 AND "orgId" = $2`, [ids[4], org]);
      expect((await verifyAuditChain(org, db)).firstBreak).toMatchObject({ position: 5, rowId: null, kind: "missing" });
    });

    it("names the first position of a reordered row", async () => {
      const org = await newOrg();
      const ids = await writeRows(org, 5);
      await pool.query(`UPDATE "audit_log" SET "chainSeq" = -1 WHERE "id" = $1`, [ids[1]]);
      await pool.query(`UPDATE "audit_log" SET "chainSeq" = 2 WHERE "id" = $1`, [ids[3]]);
      await pool.query(`UPDATE "audit_log" SET "chainSeq" = 4 WHERE "id" = $1`, [ids[1]]);
      expect((await verifyAuditChain(org, db)).firstBreak).toMatchObject({
        position: 2,
        rowId: ids[3],
        kind: "altered",
      });
    });

    // Rows the insert trigger could not have written, planted with it bypassed.
    // The walk reads positions from 1 up, so each of these was once neither
    // verified nor counted: the chain passed with a row it never looked at.
    it.each([
      { label: "position 0", chainSeq: 0, chainFirst: true, expected: { position: 0, kind: "out-of-range" } },
      {
        label: "a negative position",
        chainSeq: -7,
        chainFirst: true,
        expected: { position: -7, kind: "out-of-range" },
      },
      {
        label: "position 0 in an org with no chain",
        chainSeq: 0,
        chainFirst: false,
        expected: { position: 0, kind: "out-of-range" },
      },
    ])("reports a row planted at $label as a break", async ({ chainSeq, chainFirst, expected }) => {
      const org = await newOrg();
      if (chainFirst) await writeRows(org, 3);
      const planted = randomUUID();
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SET LOCAL session_replication_role = replica");
        await c.query(
          `INSERT INTO "audit_log" ("id","orgId","actorType","actorId","action","decision","chainSeq")
           VALUES ($1,$2,'human','u','memory.read','allow',$3)`,
          [planted, org, chainSeq],
        );
        await c.query("COMMIT");
      } finally {
        c.release();
      }
      const report = await verifyAuditChain(org, db);
      expect(report).toMatchObject({ ok: false, verified: chainFirst ? 3 : 0, unchained: 0 });
      expect(report.firstBreak).toMatchObject({ ...expected, rowId: planted });
    });
  });

  describe("the verifier while writes are landing", () => {
    /**
     * Wraps `client` so that after each read the verifier makes, one more row
     * is committed for `orgId` on another connection, between that read and the
     * verifier's next. Counts the rows it wrote.
     */
    const writerBetweenReads = (client: PrismaClient, orgId: string) => {
      const writer = { rows: 0 };
      const commitOneRow = async () => {
        await db.auditLog.create({
          data: { orgId, actorType: "agent", actorId: "late-writer", action: "memory.read", decision: "allow" },
        });
        writer.rows += 1;
      };
      const wrap = <C extends object>(target: C): C =>
        new Proxy(target, {
          get(obj, prop) {
            const value = Reflect.get(obj, prop, obj) as unknown;
            if (typeof value !== "function") return value;
            if (prop === "$queryRaw") {
              return async (...args: unknown[]) => {
                const result: unknown = await (value as (...a: unknown[]) => Promise<unknown>).apply(obj, args);
                await commitOneRow();
                return result;
              };
            }
            if (prop === "$transaction") {
              return (fn: (tx: object) => Promise<unknown>, options?: unknown) =>
                (value as (f: typeof fn, o?: unknown) => Promise<unknown>).call(
                  obj,
                  (tx: object) => fn(wrap(tx)),
                  options,
                );
            }
            return (value as (...a: unknown[]) => unknown).bind(obj);
          },
        });
      return { client: wrap(client), writer };
    };

    // 1001 rows: two pages, so rows land between the head read and the walk and between pages.
    // The altered row is the last one the verifier can see, with newer rows written after it.
    it.each([
      {
        label: "an intact chain passes at the moment the verifier started",
        tamper: null,
        expected: { ok: true, verified: 1001, head: { seq: 1001 } },
      },
      {
        label: "a row altered before the verifier started is still named",
        tamper: 1001,
        expected: { ok: false, verified: 1000, firstBreak: { kind: "altered", position: 1001 } },
      },
    ])("$label", async ({ tamper, expected }) => {
      const org = await newOrg();
      // One statement, so the seed is not 1001 round trips; the insert trigger still chains each row.
      await pool.query(
        `INSERT INTO "audit_log" ("id", "orgId", "actorType", "actorId", "action", "decision")
         SELECT gen_random_uuid()::text, $1, 'agent', 'seed-' || n, 'memory.read', 'allow' FROM generate_series(1, 1001) AS n`,
        [org],
      );
      if (tamper !== null) {
        await pool.query(`UPDATE "audit_log" SET "reason" = 'rewritten' WHERE "orgId" = $1 AND "chainSeq" = $2`, [
          org,
          tamper,
        ]);
      }
      const { client, writer } = writerBetweenReads(db, org);

      const report = await verifyAuditChain(org, client);

      // Count, head, and two pages, so the walk would see rows the head read did not.
      expect(writer.rows).toBeGreaterThanOrEqual(4);
      expect(report).toMatchObject(expected);
      if (tamper === null) {
        expect(await verifyAuditChain(org, db)).toMatchObject({ ok: true, verified: 1001 + writer.rows });
      }
    });
  });

  it("keeps one valid chain per org under concurrent inserts", async () => {
    const orgA = await newOrg();
    const orgB = await newOrg();
    const writers = Array.from({ length: 60 }, (_, i) =>
      db.auditLog.create({
        data: {
          orgId: i % 2 ? orgA : orgB,
          actorType: "agent",
          actorId: `w${i}`,
          action: "memory.read",
          decision: "allow",
        },
      }),
    );
    await Promise.all(writers);
    for (const org of [orgA, orgB]) {
      const report = await verifyAuditChain(org, db);
      expect(report).toMatchObject({ ok: true, verified: 30, head: { seq: 30 } });
    }
  });
});
