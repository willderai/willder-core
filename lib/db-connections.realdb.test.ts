// The shared client's pool reports every connection it opens, against a real Postgres.
//
// /api/mcp's `db-connections-opened` timing entry (mcp/server-timing.ts) is only as true
// as this wiring: lib/db.ts must hand Prisma the pool whose "connect" event it counts. A
// pool the adapter built for itself instead (as when a second copy of `pg` makes the
// adapter read ours as a config object) would leave the entry at zero forever.
//
// Gated on QA_DATABASE_URL, an isolated, migrated test database; skipped without it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const QA_URL = process.env.QA_DATABASE_URL;

describe.skipIf(!QA_URL)("the shared database client's connection count", () => {
  let db: (typeof import("./db"))["db"];
  let connectionsOpened: (typeof import("./db-connections"))["connectionsOpened"];

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    ({ db } = await import("./db"));
    ({ connectionsOpened } = await import("./db-connections"));
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("counts one connection per query that had to open one, and none for a query on an idle one", async () => {
    const before = connectionsOpened();
    // Three queries at once on an empty pool open three connections.
    await Promise.all([1, 2, 3].map(() => db.$queryRaw`SELECT pg_sleep(0.05)::text AS slept`));
    expect(connectionsOpened() - before).toBe(3);

    // The next query reuses an idle one.
    await db.$queryRaw`SELECT 1 AS one`;
    expect(connectionsOpened() - before).toBe(3);
  });
});
