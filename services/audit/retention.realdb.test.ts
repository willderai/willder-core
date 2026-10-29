// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The purge test for the audit retention floor. Nothing in the product purges audit rows
// (services/audit/retention.ts says why), so this runs the purge an operator or a future
// job would write -- delete every row older than the floor, then every row at all -- as
// the application's role, plain grantee and table owner, and shows the database keeps
// both a row older than six months and a row inside the floor, and that both still
// export.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { AUDIT_RETENTION_FLOOR_DAYS } from "./retention";

const QA_URL = process.env.QA_DATABASE_URL;
const RUN = randomUUID().slice(0, 8);
const ORG = `aret-${RUN}`;
const APP_ROLE = `audit_retention_app_${RUN}`;
const DAY_MS = 86_400_000;

describe.skipIf(!QA_URL)("audit retention floor: a purge keeps every row, real Postgres", () => {
  let db: PrismaClient;
  let pool: Pool;
  let queryAuditExportRows: (typeof import("@/services/access/audit-query"))["queryAuditExportRows"];
  const now = new Date();
  const olderThanFloor = new Date(now.getTime() - (AUDIT_RETENTION_FLOOR_DAYS + 20) * DAY_MS);
  const insideFloor = new Date(now.getTime() - 10 * DAY_MS);

  /**
   * Runs `sql` as the application role. As a plain grantee it autocommits, so a purge the
   * database wrongly allowed would really remove rows. As the owner it runs inside a
   * transaction that is rolled back, because ownership is borrowed for the test.
   */
  const purgeAsApp = async (sql: string, opts: { owner: boolean }) => {
    const c = await pool.connect();
    try {
      if (opts.owner) {
        await c.query("BEGIN");
        await c.query(`ALTER TABLE "audit_log" OWNER TO ${APP_ROLE}`);
        await c.query(`SET LOCAL ROLE ${APP_ROLE}`);
        await c.query(sql);
      } else {
        await c.query(`SET ROLE ${APP_ROLE}`);
        await c.query(sql);
      }
    } finally {
      if (opts.owner) await c.query("ROLLBACK");
      else await c.query("RESET ROLE");
      c.release();
    }
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    pool = new Pool({ connectionString: QA_URL, max: 2 });
    ({ queryAuditExportRows } = await import("@/services/access/audit-query"));
    await pool.query(`CREATE ROLE ${APP_ROLE} NOLOGIN`);
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
    await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON "audit_log" TO ${APP_ROLE}`);
    await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "audit_chain_heads", "orgs" TO ${APP_ROLE}`);

    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.auditLog.createMany({
      data: [olderThanFloor, insideFloor].map((at, i) => ({
        orgId: ORG,
        actorType: "human",
        actorId: `u-${i}`,
        action: "memory.read",
        target: `org_${ORG}`,
        decision: "allow" as const,
        at,
      })),
    });
  });

  afterAll(async () => {
    if (!db) return;
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.org.deleteMany({ where: { id: ORG } });
    await pool.query(`DROP OWNED BY ${APP_ROLE}`);
    await pool.query(`DROP ROLE ${APP_ROLE}`);
    await pool.end();
    await db.$disconnect();
  });

  const remaining = () => db.auditLog.findMany({ where: { orgId: ORG }, orderBy: { at: "asc" }, select: { at: true } });

  it.each([{ owner: false }, { owner: true }])(
    "refuses a purge of rows older than the floor (as table owner: $owner) and keeps both rows",
    async ({ owner }) => {
      const purge = `DELETE FROM "audit_log" WHERE "orgId" = '${ORG}' AND "at" < now() - interval '${AUDIT_RETENTION_FLOOR_DAYS} days'`;
      await expect(purgeAsApp(purge, { owner })).rejects.toThrow(/audit_log is append-only/);
      await expect(purgeAsApp(`DELETE FROM "audit_log" WHERE "orgId" = '${ORG}'`, { owner })).rejects.toThrow(
        /audit_log is append-only/,
      );
      await expect(purgeAsApp(`TRUNCATE "audit_log"`, { owner })).rejects.toThrow(/audit_log is append-only/);
      expect((await remaining()).map((r) => r.at.getTime())).toEqual([olderThanFloor.getTime(), insideFloor.getTime()]);
    },
  );

  it("still exports a row older than the floor", async () => {
    const rows = await queryAuditExportRows({
      orgId: ORG,
      from: new Date(olderThanFloor.getTime() - DAY_MS),
      to: new Date(now.getTime() + DAY_MS),
      after: null,
      limit: 10,
    });
    expect(rows.map((r) => r.at.getTime())).toEqual([olderThanFloor.getTime(), insideFloor.getTime()]);
  });
});
