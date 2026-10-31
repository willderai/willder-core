// A member with no org-root grant may still start a scope-less QA run, because
// POST /api/agents/:id/run-interactive only checks a scope when one is given. The run's
// brief is stored at the org root, so a stream that checks the brief's scope answers that
// member 404 for the run they just started, and every reconnect writes another deny row.
// The start route and the stream must agree on who may follow a run.
//
// Real Postgres 16 with ltree and the real access evaluator; authentication and the
// run loop are mocked. Set QA_DATABASE_URL to an isolated test database.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "scopelessstart";
const ROOT = `org_${ORG}`;
const SALES = `${ROOT}.sales`;
const MEMBER = "u-sls-sales"; // read on sales only, the default member posture plus one grant

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/services/agents/run-loop", async (orig) => ({
  ...(await orig<typeof import("@/services/agents/run-loop")>()),
  driveRun: vi.fn(async () => {}),
  subscribeRun: vi.fn(() => () => {}),
}));

describe.skipIf(!QA_URL)("starting and following a scope-less QA run", () => {
  let db: PrismaClient;
  let agentId: string;

  async function clear() {
    await db.agentRunEvent.deleteMany({ where: { run: { orgId: ORG } } });
    await db.agentRun.deleteMany({ where: { orgId: ORG } });
    for (const t of ["agent", "auditLog", "brief", "grant", "scope", "user"] as const) {
      await (db[t] as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where: { orgId: ORG } });
    }
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    const { requireAccessContext } = await import("@/lib/access-context");
    vi.mocked(requireAccessContext).mockResolvedValue({
      org: { id: ORG },
      user: { id: MEMBER },
      ctx: { orgId: ORG, actor: { type: "human", id: MEMBER, role: "member" } },
    } as never);
  });

  beforeEach(async () => {
    await clear();
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    const sales = await db.scope.create({ data: { orgId: ORG, path: SALES, name: "sales" } });
    await db.user.create({
      data: { id: MEMBER, orgId: ORG, email: `${MEMBER}@qa.test`, role: "member", clerkId: `c-${MEMBER}` },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: sales.id, granteeType: "user", granteeId: MEMBER, permission: "read" },
    });
    agentId = (await db.agent.create({ data: { orgId: ORG, agentKey: "qa", name: "qa", role: "qa" } })).id;
  });

  afterAll(async () => {
    await clear();
    await db.$disconnect();
  });

  it("does not let a member start a run whose stream will refuse them", async () => {
    const { POST } = await import("@/app/api/agents/[id]/run-interactive/route");
    const { GET } = await import("@/app/api/runs/[runId]/stream/route");

    const start = await POST(
      new Request("http://t/api/agents/x/run-interactive", {
        method: "POST",
        body: JSON.stringify({ target: { baseUrl: "https://example.com" } }),
      }),
      { params: Promise.resolve({ id: agentId }) },
    );

    if (start.status === 201) {
      const { runId } = (await start.json()) as { runId: string };
      const follow = await GET(new Request(`http://t/api/runs/${runId}/stream`), {
        params: Promise.resolve({ runId }),
      });
      // Started is fine only if the starter can then follow the run.
      expect(follow.status).toBe(200);
    } else {
      expect(start.status).toBe(403);
    }
  });
});
