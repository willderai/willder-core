// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The routes below read string fields from a JSON body and call `.trim()` on them (or,
// for a grant's scopeId, hand it to a lookup). A field sent as another JSON type (a
// number, a boolean, an array, an object) used to throw a TypeError there, and a body
// that was not an object threw reading the field; both answered a 500 that named
// nothing. Each is now a 400 naming the field and the type it was sent as, before
// anything is checked or written, so no audit row and no record is left behind.
// POST /api/memory/facts has its own suite (memory/facts/refuses-non-string-fact).
//
// Real: Postgres, the route handlers, check() and its audit write, the scope and grant
// writes. Faked: the Clerk session and the ingest queue.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "bodyfieldtypes";
const ROOT = `org_${ORG}`;
const ADMIN = "u-bodyfieldtypes-admin";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/inngest", () => ({ ingestMemory: vi.fn(async () => ({ readableNow: false })) }));

type Handler = (req: Request) => Promise<Response>;

/** Values of every JSON type but string, and the type each refusal names. Includes the
 * falsy ones a truthiness check would read as "absent". */
const NOT_A_STRING: [string, unknown][] = [
  ["a number", 0],
  ["a number", 42],
  ["a boolean", false],
  ["a boolean", true],
  ["an array", ["eng"]],
  ["an object", { path: "eng" }],
];

function post(body: string) {
  return new Request("http://t/api", { method: "POST", headers: { "content-type": "application/json" }, body });
}

describe.skipIf(!QA_URL)("routes refuse a body field that is not a string by name, real Postgres", () => {
  let db: PrismaClient;
  let ingestMemory: (typeof import("@/lib/inngest"))["ingestMemory"];
  /** Each route and the string fields it reads, in the order the tests below use. */
  let routes: { name: string; fields: string[]; handle: Handler }[];

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
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL! }) });
    ({ ingestMemory } = await import("@/lib/inngest"));
    const { requireAccessContext } = await import("@/lib/access-context");
    // The fields the routes read; the full Clerk-backed org and user rows are not needed.
    vi.mocked(requireAccessContext).mockResolvedValue({
      org: { id: ORG, name: "Body field types" },
      user: { id: ADMIN, name: ADMIN, email: `${ADMIN}@bodyfieldtypes.test` },
      ctx: { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "app" },
    } as Awaited<ReturnType<typeof requireAccessContext>>);

    const params = { params: Promise.resolve({ id: "does-not-matter" }) };
    const scopes = await import("./access/scopes/route");
    const grants = await import("./access/grants/route");
    const fact = await import("./memory/facts/[id]/route");
    const provenance = await import("./memory/facts/[id]/provenance/route");
    const staleness = await import("./memory/facts/staleness-check/route");
    const resolve = await import("./facts/disputes/[id]/resolve/route");
    const correct = await import("./briefs/[id]/correct/route");
    routes = [
      { name: "POST /api/access/scopes", fields: ["name", "parentPath"], handle: scopes.POST },
      { name: "POST /api/access/grants", fields: ["scopeId", "scopePath", "granteeId"], handle: grants.POST },
      { name: "PATCH /api/memory/facts/:id", fields: ["fact"], handle: (r) => fact.PATCH(r, params) },
      {
        name: "POST /api/memory/facts/:id/provenance",
        fields: ["sourceRef", "recordedRevision"],
        handle: (r) => provenance.POST(r, params),
      },
      {
        name: "POST /api/memory/facts/staleness-check",
        fields: ["sourceRef", "currentRevision", "reason"],
        handle: staleness.POST,
      },
      {
        name: "POST /api/facts/disputes/:id/resolve",
        fields: ["resolution", "value"],
        handle: (r) => resolve.POST(r, params),
      },
      {
        name: "POST /api/briefs/:id/correct",
        fields: ["correction", "sectionHeading"],
        handle: (r) => correct.POST(r, params),
      },
    ];

    await clearTenant();
    await db.org.create({ data: { id: ORG, name: "Body field types" } });
    await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: `${ADMIN}@bodyfieldtypes.test`, role: "admin", clerkId: `clerk-${ADMIN}` },
    });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: ROOT } });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
  }, 60_000);

  afterAll(async () => {
    await clearTenant();
    await db.$disconnect();
  });

  beforeEach(async () => {
    vi.mocked(ingestMemory).mockClear();
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
  });

  it("each field sent as every other JSON type is a 400 naming the field and type; nothing checked or written", async () => {
    const scopesBefore = await scopeRows();
    const grantsBefore = await grantRows();
    for (const route of routes) {
      for (const field of route.fields) {
        for (const [kind, value] of NOT_A_STRING) {
          const res = await route.handle(post(JSON.stringify({ [field]: value })));

          expect({ route: route.name, field, value, status: res.status }).toEqual({
            route: route.name,
            field,
            value,
            status: 400,
          });
          expect((await res.json()).error).toBe(`${field} must be a string, not ${kind}`);
        }
      }
    }
    expect(await auditRows()).toBe(0);
    expect(await scopeRows()).toBe(scopesBefore);
    expect(await grantRows()).toBe(grantsBefore);
    expect(ingestMemory).not.toHaveBeenCalled();
  });

  it.each([
    ["null", "null"],
    ["a string", JSON.stringify("eng")],
    ["a number", "7"],
    ["an array", JSON.stringify([{ name: "eng" }])],
  ])("a body that is %s, not a JSON object, is a 400 naming that on every route; no audit row", async (kind, body) => {
    for (const route of routes) {
      const res = await route.handle(post(body));

      expect({ route: route.name, status: res.status }).toEqual({ route: route.name, status: 400 });
      expect((await res.json()).error).toBe(`request body must be a JSON object, not ${kind}`);
    }
    expect(await auditRows()).toBe(0);
  });

  it("a null field is still read as absent, not refused by type", async () => {
    const scopes = routes[0];
    const res = await scopes.handle(post(JSON.stringify({ name: null })));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("name is required");
  });

  it.each(["constructor", "toString", "__proto__"])(
    "a dispute resolution of %j, an Object.prototype key, is refused as an unknown resolution",
    async (resolution) => {
      const resolve = routes.find((r) => r.name === "POST /api/facts/disputes/:id/resolve")!;
      const res = await resolve.handle(post(JSON.stringify({ resolution })));

      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("resolution must be one of: proposer, existing, reconciled");
    },
  );

  it("string fields are still accepted: a scope is created under a string parentPath, then granted", async () => {
    const created = await routes[0].handle(post(JSON.stringify({ name: "  Engineering  ", parentPath: ROOT })));
    expect(created.status).toBe(201);
    const { scope } = await created.json();
    expect(scope).toMatchObject({ name: "Engineering" });
    expect(scope.path.startsWith(`${ROOT}.engineering_`)).toBe(true);

    const granted = await routes[1].handle(
      post(
        JSON.stringify({
          scopePath: ` ${scope.path} `,
          granteeType: "role",
          granteeId: " member ",
          permission: "read",
        }),
      ),
    );
    expect(granted.status).toBe(201);
    expect((await granted.json()).grant).toMatchObject({
      granteeType: "role",
      granteeId: "member",
      permission: "read",
    });
  });
});
