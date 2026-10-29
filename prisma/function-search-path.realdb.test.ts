// No object a role can create reaches the code inside the schema's functions.
//
// Every function the migrations define is pinned to `search_path = pg_catalog, pg_temp`
// and names everything outside pg_catalog by its schema
// (prisma/migrations/20261018120000_functions_resolve_only_pg_catalog). These tests are
// the attacks that pin closes, on a real database:
//
// - A role allowed to CREATE in public plants overloads of the built-in functions and text
//   operators on the paths fired below, sets its own search_path to put public first, and
//   then fires every function. None of its code may run as the owner (the SECURITY
//   DEFINER audit functions) or as another role that fires a trigger. Not fired: the
//   child-table and accounts branches of org_deletion_refuse_write() and the refusal
//   branch of capabilities_issuer_bound(); the schema-wide pin check covers them.
// - A role with only TEMP, which PUBLIC has by default, plants a temporary domain named
//   "text". With `search_path = ''` Postgres would search the temporary schema first for
//   type names, so a `::text` cast inside a definer function would run the domain's CHECK
//   as the owner.
//
// Planted code proves it ran by taking a value from a marker sequence the attacker has no
// privilege on. A sequence, not a table, because nextval() survives the rollback of a
// statement the trigger then refuses. Each attack is also run against one mutant per
// function, that function's pin removed (or set to ''), and must land there, so no fire
// here passes because the path it takes never reaches a planted object.
//
// Gated on QA_DATABASE_URL, like every realdb suite. Every role and row is created in a
// transaction that is rolled back.
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const QA_URL = process.env.QA_DATABASE_URL;
const MIGRATION = join(__dirname, "migrations/20261018120000_functions_resolve_only_pg_catalog/migration.sql");
const MARKER = "public.search_path_attack_marker";

/**
 * Every function name a migration creates. Read from the files rather than the catalog, so a
 * helper a test leaves behind in the shared test database is not mistaken for one.
 */
const MIGRATION_FUNCTIONS = [
  ...new Set(
    readdirSync(join(__dirname, "migrations"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) =>
        [
          ...readFileSync(join(__dirname, "migrations", entry.name, "migration.sql"), "utf8").matchAll(
            /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?"?(\w+)"?\s*\(/gi,
          ),
        ].map((m) => m[1]),
      ),
  ),
];

/**
 * Built-ins the function bodies call, each planted in public with the same signature. A
 * planted copy marks, then returns what pg_catalog's would.
 */
const PLANTED_FUNCTIONS: Array<[name: string, args: string, returns: string]> = [
  ["convert_to", "text, text", "bytea"],
  ["convert_to", "text, name", "bytea"],
  ["octet_length", "bytea", "integer"],
  ["sha256", "bytea", "bytea"],
  ["encode", "bytea, text", "text"],
  ["to_char", "timestamp without time zone, text", "text"],
  ["repeat", "text, integer", "text"],
  ["current_setting", "text", "text"],
  ["pg_trigger_depth", "", "integer"],
  ["now", "", "timestamp with time zone"],
  ["to_jsonb", "anyelement", "jsonb"],
];

/** Operators the bodies use unqualified: [operator, left, right, pg_catalog function]. */
const PLANTED_OPERATORS: Array<[op: string, left: string, right: string, impl: string]> = [
  ["=", "text", "text", "pg_catalog.texteq"],
  ["||", "text", "text", "pg_catalog.textcat"],
  ["~~", "text", "text", "pg_catalog.textlike"],
  ["<>", 'public."Permission"', 'public."Permission"', "pg_catalog.enum_ne"],
];

describe.skipIf(!QA_URL)("function search_path", () => {
  let client: Client;
  let attacker: string;
  let victim: string;
  let org: string;
  let member: string;
  let auditId: string;

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

  /** How many times planted code has run with a privilege the attacker lacks. */
  const marks = async (): Promise<number> => {
    const { rows } = await client.query<{ n: string }>(
      `SELECT CASE WHEN is_called THEN last_value ELSE 0 END AS n FROM ${MARKER}`,
    );
    return Number(rows[0].n);
  };

  /**
   * One org with one audit row; an attacker that may write audit rows and CREATE in
   * public; a victim that writes the org's other tables and may advance the marker, as
   * any role that runs planted code by accident could.
   */
  const setUp = async () => {
    const suffix = randomUUID().slice(0, 8);
    attacker = `sp_attacker_${suffix}`;
    victim = `sp_victim_${suffix}`;
    org = `sp-${randomUUID()}`;
    auditId = randomUUID();
    await client.query("BEGIN");
    await client.query(`INSERT INTO "orgs" ("id", "name", "updatedAt") VALUES ($1, $1, now())`, [org]);
    await client.query(
      `INSERT INTO "audit_log" ("id","orgId","actorType","actorId","action","decision")
       VALUES ($1, $2, 'agent', 'a', 'memory.write', 'allow')`,
      [auditId, org],
    );
    // A member who holds read on the org's root scope through an "everyone" grant, so
    // access_person_holds() finds a row: its body is one query whose only planted
    // operators sit in the join and filter conditions, so it reaches them only when the
    // plan reads a row. With no matching row the plan decides, from statistics the
    // worker's earlier test files left, whether any row is read at all: a plan that
    // starts from scopes, where nothing matched the path, read none and the mutant
    // below did not mark. A row that matches in every table has to pass every condition,
    // whatever the join order.
    member = `sp-user-${suffix}`;
    await client.query(
      `INSERT INTO "users" ("id","orgId","clerkId","email","role","updatedAt") VALUES ($1, $2, $1, $3, 'member', now())`,
      [member, org, `sp-${suffix}@example.test`],
    );
    const scopeId = `sp-scope-${suffix}`;
    await client.query(`INSERT INTO "scopes" ("id","orgId","path","name") VALUES ($1, $2, $3, 'root')`, [
      scopeId,
      org,
      `org_${org}`,
    ]);
    await client.query(
      `INSERT INTO "grants" ("id","orgId","scopeId","granteeType","granteeId","permission") VALUES ($1, $2, $3, 'everyone', 'everyone', 'read')`,
      [`sp-grant-${suffix}`, org, scopeId],
    );
    const { rows: held } = await client.query<{ holds: boolean }>(
      `SELECT public.access_person_holds($1, $2, 'read', $3) AS holds`,
      [org, member, `org_${org}`],
    );
    expect(held[0].holds, "the access fire below must find a row, or its mutant marks only by plan luck").toBe(true);
    await client.query(`CREATE SEQUENCE ${MARKER}`);
    await client.query(`CREATE ROLE ${attacker} NOLOGIN`);
    await client.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${attacker}`);
    await client.query(`GRANT SELECT, INSERT, DELETE ON "audit_log", "audit_chain_heads", "orgs" TO ${attacker}`);
    await client.query(`CREATE ROLE ${victim} NOLOGIN`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${victim}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public TO ${victim}`);
    await client.query(`GRANT EXECUTE ON FUNCTION public.audit_log_org_exists(text) TO ${victim}`);
    await client.query(`GRANT USAGE ON SEQUENCE ${MARKER} TO ${victim}`);
  };

  /** Plants, as the attacker, a marking copy of every built-in and operator in the lists above. */
  const plantOverloads = async () => {
    await client.query(`SET LOCAL ROLE ${attacker}`);
    expect(await errorOf(`SELECT nextval('${MARKER}')`)).toMatch(/permission denied for sequence/);
    await client.query(`
      CREATE FUNCTION public.search_path_attack_mark() RETURNS void LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_catalog.nextval('${MARKER}'::pg_catalog.regclass);
      EXCEPTION WHEN insufficient_privilege THEN
        NULL;
      END $$`);
    for (const [name, args, returns] of PLANTED_FUNCTIONS) {
      const params = args
        ? args
            .split(",")
            .map((_, i) => `$${i + 1}`)
            .join(", ")
        : "";
      await client.query(`
        CREATE FUNCTION public.${name}(${args}) RETURNS ${returns} LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM public.search_path_attack_mark();
          RETURN pg_catalog.${name}(${params});
        END $$`);
    }
    for (const [op, left, right, impl] of PLANTED_OPERATORS) {
      const fn = `public.search_path_attack_op_${PLANTED_OPERATORS.findIndex((o) => o[0] === op)}`;
      await client.query(`
        CREATE FUNCTION ${fn}(a ${left}, b ${right}) RETURNS ${impl.endsWith("textcat") ? "text" : "boolean"}
        LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM public.search_path_attack_mark();
          RETURN ${impl}(a, b);
        END $$`);
      await client.query(`CREATE OPERATOR public.${op} (LEFTARG = ${left}, RIGHTARG = ${right}, FUNCTION = ${fn})`);
    }
    await client.query("RESET ROLE");
  };

  /**
   * One statement that runs each function, the role it runs as, and its arguments. No
   * statement uses an unqualified operator or built-in itself, so a mark can only come from
   * inside the function. The victim and the owner call the non-trigger functions directly;
   * nested calls run under their pinned caller's search_path, so only a direct call
   * reaches an unpinned callee.
   */
  const fires = (): Array<{ fn: string; as: "attacker" | "victim" | "owner"; sql: string; params: unknown[] }> => {
    const now = new Date();
    const capability = [
      `INSERT INTO public."capabilities" ("id","orgId","agentId","tokenHash","scopePath","permission","expiresAt","createdBy","createdAt")
       VALUES ($1, $2, 'sp-agent', $3, $4, 'admin', $5, 'system:search-path-test', $5)`,
      [`cap-${randomUUID()}`, org, `hash-${randomUUID()}`, `org_${org}`, now],
    ] as const;
    const insertAudit = [
      `INSERT INTO public."audit_log" ("id","orgId","actorType","actorId","action","decision")
       VALUES ($1, $2, 'agent', 'a', 'memory.write', 'allow')`,
      [randomUUID(), org],
    ] as const;
    const byId = `"id" OPERATOR(pg_catalog.=) $1`;
    return [
      {
        fn: "audit_log_canonical_field(text)",
        as: "victim",
        sql: `SELECT public.audit_log_canonical_field($1)`,
        params: ["x"],
      },
      {
        fn: "audit_log_row_hash(audit_log)",
        as: "victim",
        sql: `SELECT public.audit_log_row_hash(a) FROM public."audit_log" a WHERE a.${byId}`,
        params: [auditId],
      },
      { fn: "audit_log_org_exists(text)", as: "owner", sql: `SELECT public.audit_log_org_exists($1)`, params: [org] },
      { fn: "audit_log_chain_insert()", as: "attacker", sql: insertAudit[0], params: [...insertAudit[1]] },
      {
        fn: "audit_log_refuse_change()",
        as: "attacker",
        sql: `DELETE FROM public."audit_log" WHERE ${byId} AND "orgId" OPERATOR(pg_catalog.=) $2`,
        params: [auditId, org],
      },
      {
        fn: "audit_chain_heads_guard()",
        as: "attacker",
        sql: `DELETE FROM public."audit_chain_heads" WHERE "orgId" OPERATOR(pg_catalog.=) $1`,
        params: [org],
      },
      { fn: "audit_log_refuse_truncate()", as: "victim", sql: `TRUNCATE public."audit_log"`, params: [] },
      {
        fn: 'access_person_holds(text,text,"Permission",text)',
        as: "victim",
        sql: `SELECT public.access_person_holds($1, $2, 'read', $3)`,
        params: [org, member, `org_${org}`],
      },
      { fn: "capabilities_issuer_bound()", as: "victim", sql: capability[0], params: [...capability[1]] },
      { fn: "capabilities_admin_window()", as: "victim", sql: capability[0], params: [...capability[1]] },
      { fn: "org_deletion_refuse_write()", as: "victim", sql: capability[0], params: [...capability[1]] },
    ];
  };

  /** Runs one fire as its role, with public searched before pg_catalog. */
  const fire = async ({ as, sql, params }: ReturnType<typeof fires>[number]) => {
    if (as !== "owner") await client.query(`SET LOCAL ROLE ${as === "attacker" ? attacker : victim}`);
    await client.query(`SET LOCAL search_path = public, pg_catalog`);
    const error = await errorOf(sql, params);
    await client.query("RESET search_path");
    await client.query("RESET ROLE");
    return error;
  };

  it("every function the migrations define resolves names only in pg_catalog", async () => {
    const { rows } = await client.query<{ fn: string; path: string | null }>(
      `SELECT p.oid::regprocedure::text AS fn,
              (SELECT substr(c, length('search_path=') + 1) FROM unnest(p.proconfig) c WHERE c LIKE 'search\\_path=%') AS path
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = current_schema() AND p.proname = ANY($1)
        ORDER BY 1`,
      [MIGRATION_FUNCTIONS],
    );
    expect(rows.length).toBeGreaterThanOrEqual(12);
    expect(
      rows.filter((r) => r.path !== "pg_catalog, pg_temp").map((r) => `${r.fn}: ${r.path}`),
      "Pin each with SET search_path = pg_catalog, pg_temp in the migration that creates it, and name every " +
        "table, type and function outside pg_catalog as public.<name> (see " +
        "prisma/migrations/20261018120000_functions_resolve_only_pg_catalog).",
    ).toEqual([]);
  });

  it("runs no overload planted in public, as the owner or as any role that fires a function", async () => {
    await setUp();
    await plantOverloads();
    for (const f of fires()) await fire(f);
    const userId = `sp-user-${randomUUID()}`;
    await fire({
      fn: "users_join_org()",
      as: "victim",
      sql: `INSERT INTO public."users" ("id","orgId","clerkId","email","role","updatedAt") VALUES ($1, $2, $1, $3, 'member', $4)`,
      params: [userId, org, `${userId}@example.test`, new Date()],
    });
    // Deleting the org cascades through both append-only guards and the check, as the attacker.
    expect(
      await fire({
        fn: "",
        as: "attacker",
        sql: `DELETE FROM public."orgs" WHERE "id" OPERATOR(pg_catalog.=) (SELECT "orgId" FROM public."audit_chain_heads" WHERE "orgId" OPERATOR(pg_catalog.=) $1)`,
        params: [org],
      }),
    ).toBeNull();
    expect(await marks()).toBe(0);
  });

  it.each(fires().map((f) => [f.fn, f.as]))(
    "a mutant of %s without its pin runs the overload (fired as %s)",
    async (fn) => {
      await setUp();
      await plantOverloads();
      await client.query(`ALTER FUNCTION public.${fn} RESET search_path`);
      const target = fires().find((f) => f.fn === fn)!;
      await fire(target);
      expect(await marks()).toBeGreaterThan(0);
    },
  );

  // users_join_org() has no mutant above: its body calls no operator and names every
  // object with its schema, so removing its pin leaves nothing for an overload to reach.
  // The first test still fails if its pin goes.

  /** A temporary domain named "text" whose CHECK marks, as a role with only TEMP could plant it. */
  const plantTemporaryText = async () => {
    await client.query(`SET LOCAL ROLE ${attacker}`);
    await client.query(`
      CREATE FUNCTION pg_temp.search_path_attack_check(v pg_catalog.text) RETURNS boolean LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_catalog.nextval('${MARKER}'::pg_catalog.regclass);
        RETURN true;
      EXCEPTION WHEN insufficient_privilege THEN
        RETURN true;
      END $$`);
    await client.query(`CREATE DOMAIN pg_temp.text AS pg_catalog.text CHECK (pg_temp.search_path_attack_check(VALUE))`);
    await client.query("RESET ROLE");
  };

  it.each([
    { label: "never reaches the audit hash under its pin", pin: null, landed: false },
    { label: "reaches it in a mutant pinned to search_path = ''", pin: "''", landed: true },
  ])("a temporary type named text $label", async ({ pin, landed }) => {
    await setUp();
    if (pin) await client.query(`ALTER FUNCTION public.audit_log_row_hash(public.audit_log) SET search_path = ${pin}`);
    await plantTemporaryText();
    const insert = fires().find((f) => f.fn === "audit_log_chain_insert()")!;
    expect(await fire(insert)).toBeNull();
    expect((await marks()) > 0).toBe(landed);
  });

  it("re-running the migration leaves every function's definition, owner and grants as they were", async () => {
    const snapshot = async () =>
      (
        await client.query<{ s: string }>(
          `SELECT string_agg(pg_get_functiondef(p.oid) || coalesce(p.proacl::text, '') || p.proowner::regrole::text,
                             E'\n' ORDER BY p.oid::regprocedure::text COLLATE "C") AS s
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = current_schema() AND p.prokind = 'f'
              AND NOT EXISTS (
                SELECT 1 FROM pg_depend d
                 WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
              )`,
        )
      ).rows[0].s;
    const before = await snapshot();
    // The migration is its own transaction, so it runs outside the test's; it commits the
    // definitions the database already holds.
    await client.query(readFileSync(MIGRATION, "utf8"));
    await client.query(readFileSync(MIGRATION, "utf8"));
    expect(await snapshot()).toBe(before);
    await client.query("BEGIN");
  });
});
