// An org admin can permanently remove three kinds of record that otherwise have no
// removal path, so a scope that held only those can then be deleted:
//
//   DELETE /api/sources/:id/permanent             a disconnected source
//   DELETE /api/memory/conventions/:id/permanent  a retired convention
//   DELETE /api/briefs/:id                        a brief
//
// Each decides `access.manage` at the org root before it looks the record up, so a
// caller without it gets the same 403, and the same one deny row, for a real id and
// for one never issued. Each refuses a record a removal would change something for (a
// connected source or one with records left to retire, an active convention, one whose
// removal would put another back in service) with a 409 that names the fix. A removal
// that happens leaves one visible `record.removed` row naming what went by id; one that
// does not leaves none. The row never copies a record's name, title or subject: the
// audit log is append-only, so a person erased later could not be scrubbed out of it.
//
// Drives the real routes against Postgres. Only the signed-in identity and the memory
// service (the graph counts a source removal and a scope delete ask for) are stubbed.
// Set QA_DATABASE_URL to an isolated test database. Skips cleanly without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { toGid } from "@/services/memory/graphiti-store";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const ORG = `adminrm${RUN}`;
const OTHER_ORG = `adminrmother${RUN}`;
const ROOT = `org_${ORG}`;
const SCOPE = `${ROOT}.probe`;
const OTHER_ROOT = `org_${OTHER_ORG}`;
const ADMIN = `u-admin-${RUN}`;
const MEMBER = `u-member-${RUN}`;
const SCOPE_ADMIN = `u-scope-admin-${RUN}`;
const OTHER_ADMIN = `u-other-admin-${RUN}`;
const NEVER_ISSUED = `never-issued-${RUN}`;

const groupResidue = vi.hoisted(() => vi.fn());
// What the graph still holds for a source, as the memory service counts it.
const sourceRecords = vi.hoisted(() => vi.fn());
// The disconnect this file runs once purges the source's graph facts.
const removeGroupFacts = vi.hoisted(() => vi.fn(async () => ({ removedCount: 0 })));
// A person erasure's graph step; the graph holds nothing of the person here.
const planPersonErasure = vi.hoisted(() => vi.fn(async () => []));
const erasePersonFromGraph = vi.hoisted(() =>
  vi.fn(async () => ({ episodes: 0, nodes: 0, edges: 0, summaries: 0, episodeIds: [] })),
);
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/services/memory/store", () => ({
  graphitiStore: {
    groupResidue,
    sourceRecords,
    removeGroupFacts,
    planPersonErasure,
    erasePerson: erasePersonFromGraph,
  },
  memory: {},
}));

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

describe.skipIf(!QA_URL)("admin removal of out-of-service records, real Postgres", () => {
  let db: PrismaClient;
  let routes: {
    source: Handler;
    convention: Handler;
    brief: Handler;
    scope: Handler;
    disconnect: Handler;
    retire: Handler;
  };
  let signIn: (userId: string) => Promise<void>;
  let scopeId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    routes = {
      source: (await import("./sources/[id]/permanent/route")).DELETE,
      convention: (await import("./memory/conventions/[id]/permanent/route")).DELETE,
      brief: (await import("./briefs/[id]/route")).DELETE,
      scope: (await import("./access/scopes/[id]/route")).DELETE,
      disconnect: (await import("./sources/[id]/route")).DELETE,
      retire: (await import("./memory/conventions/[id]/route")).DELETE,
    };

    await db.org.create({ data: { id: ORG, name: "admin removal" } });
    await db.org.create({ data: { id: OTHER_ORG, name: "admin removal other" } });
    const users: [string, string, "admin" | "member"][] = [
      [ADMIN, ORG, "admin"],
      [MEMBER, ORG, "member"],
      [SCOPE_ADMIN, ORG, "member"],
      [OTHER_ADMIN, OTHER_ORG, "admin"],
    ];
    for (const [id, orgId, role] of users) {
      await db.user.create({ data: { id, orgId, role, email: `${id}@admin-removal.test`, clerkId: `clerk-${id}` } });
    }
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    const otherRoot = await db.scope.create({ data: { orgId: OTHER_ORG, path: OTHER_ROOT, name: "root" } });
    const probe = await db.scope.create({ data: { orgId: ORG, path: SCOPE, name: "probe" } });
    scopeId = probe.id;
    await db.grant.createMany({
      data: [
        { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
        // A member who can read everything, so a refusal is not a 404 for want of reach.
        { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: MEMBER, permission: "write" },
        // Administers the scope the records live in, but not the org.
        { orgId: ORG, scopeId: probe.id, granteeType: "user", granteeId: SCOPE_ADMIN, permission: "admin" },
        { orgId: OTHER_ORG, scopeId: otherRoot.id, granteeType: "user", granteeId: OTHER_ADMIN, permission: "admin" },
      ],
    });

    const { requireAccessContext } = await import("@/lib/access-context");
    signIn = async (userId) => {
      const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
      vi.mocked(requireAccessContext).mockResolvedValue({
        org: await db.org.findUniqueOrThrow({ where: { id: user.orgId } }),
        user,
        ctx: { orgId: user.orgId, actor: { type: "human", id: userId, role: user.role }, origin: "app" },
      } as never);
    };
  });

  beforeEach(() => {
    groupResidue.mockReset();
    groupResidue.mockResolvedValue({ facts: 0, episodes: 0 });
    sourceRecords.mockReset();
    sourceRecords.mockResolvedValue([]);
  });

  afterAll(async () => {
    if (!db) return;
    const orgs = { in: [ORG, OTHER_ORG] };
    for (const model of [
      db.changeEvent,
      db.factEdge,
      db.convention,
      db.brief,
      db.source,
      db.grant,
      db.scope,
      db.user,
    ] as unknown as { deleteMany(args: unknown): Promise<unknown> }[]) {
      await model.deleteMany({ where: { orgId: orgs } });
    }
    // Deleting the org removes its audit rows through the one cascade the append-only
    // trigger allows.
    await db.org.deleteMany({ where: { id: orgs } });
    await db.$disconnect();
  });

  let n = 0;
  const seed = {
    source: (status: "active" | "disconnected", orgId = ORG) =>
      db.source.create({
        data: {
          orgId,
          type: "website",
          externalId: `site-${RUN}-${++n}`,
          name: `site ${n}`,
          scopePath: orgId === ORG ? SCOPE : OTHER_ROOT,
          status,
        },
      }),
    convention: (retired: boolean, extra: { supersedesId?: string; supersededById?: string; orgId?: string } = {}) =>
      db.convention.create({
        data: {
          orgId: extra.orgId ?? ORG,
          scopePath: (extra.orgId ?? ORG) === ORG ? SCOPE : OTHER_ROOT,
          kind: "convention",
          subject: `rule ${++n}`,
          text: "dedupe accounts by domain",
          actorId: ADMIN,
          supersedesId: extra.supersedesId,
          supersededById: extra.supersededById,
          ...(retired ? { retiredAt: new Date(), retiredBy: ADMIN } : {}),
        },
      }),
    brief: (orgId = ORG) =>
      db.brief.create({
        data: {
          orgId,
          type: "handoff",
          scopePath: orgId === ORG ? SCOPE : OTHER_ROOT,
          title: `brief ${++n}`,
          summary: "s",
          sections: [],
        },
      }),
    supersedesEdge: (fromId: string, toId: string) =>
      db.factEdge.create({
        data: { orgId: ORG, fromId, toId, kind: "supersedes", scopePath: SCOPE, actorType: "human", actorId: ADMIN },
      }),
  };

  async function call(handler: Handler, id: string) {
    const before = await db.auditLog.count({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
    const res = await handler(new Request("http://t", { method: "DELETE" }), { params: Promise.resolve({ id }) });
    const rows = await db.auditLog.findMany({
      where: { orgId: { in: [ORG, OTHER_ORG] } },
      orderBy: { at: "asc" },
      skip: before,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, rows };
  }

  const removals = <Row extends { action: string }>(rows: Row[]) => rows.filter((r) => r.action === "record.removed");

  /** The three removals: how to make a removable record, find it, and what its rows name. */
  const KINDS = [
    {
      name: "source",
      route: () => routes.source,
      removable: async (orgId = ORG) => {
        const s = await seed.source("disconnected", orgId);
        return { id: s.id, name: s.name };
      },
      exists: async (id: string) => (await db.source.count({ where: { id } })) === 1,
      decisionTarget: (id: string) => `${ROOT}/sources:delete:${id}`,
    },
    {
      name: "convention",
      route: () => routes.convention,
      removable: async (orgId = ORG) => {
        const c = await seed.convention(true, { orgId });
        return { id: c.id, name: c.subject };
      },
      exists: async (id: string) => (await db.convention.count({ where: { id } })) === 1,
      decisionTarget: (id: string) => `${ROOT}/conventions:delete:${id}`,
    },
    {
      name: "brief",
      route: () => routes.brief,
      removable: async (orgId = ORG) => {
        const b = await seed.brief(orgId);
        return { id: b.id, name: b.title };
      },
      exists: async (id: string) => (await db.brief.count({ where: { id } })) === 1,
      decisionTarget: (id: string) => `${ROOT}/briefs:delete:${id}`,
    },
  ];

  describe.each(KINDS)("$name", (kind) => {
    it("a member gets the same 403 and one deny row for a real id and a never-issued one, and nothing is removed", async () => {
      const { id } = await kind.removable();
      await signIn(MEMBER);
      const real = await call(kind.route(), id);
      const missing = await call(kind.route(), NEVER_ISSUED);

      expect(real.status).toBe(403);
      expect({ status: missing.status, body: missing.body }).toEqual({ status: real.status, body: real.body });
      for (const res of [real, missing]) {
        expect(res.rows).toHaveLength(1);
        expect(res.rows[0]).toMatchObject({ actorId: MEMBER, action: "access.manage", decision: "deny" });
      }
      expect(await kind.exists(id)).toBe(true);
    });

    it("an admin of the record's own scope who is not an org admin is refused", async () => {
      const { id } = await kind.removable();
      await signIn(SCOPE_ADMIN);
      const res = await call(kind.route(), id);

      expect(res.status).toBe(403);
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0]).toMatchObject({ actorId: SCOPE_ADMIN, decision: "deny" });
      expect(await kind.exists(id)).toBe(true);
    });

    it("another org's admin gets a 404, the record stays, and no removal is recorded", async () => {
      const { id } = await kind.removable();
      await signIn(OTHER_ADMIN);
      const res = await call(kind.route(), id);

      expect(res.status).toBe(404);
      expect(removals(res.rows)).toEqual([]);
      expect(await kind.exists(id)).toBe(true);
    });

    it("an org admin removes it: one decision row, and one visible record.removed row naming what went by id", async () => {
      const { id, name } = await kind.removable();
      await signIn(ADMIN);
      const res = await call(kind.route(), id);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ deleted: id });
      expect(await kind.exists(id)).toBe(false);
      expect(res.rows).toHaveLength(2);
      expect(res.rows.find((r) => r.action === "access.manage")).toMatchObject({
        actorId: ADMIN,
        decision: "allow",
        target: kind.decisionTarget(id),
      });
      const [removal] = removals(res.rows);
      expect(removal).toMatchObject({
        orgId: ORG,
        actorType: "human",
        actorId: ADMIN,
        decision: "allow",
        target: `${SCOPE}/${kind.name}:${id}`,
        metadata: expect.objectContaining({ kind: kind.name, id, scopePath: SCOPE, origin: "app" }),
      });
      expect(removal!.metadata).not.toHaveProperty("name");
      expect(JSON.stringify(removal!.metadata)).not.toContain(name);

      const again = await call(kind.route(), id);
      expect(again.status).toBe(404);
      expect(removals(again.rows)).toEqual([]);
    });
  });

  it("every removal shows on the audit screens, and its decision row does not", async () => {
    const { isVisibleAuditRow, visibleAuditRowSql } = await import("@/services/audit/visibility");
    await signIn(ADMIN);
    const ids: string[] = [];
    for (const kind of KINDS) {
      const { id } = await kind.removable();
      expect((await call(kind.route(), id)).status).toBe(200);
      ids.push(id);
    }
    const shown = await db.$queryRaw<{ action: string; target: string }[]>(Prisma.sql`
      SELECT "action", "target" FROM "audit_log"
      WHERE "orgId" = ${ORG} AND ${visibleAuditRowSql()}
    `);
    for (const [i, kind] of KINDS.entries()) {
      const target = `${SCOPE}/${kind.name}:${ids[i]}`;
      expect(shown, kind.name).toContainEqual({ action: "record.removed", target });
      expect(isVisibleAuditRow("record.removed", target, "allow")).toBe(true);
      expect(shown.map((r) => r.target)).not.toContain(kind.decisionTarget(ids[i]!));
    }
  });

  describe("a record a removal would still change something for is refused, with the fix named", () => {
    beforeEach(() => signIn(ADMIN));

    async function expectRefused(handler: Handler, id: string, status: number, error: RegExp | string) {
      const res = await call(handler, id);
      expect(res.status).toBe(status);
      expect(res.body.error).toMatch(error);
      expect(removals(res.rows)).toEqual([]);
      return res;
    }

    it("a connected source", async () => {
      for (const status of ["active", "syncing", "error"] as const) {
        const source = await db.source.create({
          data: {
            orgId: ORG,
            type: "website",
            externalId: `live-${RUN}-${++n}`,
            name: "live",
            scopePath: SCOPE,
            status,
          },
        });
        await expectRefused(routes.source, source.id, 409, /disconnect it first/);
        expect(await db.source.count({ where: { id: source.id } })).toBe(1);
      }
    });

    it("a disconnected source whose records a failed or late retirement left behind", async () => {
      const source = await seed.source("disconnected");
      // A sync record its last sweep did not clear, and facts still stamped with it.
      await db.sourceFile.create({ data: { sourceId: source.id, externalFileId: "late", checksum: "c" } });
      const res = await expectRefused(routes.source, source.id, 409, /disconnect it again/);
      expect(res.body.remaining).toEqual([expect.objectContaining({ scopePath: SCOPE, syncRecords: 1 })]);
      await db.sourceFile.deleteMany({ where: { sourceId: source.id } });

      sourceRecords.mockResolvedValue([
        {
          groupId: toGid(SCOPE),
          episodes: 0,
          facts: 2,
          factEmbeddings: 0,
          verbatimNodes: 0,
          orphans: 0,
          danglingFacts: 0,
        },
      ]);
      await expectRefused(routes.source, source.id, 409, /disconnect it again/);
      expect(await db.source.count({ where: { id: source.id } })).toBe(1);

      // An orphaned entity carries no source stamp: another disconnect could not find it.
      sourceRecords.mockResolvedValue([
        {
          groupId: toGid(SCOPE),
          episodes: 0,
          facts: 0,
          factEmbeddings: 0,
          verbatimNodes: 0,
          orphans: 1,
          danglingFacts: 0,
        },
      ]);
      expect((await call(routes.source, source.id)).status).toBe(200);
    });

    it("a disconnected source when the memory service cannot say what it left", async () => {
      const { MemoryServiceError } = await import("@/services/memory/graphiti-store");
      const source = await seed.source("disconnected");
      sourceRecords.mockRejectedValue(new MemoryServiceError("memory service sourceRecords failed: 503", 503));
      await expectRefused(routes.source, source.id, 502, /was kept/);
      expect(await db.source.count({ where: { id: source.id } })).toBe(1);
    });

    it("an active convention", async () => {
      const rule = await seed.convention(false);
      await expectRefused(routes.convention, rule.id, 409, /retire it first/);
      expect(await db.convention.count({ where: { id: rule.id } })).toBe(1);
    });

    it("a convention that lost the race to replace another and was never retired, without calling it in force", async () => {
      // Never served, since a newer version won, but not retired either: the fix is the
      // same, and the message must not claim the rule is in force.
      const winner = await seed.convention(false);
      const loser = await seed.convention(false, { supersededById: winner.id });
      const res = await expectRefused(routes.convention, loser.id, 409, /is not retired; retire it first/);
      expect(res.body.error).not.toMatch(/in force/);
      expect(await db.convention.count({ where: { id: loser.id } })).toBe(1);
    });

    it("a retired convention whose removal would put the version it replaced back in service", async () => {
      const older = await seed.convention(false);
      const newer = await seed.convention(true, { supersedesId: older.id });
      await expectRefused(routes.convention, newer.id, 409, older.id);
      expect(await db.convention.count({ where: { id: newer.id } })).toBe(1);
    });

    it("a retired convention a newer version replaced", async () => {
      const older = await seed.convention(true);
      const newer = await seed.convention(true, { supersedesId: older.id });
      await expectRefused(routes.convention, older.id, 409, newer.id);
      expect(await db.convention.count({ where: { id: older.id } })).toBe(1);
    });

    it("a retired convention a version that lost the race to replace it still names", async () => {
      const winner = await seed.convention(true);
      const loser = await seed.convention(true, { supersededById: winner.id });
      await expectRefused(routes.convention, winner.id, 409, loser.id);
      expect(await db.convention.count({ where: { id: winner.id } })).toBe(1);
    });
  });

  it("removing a version chain keeps its supersedes edges, so the older version still names its replacement", async () => {
    await signIn(ADMIN);
    const { readMemoryVersion } = await import("@/services/memory/versions");
    const ctx = {
      orgId: ORG,
      actor: { type: "human" as const, id: ADMIN, role: "admin" as const },
      origin: "app" as const,
    };
    const older = await seed.convention(true);
    const newer = await seed.convention(true, { supersedesId: older.id });
    await seed.supersedesEdge(newer.id, older.id);

    const removedNewer = await call(routes.convention, newer.id);
    expect(removedNewer.status).toBe(200);
    expect(removals(removedNewer.rows)[0]?.metadata).toMatchObject({ supersedes: [older.id], supersededBy: [] });

    // The older version is still retired, and still says what replaced it.
    expect(await readMemoryVersion(ctx, older.id)).toMatchObject({
      status: "retired",
      supersededById: newer.id,
    });
    expect(await readMemoryVersion(ctx, newer.id)).toBeNull();

    const removedOlder = await call(routes.convention, older.id);
    expect(removedOlder.status).toBe(200);
    expect(removals(removedOlder.rows)[0]?.metadata).toMatchObject({ supersedes: [], supersededBy: [newer.id] });
    expect(
      await db.factEdge.count({ where: { orgId: ORG, kind: "supersedes", fromId: newer.id, toId: older.id } }),
    ).toBe(1);
  });

  it("a removed rule's row names the version it replaced even when no supersedes edge records it", async () => {
    // Rules written before supersedes edges existed carry the link only on the row.
    await signIn(ADMIN);
    const older = await seed.convention(true);
    const newer = await seed.convention(true, { supersedesId: older.id });

    const removed = await call(routes.convention, newer.id);
    expect(removed.status).toBe(200);
    expect(removals(removed.rows)[0]?.metadata).toMatchObject({ supersedes: [older.id], supersededBy: [] });
  });

  it("removing a source or a brief tells the change feed, and takes their dependent rows", async () => {
    await signIn(ADMIN);
    const source = await seed.source("disconnected");
    const brief = await seed.brief();
    await db.briefProvenance.create({ data: { briefId: brief.id, sourceIds: [source.id] } });

    expect((await call(routes.source, source.id)).status).toBe(200);
    expect((await call(routes.brief, brief.id)).status).toBe(200);

    expect(await db.briefProvenance.count({ where: { briefId: brief.id } })).toBe(0);
    const events = await db.changeEvent.findMany({
      where: { orgId: ORG, recordId: { in: [source.id, brief.id] } },
      select: { recordType: true, recordId: true, op: true, scopePath: true, actorId: true, summary: true },
    });
    // The feed, not the audit row, says what the record was called; erasure can blank it.
    expect(events).toEqual(
      expect.arrayContaining([
        {
          recordType: "source",
          recordId: source.id,
          op: "delete",
          scopePath: SCOPE,
          actorId: ADMIN,
          summary: source.name,
        },
        {
          recordType: "brief",
          recordId: brief.id,
          op: "delete",
          scopePath: SCOPE,
          actorId: ADMIN,
          summary: `deleted: ${brief.title}`,
        },
      ]),
    );
  });

  // Two removals of one record at once, the second reaching its delete after the first
  // committed: the row is gone once and recorded once. A test transaction holds the row
  // locked until both requests are waiting on it, so the race happens every run.
  describe("two removals racing for one record", () => {
    const TABLES = { source: "sources", convention: "conventions", brief: "briefs" } as const;

    async function waitersOn(table: string) {
      const [row] = await db.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE $1`,
        // Plain reads never wait on a row lock, so every waiter on this table is a delete.
        `%"public"."${table}"%`,
      );
      return Number(row.n);
    }

    it.each(KINDS)(
      "$name: one 200, one 404, one record.removed row",
      async (kind) => {
        await signIn(ADMIN);
        const { id } = await kind.removable();
        const table = TABLES[kind.name as keyof typeof TABLES];
        let both: Promise<Response[]> | undefined;
        await db.$transaction(
          async (tx) => {
            await tx.$executeRawUnsafe(`SELECT 1 FROM "${table}" WHERE id = $1 FOR UPDATE`, id);
            both = Promise.all(
              [0, 1].map(() =>
                kind.route()(new Request("http://t", { method: "DELETE" }), { params: Promise.resolve({ id }) }),
              ),
            );
            // A deadline, not a count of polls (200 x 25 ms), so a loaded machine gets time to queue both.
            for (const deadline = Date.now() + 20_000; Date.now() < deadline && (await waitersOn(table)) < 2; )
              await new Promise((r) => setTimeout(r, 25));
            expect(await waitersOn(table)).toBe(2);
          },
          { timeout: 30_000 },
        );
        const statuses = (await both!).map((r) => r.status).sort();
        expect(statuses).toEqual([200, 404]);
        expect(await kind.exists(id)).toBe(false);
        const rows = await db.auditLog.findMany({ where: { orgId: ORG, action: "record.removed" } });
        expect(rows.filter((r) => (r.metadata as { id?: string }).id === id)).toHaveLength(1);
      },
      60_000,
    );
  });

  it("a person erased after an admin removed records named for them leaves no audit row naming them", async () => {
    // The audit log is append-only and erasure never rewrites it, so a removal row that
    // copied a brief's title, a rule's subject or a source's name would keep the person
    // there for good. Removing the brief by hand must not turn an erasable copy into a
    // permanent one.
    await signIn(ADMIN);
    const person = "Dana Whitfield";
    const contact = await db.contact.create({ data: { orgId: ORG, name: person, email: `dana-${RUN}@acme.example` } });
    const source = await db.source.create({
      data: {
        orgId: ORG,
        type: "website",
        externalId: `named-${RUN}`,
        name: `${person} inbox`,
        scopePath: SCOPE,
        status: "disconnected",
      },
    });
    const rule = await db.convention.create({
      data: {
        orgId: ORG,
        scopePath: SCOPE,
        kind: "convention",
        subject: `${person}'s accounts`,
        text: "route renewals to the account owner",
        actorId: ADMIN,
        retiredAt: new Date(),
        retiredBy: ADMIN,
      },
    });
    const brief = await db.brief.create({
      data: {
        orgId: ORG,
        type: "handoff",
        scopePath: SCOPE,
        title: `Handoff: ${person}'s accounts`,
        summary: "s",
        sections: [],
      },
    });
    for (const [handler, id] of [
      [routes.source, source.id],
      [routes.convention, rule.id],
      [routes.brief, brief.id],
    ] as const) {
      expect((await call(handler, id)).status).toBe(200);
    }

    const { erasePerson } = await import("@/services/memory/person-erasure");
    await erasePerson(
      { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "app" },
      {
        contactId: contact.id,
      },
    );

    const audit = await db.$queryRaw<{ action: string; target: string }[]>(Prisma.sql`
      SELECT "action", "target" FROM "audit_log"
      WHERE "orgId" = ${ORG} AND ("metadata"::text ILIKE '%whitfield%' OR "target" ILIKE '%whitfield%')
    `);
    expect(audit).toEqual([]);
    const feed = await db.$queryRaw<{ summary: string }[]>(Prisma.sql`
      SELECT "summary" FROM "change_events" WHERE "orgId" = ${ORG} AND "summary" ILIKE '%whitfield%'
    `);
    expect(feed).toEqual([]);
  });

  it("a source reconnected while its records are being counted is kept, and no removal is recorded", async () => {
    await signIn(ADMIN);
    const source = await seed.source("disconnected");
    sourceRecords.mockImplementation(async () => {
      await db.source.update({ where: { id: source.id }, data: { status: "active" } });
      return [];
    });
    const res = await call(routes.source, source.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/disconnect it first/);
    expect(removals(res.rows)).toEqual([]);
    expect(await db.source.count({ where: { id: source.id } })).toBe(1);
  });

  it("a scope that held only these records can be deleted once they are removed", async () => {
    await signIn(ADMIN);
    // Start from an empty probe scope: earlier cases may have left records in it.
    await db.source.deleteMany({ where: { orgId: ORG } });
    await db.factEdge.deleteMany({ where: { orgId: ORG } });
    await db.convention.updateMany({ where: { orgId: ORG }, data: { supersedesId: null } });
    await db.convention.deleteMany({ where: { orgId: ORG } });
    await db.brief.deleteMany({ where: { orgId: ORG } });

    // A connected-then-disconnected source, a rule retired through its route and a
    // brief: the residue a probe run leaves behind.
    const source = await seed.source("active");
    expect((await call(routes.disconnect, source.id)).status).toBe(200);
    const rule = await seed.convention(false);
    expect((await call(routes.retire, rule.id)).status).toBe(200);
    const brief = await seed.brief();

    const blocked = await call(routes.scope, scopeId);
    expect(blocked.status).toBe(409);
    expect(blocked.body.remaining).toEqual({ sources: 1, conventions: 1, briefs: 1 });

    for (const [handler, id] of [
      [routes.source, source.id],
      [routes.convention, rule.id],
      [routes.brief, brief.id],
    ] as const) {
      expect((await call(handler, id)).status).toBe(200);
    }

    const deleted = await call(routes.scope, scopeId);
    expect(deleted.status).toBe(204);
    expect(await db.scope.count({ where: { id: scopeId } })).toBe(0);
  });
});
