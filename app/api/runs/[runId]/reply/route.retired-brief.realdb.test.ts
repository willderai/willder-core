// A reply to a finished run must not reseed the follow-up from a retired brief.
//
// POST /api/runs/:runId/reply folds the prior run's brief summary into the new
// manager run's context. brief-retirement.ts withdraws a brief whose source was
// moved out of its scope or disconnected, and every brief read adds NOT_RETIRED;
// without it here the withdrawn content would flow straight back into a new run.
// Removing NOT_RETIRED from route.ts turns the "retired" case red.
//
// Real Postgres 16 with ltree; authentication, check() and the manager engine
// are faked. Set QA_DATABASE_URL to an isolated test database; the suite skips
// without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-reply-retired";
const SCOPE = "org_rr.engineering";
const USER = "u-rr-member";
const AGENT = "agent-rr-qa";
const RUN = "run-rr-prev";
const BRIEF_ID = "rr-brief";
const SECRET = "3 endpoints failed under load at the $160k tier.";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/services/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/access")>()),
  check: vi.fn(async () => ({ allowed: true, reason: "ok" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));
vi.mock("@/services/agents/manager", () => ({
  createQaManagerRun: vi.fn(async () => "run-rr-new"),
  createArchManagerRun: vi.fn(),
  driveManager: vi.fn(),
}));

describe.skipIf(!QA_URL)("POST /api/runs/:runId/reply: a retired prior brief", () => {
  let db: PrismaClient;
  let POST: (typeof import("./route"))["POST"];
  let createQaManagerRun: ReturnType<typeof vi.fn>;

  const reply = () =>
    POST(
      new Request(`http://t/api/runs/${RUN}/reply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "also check rate limits" }),
      }),
      { params: Promise.resolve({ runId: RUN }) },
    );

  async function clear() {
    for (const table of ["agentRun", "agent", "brief", "user"] as const) {
      await (db[table] as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where: { orgId: ORG } });
    }
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ POST } = await import("./route"));
    ({ createQaManagerRun } = (await import("@/services/agents/manager")) as never);
    const { requireAccessContext } = (await import("@/lib/access-context")) as never as {
      requireAccessContext: ReturnType<typeof vi.fn>;
    };
    requireAccessContext.mockResolvedValue({
      org: { id: ORG },
      user: { id: USER, role: "member" },
      ctx: { orgId: ORG, actor: { type: "human", id: USER, role: "member" } },
    } as never);
  });

  beforeEach(async () => {
    createQaManagerRun.mockClear();
    await clear();
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.user.create({
      data: { id: USER, orgId: ORG, email: `${USER}@qa.test`, role: "member", clerkId: `clerk-${USER}` },
    });
    await db.agent.create({ data: { id: AGENT, orgId: ORG, agentKey: "qa", name: "QA", role: "qa" } });
    await db.brief.create({
      data: {
        id: BRIEF_ID,
        orgId: ORG,
        type: "qa_review",
        scopePath: SCOPE,
        title: "QA report",
        summary: SECRET,
        sections: [],
      },
    });
    await db.agentRun.create({
      data: {
        id: RUN,
        orgId: ORG,
        agentId: AGENT,
        phase: "done",
        briefId: BRIEF_ID,
        meta: {
          type: "qa-interactive",
          agentRole: "qa",
          target: { baseUrl: "https://api.acme.test" },
          scopePath: SCOPE,
        },
      },
    });
  });

  afterAll(async () => {
    await clear();
    await db.$disconnect();
  });

  const seededFocus = () => (createQaManagerRun.mock.calls[0][0] as { focus: string }).focus;

  it("seeds the follow-up with the prior brief while it is not retired", async () => {
    expect((await reply()).status).toBe(201);
    expect(seededFocus()).toContain(SECRET);
  });

  it("leaves a retired brief out of the follow-up's context", async () => {
    await db.briefRetirement.create({
      data: { briefId: BRIEF_ID, sourceId: "src-gone", reason: "source_disconnected" },
    });
    expect((await reply()).status).toBe(201);
    expect(seededFocus()).not.toContain(SECRET);
    expect(seededFocus()).toContain("also check rate limits");
  });
});
