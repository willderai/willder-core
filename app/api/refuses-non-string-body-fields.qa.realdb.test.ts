// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The non-string body field refusals on seven routes. The routes' own suites send
// each wrong-typed field alone, so most routes would refuse that body
// earlier anyway (no granteeType, no sourceType, no resolution) and its "no audit row"
// assertion cannot tell a pre-check() refusal from an unrelated early 400. Here each
// wrong-typed field rides inside a body that is otherwise valid enough to reach
// check(): the same body with every field a string is shown to write audit rows first,
// so zero rows after the wrong-typed requests means the refusal came before check().
//
// Real: Postgres, the route handlers, check() and its audit write, the scope and grant
// writes. Faked: the Clerk session, the ingest queue, and the memory service (fetch
// answers 503, so a route that gets past check() fails fast instead of calling out).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "bodyfieldtypesqa";
const ROOT = `org_${ORG}`;
const ADMIN = "u-bodyfieldtypesqa-admin";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/inngest", () => ({ ingestMemory: vi.fn(async () => ({ readableNow: false })) }));

type Handler = (req: Request) => Promise<Response>;
/** `checksWithNoRows`: false for staleness-check, which calls check() once per matched
 * provenance row, so an empty tenant reaches its lookup (a 200) without an audit row. */
type Route = {
  name: string;
  valid: Record<string, unknown>;
  fields: string[];
  handle: Handler;
  checksWithNoRows?: false;
};

const NOT_A_STRING: [string, unknown][] = [
  ["a number", 0],
  ["a number", 42],
  ["a boolean", false],
  ["a boolean", true],
  ["an array", ["eng"]],
  ["an object", { path: "eng" }],
];

function post(body: unknown) {
  return new Request("http://t/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The route's response, or the error it threw, as one comparable value. */
async function outcome(route: Route, body: unknown): Promise<{ status: number; error?: string }> {
  try {
    const res = await route.handle(post(body));
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    return { status: res.status, error: json.error };
  } catch (err) {
    return { status: 500, error: String(err) };
  }
}

describe.skipIf(!QA_URL)("a wrong-typed field in an otherwise valid body is refused before check()", () => {
  let db: PrismaClient;
  let ingestMemory: (typeof import("@/lib/inngest"))["ingestMemory"];
  let routes: Route[];

  const auditRows = () => db.auditLog.count({ where: { orgId: ORG } });
  const scopeRows = () => db.scope.count({ where: { orgId: ORG } });
  const grantRows = () => db.grant.count({ where: { orgId: ORG } });

  async function clearTenant() {
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.grant.deleteMany({ where: { orgId: ORG } });
    await db.scope.deleteMany({ where: { orgId: ORG } });
    await db.user.deleteMany({ where: { orgId: ORG } });
    await db.org.deleteMany({ where: { id: ORG } });
  }

  beforeAll(async () => {
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503 })),
    );
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL! }) });
    ({ ingestMemory } = await import("@/lib/inngest"));
    const { requireAccessContext } = await import("@/lib/access-context");
    vi.mocked(requireAccessContext).mockResolvedValue({
      org: { id: ORG, name: "Body field types QA" },
      user: { id: ADMIN, name: ADMIN, email: `${ADMIN}@bodyfieldtypesqa.test` },
      ctx: { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "app" },
    } as Awaited<ReturnType<typeof requireAccessContext>>);

    const params = { params: Promise.resolve({ id: "qa-missing-id" }) };
    const scopes = await import("./access/scopes/route");
    const grants = await import("./access/grants/route");
    const fact = await import("./memory/facts/[id]/route");
    const provenance = await import("./memory/facts/[id]/provenance/route");
    const staleness = await import("./memory/facts/staleness-check/route");
    const resolve = await import("./facts/disputes/[id]/resolve/route");
    const correct = await import("./briefs/[id]/correct/route");
    routes = [
      {
        name: "POST /api/access/scopes",
        valid: { name: "Engineering", parentPath: ROOT },
        fields: ["name", "parentPath"],
        handle: scopes.POST,
      },
      {
        name: "POST /api/access/grants",
        valid: { scopePath: ROOT, granteeType: "role", granteeId: "member", permission: "read" },
        fields: ["scopeId", "scopePath", "granteeId"],
        handle: grants.POST,
      },
      {
        name: "PATCH /api/memory/facts/:id",
        valid: { fact: "the deploy target is fra1" },
        fields: ["fact"],
        handle: (r) => fact.PATCH(r, params),
      },
      {
        name: "POST /api/memory/facts/:id/provenance",
        valid: { sourceType: "pr", sourceRef: "acme/storefront#662", recordedRevision: "a1b2c3d" },
        fields: ["sourceRef", "recordedRevision"],
        handle: (r) => provenance.POST(r, params),
      },
      {
        name: "POST /api/memory/facts/staleness-check",
        valid: { sourceType: "pr", sourceRef: "acme/storefront#662", currentRevision: "abc1234", reason: "pushed" },
        fields: ["sourceRef", "currentRevision", "reason"],
        handle: staleness.POST,
        checksWithNoRows: false,
      },
      {
        name: "POST /api/facts/disputes/:id/resolve",
        valid: { resolution: "reconciled", value: "fra1" },
        fields: ["resolution", "value"],
        handle: (r) => resolve.POST(r, params),
      },
      {
        name: "POST /api/briefs/:id/correct",
        valid: { correction: "the deploy target is fra1", sectionHeading: "Deploys" },
        fields: ["correction", "sectionHeading"],
        handle: (r) => correct.POST(r, params),
      },
    ];

    await clearTenant();
    await db.org.create({ data: { id: ORG, name: "Body field types QA" } });
    await db.user.create({
      data: {
        id: ADMIN,
        orgId: ORG,
        email: `${ADMIN}@bodyfieldtypesqa.test`,
        role: "admin",
        clerkId: `clerk-${ADMIN}`,
      },
    });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: ROOT } });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
  }, 60_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    await clearTenant();
    await db.$disconnect();
  });

  beforeEach(async () => {
    vi.mocked(ingestMemory).mockClear();
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
  });

  it("the all-string body passes the type check on every route and gets past it: an audit row, or the staleness lookup", async () => {
    for (const route of routes) {
      const before = await auditRows();
      const result = await outcome(route, route.valid);

      expect({ route: route.name, error: result.error ?? "" }).not.toMatchObject({
        error: expect.stringMatching(/must be a string|must be a JSON object/),
      });
      if (route.checksWithNoRows === false) {
        expect({ route: route.name, status: result.status }).toEqual({ route: route.name, status: 200 });
        continue;
      }
      expect({ route: route.name, auditRowsWritten: (await auditRows()) > before }).toEqual({
        route: route.name,
        auditRowsWritten: true,
      });
    }
  });

  it("each field, wrong-typed inside that same body, is a 400 naming it; no audit row, scope, grant or ingest", async () => {
    const scopesBefore = await scopeRows();
    const grantsBefore = await grantRows();
    for (const route of routes) {
      for (const field of route.fields) {
        for (const [kind, value] of NOT_A_STRING) {
          const result = await outcome(route, { ...route.valid, [field]: value });

          expect({ route: route.name, field, value, ...result }).toEqual({
            route: route.name,
            field,
            value,
            status: 400,
            error: `${field} must be a string, not ${kind}`,
          });
        }
      }
    }
    expect(await auditRows()).toBe(0);
    expect(await scopeRows()).toBe(scopesBefore);
    expect(await grantRows()).toBe(grantsBefore);
    expect(ingestMemory).not.toHaveBeenCalled();
  });

  it.each(["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"])(
    "a dispute resolution of %j never reaches the dispute lookup or check()",
    async (resolution) => {
      const resolveRoute = routes.find((r) => r.name === "POST /api/facts/disputes/:id/resolve")!;
      const result = await outcome(resolveRoute, { resolution, value: "fra1" });

      expect(result).toEqual({ status: 400, error: "resolution must be one of: proposer, existing, reconciled" });
      expect(await auditRows()).toBe(0);
    },
  );

  it.each(["proposer", "existing", "reconciled"])(
    "the own-key resolution %j still passes the lookup and reaches authorization (404 on a missing dispute)",
    async (resolution) => {
      const resolveRoute = routes.find((r) => r.name === "POST /api/facts/disputes/:id/resolve")!;
      const result = await outcome(resolveRoute, { resolution, value: "fra1" });

      expect(result).toEqual({ status: 404, error: "dispute not found" });
    },
  );
});
