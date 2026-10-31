// POST /api/agents/:id/run-interactive and /run-manager start a QA run the caller then
// follows on GET /api/runs/:runId/stream. The stream checks memory.read on the run's
// scope, or the org root for a scope-less run, so both start routes must make the same
// check before creating anything: a caller who could not follow the run is refused 403
// up front and no run row is written.
//
// Runs the shipping routes against a real Postgres 16 with ltree and the real access
// evaluator. Authentication and the run/manager loops are mocked. Set QA_DATABASE_URL
// to an isolated test database (never the inherited DATABASE_URL); the suite skips
// without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "runstartscope"; // ltree-safe, so the org root path is a valid scope
const ROOT = `org_${ORG}`;
const SALES = `${ROOT}.sales`;
const ENG = `${ROOT}.eng`;

const SALES_READER = "u-rss-sales";
const ROOT_READER = "u-rss-root";
const EXPIRED_ROOT_READER = "u-rss-expired";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/services/agents/run-loop", async (orig) => ({
  ...(await orig<typeof import("@/services/agents/run-loop")>()),
  driveRun: vi.fn(async () => {}),
  subscribeRun: vi.fn(() => () => {}),
}));
vi.mock("@/services/agents/manager", async (orig) => ({
  ...(await orig<typeof import("@/services/agents/manager")>()),
  driveManager: vi.fn(async () => {}),
}));

type StartHandler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
type StreamHandler = (req: Request, ctx: { params: Promise<{ runId: string }> }) => Promise<Response>;

const START_ROUTES = [
  { name: "run-interactive", load: async () => (await import("@/app/api/agents/[id]/run-interactive/route")).POST },
  { name: "run-manager", load: async () => (await import("@/app/api/agents/[id]/run-manager/route")).POST },
];

describe.skipIf(!QA_URL).each(START_ROUTES)(
  "POST /api/agents/:id/$name checks the scope its stream will",
  ({ name, load }) => {
    let db: PrismaClient;
    let start: StartHandler;
    let streamGET: StreamHandler;
    let requireAccessContext: ReturnType<typeof vi.fn>;
    let agentId: string;
    const scopeIds: Record<string, string> = {};

    function actAs(userId: string) {
      requireAccessContext.mockResolvedValue({
        org: { id: ORG },
        user: { id: userId },
        ctx: { orgId: ORG, actor: { type: "human", id: userId, role: "member" } },
      } as never);
    }

    async function startRun(scopePath?: string) {
      const body = { target: { baseUrl: "https://example.com" }, ...(scopePath === undefined ? {} : { scopePath }) };
      return start(
        new Request(`http://t/api/agents/${agentId}/${name}`, { method: "POST", body: JSON.stringify(body) }),
        {
          params: Promise.resolve({ id: agentId }),
        },
      );
    }

    async function streamStatus(runId: string) {
      const res = await streamGET(new Request(`http://t/api/runs/${runId}/stream`), {
        params: Promise.resolve({ runId }),
      });
      await res.body?.cancel();
      return res.status;
    }

    async function runCount() {
      return db.agentRun.count({ where: { orgId: ORG } });
    }

    async function grant(userId: string, scope: string, expiresAt?: Date) {
      await db.grant.create({
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

    async function clearTenant() {
      await db.agentRunEvent.deleteMany({ where: { run: { orgId: ORG } } });
      await db.agentRun.deleteMany({ where: { orgId: ORG } });
      for (const table of ["agent", "auditLog", "brief", "grant", "scope", "user"] as const) {
        await (db[table] as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where: { orgId: ORG } });
      }
      await deleteOrgsWithRetry(db, { where: { id: ORG } });
    }

    beforeAll(async () => {
      process.env.DATABASE_URL = QA_URL;
      vi.stubEnv("QA_MANAGER", "true"); // run-manager is flag-gated; enable it for this suite
      db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
      start = await load();
      streamGET = (await import("@/app/api/runs/[runId]/stream/route")).GET;
      requireAccessContext = (await import("@/lib/access-context")).requireAccessContext as unknown as ReturnType<
        typeof vi.fn
      >;
    });

    beforeEach(async () => {
      await clearTenant();
      await db.org.create({ data: { id: ORG, name: ORG } });
      for (const [path, scopeName] of [
        [ROOT, "root"],
        [SALES, "sales"],
        [ENG, "eng"],
      ]) {
        scopeIds[path] = (await db.scope.create({ data: { orgId: ORG, path, name: scopeName } })).id;
      }
      for (const id of [SALES_READER, ROOT_READER, EXPIRED_ROOT_READER]) {
        await db.user.create({
          data: { id, orgId: ORG, email: `${id}@qa.test`, role: "member", clerkId: `clerk-${id}` },
        });
      }
      await grant(SALES_READER, SALES);
      await grant(ROOT_READER, ROOT);
      await grant(EXPIRED_ROOT_READER, ROOT, new Date(Date.now() - 60_000));
      agentId = (await db.agent.create({ data: { orgId: ORG, agentKey: "qa", name: "qa", role: "qa" } })).id;
    });

    afterAll(async () => {
      vi.unstubAllEnvs();
      await clearTenant();
      await db.$disconnect();
    });

    it("refuses a scope-less run to a member without an org-root grant, before creating it", async () => {
      actAs(SALES_READER);
      const res = await startRun();
      expect(res.status).toBe(403);
      expect(await runCount()).toBe(0);
      const denial = await db.auditLog.findFirst({
        where: { orgId: ORG, actorId: SALES_READER, decision: "deny", target: ROOT },
      });
      expect(denial).not.toBeNull();
    });

    it("starts a scope-less run for an org-root reader, who can then follow it", async () => {
      actAs(ROOT_READER);
      const res = await startRun();
      expect(res.status).toBe(201);
      const { runId } = (await res.json()) as { runId: string };
      expect(await streamStatus(runId)).toBe(200);
    });

    it("starts a run in a scope the member can read, who can then follow it", async () => {
      actAs(SALES_READER);
      const res = await startRun(SALES);
      expect(res.status).toBe(201);
      const { runId } = (await res.json()) as { runId: string };
      expect(await streamStatus(runId)).toBe(200);
    });

    it("refuses a run in a sibling scope the member cannot read", async () => {
      actAs(SALES_READER);
      expect((await startRun(ENG)).status).toBe(403);
      expect(await runCount()).toBe(0);
    });

    it("treats a malformed scope as scope-less, so it needs the org root", async () => {
      actAs(SALES_READER);
      expect((await startRun(`${ROOT}.deal A`)).status).toBe(403);
      expect(await runCount()).toBe(0);
    });

    it("refuses a scope-less run on an expired org-root grant", async () => {
      actAs(EXPIRED_ROOT_READER);
      expect((await startRun()).status).toBe(403);
      expect(await runCount()).toBe(0);
    });
  },
);
