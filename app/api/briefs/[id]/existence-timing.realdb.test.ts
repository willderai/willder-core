// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// existence-oracle.realdb.test.ts proves a hidden brief and an absent id get the
// same status and body. This file proves they also take the same time. Before
// the absent path did the same authorization work as the hidden one, an absent
// id answered in about 0.8 ms and a hidden brief in about 3 ms (local Postgres,
// n=300), so a member with no grant could still tell which brief ids are real by
// timing the 404.
//
// Each route is called with the hidden id and the absent id in back-to-back
// pairs, so drift in the machine's load lands on both sides alike, and the
// median difference per pair is compared with a bound. Only authentication is
// mocked; the route handlers, the access evaluator and the audit writes are the
// shipping ones, against real Postgres.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-brief-timing";
const BRIEF_SCOPE = "org_bt.sales";
const SIBLING_SCOPE = "org_bt.engineering";
const BRIEF_ID = "brief-timing-1";
const RETIRED_ID = "brief-timing-retired"; // withdrawn by a disconnected source
const ABSENT_ID = "brief-timing-never-issued";
const SIBLING = "u-bt-sibling"; // read on a sibling scope only

const WARMUP = 20;
const SAMPLES = 150;

/**
 * The largest median difference allowed between a hidden and an absent call: a
 * tenth of the median call, and never under 0.2 ms. The gap this closes was
 * about 2.5 ms on a median of 3.5 ms, and one extra indexed query costs about
 * 0.5 ms, so the bound catches either; measured noise after the fix stayed
 * under 5% of the median. Relative rather than fixed, so a loaded CI runner where every call is
 * several times slower does not fail on noise alone.
 */
function allowedGapMs(medianCallMs: number): number {
  return Math.max(0.2, medianCallMs / 10);
}

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

describe.skipIf(!QA_URL)("brief routes take as long to refuse a hidden brief as an absent id", () => {
  let db: PrismaClient;
  const routes: Record<string, { handler: Handler; method: string; body?: unknown }> = {};

  async function timeCall(name: string, id: string): Promise<number> {
    const { handler, method, body } = routes[name];
    const req = new Request(`http://t/api/briefs/${id}/${name}`, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const started = performance.now();
    const res = await handler(req, { params: Promise.resolve({ id }) });
    await res.text();
    const elapsed = performance.now() - started;
    expect(res.status).toBe(404);
    return elapsed;
  }

  async function clearTenant() {
    for (const table of ["auditLog", "brief", "grant", "scope", "source", "user"] as const) {
      await (db[table] as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where: { orgId: ORG } });
    }
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });

    routes.read = { handler: (await import("./route")).GET, method: "GET" };
    routes.staleness = { handler: (await import("./staleness/route")).GET, method: "GET" };
    routes.acknowledge = { handler: (await import("./acknowledge/route")).POST, method: "POST" };
    routes["export-doc"] = { handler: (await import("./export-doc/route")).POST, method: "POST", body: { token: "t" } };
    routes.persist = { handler: (await import("./persist/route")).POST, method: "POST" };
    routes.correct = { handler: (await import("./correct/route")).POST, method: "POST", body: { correction: "c" } };
    routes.retirement = { handler: (await import("./retirement/route")).DELETE, method: "DELETE" };

    await clearTenant();
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.scope.create({ data: { orgId: ORG, path: BRIEF_SCOPE, name: "sales" } });
    const siblingScope = await db.scope.create({ data: { orgId: ORG, path: SIBLING_SCOPE, name: "engineering" } });
    await db.brief.create({
      data: {
        id: BRIEF_ID,
        orgId: ORG,
        type: "handoff",
        scopePath: BRIEF_SCOPE,
        title: "t",
        summary: "s",
        sections: {},
      },
    });
    await db.brief.create({
      data: {
        id: RETIRED_ID,
        orgId: ORG,
        type: "handoff",
        scopePath: BRIEF_SCOPE,
        title: "t",
        summary: "s",
        sections: {},
      },
    });
    await db.briefRetirement.create({
      data: { briefId: RETIRED_ID, sourceId: "source-gone", reason: "source_disconnected" },
    });
    await db.user.create({
      data: { id: SIBLING, orgId: ORG, email: `${SIBLING}@qa.test`, role: "member", clerkId: `clerk-${SIBLING}` },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: siblingScope.id, granteeType: "user", granteeId: SIBLING, permission: "read" },
    });

    const { requireAccessContext } = (await import("@/lib/access-context")) as never as {
      requireAccessContext: ReturnType<typeof vi.fn>;
    };
    requireAccessContext.mockResolvedValue({
      org: { id: ORG },
      user: { id: SIBLING },
      ctx: { orgId: ORG, actor: { type: "human", id: SIBLING, role: "member" } },
    } as never);
  });

  afterAll(async () => {
    await clearTenant();
    await db.$disconnect();
  });

  /**
   * Time `name` on `hiddenId` and on an absent id in back-to-back pairs, and
   * compare them by the median of the per-pair differences. Each pair runs under
   * the same machine load, so the difference cancels noise both calls share; on
   * a busy runner the two sides' own medians can land on different modes of a
   * noisy distribution even when neither path is slower.
   */
  async function expectSameTime(name: string, hiddenId: string) {
    for (let i = 0; i < WARMUP; i++) {
      await timeCall(name, hiddenId);
      await timeCall(name, ABSENT_ID);
    }
    const differences: number[] = [];
    const all: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      // Alternate which goes first, so neither side always runs on a warmer pool.
      let hiddenMs: number;
      let absentMs: number;
      if (i % 2) {
        hiddenMs = await timeCall(name, hiddenId);
        absentMs = await timeCall(name, ABSENT_ID);
      } else {
        absentMs = await timeCall(name, ABSENT_ID);
        hiddenMs = await timeCall(name, hiddenId);
      }
      differences.push(hiddenMs - absentMs);
      all.push(hiddenMs, absentMs);
    }
    const gap = median(differences);
    const bound = allowedGapMs(median(all));
    console.info(
      `${name} ${hiddenId}: hidden minus absent ${gap.toFixed(2)} ms, median call ${median(all).toFixed(2)} ms, bound ${bound.toFixed(2)} ms`,
    );
    expect(Math.abs(gap), `hidden minus absent, median per pair: ${gap.toFixed(2)} ms`).toBeLessThanOrEqual(bound);
  }

  it.each(["read", "staleness", "acknowledge", "export-doc", "persist", "correct", "retirement"])(
    "%s: the median refusal time does not depend on whether the brief exists",
    (name) => expectSameTime(name, BRIEF_ID),
    60_000,
  );

  // The only route that finds withdrawn briefs, and it answers a retired one
  // with a 404 even to a caller who can read its scope.
  it(
    "retirement: a retired brief takes as long to refuse as an absent id",
    () => expectSameTime("retirement", RETIRED_ID),
    60_000,
  );
});
