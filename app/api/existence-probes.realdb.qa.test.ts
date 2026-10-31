// A caller without access cannot tell a missing record from one it may not act on.
//
// Existence probes: a route that looks a record up before it
// decides access answers 404 for an id that does not exist and 403 for one that does,
// and the difference is the disclosure. Each case below asks as a member holding no
// grant, once for an id that was never issued and once for a real record in a scope
// they cannot read, and requires the two responses to be byte-identical. Each refusal
// leaves exactly one deny row, the never-issued id's too: every route now decides it
// so it costs the same as the real one (existence-timing.realdb.test.ts and
// briefs/[id]/existence-timing.realdb.test.ts measure that). An org admin asking for the
// same records gets the answer they always got.
//
// The structural half is eslint.lookup-gate.mjs, which holds every route to deciding
// before it looks up, or to services/access/authorize-record.ts.
//
// It needs QA_DATABASE_URL naming an isolated, migrated test Postgres; without it the
// tests are skipped, not failed. The signed-in identity is stubbed, and so is every
// call that would leave the process (job queue, model runs, the memory service); the
// lookups, check() and the audit writer all run against Postgres.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("next/server", async (original) => ({ ...(await original<object>()), after: vi.fn() }));
vi.mock("@/lib/inngest", async (original) => ({
  ...(await original<object>()),
  inngest: { send: vi.fn(async () => ({ ids: ["job-qa"] })) },
  ingestMemory: vi.fn(async () => undefined),
}));
vi.mock("@/services/agents/run-loop", async (original) => ({
  ...(await original<object>()),
  createArchInteractiveRun: vi.fn(async () => "run-qa"),
  createQaInteractiveRun: vi.fn(async () => "run-qa"),
  driveRun: vi.fn(async () => undefined),
}));
vi.mock("@/services/agents/manager", async (original) => ({
  ...(await original<object>()),
  archManagerEnabled: () => true,
  qaManagerEnabled: () => true,
  createArchManagerRun: vi.fn(async () => "run-qa"),
  createQaManagerRun: vi.fn(async () => "run-qa"),
  driveManager: vi.fn(async () => undefined),
}));
vi.mock("@/services/agents/qa-run", () => ({
  runAndPersistQaReview: vi.fn(async () => ({ brief: { id: "brief-qa" }, report: {} })),
}));
vi.mock("@/services/facts/conflicts", () => ({
  findContradiction: vi.fn(async () => ({ contradiction: null, complete: true })),
}));
vi.mock("@/services/signals", () => ({ recordFeedback: vi.fn(async () => undefined) }));
vi.mock("@/services/memory/source-retirement", async (original) => ({
  ...(await original<object>()),
  retireSourceContent: vi.fn(async () => ({ retiredFacts: 0, retiredChunks: 0 })),
}));
vi.mock("@/services/memory/scope-deletion", async (original) => ({
  ...(await original<object>()),
  findScopeResidue: vi.fn(async () => ({})),
}));

const QA_URL = process.env.QA_DATABASE_URL;
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const ORG = `org-qa-probes-${RUN}`;
const ROOT = `org_${ORG}`;
/** A scope nobody but org admins can read. */
const SECRET = `${ROOT}.secret`;
const MEMBER = `user-qa-probes-member-${RUN}`;
const ADMIN = `user-qa-probes-admin-${RUN}`;
const NEVER_ISSUED = `never-issued-${RUN}`;
/** A scope path that was never registered, under the scope the member cannot read. */
const NEVER_REGISTERED = `${SECRET}.never_${RUN}`;

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

/** The records one caller's half of the run acts on. Each half gets its own, because
 * several routes delete or retire what they are given. */
interface Seeded {
  contact: string;
  account: string;
  architectureAgent: string;
  qaAgent: string;
  brief: string;
  convention: string;
  source: string;
  syncSource: string;
  dispute: string;
  capability: string;
  grant: string;
  /** A leaf scope, for the probe that deletes one. */
  scope: string;
  /** The scope the records live at, by id and by path. */
  scopeId: string;
  scopePath: string;
}

interface Probe {
  name: string;
  route: string;
  method: "POST" | "PATCH" | "DELETE";
  /** The request for one record: `id` is either a real one or {@link NEVER_ISSUED}. */
  request: (id: string) => { params?: Record<string, string>; body?: unknown };
  /** Which seeded record the probe names. */
  record: (s: Seeded) => string;
  /** What an org admin gets for a real record: the route's ordinary answer. */
  adminStatus: number;
  /** The id that names nothing, when the route names its record by something other
   * than an id. Defaults to {@link NEVER_ISSUED}. */
  missing?: string;
}

const qaTarget = { target: { baseUrl: "https://example.test" } };

const PROBES: Probe[] = [
  {
    name: "contact enrich",
    route: "./contacts/[id]/enrich/route",
    method: "POST",
    request: (id) => ({ params: { id } }),
    record: (s) => s.contact,
    adminStatus: 202,
  },
  {
    name: "account enrich",
    route: "./accounts/[id]/enrich/route",
    method: "POST",
    request: (id) => ({ params: { id } }),
    record: (s) => s.account,
    adminStatus: 202,
  },
  {
    name: "architecture plan-interactive",
    route: "./agents/[id]/plan-interactive/route",
    method: "POST",
    request: (id) => ({ params: { id }, body: { scopePath: SECRET, prompt: "plan" } }),
    record: (s) => s.architectureAgent,
    adminStatus: 201,
  },
  {
    name: "architecture plan-manager",
    route: "./agents/[id]/plan-manager/route",
    method: "POST",
    request: (id) => ({ params: { id }, body: { scopePath: SECRET, prompt: "plan" } }),
    record: (s) => s.architectureAgent,
    adminStatus: 201,
  },
  {
    name: "qa one-shot",
    route: "./agents/[id]/qa/route",
    method: "POST",
    request: (id) => ({ params: { id }, body: { scopePath: SECRET, ...qaTarget } }),
    record: (s) => s.qaAgent,
    adminStatus: 200,
  },
  {
    name: "qa run-interactive",
    route: "./agents/[id]/run-interactive/route",
    method: "POST",
    request: (id) => ({ params: { id }, body: { scopePath: SECRET, ...qaTarget } }),
    record: (s) => s.qaAgent,
    adminStatus: 201,
  },
  {
    name: "qa run-manager",
    route: "./agents/[id]/run-manager/route",
    method: "POST",
    request: (id) => ({ params: { id }, body: { scopePath: SECRET, ...qaTarget } }),
    record: (s) => s.qaAgent,
    adminStatus: 201,
  },
  {
    name: "agent edit",
    route: "./agents/[id]/route",
    method: "PATCH",
    request: (id) => ({ params: { id }, body: { name: `renamed ${RUN}` } }),
    record: (s) => s.architectureAgent,
    adminStatus: 200,
  },
  {
    name: "source sync",
    route: "./sources/[id]/sync/route",
    method: "POST",
    request: (id) => ({ params: { id }, body: {} }),
    record: (s) => s.syncSource,
    adminStatus: 202,
  },
  {
    name: "brief correct",
    route: "./briefs/[id]/correct/route",
    method: "POST",
    request: (id) => ({ params: { id }, body: { correction: "fixed" } }),
    record: (s) => s.brief,
    adminStatus: 200,
  },
  {
    name: "convention retire",
    route: "./memory/conventions/[id]/route",
    method: "DELETE",
    request: (id) => ({ params: { id } }),
    record: (s) => s.convention,
    adminStatus: 200,
  },
  {
    name: "source disconnect",
    route: "./sources/[id]/route",
    method: "DELETE",
    request: (id) => ({ params: { id } }),
    record: (s) => s.source,
    adminStatus: 200,
  },
  {
    name: "dispute resolve",
    route: "./facts/disputes/[id]/resolve/route",
    method: "POST",
    request: (id) => ({ params: { id }, body: { resolution: "existing" } }),
    record: (s) => s.dispute,
    adminStatus: 200,
  },
  {
    name: "capability revoke",
    route: "./access/capabilities/[id]/route",
    method: "DELETE",
    request: (id) => ({ params: { id } }),
    record: (s) => s.capability,
    adminStatus: 200,
  },
  {
    name: "grant revoke",
    route: "./access/grants/[id]/route",
    method: "DELETE",
    request: (id) => ({ params: { id } }),
    record: (s) => s.grant,
    adminStatus: 200,
  },
  {
    name: "scope delete",
    route: "./access/scopes/[id]/route",
    method: "DELETE",
    request: (id) => ({ params: { id } }),
    record: (s) => s.scope,
    adminStatus: 204,
  },
  {
    name: "capability issue at a scope path",
    route: "./access/capabilities/route",
    method: "POST",
    request: (path) => ({ body: { agentId: "handoff", scopePath: path } }),
    record: (s) => s.scopePath,
    adminStatus: 201,
    missing: NEVER_REGISTERED,
  },
  {
    name: "grant create at a scope path",
    route: "./access/grants/route",
    method: "POST",
    request: (path) => ({ body: { granteeType: "everyone", permission: "read", scopePath: path } }),
    record: (s) => s.scopePath,
    adminStatus: 201,
    missing: NEVER_REGISTERED,
  },
  {
    name: "grant create at a scope id",
    route: "./access/grants/route",
    method: "POST",
    request: (id) => ({ body: { granteeType: "everyone", permission: "read", scopeId: id } }),
    record: (s) => s.scopeId,
    adminStatus: 201,
  },
  {
    name: "scope create under a parent path",
    route: "./access/scopes/route",
    method: "POST",
    request: (path) => ({ body: { name: `child ${RUN}`, parentPath: path } }),
    record: (s) => s.scopePath,
    adminStatus: 201,
    missing: NEVER_REGISTERED,
  },
];

const neverIssued = (probe: Probe) => probe.missing ?? NEVER_ISSUED;

describe.skipIf(!QA_URL)("existence probes: missing and forbidden answer alike (real database)", () => {
  let db: PrismaClient;
  let asMember: Seeded;
  let asAdmin: Seeded;
  let signIn: (userId: string, role: "member" | "admin") => Promise<void>;

  async function seed(tag: string): Promise<Seeded> {
    const at = await db.scope.create({ data: { orgId: ORG, path: `${SECRET}.${tag}`, name: tag } });
    const scopePath = at.path;
    const account = await db.account.create({
      data: { orgId: ORG, name: `Acme ${tag}`, domain: `${tag}.example.test` },
    });
    const contact = await db.contact.create({ data: { orgId: ORG, name: `Ada ${tag}`, accountId: account.id } });
    const agent = (role: "architecture" | "qa") =>
      db.agent.create({ data: { orgId: ORG, agentKey: `${role}-${tag}-${RUN}`, name: role, role } });
    const brief = await db.brief.create({
      data: { orgId: ORG, type: "handoff", scopePath, title: "Brief", summary: "s", sections: [] },
    });
    const convention = await db.convention.create({
      data: { orgId: ORG, scopePath, kind: "convention", subject: `subject ${tag}`, text: "t", actorId: ADMIN },
    });
    const source = (name: string) =>
      db.source.create({ data: { orgId: ORG, type: "posthog", externalId: `${name}-${tag}-${RUN}`, name, scopePath } });
    const dispute = await db.factDispute.create({
      data: {
        orgId: ORG,
        scopePath,
        graphitiFactUuid: `fact-${tag}`,
        proposerActorType: "human",
        proposerActorId: ADMIN,
        existingActorType: "human",
        existingActorId: ADMIN,
      },
    });
    const capability = await db.capability.create({
      data: {
        orgId: ORG,
        agentId: "handoff",
        tokenHash: `hash-${tag}-${RUN}`,
        scopePath,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    const grant = await db.grant.create({
      data: { orgId: ORG, scopeId: at.id, granteeType: "user", granteeId: `someone-${tag}`, permission: "read" },
    });
    // The scope the delete probe removes: a leaf of its own, so it has no children.
    const leaf = await db.scope.create({ data: { orgId: ORG, path: `${SECRET}.${tag}_leaf`, name: `${tag} leaf` } });
    return {
      contact: contact.id,
      account: account.id,
      architectureAgent: (await agent("architecture")).id,
      qaAgent: (await agent("qa")).id,
      brief: brief.id,
      convention: convention.id,
      source: (await source("disconnect")).id,
      syncSource: (await source("sync")).id,
      dispute: dispute.id,
      capability: capability.id,
      grant: grant.id,
      scope: leaf.id,
      scopeId: at.id,
      scopePath,
    };
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    await db.org.create({ data: { id: ORG, name: "Existence probe QA" } });
    for (const [id, role] of [
      [MEMBER, "member"],
      [ADMIN, "admin"],
    ] as const) {
      await db.user.create({ data: { id, orgId: ORG, email: `${id}@probes.test`, role, clerkId: `clerk-${id}` } });
    }
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "Org" } });
    await db.scope.create({ data: { orgId: ORG, path: SECRET, name: "Secret" } });
    // The tenant default (lib/tenant.ts): org admins hold admin at the root, members nothing.
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "role", granteeId: "admin", permission: "admin" },
    });
    asMember = await seed("m");
    asAdmin = await seed("a");

    const { requireAccessContext } = await import("@/lib/access-context");
    const org = await db.org.findUniqueOrThrow({ where: { id: ORG } });
    signIn = async (userId, role) => {
      const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
      vi.mocked(requireAccessContext).mockResolvedValue({
        org,
        user,
        ctx: { orgId: ORG, actor: { type: "human", id: userId, role }, origin: "app" },
      } as never);
    };
  });

  afterAll(async () => {
    // Deleting the org removes its rows, audit rows included, through the cascades.
    await db.user.deleteMany({ where: { orgId: ORG } });
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.$disconnect();
  });

  const denyRows = () => db.auditLog.count({ where: { orgId: ORG, decision: "deny" } });

  async function ask(probe: Probe, id: string): Promise<{ status: number; body: string; denies: number }> {
    const handler = ((await import(probe.route)) as Record<string, Handler>)[probe.method]!;
    const { params = {}, body } = probe.request(id);
    const before = await denyRows();
    const res = await handler(
      new Request("http://t/api/probe", {
        method: probe.method,
        ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
      }),
      { params: Promise.resolve(params) },
    );
    return { status: res.status, body: await res.text(), denies: (await denyRows()) - before };
  }

  for (const probe of PROBES) {
    it(`${probe.name}: a member gets the same answer for a missing and a forbidden record`, async () => {
      await signIn(MEMBER, "member");
      const missing = await ask(probe, neverIssued(probe));
      const forbidden = await ask(probe, probe.record(asMember));

      expect(forbidden.status, probe.name).toBeGreaterThanOrEqual(400);
      expect({ status: forbidden.status, body: forbidden.body }, probe.name).toEqual({
        status: missing.status,
        body: missing.body,
      });
      expect(forbidden.denies, `${probe.name}: deny rows for the forbidden record`).toBe(1);
      expect(missing.denies, `${probe.name}: deny rows for the missing id`).toBe(1);
    });
  }

  for (const probe of PROBES) {
    it(`${probe.name}: an org admin gets the ordinary answer for a real record, and 404 for a missing one`, async () => {
      await signIn(ADMIN, "admin");
      const real = await ask(probe, probe.record(asAdmin));
      expect(real.status, `${probe.name}: ${real.body}`).toBe(probe.adminStatus);
      expect(real.denies, probe.name).toBe(0);
      const missing = await ask(probe, neverIssued(probe));
      expect(missing.status, `${probe.name}: ${missing.body}`).toBe(404);
    });
  }
});
