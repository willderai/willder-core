// QA for GET /api/agents/:id/runs/:runId/audit paging, against a real Postgres:
//
//   1. A withheld trail (another agent shares the copy-agent identity in the window)
//      never offers a way past its empty page: no `hasMore`, no `endCursor`, with or
//      without a cursor, however many rows the window holds.
//   2. A live trail re-read from its last page's start shows a row that committed
//      late with an earlier time than rows already shown, in (at, id) order. That is
//      the contract RunMemoryTrail's poll relies on.
//   3. The trail query itself reads at most the page it is asked for, so a long
//      trail is never pulled whole and sliced in the route.
//
// Authentication is mocked; the access evaluator, the SQL and the route are real. Set
// QA_DATABASE_URL to an isolated test database; the suite skips without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { COPY_AGENT_ID } from "@/services/access/system-actors";
import { RUN_TRAIL_PAGE_SIZE } from "@/lib/agent-lists";
import { encodeListCursor } from "@/lib/list-cursor";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "trailpagingqa";
const ROOT = `org_${ORG}`;
const ADMIN = "u-trailqa-admin";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

type Handler = (req: Request, ctx: { params: Promise<{ id: string; runId: string }> }) => Promise<Response>;
type Trail = {
  entries: { id: string; at: string }[];
  hasMore: boolean;
  endCursor: string | null;
  entriesSuppressed: boolean;
};

describe.skipIf(!QA_URL)("run memory trail paging, QA", { timeout: 60_000 }, () => {
  let db: PrismaClient;
  let GET: Handler;
  const started = new Date(Date.now() - 60 * 60_000);

  async function trail(agentId: string, runId: string, cursor: string | null): Promise<Trail> {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const res = await GET(new Request(`http://t/api/agents/${agentId}/runs/${runId}/audit${query}`), {
      params: Promise.resolve({ id: agentId, runId }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Trail;
  }

  async function auditRows(actorId: string, offsets: number[], prefix: string) {
    await db.auditLog.createMany({
      data: offsets.map((ms, i) => ({
        id: `${prefix}-${String(i).padStart(4, "0")}`,
        orgId: ORG,
        actorType: "agent",
        actorId,
        action: "memory.read",
        target: `${ROOT}:query`,
        decision: "allow" as const,
        at: new Date(started.getTime() + ms),
      })),
    });
  }

  async function agentWithRun(agentKey: string, role: string, finished: boolean) {
    const agent = await db.agent.create({ data: { orgId: ORG, agentKey, name: agentKey, role: role as never } });
    const run = await db.agentRun.create({
      data: {
        orgId: ORG,
        agentId: agent.id,
        status: finished ? "completed" : "running",
        meta: {},
        startedAt: started,
        finishedAt: finished ? new Date(started.getTime() + 60_000) : null,
      },
    });
    return { agentId: agent.id, runId: run.id };
  }

  async function clear() {
    await db.agentRun.deleteMany({ where: { orgId: ORG } });
    for (const t of ["agent", "grant", "scope", "user"] as const) {
      await (db[t] as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where: { orgId: ORG } });
    }
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
  });

  afterAll(async () => {
    await clear();
    await db.$disconnect();
  });

  it("a withheld trail longer than a page offers no next page, with or without a cursor", async () => {
    // Two custom agents run at once: both are audited as the copy agent, so neither
    // trail can be told apart from the other and both are withheld.
    const viewed = await agentWithRun("custom-qa-a", "custom", true);
    await agentWithRun("custom-qa-b", "custom", true);
    await auditRows(
      COPY_AGENT_ID,
      Array.from({ length: RUN_TRAIL_PAGE_SIZE + 5 }, (_, i) => 1 + i),
      "trailqa-w",
    );

    const first = await trail(viewed.agentId, viewed.runId, null);
    expect(first).toMatchObject({ entries: [], hasMore: false, endCursor: null, entriesSuppressed: true });

    // A cursor a client kept from before the trail was withheld reads nothing either.
    const kept = encodeListCursor({ at: new Date(started.getTime() + 1), id: "trailqa-w-0000" });
    const resumed = await trail(viewed.agentId, viewed.runId, kept);
    expect(resumed).toMatchObject({ entries: [], hasMore: false, endCursor: null, entriesSuppressed: true });
  });

  it("re-reading a live trail's last page from its start shows a late row with an earlier time", async () => {
    const live = await agentWithRun("qa-live", "qa", false);
    await auditRows(
      "qa-live",
      Array.from({ length: RUN_TRAIL_PAGE_SIZE + 5 }, (_, i) => 10 * (i + 1)),
      "trailqa-l",
    );

    const first = await trail(live.agentId, live.runId, null);
    expect(first.entries).toHaveLength(RUN_TRAIL_PAGE_SIZE);
    expect(first.hasMore).toBe(true);
    const lastPageStart = first.endCursor;

    const last = await trail(live.agentId, live.runId, lastPageStart);
    expect(last.entries).toHaveLength(5);
    expect(last.hasMore).toBe(false);

    // A row that committed after the read, timed between rows already on the last page.
    const lateAt = new Date(new Date(last.entries[1].at).getTime() + 5);
    await db.auditLog.create({
      data: {
        id: "trailqa-late",
        orgId: ORG,
        actorType: "agent",
        actorId: "qa-live",
        action: "memory.write",
        target: `${ROOT}:fact`,
        decision: "allow",
        at: lateAt,
      },
    });

    // Tailing from the last row shown never sees it: that is why the poll re-reads.
    const tail = await trail(live.agentId, live.runId, last.endCursor);
    expect(tail.entries.map((e) => e.id)).not.toContain("trailqa-late");

    const reread = await trail(live.agentId, live.runId, lastPageStart);
    expect(reread.entries.map((e) => e.id)).toEqual([
      last.entries[0].id,
      last.entries[1].id,
      "trailqa-late",
      ...last.entries.slice(2).map((e) => e.id),
    ]);
  });

  it("the trail query reads at most the rows it is asked for", async () => {
    await auditRows(
      "qa-limit",
      Array.from({ length: 12 }, (_, i) => 1 + i),
      "trailqa-n",
    );
    const { queryRunAuditEntries } = await import("@/services/access/audit-query");
    const window = { orgId: ORG, actorId: "qa-limit", from: started, to: new Date(started.getTime() + 60_000) };

    const page = await queryRunAuditEntries({ ...window, limit: 5 });
    expect(page.map((e) => e.id)).toEqual([
      "trailqa-n-0000",
      "trailqa-n-0001",
      "trailqa-n-0002",
      "trailqa-n-0003",
      "trailqa-n-0004",
    ]);

    const next = await queryRunAuditEntries({ ...window, limit: 5, after: { at: page[4].at, id: page[4].id } });
    expect(next.map((e) => e.id)).toEqual([
      "trailqa-n-0005",
      "trailqa-n-0006",
      "trailqa-n-0007",
      "trailqa-n-0008",
      "trailqa-n-0009",
    ]);
  });
});
