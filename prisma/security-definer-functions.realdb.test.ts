// No SECURITY DEFINER function in the schema is callable by every role.
//
// Row-level security keeps Supabase's anon and authenticated roles out of a
// table, but it does not cover functions. Postgres grants EXECUTE on a new
// function to PUBLIC, and PostgREST serves every function in the exposed schema
// at /rest/v1/rpc/<name>. A SECURITY DEFINER function runs as its owner, so it
// reads past RLS: with the public anon key, /rpc/audit_log_org_exists answered
// whether any org id exists.
//
// Trigger functions are left out: PostgREST cannot call them, and Postgres
// refuses to call one outside a trigger.
//
// The audit log's append-only triggers are that function's only callers, so the
// last test checks that every shape of role that writes audit rows still gets the
// append-only behaviour without being able to call it.
//
// Gated on QA_DATABASE_URL, like every realdb suite. Every role and row these
// tests create is inside a transaction that is rolled back.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const QA_URL = process.env.QA_DATABASE_URL;
const MIGRATION = join(__dirname, "migrations/20261018100000_audit_org_exists_not_public/migration.sql");

describe.skipIf(!QA_URL)("SECURITY DEFINER functions", () => {
  let client: Client;

  beforeEach(async () => {
    client = new Client({ connectionString: QA_URL, connectionTimeoutMillis: 10_000 });
    await client.connect();
  });

  afterEach(async () => {
    await client.query("ROLLBACK");
    await client.end();
  });

  /** Runs `sql` in a savepoint and returns its error message, or null when it succeeded. */
  const errorOf = async (sql: string, params: unknown[] = []): Promise<string | null> => {
    await client.query("SAVEPOINT attempt");
    try {
      await client.query(sql, params);
      await client.query("RELEASE SAVEPOINT attempt");
      return null;
    } catch (err) {
      await client.query("ROLLBACK TO SAVEPOINT attempt");
      return (err as Error).message;
    }
  };

  it("are not executable by PUBLIC, so the anon key cannot call them over /rpc", async () => {
    const { rows } = await client.query<{ fn: string }>(
      `SELECT p.oid::regprocedure::text AS fn
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = current_schema()
          AND p.prosecdef
          AND p.prorettype <> 'trigger'::regtype
          AND has_function_privilege('public', p.oid, 'EXECUTE')
          AND NOT EXISTS (
            SELECT 1 FROM pg_depend d
             WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
          )
        ORDER BY 1`,
    );
    expect(
      rows.map((r) => r.fn),
      "These SECURITY DEFINER functions run as their owner, past row-level security, and PUBLIC may call " +
        "them, so on Supabase the anon key can call each one at /rest/v1/rpc/<name>. Add " +
        "REVOKE EXECUTE ON FUNCTION <name>(<args>) FROM PUBLIC; to the migration that creates it, and grant " +
        "EXECUTE only to the roles that need it.",
    ).toEqual([]);
  });

  /**
   * Every EXECUTE that a role other than the owner holds on a SECURITY DEFINER function
   * in this schema, trigger functions included, as "function: grantee". A function
   * with no ACL yet still carries the default grant to PUBLIC.
   */
  const nonOwnerExecute = async (): Promise<string[]> => {
    const { rows } = await client.query<{ grant: string }>(
      `SELECT p.oid::regprocedure::text || ': ' ||
              CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE acl.grantee::regrole::text END AS grant
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
        WHERE n.nspname = current_schema()
          AND p.prosecdef
          AND acl.privilege_type = 'EXECUTE'
          AND acl.grantee <> p.proowner
          AND NOT EXISTS (
            SELECT 1 FROM pg_depend d
             WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
          )
        ORDER BY 1`,
    );
    return rows.map((r) => r.grant);
  };

  // That every function here, these included, pins its own search_path, and to what, is
  // prisma/function-search-path.realdb.test.ts.

  // Stricter than the test above: a REVOKE from PUBLIC alone passes it while Supabase's
  // grants by name stay, and a trigger function can still be attached to a table the
  // caller owns. So no role but the owner may hold EXECUTE on any of them.
  it("grant EXECUTE to no role but their owner", async () => {
    expect(
      await nonOwnerExecute(),
      "Revoke EXECUTE on each from PUBLIC and from every other grantee, CASCADE, in the migration that " +
        "creates it (see prisma/migrations/20261018100000_audit_org_exists_not_public), and call it only " +
        "from code that runs as its owner.",
    ).toEqual([]);
  });

  // Supabase's default privileges grant EXECUTE on every new function to anon and
  // authenticated by name, so a REVOKE from PUBLIC alone leaves them able to call it.
  // The grant is reproduced here, the migration re-run, and each function tried as each
  // role: the check called directly, and each SECURITY DEFINER trigger function attached
  // to a temporary table of the role's own, where its DELETE would answer the same question.
  const auditTriggerFunctions = ["audit_log_refuse_change()", "audit_chain_heads_guard()", "audit_log_chain_insert()"];

  it.each(["anon", "authenticated"])(
    "refuses %s EXECUTE on the audit SECURITY DEFINER functions, even after a Supabase-style grant by name",
    async (role) => {
      await client.query("BEGIN");
      const existing = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
      if (existing.rowCount === 0) await client.query(`CREATE ROLE ${role} NOLOGIN`);
      await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      for (const fn of ["audit_log_org_exists(text)", ...auditTriggerFunctions]) {
        await client.query(`GRANT EXECUTE ON FUNCTION ${fn} TO ${role}`);
      }
      // A grantee that passed its EXECUTE on, to PUBLIC: a REVOKE without CASCADE fails on it.
      const grantor = `secdef_grantor_${randomUUID().slice(0, 8)}`;
      await client.query(`CREATE ROLE ${grantor} NOLOGIN`);
      await client.query(`GRANT EXECUTE ON FUNCTION audit_log_org_exists(text) TO ${grantor} WITH GRANT OPTION`);
      await client.query(`SET LOCAL ROLE ${grantor}`);
      await client.query(`GRANT EXECUTE ON FUNCTION audit_log_org_exists(text) TO PUBLIC`);
      await client.query("RESET ROLE");

      await client.query(readFileSync(MIGRATION, "utf8"));
      expect(await nonOwnerExecute()).toEqual([]);

      await client.query(`SET LOCAL ROLE ${role}`);
      expect(await errorOf(`SELECT audit_log_org_exists('any-org')`)).toMatch(
        /permission denied for function audit_log_org_exists/,
      );
      await client.query(`CREATE TEMP TABLE probe ("id" TEXT, "orgId" TEXT)`);
      for (const fn of auditTriggerFunctions) {
        expect(
          await errorOf(
            `CREATE TRIGGER probe_trigger BEFORE DELETE ON pg_temp.probe FOR EACH ROW EXECUTE FUNCTION ${fn}`,
          ),
          fn,
        ).toMatch(/permission denied for function/);
      }
    },
  );

  // Every shape of role that writes audit rows. Production connects as the owner of the
  // tables and the functions, which is not a superuser on Neon or Supabase. A separate
  // runtime role holds DML only, and audit_log's owner may differ from the functions'
  // owner (an org delete cascades into audit_log as the table's owner). Only the
  // functions' owner may call the check, and every one of them gets the same behaviour.
  const auditFunctions = ["audit_log_org_exists(text)", ...auditTriggerFunctions];

  it.each([
    { label: "the owner of the tables and functions", ownsTables: true, ownsFunctions: true },
    { label: "a plain grantee", ownsTables: false, ownsFunctions: false },
    { label: "audit_log's owner", ownsTables: true, ownsFunctions: false },
  ])("lets $label write audit rows and delete its org, and refuses it a direct delete", async (shape) => {
    const role = `secdef_writer_${randomUUID().slice(0, 8)}`;
    const org = `secdef-${randomUUID()}`;
    await client.query("BEGIN");
    await client.query(`CREATE ROLE ${role} NOLOGIN`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "audit_log", "audit_chain_heads", "orgs" TO ${role}`);
    if (shape.ownsTables) {
      for (const table of ["audit_log", "audit_chain_heads"])
        await client.query(`ALTER TABLE "${table}" OWNER TO ${role}`);
    }
    if (shape.ownsFunctions) {
      for (const fn of auditFunctions) await client.query(`ALTER FUNCTION ${fn} OWNER TO ${role}`);
    }
    await client.query(`INSERT INTO "orgs" ("id", "name", "updatedAt") VALUES ($1, $1, now())`, [org]);

    await client.query(`SET LOCAL ROLE ${role}`);
    const execute = await client.query<{ ok: boolean }>(
      `SELECT has_function_privilege(current_user, 'audit_log_org_exists(text)', 'EXECUTE') AS ok`,
    );
    expect(execute.rows[0].ok).toBe(shape.ownsFunctions);

    const inserted = await client.query<{ chainSeq: number }>(
      `INSERT INTO "audit_log" ("id","orgId","actorType","actorId","action","decision")
       VALUES ($1, $2, 'agent', 'a', 'memory.write', 'allow') RETURNING "chainSeq"`,
      [randomUUID(), org],
    );
    expect(inserted.rows[0].chainSeq).toBe(1);

    expect(await errorOf(`DELETE FROM "audit_log" WHERE "orgId" = $1`, [org])).toMatch(/audit_log is append-only/);
    expect(await errorOf(`DELETE FROM "audit_chain_heads" WHERE "orgId" = $1`, [org])).toMatch(
      /audit_chain_heads is written only/,
    );

    // The org row is located through its chain head, so the statement names the org it scopes to.
    expect(
      await errorOf(`DELETE FROM "orgs" WHERE "id" = (SELECT "orgId" FROM "audit_chain_heads" WHERE "orgId" = $1)`, [
        org,
      ]),
    ).toBeNull();
    const left = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM "audit_log" WHERE "orgId" = $1`, [
      org,
    ]);
    expect(left.rows[0].n).toBe(0);
  });
});
