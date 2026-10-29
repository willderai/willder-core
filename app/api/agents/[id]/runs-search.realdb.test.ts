// GET /api/agents/:id/runs with a search, a status filter and an order: a caller
// gets, and counts, only runs whose scope they can read. A run they cannot read is
// never returned, never counted in `total`, never shortens a page, and its secrets
// (the starter's prompt, the QA target's credential) are never searchable. Past the
// first page, `nextCursor` walks every readable run exactly once.
//
// Runs the shipping route against a real Postgres with ltree and the real access
// evaluator. Authentication is mocked. Set QA_DATABASE_URL to an isolated test
// database (never the inherited DATABASE_URL); the suite skips without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "runsearch";
const OTHER_ORG = "runsearchother";
const ROOT = `org_${ORG}`;
const SALES = `${ROOT}.sales`;
const ENG = `${ROOT}.eng`;

const SALES_READER = "u-rsr-sales";
const ROOT_READER = "u-rsr-root";
const REVOKED = "u-rsr-revoked";
const OUTSIDER = "u-rsr-outsider";

const SECRET_PROMPT = "Renewal floor is 160k";
const CREDENTIAL = "Bearer qa-target-secret";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

type ListHandler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
type Listed = { runs: { id: string; status: string }[]; total: number; nextCursor: string | null };

describe.skipIf(!QA_URL)("the run list's search and filters never reach runs the caller cannot read", () => {
  let db: PrismaClient;
  let requireAccessContext: ReturnType<typeof vi.fn>;
  let list: ListHandler;
  let agentId: string;
  let minutesAgo = 1000;

  function actAs(orgId: string, userId: string) {
    requireAccessContext.mockResolvedValue({
      org: { id: orgId },
      user: { id: userId },
      ctx: { orgId, actor: { type: "human", id: userId, role: "member" } },
    } as never);
  }

  async function listed(query = ""): Promise<Listed> {
    const res = await list(new Request(`http://t/api/agents/${agentId}/runs?${query}`), {
      params: Promise.resolve({ id: agentId }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Listed;
  }

  /** A run at `scope` (scope-less when undefined), each one newer than the last. */
  async function run(
    scope: string | undefined,
    status: "running" | "completed" | "failed",
    names: Record<string, string>,
  ) {
    const meta = {
      prompt: SECRET_PROMPT,
      target: { baseUrl: "https://example.com", authHeader: CREDENTIAL },
      ...names,
      ...(scope === undefined ? {} : { scopePath: scope }),
    };
    minutesAgo -= 1;
    const created = await db.agentRun.create({
      data: { orgId: ORG, agentId, status, meta, startedAt: new Date(Date.now() - minutesAgo * 60_000) },
    });
    return created.id;
  }

  async function clear() {
    for (const org of [ORG, OTHER_ORG]) {
      await db.agentRunEvent.deleteMany({ where: { run: { orgId: org } } });
      await db.agentRun.deleteMany({ where: { orgId: org } });
      for (const t of ["agent", "auditLog", "grant", "scope", "user"] as const) {
        await (db[t] as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where: { orgId: org } });
      }
      await db.org.deleteMany({ where: { id: org } });
    }
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    requireAccessContext = vi.mocked((await import("@/lib/access-context")).requireAccessContext);
    list = (await import("@/app/api/agents/[id]/runs/route")).GET;
  });

  beforeEach(async () => {
    await clear();
    minutesAgo = 1000;
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.org.create({ data: { id: OTHER_ORG, name: OTHER_ORG } });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    const sales = await db.scope.create({ data: { orgId: ORG, path: SALES, name: "sales" } });
    await db.scope.create({ data: { orgId: ORG, path: ENG, name: "eng" } });
    const grants: [string, string, Date | null][] = [
      [SALES_READER, sales.id, null],
      [ROOT_READER, root.id, null],
      [REVOKED, sales.id, new Date(Date.now() - 60_000)],
    ];
    for (const [userId, scopeId, expiresAt] of grants) {
      await db.user.create({
        data: { id: userId, orgId: ORG, email: `${userId}@qa.test`, role: "member", clerkId: `c-${userId}` },
      });
      await db.grant.create({
        data: { orgId: ORG, scopeId, granteeType: "user", granteeId: userId, permission: "read", expiresAt },
      });
    }
    await db.user.create({
      data: { id: OUTSIDER, orgId: OTHER_ORG, email: `${OUTSIDER}@qa.test`, role: "member", clerkId: `c-${OUTSIDER}` },
    });
    agentId = (await db.agent.create({ data: { orgId: ORG, agentKey: "copy", name: "copy", role: "copy" } })).id;
  });

  afterAll(async () => {
    await clear();
    await db.$disconnect();
  });

  it("a search lists and counts only the matching runs the caller can read", async () => {
    const salesRenewal = await run(SALES, "completed", { campaignName: "Acme renewal" });
    const salesPilot = await run(SALES, "failed", { campaignName: "Acme pilot" });
    const engExpansion = await run(ENG, "failed", { campaignName: "Acme expansion" });
    await run(SALES, "completed", { campaignName: "Globex intro" });

    actAs(ORG, SALES_READER);
    const sales = await listed("q=acme");
    expect(sales.runs.map((r) => r.id)).toEqual([salesPilot, salesRenewal]);
    expect(sales.total).toBe(2);

    actAs(ORG, ROOT_READER);
    const root = await listed("q=ACME");
    expect(root.runs.map((r) => r.id)).toEqual([engExpansion, salesPilot, salesRenewal]);
    expect(root.total).toBe(3);
  });

  it("a status filter lists and counts only readable runs with that status", async () => {
    const salesFailed = await run(SALES, "failed", { campaignName: "a" });
    await run(SALES, "completed", { campaignName: "b" });
    await run(ENG, "failed", { campaignName: "c" });
    await run(undefined, "failed", { campaignName: "d" });

    actAs(ORG, SALES_READER);
    expect(await listed("status=failed")).toEqual({
      runs: [expect.objectContaining({ id: salesFailed })],
      total: 1,
      nextCursor: null,
    });

    actAs(ORG, ROOT_READER);
    expect((await listed("status=failed")).total).toBe(3);

    actAs(ORG, REVOKED);
    expect(await listed("status=failed")).toEqual({ runs: [], total: 0, nextCursor: null });
  });

  it("newer hidden runs never push a readable run off the page", async () => {
    const salesFailed = await run(SALES, "failed", { campaignName: "Acme pilot" });
    for (let i = 0; i < 5; i += 1) await run(ENG, "failed", { campaignName: `Acme hidden ${i}` });

    actAs(ORG, SALES_READER);
    expect(await listed("limit=1&status=failed&q=acme")).toEqual({
      runs: [expect.objectContaining({ id: salesFailed })],
      total: 1,
      nextCursor: null,
    });
  });

  it("the starter's prompt and the QA credential are not searchable, even by a root reader", async () => {
    await run(SALES, "completed", { campaignName: "Acme renewal" });
    actAs(ORG, ROOT_READER);
    for (const secret of ["160k", "qa-target-secret", "example.com", "Renewal floor"]) {
      expect(await listed(`q=${encodeURIComponent(secret)}`)).toEqual({ runs: [], total: 0, nextCursor: null });
    }
  });

  it("matches contact and prospect names, and treats % and _ as literal characters", async () => {
    const testRun = await run(SALES, "completed", { type: "test-run", contactName: "Dana Ruiz" });
    const prospect = await run(SALES, "completed", { campaignName: "Q4", prospectContactName: "Lee_Park" });

    actAs(ORG, SALES_READER);
    expect((await listed("q=dana")).runs.map((r) => r.id)).toEqual([testRun]);
    expect((await listed("q=lee_park")).runs.map((r) => r.id)).toEqual([prospect]);
    expect(await listed("q=%25")).toEqual({ runs: [], total: 0, nextCursor: null });
    expect(await listed("q=Lee%25Park")).toEqual({ runs: [], total: 0, nextCursor: null });
    expect(await listed("q=Lee_Pa_k")).toEqual({ runs: [], total: 0, nextCursor: null });
  });

  it("orders oldest first on request", async () => {
    const first = await run(SALES, "completed", { campaignName: "a" });
    const second = await run(SALES, "completed", { campaignName: "b" });
    actAs(ORG, SALES_READER);
    expect((await listed("order=asc")).runs.map((r) => r.id)).toEqual([first, second]);
    expect((await listed()).runs.map((r) => r.id)).toEqual([second, first]);
  });

  it("never returns a credential in a searched page", async () => {
    await run(SALES, "completed", { campaignName: "Acme renewal" });
    actAs(ORG, ROOT_READER);
    const body = JSON.stringify(await listed("q=acme"));
    expect(body).toContain("Acme renewal");
    expect(body).not.toContain(CREDENTIAL);
  });

  /** Every page of a view, following `nextCursor` until the route says it is the last. */
  async function walk(query: string): Promise<{ ids: string[]; totals: number[]; pages: number }> {
    const ids: string[] = [];
    const totals: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await listed(cursor ? `${query}&cursor=${encodeURIComponent(cursor)}` : query);
      ids.push(...page.runs.map((r) => r.id));
      totals.push(page.total);
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 50);
    return { ids, totals, pages };
  }

  it("a cursor walks every readable run exactly once, past the first page, in both orders", async () => {
    // Three readable runs share one start time, so only the id tie-break keeps a
    // page boundary from skipping or repeating one; hidden runs sit between them.
    const tie = new Date(Date.now() - 500 * 60_000);
    const readable: { id: string; startedAt: Date }[] = [];
    for (let i = 0; i < 7; i += 1) {
      const startedAt = i < 3 ? tie : new Date(tie.getTime() + i * 60_000);
      const created = await db.agentRun.create({
        data: {
          orgId: ORG,
          agentId,
          status: "completed",
          meta: { scopePath: SALES, campaignName: `Acme ${i}` },
          startedAt,
        },
      });
      readable.push({ id: created.id, startedAt });
      await db.agentRun.create({
        data: {
          orgId: ORG,
          agentId,
          status: "completed",
          meta: { scopePath: ENG, campaignName: `Acme hidden ${i}` },
          startedAt,
        },
      });
    }
    const byTimeThenId = (a: { id: string; startedAt: Date }, b: { id: string; startedAt: Date }) =>
      a.startedAt.getTime() - b.startedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const oldestFirst = [...readable].sort(byTimeThenId).map((r) => r.id);

    actAs(ORG, SALES_READER);
    const newest = await walk("limit=2");
    expect(newest.ids).toEqual([...oldestFirst].reverse());
    expect(newest.pages).toBe(4);
    expect(new Set(newest.totals)).toEqual(new Set([7]));

    const oldest = await walk("limit=2&order=asc&q=acme");
    expect(oldest.ids).toEqual(oldestFirst);
    expect(new Set(oldest.totals)).toEqual(new Set([7]));

    actAs(ORG, ROOT_READER);
    expect((await walk("limit=3")).ids).toHaveLength(14);
  });

  it("refuses a cursor it did not issue", async () => {
    await run(SALES, "completed", { campaignName: "a" });
    actAs(ORG, SALES_READER);
    for (const cursor of [
      "nonsense",
      "2026-10-01T00:00:00.000Z_",
      "_abc",
      "not-a-date_abc",
      "2026-10-01T00:00:00.000Z_a'b",
    ]) {
      const res = await list(new Request(`http://t/api/agents/${agentId}/runs?cursor=${encodeURIComponent(cursor)}`), {
        params: Promise.resolve({ id: agentId }),
      });
      expect(res.status).toBe(400);
    }
  });

  it("a member of another org cannot list the agent at all", async () => {
    await run(SALES, "failed", { campaignName: "Acme pilot" });
    actAs(OTHER_ORG, OUTSIDER);
    const res = await list(new Request(`http://t/api/agents/${agentId}/runs?q=acme`), {
      params: Promise.resolve({ id: agentId }),
    });
    expect(res.status).toBe(404);
  });
});
