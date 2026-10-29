// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Routes that load one record by id and then authorize against the scope it is
// stored at must answer a caller who cannot read that scope exactly as they
// answer an id that was never issued: same status, same body. A 403 (or a 409
// about the record's state) for "exists but hidden" next to a 404 for "absent"
// lets a scope admin probe which ids are real in scopes they hold no grant on,
// and a 403 carrying the deny reason also names the hidden scope.
//
// Runs the shipping route handlers against a real Postgres 16 with ltree and
// the real access evaluator, two tenants and two scopes. Only authentication is
// mocked. services/access/authorize-record.ts is the rule; the brief routes have their own
// suite in app/api/briefs/[id]/existence-oracle.realdb.test.ts.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-record-oracle";
const OTHER_ORG = "org-record-oracle-other";
const ROOT = "org_ro";
const HIDDEN_SCOPE = "org_ro.legal";
const ADMIN_SCOPE = "org_ro.engineering";
const ABSENT_ID = "record-oracle-never-issued";

const SCOPE_ADMIN = "u-ro-eng-admin"; // admin on engineering only: cannot read legal
const READER = "u-ro-legal-reader"; // read on legal: can see the records, cannot manage them
const OUTSIDER = "u-ro-outsider"; // member of the other org

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
type Route = { method: string; path: string; handler: Handler; body?: unknown };

describe.skipIf(!QA_URL)("record routes do not disclose whether a hidden record exists", () => {
  let db: PrismaClient;
  let requireAccessContext: ReturnType<typeof vi.fn>;
  const routes: Record<string, Route> = {};
  const ids: Record<string, string> = {};

  function actAs(orgId: string, userId: string) {
    requireAccessContext.mockResolvedValue({
      org: { id: orgId },
      user: { id: userId },
      ctx: { orgId, actor: { type: "human", id: userId, role: "member" } },
    } as never);
  }

  async function call(name: string, id: string) {
    const { method, path, handler, body } = routes[name];
    const req = new Request(`http://t/api/${path.replace(":id", id)}`, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const res = await handler(req, { params: Promise.resolve({ id }) });
    return { status: res.status, body: await res.json() };
  }

  async function clearTenants() {
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.sourceFile.deleteMany({ where: { source: { orgId } } });
      for (const table of ["auditLog", "factDispute", "capability", "source", "grant", "scope", "user"] as const) {
        await (db[table] as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where: { orgId } });
      }
    }
    await db.org.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ requireAccessContext } = (await import("@/lib/access-context")) as never);

    const resolve = { resolution: "proposer" };
    routes.grant = {
      method: "DELETE",
      path: "access/grants/:id",
      handler: (await import("./access/grants/[id]/route")).DELETE,
    };
    routes.capability = {
      method: "DELETE",
      path: "access/capabilities/:id",
      handler: (await import("./access/capabilities/[id]/route")).DELETE,
    };
    routes.scope = {
      method: "DELETE",
      path: "access/scopes/:id",
      handler: (await import("./access/scopes/[id]/route")).DELETE,
    };
    routes.dispute = {
      method: "POST",
      path: "facts/disputes/:id/resolve",
      handler: (await import("./facts/disputes/[id]/resolve/route")).POST,
      body: resolve,
    };
    routes["source-delete"] = {
      method: "DELETE",
      path: "sources/:id",
      handler: (await import("./sources/[id]/route")).DELETE,
    };
    routes["source-sync"] = {
      method: "POST",
      path: "sources/:id/sync",
      handler: (await import("./sources/[id]/sync/route")).POST,
      body: {},
    };

    await clearTenants();
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.org.create({ data: { id: OTHER_ORG, name: OTHER_ORG } });

    await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    const hidden = await db.scope.create({ data: { orgId: ORG, path: HIDDEN_SCOPE, name: "legal" } });
    const admin = await db.scope.create({ data: { orgId: ORG, path: ADMIN_SCOPE, name: "engineering" } });

    for (const [id, orgId] of [
      [SCOPE_ADMIN, ORG],
      [READER, ORG],
      [OUTSIDER, OTHER_ORG],
    ] as const) {
      await db.user.create({ data: { id, orgId, email: `${id}@qa.test`, role: "member", clerkId: `clerk-${id}` } });
    }
    await db.grant.create({
      data: { orgId: ORG, scopeId: admin.id, granteeType: "user", granteeId: SCOPE_ADMIN, permission: "admin" },
    });
    const readerGrant = await db.grant.create({
      data: { orgId: ORG, scopeId: hidden.id, granteeType: "user", granteeId: READER, permission: "read" },
    });

    // One record of each kind, all stored at the hidden scope.
    ids.grant = readerGrant.id;
    ids.scope = hidden.id;
    ids.capability = (
      await db.capability.create({
        data: {
          orgId: ORG,
          agentId: "agent-ro",
          tokenHash: "hash-ro",
          scopePath: HIDDEN_SCOPE,
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      })
    ).id;
    const dispute = {
      orgId: ORG,
      scopePath: HIDDEN_SCOPE,
      graphitiFactUuid: "fact-ro",
      proposerActorType: "human" as const,
      proposerActorId: READER,
      existingActorType: "human" as const,
      existingActorId: READER,
    };
    ids.dispute = (await db.factDispute.create({ data: dispute })).id;
    ids.resolvedDispute = (await db.factDispute.create({ data: { ...dispute, status: "resolved_proposer" } })).id;
    const source = { orgId: ORG, type: "gdrive" as const, name: "drive", scopePath: HIDDEN_SCOPE };
    ids.source = (await db.source.create({ data: { ...source, externalId: "folder-ro" } })).id;
    ids.disconnectedSource = (
      await db.source.create({ data: { ...source, externalId: "folder-ro-off", status: "disconnected" } })
    ).id;

    // A source moved into the admin's scope that still holds content it wrote
    // at the hidden scope before the move.
    const moved = await db.source.create({
      data: { ...source, externalId: "folder-ro-moved", scopePath: ADMIN_SCOPE },
    });
    ids.movedSource = moved.id;
    await db.sourceFile.create({
      data: { sourceId: moved.id, externalFileId: "file-ro", checksum: "c", episodeScopePath: HIDDEN_SCOPE },
    });
  });

  afterAll(async () => {
    await clearTenants();
    await db.$disconnect();
  });

  const cases: [route: string, record: string, notFound: string][] = [
    ["grant", "grant", "grant not found"],
    ["capability", "capability", "capability not found"],
    ["scope", "scope", "scope not found"],
    ["dispute", "dispute", "dispute not found"],
    ["dispute", "resolvedDispute", "dispute not found"],
    ["source-delete", "source", "source not found"],
    ["source-sync", "source", "source not found"],
    ["source-sync", "disconnectedSource", "source not found"],
  ];

  // Source sync decides at the org root before it looks the source up, so a caller
  // refused there gets one 403 for every id, real or not. The other routes decide on
  // the record's own scope and answer a hidden one with the absent id's 404.
  const DECIDES_BEFORE_LOOKUP = new Set(["source-sync"]);

  it.each(cases)("%s on %s: a hidden record answers exactly like an absent id", async (route, record, notFound) => {
    actAs(ORG, SCOPE_ADMIN);
    const absent = await call(route, ABSENT_ID);
    const hidden = await call(route, ids[record]);

    if (DECIDES_BEFORE_LOOKUP.has(route)) expect(absent.status).toBe(403);
    else expect(absent).toEqual({ status: 404, body: { error: notFound } });
    expect(hidden).toEqual(absent);
  });

  it.each(cases)(
    "%s on %s: another org's record answers exactly like an absent id",
    async (route, record, notFound) => {
      actAs(OTHER_ORG, OUTSIDER);
      const absent = await call(route, ABSENT_ID);

      if (!DECIDES_BEFORE_LOOKUP.has(route)) expect(absent).toEqual({ status: 404, body: { error: notFound } });
      expect(await call(route, ids[record])).toEqual(absent);
    },
  );

  it.each(cases)(
    "%s on %s: a caller who can read the record but not manage it gets 403, which discloses nothing new",
    async (route, record) => {
      actAs(ORG, READER);
      const res = await call(route, ids[record]);
      expect(res.status).toBe(403);
    },
  );

  it("source-delete: a 403 for content the source left in a hidden scope does not name that scope", async () => {
    actAs(ORG, SCOPE_ADMIN);
    const res = await call("source-delete", ids.movedSource);

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain(HIDDEN_SCOPE);
    expect(await db.source.findUniqueOrThrow({ where: { id: ids.movedSource } })).toMatchObject({ status: "active" });
  });

  it("nothing was changed by any denied call", async () => {
    expect(await db.grant.count({ where: { id: ids.grant } })).toBe(1);
    expect(await db.scope.count({ where: { id: ids.scope } })).toBe(1);
    expect(await db.capability.findUniqueOrThrow({ where: { id: ids.capability } })).toMatchObject({ revokedAt: null });
    expect(await db.factDispute.findUniqueOrThrow({ where: { id: ids.dispute } })).toMatchObject({
      status: "disputed",
    });
    expect(await db.source.findUniqueOrThrow({ where: { id: ids.source } })).toMatchObject({ status: "active" });
  });
});
