// A caller who cannot read the scope learns nothing about the agent: the four
// plan/run start routes check memory.read on the run's scope before they look up
// the agent, so the answer is 403 whether the agent is active, switched off or absent.
// Checking the agent first would answer 409 for a switched-off agent and 404 for a
// missing one, telling a caller without access which agents exist and which are off.
//
// Runs the shipping routes against a real Postgres 16 with ltree and the real
// access evaluator. Authentication and the background drivers are mocked. Set
// QA_DATABASE_URL to an isolated test database; the suite skips without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "deactivatedorder"; // ltree-safe
const ROOT = `org_${ORG}`;
const SALES = `${ROOT}.sales`;
const ENG = `${ROOT}.eng`;
const OUTSIDER = "u-dao-outsider"; // may read eng, not sales

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: vi.fn() }));
vi.mock("@/services/agents/run-loop", async (orig) => ({
  ...(await orig<typeof import("@/services/agents/run-loop")>()),
  driveRun: vi.fn(async () => {}),
}));
vi.mock("@/services/agents/manager", async (orig) => ({
  ...(await orig<typeof import("@/services/agents/manager")>()),
  driveManager: vi.fn(async () => {}),
}));

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

const ROUTES: { name: string; role: "qa" | "architecture"; body: unknown; load: () => Promise<Handler> }[] = [
  {
    name: "run-interactive",
    role: "qa",
    body: { scopePath: SALES, target: { baseUrl: "https://example.com" } },
    load: async () => (await import("./run-interactive/route")).POST as Handler,
  },
  {
    name: "run-manager",
    role: "qa",
    body: { scopePath: SALES, target: { baseUrl: "https://example.com" } },
    load: async () => (await import("./run-manager/route")).POST as Handler,
  },
  {
    name: "plan-interactive",
    role: "architecture",
    body: { scopePath: SALES, prompt: "plan it" },
    load: async () => (await import("./plan-interactive/route")).POST as Handler,
  },
  {
    name: "plan-manager",
    role: "architecture",
    body: { scopePath: SALES, prompt: "plan it" },
    load: async () => (await import("./plan-manager/route")).POST as Handler,
  },
];

describe.skipIf(!QA_URL)("plan/run start routes check scope access before the agent", () => {
  let db: PrismaClient;
  let requireAccessContext: ReturnType<typeof vi.fn>;

  async function clearTenant() {
    await db.agentRunEvent.deleteMany({ where: { run: { orgId: ORG } } });
    await db.agentRun.deleteMany({ where: { orgId: ORG } });
    for (const table of ["capability", "agent", "auditLog", "grant", "scope", "user"] as const) {
      await (db[table] as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where: { orgId: ORG } });
    }
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
  }

  async function post(handler: Handler, name: string, agentId: string, body: unknown) {
    const res = await handler(
      new Request(`http://t/api/agents/${agentId}/${name}`, { method: "POST", body: JSON.stringify(body) }),
      { params: Promise.resolve({ id: agentId }) },
    );
    await res.body?.cancel();
    return res.status;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    vi.stubEnv("QA_MANAGER", "true");
    vi.stubEnv("ARCH_MANAGER", "true");
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    requireAccessContext = (await import("@/lib/access-context")).requireAccessContext as unknown as ReturnType<
      typeof vi.fn
    >;
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await clearTenant();
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    await db.scope.create({ data: { orgId: ORG, path: SALES, name: "sales" } });
    const eng = await db.scope.create({ data: { orgId: ORG, path: ENG, name: "eng" } });
    await db.user.create({
      data: { id: OUTSIDER, orgId: ORG, email: `${OUTSIDER}@qa.test`, role: "member", clerkId: `clerk-${OUTSIDER}` },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: eng.id, granteeType: "user", granteeId: OUTSIDER, permission: "read" },
    });
    requireAccessContext.mockResolvedValue({
      org: { id: ORG, name: ORG },
      user: { id: OUTSIDER },
      ctx: { orgId: ORG, actor: { type: "human", id: OUTSIDER, role: "member" }, origin: "api" },
    } as never);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await clearTenant();
    await db.$disconnect();
  });

  describe.each(ROUTES)("POST /api/agents/:id/$name", ({ name, role, body, load }) => {
    it("answers 403 for an active, a switched-off and a missing agent alike, and starts nothing", async () => {
      const handler = await load();
      const active = await db.agent.create({ data: { orgId: ORG, agentKey: `custom-${role}-on`, name: "On", role } });
      const off = await db.agent.create({
        data: { orgId: ORG, agentKey: `custom-${role}-off`, name: "Off", role, active: false },
      });

      expect(await post(handler, name, active.id, body)).toBe(403);
      expect(await post(handler, name, off.id, body)).toBe(403);
      expect(await post(handler, name, "no-such-agent", body)).toBe(403);
      expect(await db.agentRun.count({ where: { orgId: ORG } })).toBe(0);
      expect(await db.capability.count({ where: { orgId: ORG } })).toBe(0);
    });

    it("still answers 409 for a switched-off agent once the caller can read the scope", async () => {
      const handler = await load();
      const sales = await db.scope.findFirstOrThrow({ where: { orgId: ORG, path: SALES } });
      await db.grant.create({
        data: { orgId: ORG, scopeId: sales.id, granteeType: "user", granteeId: OUTSIDER, permission: "read" },
      });
      const off = await db.agent.create({
        data: { orgId: ORG, agentKey: `custom-${role}-off`, name: "Off", role, active: false },
      });

      expect(await post(handler, name, off.id, body)).toBe(409);
      expect(await db.agentRun.count({ where: { orgId: ORG } })).toBe(0);
    });
  });
});
