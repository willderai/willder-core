import { beforeEach, describe, expect, it, vi } from "vitest";

// The audit actors query stays bounded to the caller's org and readable scopes.
//
// The suite in app/api/access-routes.test.ts mocks `db.auditLog.findMany`
// itself, so it can only assert the ARGUMENTS the route passes to Prisma —
// `{ distinct: ["actorType", "actorId"] }` looks correct there and the tests
// pass. What it structurally cannot see is the SQL Prisma actually emits for
// those arguments, and that is where the defect lives: in Prisma 7.8 the
// `distinct` option is applied client-side, so the emitted statement carries
// no DISTINCT, no GROUP BY and no LIMIT, and Postgres is asked for every
// audit_log row in the org on each load of the audit page.
//
// So these tests mock one layer LOWER — at the driver adapter — and let the
// real route drive the real Prisma query builder. The assertion is on the
// observable property that matters (what the database is asked to return),
// not on the route's internal phrasing of it.
//
// The property under test: a route that only needs the distinct (actorType,
// actorId) pairs must not ask Postgres for every matching row. It must either
// dedupe server-side (DISTINCT / GROUP BY) or bound the read (LIMIT).

// Hoisted so the vi.mock factory below (which vitest lifts to the top of the
// file) can reach both the recorder and the adapter it installs.
const { captured, recordingAdapter } = vi.hoisted(() => {
  const captured: string[] = [];
  const emptyResult = { columnNames: [], columnTypes: [], rows: [] };
  const queryable = {
    provider: "postgres",
    adapterName: "@prisma/adapter-pg",
    queryRaw: async (q: { sql: string }) => {
      captured.push(q.sql);
      return emptyResult;
    },
    executeRaw: async (q: { sql: string }) => {
      captured.push(q.sql);
      return 0;
    },
  };
  // Minimal driver adapter: records the SQL Prisma generates and returns an
  // empty result set. No database is contacted, so this runs in ordinary CI
  // exactly like every other mocked route test in this repo.
  const recordingAdapter = {
    provider: "postgres",
    adapterName: "@prisma/adapter-pg",
    connect: async () => ({
      ...queryable,
      transactionContext: async () => ({
        ...queryable,
        startTransaction: async () => ({
          ...queryable,
          commit: async () => {},
          rollback: async () => {},
        }),
      }),
      dispose: async () => {},
    }),
  };
  return { captured, recordingAdapter };
});

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/services/access", () => ({
  check: vi.fn().mockResolvedValue({ allowed: true }),
  orgRootPath: (id: string) => `org_${id}`,
}));
vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("@/lib/generated/prisma/client");
  return { db: new PrismaClient({ adapter: recordingAdapter as never }) };
});

import { requireAccessContext } from "@/lib/access-context";
import { GET as auditActorsGET } from "./actors/route";
import { GET as auditGET } from "./route";

const admin = { org: { id: "org_1" }, ctx: { orgId: "org_1", actor: { type: "human", id: "user_1" } } };

/** The SQL statement that actually fetches audit_log ROWS, ignoring Prisma's
 *  own connection-setup chatter (SET, BEGIN, deallocate) and the separate
 *  COUNT(*) the paginated list route issues alongside its page query — an
 *  aggregate returns one row regardless of table size, so it is not the read
 *  whose bounds are in question here. The schema qualifier is optional: item
 *  audit-route-scope-prefix-leak moved GET /api/audit itself onto raw SQL
 *  (services/access/audit-query.ts) with an unqualified `"audit_log"`, the
 *  same convention services/access/check.ts's own raw queries already use
 *  (`FROM "grants" g`, no `"public".` prefix) — only Prisma's typed query
 *  builder (what this route used before the fix, and what /api/audit/actors
 *  still uses) always emits the fully-qualified form. */
function auditLogRowReads(): string[] {
  return captured.filter((s) => /FROM\s+(?:"?public"?\.)?"?audit_log"?/i.test(s) && !/COUNT\s*\(/i.test(s));
}

function auditLogRowRead(): string {
  const reads = auditLogRowReads();
  expect(reads.length, `expected exactly one audit_log row read, got ${reads.length}:\n${reads.join("\n")}`).toBe(1);
  return reads[0]!;
}

const dedupesInPostgres = (sql: string) => /\bDISTINCT\b/i.test(sql) || /\bGROUP\s+BY\b/i.test(sql);
const isBounded = (sql: string) => /\bLIMIT\b/i.test(sql);

describe("audit_log read bounds", () => {
  beforeEach(() => {
    captured.length = 0;
    vi.mocked(requireAccessContext).mockResolvedValue(admin as never);
  });

  // CONTROL. Proves the harness can tell a bounded read from an unbounded one,
  // and that this is genuinely a regression introduced by this change rather
  // than the shape audit_log queries have always had here. The paginated list
  // route on the very same table must come back LIMIT-bounded. If this ever
  // fails, the detector is broken and the failure below means nothing.
  it("CONTROL: the paginated audit list route bounds its read with LIMIT", async () => {
    // The list route also issues a COUNT(*) for its pager. The recording
    // adapter returns an empty result set for every statement, which Prisma's
    // count unpacker cannot decode, so the handler rejects AFTER both
    // statements have already been generated and captured. That rejection is
    // an artifact of the stub, not of the route, and the SQL is what is under
    // test here — so the SQL assertion below still runs on real output.
    // The route reads its page plus one row for each decision count, so every
    // row read it issues must be bounded, not just one.
    await auditGET(new Request("http://t/api/audit")).catch(() => undefined);
    const reads = auditLogRowReads();
    expect(reads.length).toBeGreaterThan(0);
    for (const sql of reads) {
      expect(isBounded(sql), `list route SQL was not LIMIT-bounded:\n${sql}`).toBe(true);
    }
  });

  // THE FINDING. Currently RED against this branch: Prisma 7.8 resolves
  // `distinct` in the client process, so the generated statement has neither a
  // server-side dedupe nor a LIMIT and Postgres returns the org's entire
  // visible audit history to Node on every audit page load.
  //
  // Note for whoever fixes this: adding `take` does NOT close it — measured on
  // this branch, `distinct` + `take: 200` still emits no LIMIT, because the
  // take is applied to the already-materialised, client-deduped set. Switching
  // the query to `db.auditLog.groupBy({ by: ["actorType", "actorId"], where })`
  // does emit a real `GROUP BY` and returns the same {actorType, actorId}
  // shape the route already maps over.
  it("GET /api/audit/actors must not ask Postgres for every audit row to list distinct actors", async () => {
    await auditActorsGET();
    const sql = auditLogRowRead();
    expect(
      dedupesInPostgres(sql) || isBounded(sql),
      `the distinct-actors query is an unbounded full read of audit_log — it has no ` +
        `DISTINCT/GROUP BY and no LIMIT, so every row in the org is returned to Node ` +
        `and deduped there:\n${sql}`,
    ).toBe(true);
  });

  // Guards the specific fix rather than any statement that happens to contain
  // the word LIMIT: the dedupe has to happen in Postgres, because a LIMIT alone
  // on a non-deduped scan would silently truncate the picker's actor list.
  it("the distinct-actors query dedupes server-side, not by truncating the scan", async () => {
    await auditActorsGET();
    const sql = auditLogRowRead();
    expect(
      dedupesInPostgres(sql),
      `distinct actors must be resolved by Postgres (DISTINCT/GROUP BY). A bare LIMIT ` +
        `would drop real identities from the picker instead:\n${sql}`,
    ).toBe(true);
  });
});
