// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// PgvectorMemoryStore.removeFact and findFactById: the scope containment
// predicate, evaluated by real Postgres.
//
// pgvector-store.test.ts covers the same cases against an in-memory `db` double,
// but that double re-implements the "within" rule itself in JavaScript. A wrong
// predicate in pgvector-store.ts, or in scopeContainsSql, could still pass there
// as long as the double agreed with it. This file runs the store's real SQL, so
// Postgres decides every case, including the ones the double cannot model: the
// LIKE prefix's escaped `_`, and a sibling whose label merely starts with the
// granted one.
//
// Each case inserts one row, asks findFactById whether the authorized scope can
// see it, asks removeFact to delete it, then reads the table directly. A read
// and a delete use the same three-part predicate (id, tenant, containment), so
// they must agree on every case.
//
// Set QA_DATABASE_URL to an ISOLATED test database with the migrations applied.
// Never the sandbox's inherited DATABASE_URL. Skips cleanly without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qa_pgv_contain";
const OTHER_ORG = "qa_pgv_contain_other";
const ROOT = `org_${ORG}`;
const GRANTED = `${ROOT}.dept_sales`;
const FACT_ID = "qa-pgv-contain-fact";
const DIMENSIONS = 384;

interface Case {
  name: string;
  /** Tenant that owns the stored row. */
  rowOrg: string;
  /** The row's own scopePath; null is an untagged row. */
  rowScope: string | null;
  /** The scope check() authorized: the store's `groupId`. */
  authorized: string;
  reachable: boolean;
}

const CASES: Case[] = [
  { name: "the authorized scope itself", rowOrg: ORG, rowScope: GRANTED, authorized: GRANTED, reachable: true },
  {
    name: "a descendant of the authorized scope",
    rowOrg: ORG,
    rowScope: `${GRANTED}.eu`,
    authorized: GRANTED,
    reachable: true,
  },
  { name: "a sibling scope", rowOrg: ORG, rowScope: `${ROOT}.marketing`, authorized: GRANTED, reachable: false },
  // Differs from GRANTED only where GRANTED has `_`: an unescaped LIKE matches it.
  {
    name: "a sibling matching only through LIKE's `_` wildcard",
    rowOrg: ORG,
    rowScope: `${ROOT}.deptXsales.eu`,
    authorized: GRANTED,
    reachable: false,
  },
  {
    name: "a sibling whose label starts with the authorized label",
    rowOrg: ORG,
    rowScope: `${GRANTED}_eu`,
    authorized: GRANTED,
    reachable: false,
  },
  { name: "an ancestor of the authorized scope", rowOrg: ORG, rowScope: ROOT, authorized: GRANTED, reachable: false },
  { name: "an untagged row, from a narrow scope", rowOrg: ORG, rowScope: null, authorized: GRANTED, reachable: false },
  { name: "an untagged row, from org root", rowOrg: ORG, rowScope: null, authorized: ROOT, reachable: true },
  {
    name: "the same scope path in another tenant",
    rowOrg: OTHER_ORG,
    rowScope: GRANTED,
    authorized: GRANTED,
    reachable: false,
  },
];

describe.skipIf(!QA_URL)("PgvectorMemoryStore scope containment, real Postgres", () => {
  let db: PrismaClient;
  let store: InstanceType<(typeof import("./pgvector-store"))["PgvectorMemoryStore"]>;

  const rowExists = async () =>
    (await db.$queryRaw<{ id: string }[]>`SELECT id FROM memory_chunks WHERE id = ${FACT_ID}`).length === 1;

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    const { PgvectorMemoryStore } = await import("./pgvector-store");
    store = new PgvectorMemoryStore();
    for (const id of [ORG, OTHER_ORG]) {
      await db.org.upsert({ where: { id }, update: {}, create: { id, name: id } });
    }
  });

  beforeEach(async () => {
    await db.$executeRaw`DELETE FROM memory_chunks WHERE id = ${FACT_ID} AND "orgId" IN (${ORG}, ${OTHER_ORG})`;
  });

  afterAll(async () => {
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" IN (${ORG}, ${OTHER_ORG})`;
    await db.$disconnect();
  });

  it.each(CASES)("$name: reachable=$reachable", async ({ rowOrg, rowScope, authorized, reachable }) => {
    const embedding = `[1${",0".repeat(DIMENSIONS - 1)}]`;
    await db.$executeRaw`
      INSERT INTO memory_chunks ("id","orgId","content","source","actorType","scopePath","embedding","createdAt")
      VALUES (${FACT_ID}, ${rowOrg}, 'contained?', 'text', 'human', ${rowScope}, ${embedding}::vector, NOW())
    `;
    const input = { groupId: authorized, factId: FACT_ID, tenantId: ORG };

    const found = await store.findFactById(input);
    expect(found !== null).toBe(reachable);

    // A removed row also says where it was stored, which can be below the scope asked.
    expect(await store.removeFact(input)).toEqual(
      reachable ? { removed: true, storedScopePath: rowScope, storedEntityName: null } : { removed: false },
    );
    expect(await rowExists()).toBe(!reachable);
  });
});
