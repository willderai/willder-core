// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The workflow budget guard against a real database.
//
// engine.test.ts mocks `@/lib/db` wholesale, including
// `$executeRaw: vi.fn()`. Its two budget tests assert only that the JS wrapper
// maps a returned row count of 1 to `true` and 0 to `false` — they never run
// the SQL. A typo, a wrong column name, or inverted boundary semantics inside
// that raw UPDATE would leave those tests green.
//
// That matters more here than usual, because raw SQL is used for exactly one
// stated reason (engine.ts's own comment): Prisma's query builder has no
// column-to-column comparison in `where`, so a read-then-write would race, and
// the conditional UPDATE is what makes the reservation atomic. "It is atomic"
// is precisely the claim a mock cannot substantiate — including the
// concurrency case below, which is the whole point of the guard.
//
// So this file runs the SHIPPING reserveWorkflowCredits/settleWorkflowCredits
// against a REAL Postgres 16 and asserts on the rows the database actually
// holds, including two genuinely concurrent reservations racing for the same
// remaining budget.
//
// Set QA_DATABASE_URL to an ISOLATED test database, never the inherited
// DATABASE_URL, which may point at a live database. Skips cleanly without it.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;
if (QA_URL) process.env.DATABASE_URL = QA_URL;

const ORG = "org-qa-131";
const RUN = "run-qa-131";

describe.skipIf(!QA_URL)("workflow budget guard against real Postgres", { timeout: 30_000 }, () => {
  // Explicit bounds sized for a loaded CI runner, not Vitest's 10 s hook and 5 s test
  // defaults: importing the route and database modules alone can take several seconds
  // when every core is busy, and a timeout there fails the suite without testing anything.

  let db: PrismaClient;
  let reserveWorkflowCredits: (runId: string, estimate: number) => Promise<boolean>;
  let settleWorkflowCredits: (runId: string, reservedEstimate: number, actualCost: number) => Promise<void>;

  beforeAll(async () => {
    ({ db } = await import("@/lib/db"));
    ({ reserveWorkflowCredits, settleWorkflowCredits } = await import("./engine"));

    await db.workflowRun.deleteMany({ where: { orgId: ORG } });
    await db.org.deleteMany({ where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: "QA 131 org" } });
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await db.workflowRun.deleteMany({ where: { orgId: ORG } });
    await db.org.deleteMany({ where: { id: ORG } });
    await db.$disconnect();
  });

  /** A run with a 100-credit budget and nothing reserved or spent yet. */
  async function seedRun(over: Partial<{ budgetCredits: number; reservedCredits: number; spentCredits: number }> = {}) {
    await db.workflowRun.deleteMany({ where: { orgId: ORG } });
    await db.workflowRun.create({
      data: {
        id: RUN,
        orgId: ORG,
        workflowKey: "handoff-brief",
        idempotencyKey: `idem-${Date.now()}-${Math.random()}`,
        requestedBy: "user-qa-131",
        scopePath: "org_qa131",
        budgetCredits: over.budgetCredits ?? 100,
        reservedCredits: over.reservedCredits ?? 0,
        spentCredits: over.spentCredits ?? 0,
      },
    });
  }

  const read = () => db.workflowRun.findUniqueOrThrow({ where: { id: RUN } });

  beforeEach(async () => {
    await seedRun();
  });

  it("the raw SQL actually executes against the real schema and reserves within budget", async () => {
    expect(await reserveWorkflowCredits(RUN, 30)).toBe(true);
    expect((await read()).reservedCredits).toBe(30);
  });

  it("refuses a reservation that would exceed the budget, and mutates nothing", async () => {
    await seedRun({ reservedCredits: 80, spentCredits: 10 });

    expect(await reserveWorkflowCredits(RUN, 11)).toBe(false);
    const row = await read();
    expect(row.reservedCredits).toBe(80);
    expect(row.spentCredits).toBe(10);
  });

  it("allows reserving EXACTLY up to the budget — the boundary is inclusive", async () => {
    await seedRun({ reservedCredits: 80, spentCredits: 10 });

    expect(await reserveWorkflowCredits(RUN, 10)).toBe(true);
    expect((await read()).reservedCredits).toBe(90);
  });

  it("counts spentCredits, not just reservedCredits, against the budget", async () => {
    // A settled step has moved credits from reserved to spent. If the guard
    // only looked at reservedCredits, this would wrongly succeed.
    await seedRun({ reservedCredits: 0, spentCredits: 95 });

    expect(await reserveWorkflowCredits(RUN, 10)).toBe(false);
    expect((await read()).reservedCredits).toBe(0);
  });

  it("a non-existent run reserves nothing and reports false", async () => {
    expect(await reserveWorkflowCredits("run-does-not-exist", 1)).toBe(false);
  });

  it("CONCURRENCY: two racing reservations that each fit but together overflow — exactly one wins", async () => {
    // The claim the raw SQL exists for. Budget 100, nothing used; each asks
    // for 60. A read-then-write would let both read "0 reserved", both decide
    // they fit, and both write — landing 120 against a 100 budget.
    await seedRun({ budgetCredits: 100 });

    const [a, b] = await Promise.all([reserveWorkflowCredits(RUN, 60), reserveWorkflowCredits(RUN, 60)]);

    expect([a, b].filter(Boolean)).toHaveLength(1);
    const row = await read();
    expect(row.reservedCredits).toBe(60);
    expect(row.reservedCredits + row.spentCredits).toBeLessThanOrEqual(row.budgetCredits);
  });

  it("CONCURRENCY: many racing reservations never overshoot the budget in the DB", async () => {
    await seedRun({ budgetCredits: 100 });

    const results = await Promise.all(Array.from({ length: 12 }, () => reserveWorkflowCredits(RUN, 10)));

    const won = results.filter(Boolean).length;
    expect(won).toBe(10); // 12 tried, budget fits exactly 10
    const row = await read();
    expect(row.reservedCredits).toBe(100);
    expect(row.reservedCredits + row.spentCredits).toBeLessThanOrEqual(row.budgetCredits);
  });

  it("settle releases the estimate and books real cost, so an overshoot estimate strands nothing", async () => {
    await reserveWorkflowCredits(RUN, 40);
    await settleWorkflowCredits(RUN, 40, 12);

    const row = await read();
    expect(row.reservedCredits).toBe(0);
    expect(row.spentCredits).toBe(12);

    // And the released headroom is genuinely reusable afterwards.
    expect(await reserveWorkflowCredits(RUN, 88)).toBe(true);
  });
});
