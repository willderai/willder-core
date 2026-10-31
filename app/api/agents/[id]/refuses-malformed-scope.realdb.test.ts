// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The four agent routes that take a required scopePath (architecture, handoff,
// plan-interactive, plan-manager) refuse a scope holding a NUL (U+0000), or a scopePath
// sent as another JSON type, with a 403 that names the fix, start nothing, and leave one
// deny row on the audit trail. Postgres text cannot hold a NUL, so a deny row quoting the
// raw scope used to fail on insert, and a number or an array threw a TypeError on
// `.trim()`; either way the request answered a 500 that named nothing.
//
// Real: Postgres, the four route handlers, the scope refusal and its audit write, check()
// and the agent, run and capability rows. Faked: the Clerk session, the LLM runners and
// the background drivers, so a request that gets past the scope reaches a fake.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "nulagentscope";
const ROOT = `org_${ORG}`;
const SALES = `${ROOT}.sales`;
const ADMIN = "u-nulagentscope-admin";
const NUL = "\u0000";

const NUL_REASON = "scopePath contains a NUL (\\u0000) character, which is not accepted. Remove it and retry.";
/** What every mocked runner throws, so a test can tell "reached the work" from a real failure. */
const REACHED = "runner reached";

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
vi.mock("@/services/agents/runner", async (orig) => ({
  ...(await orig<typeof import("@/services/agents/runner")>()),
  runHandoffAgent: vi.fn(async () => {
    throw new Error(REACHED);
  }),
}));
vi.mock("@/services/agents/architecture-run", () => ({
  runAndPersistArchitecturePlan: vi.fn(async () => {
    throw new Error(REACHED);
  }),
}));

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

/** One route: the agent role it runs, a valid body for a scope, and how to load it. */
interface ScopedRoute {
  name: string;
  role: "architecture" | "handoff";
  body: (scopePath: unknown) => Record<string, unknown>;
  load: () => Promise<Handler>;
}

const ROUTES: ScopedRoute[] = [
  {
    name: "architecture",
    role: "architecture",
    body: (scopePath) => ({ scopePath }),
    load: async () => (await import("./architecture/route")).POST as Handler,
  },
  {
    name: "handoff",
    role: "handoff",
    body: (scopePath) => ({ scopePath, granteeName: "New hire" }),
    load: async () => (await import("./handoff/route")).POST as Handler,
  },
  {
    name: "plan-interactive",
    role: "architecture",
    body: (scopePath) => ({ scopePath, prompt: "plan the billing rework" }),
    load: async () => (await import("./plan-interactive/route")).POST as Handler,
  },
  {
    name: "plan-manager",
    role: "architecture",
    body: (scopePath) => ({ scopePath, prompt: "plan the billing rework" }),
    load: async () => (await import("./plan-manager/route")).POST as Handler,
  },
];

describe.skipIf(!QA_URL)("agent routes refuse a NUL or a non-string required scopePath, real Postgres", () => {
  let db: PrismaClient;
  const agentIds: Record<ScopedRoute["role"], string> = { architecture: "", handoff: "" };

  async function clearTenant() {
    await db.agentRunEvent.deleteMany({ where: { run: { orgId: ORG } } });
    await db.agentRun.deleteMany({ where: { orgId: ORG } });
    for (const table of ["capability", "agent", "auditLog", "brief", "grant", "scope", "user"] as const) {
      await (db[table] as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where: { orgId: ORG } });
    }
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
  }

  /** Send a route's request; a mocked runner's throw is reported as "reached". */
  async function send(route: ScopedRoute, scopePath: unknown) {
    const agentId = agentIds[route.role];
    try {
      const res = await (
        await route.load()
      )(
        new Request(`http://t/api/agents/${agentId}/${route.name}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(route.body(scopePath)),
        }),
        { params: Promise.resolve({ id: agentId }) },
      );
      return { status: res.status, body: (await res.json()) as { error?: string } };
    } catch (e) {
      if (e instanceof Error && e.message === REACHED) return { status: "reached" as const, body: {} };
      throw e;
    }
  }

  /** Everything a started request leaves behind in this org. */
  async function footprint() {
    const [runs, capabilities, briefs] = await Promise.all([
      db.agentRun.count({ where: { orgId: ORG } }),
      db.capability.count({ where: { orgId: ORG } }),
      db.brief.count({ where: { orgId: ORG } }),
    ]);
    return { runs, capabilities, briefs };
  }

  const auditRows = () =>
    db.auditLog.findMany({
      where: { orgId: ORG },
      select: { action: true, target: true, decision: true, reason: true },
      orderBy: { at: "asc" },
    });

  beforeAll(async () => {
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    vi.stubEnv("ARCH_MANAGER", "true");
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL! }) });
    const { requireAccessContext } = await import("@/lib/access-context");
    // The fields the routes read; the full Clerk-backed org and user rows are not needed.
    vi.mocked(requireAccessContext).mockResolvedValue({
      org: { id: ORG, name: ORG },
      user: { id: ADMIN },
      ctx: { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "api" },
    } as Awaited<ReturnType<typeof requireAccessContext>>);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await clearTenant();
    await db.org.create({ data: { id: ORG, name: ORG } });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    await db.scope.create({ data: { orgId: ORG, path: SALES, name: "sales" } });
    await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: `${ADMIN}@nulagentscope.test`, role: "admin", clerkId: `clerk-${ADMIN}` },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    for (const role of ["architecture", "handoff"] as const) {
      const agent = await db.agent.create({
        data: { orgId: ORG, agentKey: `custom-${role}`, name: `Custom ${role}`, role },
      });
      agentIds[role] = agent.id;
    }
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await clearTenant();
    await db.$disconnect();
  });

  describe.each(ROUTES)("POST /api/agents/:id/$name", (route) => {
    it.each([
      ["at the end", `${SALES}${NUL}`, `${SALES}\\u0000`],
      ["inside a label", `${ROOT}.deal${NUL}a`, `${ROOT}.deal\\u0000a`],
    ])(
      "a NUL %s is a 403 naming the fix, starts nothing, and one deny row records it",
      async (_where, scopePath, recorded) => {
        const res = await send(route, scopePath);

        expect(res).toEqual({ status: 403, body: { error: `access denied: ${NUL_REASON}` } });
        expect(await footprint()).toEqual({ runs: 0, capabilities: 0, briefs: 0 });
        expect(await auditRows()).toEqual([
          { action: "memory.read", target: recorded, decision: "deny", reason: NUL_REASON },
        ]);
      },
    );

    it.each([
      ["a number", 42, "42"],
      ["an array", [SALES], `["${SALES}"]`],
    ])(
      "a scopePath sent as %s is a 403 naming the field, starts nothing, and one deny row records it",
      async (kind, scopePath, recorded) => {
        const refusal = `scopePath must be a string scope path, not ${kind}`;
        const res = await send(route, scopePath);

        expect(res).toEqual({ status: 403, body: { error: `access denied: ${refusal}` } });
        expect(await footprint()).toEqual({ runs: 0, capabilities: 0, briefs: 0 });
        expect(await auditRows()).toEqual([
          { action: "memory.read", target: recorded, decision: "deny", reason: refusal },
        ]);
      },
    );

    it("the same request with a valid scope is allowed and reaches its work", async () => {
      const res = await send(route, SALES);

      expect(res.status === "reached" || res.status === 201).toBe(true);
      expect((await auditRows()).map((r) => [r.action, r.target, r.decision])).toContainEqual([
        "memory.read",
        SALES,
        "allow",
      ]);
    });
  });
});
