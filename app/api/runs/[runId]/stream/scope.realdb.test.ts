// GET /api/runs/:runId/stream sends a run's persisted events, and the `done` event
// carries the full brief the run produced. A caller must be able to read the run's
// scope and the brief's stored scope before anything is sent; one who cannot gets
// the same 404 as a run id that was never issued, so the stream is neither a way
// around GET /api/briefs/:id nor a probe for which runs exist. Once the brief is
// retired, the stream answers its readers the same way, as the brief route does.
//
// Runs the shipping route against a real Postgres 16 with ltree and the real access
// evaluator, two tenants and two scopes. Authentication and the live run loop are
// mocked. Set QA_DATABASE_URL to an isolated test database (never the inherited
// DATABASE_URL); the suite skips without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "streamscope"; // ltree-safe, so the org root path is a valid scope
const OTHER_ORG = "org-stream-scope-other";
const ROOT = `org_${ORG}`;
const SALES = `${ROOT}.sales`;
const ENG = `${ROOT}.eng`;
const SECRET = "Renewal floor is $160k";
const ABSENT_RUN = "run-never-issued";

const SALES_READER = "u-ss-sales";
const ENG_READER = "u-ss-eng";
const ROOT_READER = "u-ss-root";
const OUTSIDER = "u-ss-outsider"; // member of the other org

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/services/agents/run-loop", () => ({
  driveRun: vi.fn(async () => {}),
  subscribeRun: vi.fn(() => () => {}),
  isTerminalPhase: (phase: string | null | undefined) => phase === "done" || phase === "failed",
}));

type StreamHandler = (req: Request, ctx: { params: Promise<{ runId: string }> }) => Promise<Response>;

describe.skipIf(!QA_URL)("the run stream only replays to a caller who can read the run's scope", () => {
  let db: PrismaClient;
  let streamGET: StreamHandler;
  let requireAccessContext: ReturnType<typeof vi.fn>;
  let agentId: string;
  const scopeIds: Record<string, string> = {};

  function actAs(orgId: string, userId: string) {
    requireAccessContext.mockResolvedValue({
      org: { id: orgId },
      user: { id: userId },
      ctx: { orgId, actor: { type: "human", id: userId, role: "member" } },
    } as never);
  }

  async function stream(runId: string) {
    const res = await streamGET(new Request(`http://t/api/runs/${runId}/stream`), {
      params: Promise.resolve({ runId }),
    });
    return { status: res.status, body: await res.text() };
  }

  /** A finished run whose `done` event replays a brief holding SECRET. */
  async function finishedRun(opts: { runScope?: unknown; briefScope: string }) {
    const brief = await db.brief.create({
      data: { orgId: ORG, type: "handoff", scopePath: opts.briefScope, title: "deal", summary: SECRET, sections: {} },
    });
    const run = await db.agentRun.create({
      data: {
        orgId: ORG,
        agentId,
        status: "completed",
        phase: "done",
        briefId: brief.id,
        meta: opts.runScope === undefined ? { agentRole: "qa" } : { agentRole: "qa", scopePath: opts.runScope },
      },
    });
    await db.agentRunEvent.create({
      data: {
        runId: run.id,
        seq: 1,
        type: "done",
        payload: { seq: 1, type: "done", briefId: brief.id, brief: { summary: SECRET } },
      },
    });
    return run.id;
  }

  async function grant(userId: string, scope: string, expiresAt?: Date) {
    return db.grant.create({
      data: {
        orgId: ORG,
        scopeId: scopeIds[scope],
        granteeType: "user",
        granteeId: userId,
        permission: "read",
        expiresAt,
      },
    });
  }

  async function clearTenants() {
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.agentRunEvent.deleteMany({ where: { run: { orgId } } });
      await db.agentRun.deleteMany({ where: { orgId } });
      await db.briefRetirement.deleteMany({ where: { brief: { orgId } } });
      for (const table of ["agent", "auditLog", "brief", "grant", "scope", "user"] as const) {
        await (db[table] as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where: { orgId } });
      }
    }
    await db.org.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    streamGET = (await import("@/app/api/runs/[runId]/stream/route")).GET;
    requireAccessContext = (await import("@/lib/access-context")).requireAccessContext as unknown as ReturnType<
      typeof vi.fn
    >;
  });

  beforeEach(async () => {
    await clearTenants();
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.org.create({ data: { id: OTHER_ORG, name: OTHER_ORG } });
    for (const [path, name] of [
      [ROOT, "root"],
      [SALES, "sales"],
      [ENG, "eng"],
    ]) {
      scopeIds[path] = (await db.scope.create({ data: { orgId: ORG, path, name } })).id;
    }
    for (const id of [SALES_READER, ENG_READER, ROOT_READER]) {
      await db.user.create({
        data: { id, orgId: ORG, email: `${id}@qa.test`, role: "member", clerkId: `clerk-${id}` },
      });
    }
    await db.user.create({
      data: {
        id: OUTSIDER,
        orgId: OTHER_ORG,
        email: `${OUTSIDER}@qa.test`,
        role: "member",
        clerkId: `clerk-${OUTSIDER}`,
      },
    });
    await grant(SALES_READER, SALES);
    await grant(ENG_READER, ENG);
    await grant(ROOT_READER, ROOT);
    agentId = (await db.agent.create({ data: { orgId: ORG, agentKey: "qa", name: "qa", role: "qa" } })).id;
  });

  afterAll(async () => {
    await clearTenants();
    await db.$disconnect();
  });

  it("replays the brief to a reader of the run's scope", async () => {
    const runId = await finishedRun({ runScope: SALES, briefScope: SALES });
    actAs(ORG, SALES_READER);

    const res = await stream(runId);

    expect(res.status).toBe(200);
    expect(res.body).toContain(SECRET);
  });

  it("answers a reader of a sibling scope exactly as it answers an absent run", async () => {
    const runId = await finishedRun({ runScope: SALES, briefScope: SALES });
    actAs(ORG, ENG_READER);

    const hidden = await stream(runId);
    const absent = await stream(ABSENT_RUN);

    expect(hidden).toEqual({ status: 404, body: absent.body });
    expect(hidden.body).not.toContain(SECRET);
    const denial = await db.auditLog.findFirst({
      where: { orgId: ORG, actorId: ENG_READER, action: "memory.read", target: SALES, decision: "deny" },
    });
    expect(denial).not.toBeNull();
  });

  it("answers a member of another org exactly as it answers an absent run", async () => {
    const runId = await finishedRun({ runScope: SALES, briefScope: SALES });
    actAs(OTHER_ORG, OUTSIDER);

    expect(await stream(runId)).toEqual(await stream(ABSENT_RUN));
  });

  it("checks the brief's stored scope, not only the scope recorded on the run", async () => {
    const runId = await finishedRun({ runScope: ENG, briefScope: SALES });
    actAs(ORG, ENG_READER);

    const res = await stream(runId);

    expect(res.status).toBe(404);
    expect(res.body).not.toContain(SECRET);
  });

  it("holds a scope-less run to the org root, where its brief is stored", async () => {
    const runId = await finishedRun({ briefScope: ROOT });

    actAs(ORG, SALES_READER);
    expect((await stream(runId)).status).toBe(404);

    actAs(ORG, ROOT_READER);
    const res = await stream(runId);
    expect(res.status).toBe(200);
    expect(res.body).toContain(SECRET);
  });

  it("stops replaying once the caller's grant is revoked", async () => {
    const runId = await finishedRun({ runScope: ENG, briefScope: ENG });
    actAs(ORG, ENG_READER);
    expect((await stream(runId)).status).toBe(200);

    await db.grant.deleteMany({ where: { orgId: ORG, granteeId: ENG_READER } });

    expect((await stream(runId)).status).toBe(404);
  });

  it("does not replay on an expired grant", async () => {
    const runId = await finishedRun({ runScope: SALES, briefScope: SALES });
    await db.grant.deleteMany({ where: { orgId: ORG, granteeId: SALES_READER } });
    await grant(SALES_READER, SALES, new Date(Date.now() - 60_000));
    actAs(ORG, SALES_READER);

    expect((await stream(runId)).status).toBe(404);
  });

  it("answers a reader of the brief's scope as an absent run once the brief is retired", async () => {
    const runId = await finishedRun({ runScope: SALES, briefScope: SALES });
    const run = await db.agentRun.findUniqueOrThrow({ where: { id: runId }, select: { briefId: true } });
    actAs(ORG, SALES_READER);
    expect((await stream(runId)).status).toBe(200);

    await db.briefRetirement.create({
      data: { briefId: run.briefId!, sourceId: "src-moved", reason: "source_moved" },
    });

    const retired = await stream(runId);
    expect(retired).toEqual(await stream(ABSENT_RUN));
    expect(retired.body).not.toContain(SECRET);
  });

  it("keeps replaying a run whose own brief is not retired when another brief in the org is", async () => {
    const retiredRunId = await finishedRun({ runScope: SALES, briefScope: SALES });
    const liveRunId = await finishedRun({ runScope: SALES, briefScope: SALES });
    const retiredRun = await db.agentRun.findUniqueOrThrow({ where: { id: retiredRunId }, select: { briefId: true } });
    await db.briefRetirement.create({
      data: { briefId: retiredRun.briefId!, sourceId: "src-gone", reason: "source_disconnected" },
    });
    actAs(ORG, SALES_READER);

    const res = await stream(liveRunId);

    expect(res.status).toBe(200);
    expect(res.body).toContain(SECRET);
  });

  it("treats a run whose stored scope is malformed as unreadable", async () => {
    const runId = await finishedRun({ runScope: "sales; drop", briefScope: ROOT });
    actAs(ORG, ROOT_READER);

    expect((await stream(runId)).status).toBe(404);
  });
});
