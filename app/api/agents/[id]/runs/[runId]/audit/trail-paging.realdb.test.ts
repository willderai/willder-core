// GET /api/agents/:id/runs/:runId/audit a page at a time: a run's memory trail is
// read RUN_TRAIL_PAGE_SIZE rows per request, oldest first, and following `endCursor`
// returns every row of the run's window exactly once, including rows written in the
// same millisecond, and never a row of another actor or outside the window.
//
// Runs the shipping route against a real Postgres with the real access evaluator.
// Authentication is mocked. Set QA_DATABASE_URL to an isolated test database (never
// the inherited DATABASE_URL); the suite skips without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { RUN_TRAIL_PAGE_SIZE } from "@/lib/agent-lists";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "trailpaging";
const ROOT = `org_${ORG}`;
const ADMIN = "u-trail-admin";
const AGENT_KEY = "qa-agent";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

type Handler = (req: Request, ctx: { params: Promise<{ id: string; runId: string }> }) => Promise<Response>;
type Trail = { entries: { id: string; at: string }[]; hasMore: boolean; endCursor: string | null };

describe.skipIf(!QA_URL)("a run's memory trail is paged by cursor", { timeout: 60_000 }, () => {
  let db: PrismaClient;
  let GET: Handler;
  let agentId: string;
  let runId: string;
  const started = new Date(Date.now() - 60 * 60_000);

  async function trail(cursor: string | null): Promise<Trail> {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const res = await GET(new Request(`http://t/api/agents/${agentId}/runs/${runId}/audit${query}`), {
      params: Promise.resolve({ id: agentId, runId }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Trail;
  }

  /**
   * Audit rows by the given actor, at `started` plus each offset in milliseconds. Ids
   * descend in insertion order, so a query that orders a tie by anything but id (its
   * physical order, say) disagrees with the expected order.
   */
  async function rows(actorId: string, offsets: number[]): Promise<{ id: string; at: Date }[]> {
    const data = offsets.map((ms, i) => ({
      id: `${actorId}-${String(offsets.length - i).padStart(4, "0")}`,
      orgId: ORG,
      actorType: "agent",
      actorId,
      action: "memory.read",
      target: `${ROOT}:query`,
      decision: "allow" as const,
      at: new Date(started.getTime() + ms),
    }));
    await db.auditLog.createMany({ data });
    return db.auditLog.findMany({
      where: { orgId: ORG, actorId, at: { in: data.map((d) => d.at) } },
      select: { id: true, at: true },
    });
  }

  async function clear() {
    await db.agentRun.deleteMany({ where: { orgId: ORG } });
    for (const t of ["agent", "grant", "scope", "user"] as const) {
      await (db[t] as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where: { orgId: ORG } });
    }
    // Audit rows are append-only; they go with their org.
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    const requireAccessContext = vi.mocked((await import("@/lib/access-context")).requireAccessContext);
    requireAccessContext.mockResolvedValue({
      org: { id: ORG },
      user: { id: ADMIN },
      ctx: { orgId: ORG, actor: { type: "human", id: ADMIN, role: "member" } },
    } as never);
    GET = (await import("./route")).GET;
  });

  beforeEach(async () => {
    await clear();
    await db.org.create({ data: { id: ORG, name: ORG } });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: `${ADMIN}@qa.test`, role: "member", clerkId: `c-${ADMIN}` },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    agentId = (await db.agent.create({ data: { orgId: ORG, agentKey: AGENT_KEY, name: "QA", role: "qa" } })).id;
    runId = (
      await db.agentRun.create({
        data: {
          orgId: ORG,
          agentId,
          status: "completed",
          meta: {},
          startedAt: started,
          finishedAt: new Date(started.getTime() + 60_000),
        },
      })
    ).id;
  });

  afterAll(async () => {
    await clear();
    await db.$disconnect();
  });

  it("returns every row of the window once, in order, across pages that split same-millisecond rows", async () => {
    // Groups of three rows share a millisecond; the page size is not a multiple of
    // three, so page boundaries fall inside a tie.
    expect(RUN_TRAIL_PAGE_SIZE % 3).not.toBe(0);
    const total = 2 * RUN_TRAIL_PAGE_SIZE + 7;
    const own = await rows(
      AGENT_KEY,
      Array.from({ length: total }, (_, i) => 1 + Math.floor(i / 3)),
    );
    // Another actor inside the window, and this actor outside it: neither belongs.
    await rows("copy-agent", [10, 20]);
    await db.auditLog.createMany({
      data: [-5_000, 120_000].map((ms) => ({
        orgId: ORG,
        actorType: "agent",
        actorId: AGENT_KEY,
        action: "memory.read",
        target: `${ROOT}:query`,
        decision: "allow" as const,
        at: new Date(started.getTime() + ms),
      })),
    });

    const seen: string[] = [];
    const sizes: number[] = [];
    let cursor: string | null = null;
    let page: Trail;
    do {
      page = await trail(cursor);
      seen.push(...page.entries.map((e) => e.id));
      sizes.push(page.entries.length);
      cursor = page.endCursor;
    } while (page.hasMore && sizes.length < 10);

    const expected = [...own]
      .sort((a, b) => a.at.getTime() - b.at.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((r) => r.id);
    expect(sizes).toEqual([RUN_TRAIL_PAGE_SIZE, RUN_TRAIL_PAGE_SIZE, 7]);
    expect(seen).toEqual(expected);

    // A live trail polls from its last row: nothing new reads as an empty page that keeps its place.
    const after = await trail(cursor);
    expect(after).toMatchObject({ entries: [], hasMore: false, endCursor: null });
  });
});
