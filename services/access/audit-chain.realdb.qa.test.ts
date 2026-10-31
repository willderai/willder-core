// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The audit chain, covering what audit-chain.realdb.test.ts leaves untested: a tail rewrite that only the chain head can expose, the
// unique index that refuses a fork the trigger did not make, the first-insert
// race for a brand-new org, and a chain longer than one verifier page. Each
// case fails when its guard is removed, which that file does not catch.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { auditRowHash, verifyAuditChain, type CanonicalAuditRow } from "./audit-chain";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;
const PREFIX = "achain-qa-";

const CANONICAL_COLUMNS = `"id","orgId","chainSeq","prevHash","actorType","actorId","action","target",
  "decision"::text AS "decision","reason","metadata"::text AS "metadata",
  to_char("at", 'YYYY-MM-DD"T"HH24:MI:SS.US') AS "at","runId"`;

describe.skipIf(!QA_URL)("audit chain QA, real Postgres", () => {
  let db: PrismaClient;
  let pool: Pool;

  const newOrg = async () => {
    const id = `${PREFIX}${randomUUID()}`;
    await db.org.create({ data: { id, name: id } });
    return id;
  };

  /** Inserts `count` audit rows for `orgId` in one statement; the database chains each one. */
  const writeRows = (orgId: string, count: number) =>
    pool.query(
      `INSERT INTO "audit_log" ("id","orgId","actorType","actorId","action","decision")
       SELECT gen_random_uuid()::text, $1, 'agent', 'a' || g, 'memory.read', 'allow'
         FROM generate_series(1, $2) AS g`,
      [orgId, count],
    );

  const canonicalRow = async (orgId: string, chainSeq: number): Promise<CanonicalAuditRow> => {
    const { rows } = await pool.query(
      `SELECT ${CANONICAL_COLUMNS} FROM "audit_log" WHERE "orgId" = $1 AND "chainSeq" = $2`,
      [orgId, chainSeq],
    );
    return rows[0];
  };

  /** A superuser session with triggers off: the attacker who has bypassed the append-only trigger. */
  const withTriggersOff = async <T>(fn: (c: PoolClient) => Promise<T>): Promise<T> => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      const result = await fn(c);
      await c.query("COMMIT");
      return result;
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    } finally {
      c.release();
    }
  };

  beforeAll(() => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    pool = new Pool({ connectionString: QA_URL, max: 6 });
  });

  afterAll(async () => {
    await deleteOrgsWithRetry(db, { where: { id: { startsWith: PREFIX } } });
    await pool.end();
    await db.$disconnect();
  });

  it("detects a rewritten last row whose hash was recomputed, against the chain head", async () => {
    const org = await newOrg();
    await writeRows(org, 3);
    const last = await canonicalRow(org, 3);
    const rewritten = { ...last, reason: "rewritten" };
    await pool.query(`UPDATE "audit_log" SET "reason" = $1, "rowHash" = $2 WHERE "id" = $3`, [
      rewritten.reason,
      auditRowHash(rewritten),
      last.id,
    ]);

    const report = await verifyAuditChain(org, db);
    expect(report).toMatchObject({ ok: false, verified: 3, firstBreak: { kind: "head-mismatch", position: 3 } });
  });

  it("detects a row appended past the chain head with the insert trigger bypassed", async () => {
    const org = await newOrg();
    await writeRows(org, 2);
    const tail = await pool.query(`SELECT "rowHash" FROM "audit_log" WHERE "orgId" = $1 AND "chainSeq" = 2`, [org]);
    const appended: CanonicalAuditRow = {
      ...(await canonicalRow(org, 2)),
      id: randomUUID(),
      chainSeq: 3,
      prevHash: tail.rows[0].rowHash,
      reason: "planted",
    };
    await withTriggersOff((c) =>
      c.query(
        `INSERT INTO "audit_log" ("id","orgId","chainSeq","prevHash","rowHash","actorType","actorId","action","decision","reason","at")
         VALUES ($1,$2,3,$3,$4,$5,$6,$7,$8::"AuditDecision",$9,$10::timestamp)`,
        [
          appended.id,
          org,
          appended.prevHash,
          auditRowHash(appended),
          appended.actorType,
          appended.actorId,
          appended.action,
          appended.decision,
          appended.reason,
          appended.at,
        ],
      ),
    );

    const report = await verifyAuditChain(org, db);
    expect(report).toMatchObject({ ok: false, firstBreak: { kind: "head-mismatch" } });
  });

  it("refuses to store a second row at a position, even with the insert trigger bypassed", async () => {
    const org = await newOrg();
    await writeRows(org, 2);
    await expect(
      withTriggersOff((c) =>
        c.query(
          `INSERT INTO "audit_log" ("id","orgId","chainSeq","prevHash","rowHash","actorType","actorId","action","decision")
           VALUES ($1,$2,2,$3,$3,'agent','a','memory.read','allow')`,
          [randomUUID(), org, "c".repeat(64)],
        ),
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("chains every writer when several race to write a new org's first rows", async () => {
    const org = await newOrg();
    const insert = (c: PoolClient) =>
      c.query(
        `INSERT INTO "audit_log" ("id","orgId","actorType","actorId","action","decision")
         VALUES ($1,$2,'agent','a','memory.read','allow') RETURNING "chainSeq"`,
        [randomUUID(), org],
      );
    const [first, second, third] = await Promise.all([pool.connect(), pool.connect(), pool.connect()]);
    try {
      for (const c of [first, second, third]) await c.query("BEGIN");
      // The first writer creates the org's chain head and holds it uncommitted, so the
      // other two both find no head and queue behind its insert of one.
      await insert(first);
      const commitAfterInsert = (c: PoolClient) =>
        insert(c).then(async (r) => {
          await c.query("COMMIT");
          return r.rows[0].chainSeq as number;
        });
      const racing = Promise.allSettled([commitAfterInsert(second), commitAfterInsert(third)]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await first.query("COMMIT");

      const settled = await racing;
      expect(settled.map((s) => s.status)).toEqual(["fulfilled", "fulfilled"]);
      const positions = settled.map((s) => (s as PromiseFulfilledResult<number>).value).sort();
      expect(positions).toEqual([2, 3]);
    } finally {
      for (const c of [first, second, third]) {
        await c.query("ROLLBACK").catch(() => undefined);
        c.release();
      }
    }

    const report = await verifyAuditChain(org, db);
    expect(report).toMatchObject({ ok: true, verified: 3, head: { seq: 3 } });
  });

  it("verifies a chain longer than one page, and names a break on the second page", async () => {
    const org = await newOrg();
    await writeRows(org, 1003);
    expect(await verifyAuditChain(org, db)).toMatchObject({ ok: true, verified: 1003, head: { seq: 1003 } });

    await pool.query(`UPDATE "audit_log" SET "reason" = 'rewritten' WHERE "orgId" = $1 AND "chainSeq" = 1002`, [org]);
    expect(await verifyAuditChain(org, db)).toMatchObject({
      ok: false,
      verified: 1001,
      firstBreak: { kind: "altered", position: 1002 },
    });
  });
});
