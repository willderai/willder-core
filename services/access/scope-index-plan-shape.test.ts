// Database-gated: the live block runs only with LIVE_DB_TESTS=1 and DATABASE_URL set to the
// hosted database; without the flag it is skipped, not failed. The synthetic block always runs.
//
// The SCOPE-INDEX PLAN-SHAPE invariant, live against the real DB.
//
// WHAT THIS ASSERTS
//
// For the read paths listed below, the authorization-bearing `orgId` AND
// `scopePath` predicates must both be resolved BY THE SCOPE INDEX
// (`Index Cond`), not re-checked row by row after a scan (`Filter`). A scope
// predicate stuck in Filter means every row in the org is read and re-checked —
// the latency/DoS shape the btree (orgId, scopePath) index exists to close.
//
// COVERAGE, stated exactly rather than generally: `briefs` (get_my_brief) and
// `memory_chunks` (retrieve(), both includeUntagged branches). The other
// scope-containment readers — draft_list and the campaign list in
// mcp/tools.ts — are NOT covered here and would not be caught by this file.
//
// WHY PLAN SHAPE, NOT INDEX EXISTENCE
//
// A test that a btree (orgId, scopePath) index EXISTS on the scope-bearing
// tables says nothing about whether the planner uses it. So this asks Postgres
// directly, via a live EXPLAIN on the real query. The planner is an
// independent source of truth — nothing in this repo can talk it into a wrong
// answer, which is why it can't be fooled the way a schema read or a static
// code scan can.
//
// WHAT THE PLANNER DOES (PostgreSQL 18)
//
// It is tempting to expect memory_chunks to be INERT — that ivfflat would
// serve the `ORDER BY embedding <=> $vec` ordering and dump every scalar
// predicate, orgId included, into a Filter regardless of what btree exists.
// That is NOT what the database does. Observed, stably, across repeated runs:
//
//   briefs         Index Scan using briefs_orgId_scopePath_idx
//                  Index Cond: ("orgId" = $1) AND ("scopePath" = $2)
//
//   memory_chunks  Bitmap Heap Scan
//                    BitmapOr
//                      Bitmap Index Scan using memory_chunks_orgId_scopePath_idx
//                        Index Cond: "orgId" = $1 AND "scopePath" = $2
//                      Bitmap Index Scan using memory_chunks_orgId_scopePath_idx
//                        Index Cond: "orgId" = $1 AND "scopePath" >= $3 AND < $4
//
// The ivfflat index (memory_chunks_embedding_idx) exists and the planner does
// not choose it: it pre-filters by scope through the btree, then sorts the
// surviving rows by distance. Both legs of the containment predicate are
// index-served, and so is the `IS NULL` leg when includeUntagged is true.
//
// WHERE THE "INERT" READING COMES FROM — a measurement artifact:
// writing the containment predicate by hand as `"scopePath" LIKE 'X.%'` DOES
// produce a Seq Scan with everything in Filter. Not because of vector ordering,
// but because an unescaped scope path contains `_`, and `_` is a LIKE wildcard.
// With a wildcard that early in the pattern Postgres cannot derive a prefix
// range, so no index is usable. Production never emits that: scopeContainsSql
// escapes it (`\_` plus an ESCAPE clause), which leaves a literal prefix the
// planner CAN turn into the range scan above. escapeLikePattern is therefore not
// only a correctness guard against a scope matching outside its own subtree — it
// is also the reason the btree works at all. That is why this test builds its
// predicate through the production helper instead of hand-rolling it: a
// hand-rolled approximation produces the inert reading.
//
// WHAT IS STILL A REAL RISK (not asserted here)
//
// The concern behind the "inert" reading is not imaginary, it is just not
// current behavior. ivfflat becomes attractive to the planner as the table
// grows, and if it is ever chosen to serve the ordering, the scalar predicates
// WOULD fall back into a Filter — precisely when the data volume makes that
// expensive. This test notices the flip when it happens, because that is
// exactly the shape it asserts against.
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "@/lib/generated/prisma/client";
import { scopeContainsSql } from "@/services/access";

// Opt-in, and deliberately NOT gated on `DATABASE_URL` being set.
//
// The presence of DATABASE_URL is not evidence that a real database is
// reachable: .github/workflows/ci.yml sets a dummy
// `postgresql://ci:ci@localhost:5432/ci` purely so `prisma generate` can run
// without a connection. Gating on presence therefore fails all three of these
// tests on every PR — verified by running this file with that exact value. The
// repo already draws this line for live-DB work: the real verifiers live in
// .github/workflows/live-checks.yml, workflow_dispatch-only, with a real
// DATABASE_URL secret. This follows that convention rather than inventing one.
//
// Consequence, stated plainly rather than papered over: this is a manual /
// scheduled invariant, not a per-PR gate. It cannot become a per-PR gate until
// ordinary CI has a real database to plan against.
const OPT_IN = process.env.LIVE_DB_TESTS === "1";

// Opted in but unconfigured is a misconfiguration, not a reason to skip quietly
// — that is exactly how a live check silently stops covering anything.
if (OPT_IN && !process.env.DATABASE_URL) {
  throw new Error("LIVE_DB_TESTS=1 but DATABASE_URL is unset: nothing to plan against.");
}

const LIVE = OPT_IN;

// Real round trips to the hosted database run past vitest's 5s default.
// Generous on purpose: a timeout must never be mistakable for a plan-shape
// verdict.
const LIVE_TIMEOUT_MS = 45_000;

// Queries go over the hosted database's HTTPS SQL endpoint rather than through
// `@/lib/db`. Not a preference: lib/db.ts uses @prisma/adapter-pg (direct
// postgres TCP), and an environment without TCP egress hangs on the pooled
// connection until the test times out. The HTTPS endpoint reaches the SAME
// database, and a query plan is a property of the database and the SQL, not
// of the client that carried it. The SQL itself is still built with Prisma.sql
// and the production containment helper, then handed over as ($text, $values).
//
// Built inside the live block, not at import: `neon()` throws on an empty
// connection string, and a skipped suite must still import cleanly.
let sql: NeonQueryFunction<false, false>;

type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };

/** Every node in an EXPLAIN (FORMAT JSON) plan tree, flattened. */
function walk(node: PlanNode): PlanNode[] {
  const kids = Array.isArray(node.Plans) ? node.Plans : [];
  return [node, ...kids.flatMap(walk)];
}

async function explain(query: Prisma.Sql): Promise<PlanNode> {
  // ANALYZE so the plan is the one actually executed, not a hypothetical.
  const wrapped = Prisma.sql`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`;
  const rows = (await sql.query(wrapped.text, wrapped.values as unknown[])) as Array<Record<string, unknown>>;
  // One row, one column, holding the JSON plan array. The driver may hand it
  // back already-parsed or as text depending on the column type.
  const raw = Object.values(rows[0])[0];
  const parsed = (typeof raw === "string" ? JSON.parse(raw) : raw) as Array<{ Plan: PlanNode }>;
  return parsed[0].Plan;
}

/**
 * Assert the scope predicate on `table` is index-served.
 *
 * Collecting the Index Conds is the fiddly part, and getting it wrong is how
 * this test would silently become a lie. In a plain `Index Scan` the cond sits
 * on the node that names the relation. In a `Bitmap Heap Scan` it does NOT: the
 * heap node names the relation but carries no Index Cond, while the child
 * `Bitmap Index Scan` nodes carry the conds and name only the INDEX, with no
 * "Relation Name" at all. An earlier draft of this function looked only at nodes
 * matching the relation name and therefore reported memory_chunks as unindexed
 * while Postgres was in fact serving it from the scope index through a BitmapOr.
 * So: find the node that scans the relation, then search its whole subtree.
 */
export function analyzeScopePlan(plan: PlanNode, table: string, indexName: string) {
  const all = walk(plan);
  const scanRoots = all.filter((n) => String(n["Relation Name"] ?? "") === table);
  const subtree = scanRoots.flatMap(walk);
  return {
    touched: scanRoots.length > 0,
    nodeTypes: subtree.map((n) => String(n["Node Type"] ?? "")).join(", "),
    filters: subtree.map((n) => String(n["Filter"] ?? "")).filter(Boolean),
    scopeIdxConds: subtree
      .filter((n) => String(n["Index Name"] ?? "") === indexName)
      .map((n) => String(n["Index Cond"] ?? ""))
      .filter(Boolean),
    allConds: subtree
      .map((n) => ({ cond: String(n["Index Cond"] ?? ""), idx: String(n["Index Name"] ?? "") }))
      .filter((c) => c.cond),
    /** Legs the scope index serves that fail to bind BOTH columns. */
    get unboundLegs() {
      return this.scopeIdxConds.filter((c) => !c.includes("orgId") || !c.includes("scopePath"));
    },
  };
}

function expectScopePredicateIndexed(plan: PlanNode, table: string, indexName: string) {
  const a = analyzeScopePlan(plan, table, indexName);
  expect(
    a.touched,
    `no plan node scanned ${table}; the query shape changed and this test is no longer testing it`,
  ).toBe(true);

  const detail =
    `Node types: [${a.nodeTypes}]. Index Conds: ${JSON.stringify(a.allConds)}. ` +
    `Filters: ${JSON.stringify(a.filters)}.`;

  // Only conditions served by the scope index itself count. memory_chunks also
  // carries a bare (orgId) btree, so "some index resolved orgId" is not enough.
  expect(
    a.scopeIdxConds.length,
    `${table}: no Index Cond came from ${indexName} — the scope predicate is being ` +
      `re-checked row by row. ${detail}`,
  ).toBeGreaterThan(0);

  // Both columns must appear in EVERY cond the scope index serves, checked per
  // leg rather than across the plan as a whole.
  //
  // Checking "some cond mentions orgId" and "some cond used this index"
  // independently is not enough, and the gap is not hypothetical: a composite
  // (orgId, scopePath) btree can legally be used through its LEADING column
  // alone, with scopePath left to a heap Filter. That plan satisfies both
  // independent checks while scanning every row in the org — exactly the
  // regression this file exists to catch, waved through by its own assertion.
  //
  // Per leg matters just as much for the BitmapOr case: one containment leg
  // silently losing its scopePath bound would scan the whole org even while its
  // siblings stay tight.
  //
  // This deliberately does NOT assert the absence of a scopePath `Filter` on the
  // scan node. A Bitmap Heap Scan always re-checks its bitmap's conditions on
  // the heap, so the real, correct memory_chunks plan carries the containment
  // predicate in BOTH Index Cond and Filter. Failing on that would reject a
  // passing plan.
  expect(
    a.unboundLegs,
    `${table}: ${a.unboundLegs.length} of ${a.scopeIdxConds.length} Index Cond leg(s) on ` +
      `${indexName} do not bind BOTH "orgId" and "scopePath". A leg bound only by the index's ` +
      `leading column still scans every row in the org. ${detail}`,
  ).toEqual([]);
}

describe.skipIf(!LIVE)("scope-index plan shape (live DB)", () => {
  beforeAll(() => {
    sql = neon(process.env.DATABASE_URL ?? "");
  });

  it(
    "briefs: get_my_brief's scope-filtered read is served by briefs_orgId_scopePath_idx",
    async () => {
      // Brief.scopePath is non-nullable in schema.prisma, so any row will do.
      const rows = (await sql`SELECT "orgId", "scopePath" FROM briefs LIMIT 1`) as Array<{
        orgId: string;
        scopePath: string;
      }>;
      // No seeded brief means no live evidence either way. Fail rather than
      // skip: a silent pass here is precisely how an inert index survives.
      expect(rows.length, "no brief in the live DB to plan against").toBeGreaterThan(0);
      const row = rows[0];

      // Same shape as mcp/tools.ts's get_my_brief:
      //   db.brief.findFirst({ where: { orgId, scopePath: target },
      //                        orderBy: { createdAt: "desc" } })
      const plan = await explain(Prisma.sql`
        SELECT "id" FROM "briefs"
        WHERE "orgId" = ${row.orgId} AND "scopePath" = ${row.scopePath}
        ORDER BY "createdAt" DESC
        LIMIT 1
      `);

      expectScopePredicateIndexed(plan, "briefs", "briefs_orgId_scopePath_idx");
    },
    LIVE_TIMEOUT_MS,
  );

  // Both branches of retrieve()'s containment predicate, because they plan
  // differently: includeUntagged adds an `IS NULL` leg to the BitmapOr, and a
  // regression could plausibly break one branch while leaving the other indexed.
  describe.each([{ includeUntagged: false }, { includeUntagged: true }])(
    "memory_chunks: retrieve()'s vector-ordered read (includeUntagged=$includeUntagged)",
    ({ includeUntagged }) => {
      it(
        "pre-filters by scope through memory_chunks_orgId_scopePath_idx rather than filtering per row",
        async () => {
          const rows = (await sql`
            SELECT "orgId", "scopePath" FROM memory_chunks
            WHERE "scopePath" IS NOT NULL AND embedding IS NOT NULL
            LIMIT 1
          `) as Array<{ orgId: string; scopePath: string }>;
          expect(rows.length, "no embedded, scoped memory_chunk in the live DB to plan against").toBeGreaterThan(0);

          // Built through the SAME shared helper production uses, so this tracks
          // retrieve() instead of drifting from it — and so the LIKE escaping
          // that makes the index usable is the real one, not an approximation.
          const containment = scopeContainsSql(Prisma.raw('"scopePath"'), rows[0].scopePath, {
            relation: "within",
            mode: "text",
            includeUntagged,
          });
          const queryVec = `[${Array.from({ length: 384 }, () => 0.01).join(",")}]`;

          const plan = await explain(Prisma.sql`
            SELECT id, content, "createdAt" as created_at, "actorType" as actor_type
            FROM memory_chunks
            WHERE "orgId" = ${rows[0].orgId}
              AND embedding IS NOT NULL
              AND ${containment}
            ORDER BY embedding <=> ${queryVec}::vector
            LIMIT 10
          `);

          expectScopePredicateIndexed(plan, "memory_chunks", "memory_chunks_orgId_scopePath_idx");
        },
        LIVE_TIMEOUT_MS,
      );
    },
  );
});

// ── Detector self-tests (no database, so these DO run in ordinary CI) ─────────
//
// The live block above only runs under LIVE_DB_TESTS=1, which means the logic
// deciding pass/fail would otherwise have zero per-PR coverage. The obvious
// wrong detector checks "some cond mentions orgId" and "some cond used this
// index" independently, which passes on a plan that binds only the index's
// leading column. A detector that silently stops detecting is worse than no
// detector, so its verdicts are pinned here against hand-built plan trees,
// including that exact false-positive shape.
describe("analyzeScopePlan (synthetic plans)", () => {
  const IDX = "memory_chunks_orgId_scopePath_idx";
  const bothCols = "((\"orgId\" = 'o1'::text) AND (\"scopePath\" = 'o1.eng'::text))";

  it("accepts a plain Index Scan binding both columns", () => {
    const a = analyzeScopePlan(
      {
        "Node Type": "Index Scan",
        "Relation Name": "memory_chunks",
        "Index Name": IDX,
        "Index Cond": bothCols,
      },
      "memory_chunks",
      IDX,
    );
    expect(a.touched).toBe(true);
    expect(a.scopeIdxConds).toHaveLength(1);
    expect(a.unboundLegs).toEqual([]);
  });

  it("REJECTS the leading-column-only plan (the false positive an independent check lets through)", () => {
    // The index is genuinely used, and orgId is genuinely in an Index Cond --
    // but scopePath is left to a heap Filter, so every row in the org is read.
    const a = analyzeScopePlan(
      {
        "Node Type": "Index Scan",
        "Relation Name": "memory_chunks",
        "Index Name": IDX,
        "Index Cond": "(\"orgId\" = 'o1'::text)",
        Filter: "(\"scopePath\" = 'o1.eng'::text)",
      },
      "memory_chunks",
      IDX,
    );
    expect(a.scopeIdxConds).toHaveLength(1); // index used...
    expect(a.unboundLegs).toHaveLength(1); // ...but not bound by both columns
  });

  it("REJECTS a BitmapOr where a single leg loses its scopePath bound", () => {
    const a = analyzeScopePlan(
      {
        "Node Type": "Bitmap Heap Scan",
        "Relation Name": "memory_chunks",
        Plans: [
          {
            "Node Type": "BitmapOr",
            Plans: [
              { "Node Type": "Bitmap Index Scan", "Index Name": IDX, "Index Cond": bothCols },
              // Sibling leg bound only by orgId: scans the whole org.
              {
                "Node Type": "Bitmap Index Scan",
                "Index Name": IDX,
                "Index Cond": "(\"orgId\" = 'o1'::text)",
              },
            ],
          },
        ],
      },
      "memory_chunks",
      IDX,
    );
    expect(a.scopeIdxConds).toHaveLength(2);
    expect(a.unboundLegs).toHaveLength(1);
  });

  it("accepts the real BitmapOr shape, incl. the containment range and IS NULL legs", () => {
    const a = analyzeScopePlan(
      {
        "Node Type": "Bitmap Heap Scan",
        "Relation Name": "memory_chunks",
        // A Bitmap Heap Scan always rechecks on the heap; that must not fail.
        Filter: "((\"scopePath\" = 'o1.eng'::text) OR (\"scopePath\" ~~ 'o1.eng.%'::text))",
        Plans: [
          {
            "Node Type": "BitmapOr",
            Plans: [
              { "Node Type": "Bitmap Index Scan", "Index Name": IDX, "Index Cond": bothCols },
              {
                "Node Type": "Bitmap Index Scan",
                "Index Name": IDX,
                "Index Cond":
                  "((\"orgId\" = 'o1'::text) AND (\"scopePath\" >= 'o1.eng.'::text) AND (\"scopePath\" < 'o1.eng/'::text))",
              },
              {
                "Node Type": "Bitmap Index Scan",
                "Index Name": IDX,
                "Index Cond": '(("orgId" = \'o1\'::text) AND ("scopePath" IS NULL))',
              },
            ],
          },
        ],
      },
      "memory_chunks",
      IDX,
    );
    expect(a.scopeIdxConds).toHaveLength(3);
    expect(a.unboundLegs).toEqual([]);
  });

  it("REJECTS a Seq Scan with the predicates in Filter", () => {
    const a = analyzeScopePlan(
      {
        "Node Type": "Seq Scan",
        "Relation Name": "memory_chunks",
        Filter: "((\"orgId\" = 'o1'::text) AND (\"scopePath\" = 'o1.eng'::text))",
      },
      "memory_chunks",
      IDX,
    );
    expect(a.touched).toBe(true);
    expect(a.scopeIdxConds).toEqual([]);
  });

  it("REJECTS orgId served by a different index (the bare (orgId) btree)", () => {
    const a = analyzeScopePlan(
      {
        "Node Type": "Index Scan",
        "Relation Name": "memory_chunks",
        "Index Name": "memory_chunks_orgId_idx",
        "Index Cond": "(\"orgId\" = 'o1'::text)",
      },
      "memory_chunks",
      IDX,
    );
    expect(a.allConds).toHaveLength(1); // an index did resolve orgId...
    expect(a.scopeIdxConds).toEqual([]); // ...but not the scope index
  });

  it("reports an untouched table rather than passing vacuously", () => {
    const a = analyzeScopePlan(
      { "Node Type": "Index Scan", "Relation Name": "briefs", "Index Cond": bothCols },
      "memory_chunks",
      IDX,
    );
    expect(a.touched).toBe(false);
  });
});
