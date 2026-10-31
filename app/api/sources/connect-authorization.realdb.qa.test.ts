// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// "A sync write names the connect that authorized it", on the axes
// a single-tenant test covers with only one tenant, one
// scope and one connect:
//
//   - a reconnect is a fresh authorization: the source records the newer connect row, the
//     next sync stamps that one, and events already written keep the row in force then;
//   - `GET /api/audit?ids=` only narrows: exactly the named visible rows, nothing for an
//     empty list, another tenant's row, a row outside `?scope=`, or a never-visible row;
//   - a sync-written change is readable only inside its own scope and tenant, and every
//     refusal is the same 404 an absent change gets.
//
// Real: POST /api/sources under check(), the per-item sync (syncOneTextItem /
// retireVanishedTextItem), GET /api/audit, GET /api/audit/timeline/:changeId. Faked: the
// Clerk session and the graph store's ingest (connector content is graph-only).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "case416a";
const OTHER_ORG = "case416b";
const ROOT = `org_${ORG}`;
const SCOPE_A = `${ROOT}.handbook_a`;
const SCOPE_B = `${ROOT}.handbook_b`;
const OTHER_ROOT = `org_${OTHER_ORG}`;
const FIRST_ADMIN = "u-case416-first";
const SECOND_ADMIN = "u-case416-second";
const OTHER_ADMIN = "u-case416b-admin";
const DOMAIN = "handbook.case416.test";
const ABSENT = "00000000-0000-4000-8000-000000000416";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

describe.skipIf(!QA_URL)("connect authorization across reconnects, tenants and scopes, real Postgres", () => {
  let db: PrismaClient;
  let SOURCES: (typeof import("./route"))["POST"];
  let AUDIT: (typeof import("../audit/route"))["GET"];
  let CHANGE: (typeof import("../audit/timeline/[changeId]/route"))["GET"];
  let requireAccessContext: ReturnType<typeof vi.fn>;

  const orgs = [ORG, OTHER_ORG];
  async function wipe() {
    await db.changeEvent.deleteMany({ where: { orgId: { in: orgs } } });
    await db.auditLog.deleteMany({ where: { orgId: { in: orgs } } });
    await db.sourceFile.deleteMany({ where: { source: { orgId: { in: orgs } } } });
    await db.source.deleteMany({ where: { orgId: { in: orgs } } });
    await db.grant.deleteMany({ where: { orgId: { in: orgs } } });
    await db.scope.deleteMany({ where: { orgId: { in: orgs } } });
    await db.user.deleteMany({ where: { orgId: { in: orgs } } });
    await deleteOrgsWithRetry(db, { where: { id: { in: orgs } } });
  }

  const as = (orgId: string, userId: string) =>
    requireAccessContext.mockResolvedValue({
      org: { id: orgId },
      user: { id: userId, name: userId },
      ctx: { orgId, actor: { type: "human", id: userId, role: "admin" } },
    });

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    delete process.env.GRAPHITI_SERVICE_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ POST: SOURCES } = await import("./route"));
    ({ GET: AUDIT } = await import("../audit/route"));
    ({ GET: CHANGE } = await import("../audit/timeline/[changeId]/route"));
    ({ requireAccessContext } = (await import("@/lib/access-context")) as never);

    await wipe();
    for (const id of orgs) await db.org.create({ data: { id, name: `QA 416 ${id}` } });
    for (const [id, orgId] of [
      [FIRST_ADMIN, ORG],
      [SECOND_ADMIN, ORG],
      [OTHER_ADMIN, OTHER_ORG],
    ] as const) {
      await db.user.create({
        data: { id, orgId, email: `${id}@case416.test`, role: "admin", clerkId: `clerk-${id}`, name: id },
      });
    }
    const scope = async (orgId: string, path: string) =>
      (await db.scope.create({ data: { orgId, path, name: path } })).id;
    const root = await scope(ORG, ROOT);
    await scope(ORG, SCOPE_A);
    await scope(ORG, SCOPE_B);
    const otherRoot = await scope(OTHER_ORG, OTHER_ROOT);
    for (const userId of [FIRST_ADMIN, SECOND_ADMIN]) {
      await db.grant.create({
        data: { orgId: ORG, scopeId: root, granteeType: "user", granteeId: userId, permission: "admin" },
      });
    }
    await db.grant.create({
      data: { orgId: OTHER_ORG, scopeId: otherRoot, granteeType: "user", granteeId: OTHER_ADMIN, permission: "admin" },
    });
  }, 60_000);

  afterAll(async () => {
    await wipe();
    await db.$disconnect();
  });

  beforeEach(async () => {
    await db.changeEvent.deleteMany({ where: { orgId: { in: orgs } } });
    await db.auditLog.deleteMany({ where: { orgId: { in: orgs } } });
    await db.sourceFile.deleteMany({ where: { source: { orgId: { in: orgs } } } });
    await db.source.deleteMany({ where: { orgId: { in: orgs } } });
    const { graphitiStore } = await import("@/services/memory");
    let next = 0;
    vi.spyOn(graphitiStore, "ingest").mockImplementation(
      async () => ({ episodeId: `case416-episode-${++next}` }) as never,
    );
    vi.spyOn(graphitiStore, "removeEpisode").mockResolvedValue({ removed: true } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function connect(userId: string, scopePath: string, domain = DOMAIN) {
    as(ORG, userId);
    const res = await SOURCES(
      new Request("http://t/api/sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "website", domain, scopePath }),
      }),
    );
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { source: { id: string } }).source.id;
    const { connectAuthorizationId } = await db.source.findUniqueOrThrow({
      where: { id },
      select: { connectAuthorizationId: true },
    });
    return { sourceId: id, connectAuthorizationId: connectAuthorizationId! };
  }

  async function sync(sourceId: string, items: { id: string; checksum: string; text: string }[]) {
    const { planConnectorSync } = await import("@/lib/inngest/connector-records");
    const { retireVanishedTextItem, syncOneTextItem } = await import("@/lib/inngest/connector-text-items");
    const source = await db.source.findUniqueOrThrow({
      where: { id: sourceId },
      select: { id: true, orgId: true, type: true, name: true, scopePath: true, connectAuthorizationId: true },
    });
    const existing = (await db.sourceFile.findMany({ where: { sourceId } })).map((f) => ({
      externalFileId: f.externalFileId,
      checksum: f.checksum,
      episodeId: f.episodeId,
      episodeScopePath: f.episodeScopePath,
    }));
    const plan = planConnectorSync(existing, items, source.scopePath);
    for (const { item, previousEpisode } of plan.toIngest)
      expect(await syncOneTextItem(source, item, previousEpisode)).toBe("synced");
    for (const stale of plan.toRetire) expect(await retireVanishedTextItem(source, stale)).toBe("retired");
  }

  const factEvents = () =>
    db.changeEvent.findMany({ where: { orgId: ORG, recordType: "fact" }, orderBy: { seq: "asc" } });

  async function auditIds(query: string, orgId = ORG, userId = FIRST_ADMIN): Promise<string[]> {
    as(orgId, userId);
    const res = await AUDIT(new Request(`http://t/api/audit?${query}`));
    expect(res.status).toBe(200);
    return ((await res.json()) as { entries: { id: string }[] }).entries.map((e) => e.id);
  }

  async function detail(changeId: string, scope: string, orgId = ORG, userId = FIRST_ADMIN) {
    as(orgId, userId);
    const res = await CHANGE(new Request(`http://t/api/audit/timeline/x?scope=${scope}`), {
      params: Promise.resolve({ changeId }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it("a reconnect by another person replaces the connect row; old events keep theirs, new syncs stamp the new one", async () => {
    const first = await connect(FIRST_ADMIN, SCOPE_A);
    await sync(first.sourceId, [{ id: "p0", checksum: "c0", text: "Deploys need two reviewers" }]);

    const second = await connect(SECOND_ADMIN, SCOPE_A);
    expect(second.sourceId).toBe(first.sourceId);
    expect(second.connectAuthorizationId).not.toBe(first.connectAuthorizationId);
    const secondRow = await db.auditLog.findUniqueOrThrow({ where: { id: second.connectAuthorizationId } });
    expect(secondRow).toMatchObject({ actorId: SECOND_ADMIN, action: "memory.write", decision: "allow" });

    await sync(first.sourceId, [
      { id: "p0", checksum: "c0", text: "Deploys need two reviewers" },
      { id: "p1", checksum: "c0", text: "Hotfixes skip the train" },
    ]);
    const events = await factEvents();
    expect(events.map((e) => e.authorizedById)).toEqual([first.connectAuthorizationId, second.connectAuthorizationId]);

    const answer = await detail(events[1]!.id, SCOPE_A);
    expect(answer.body).toMatchObject({ authorizedById: second.connectAuthorizationId, authorizationKind: "connect" });
  });

  it("?ids names exactly the visible rows asked for, and nothing more", async () => {
    const a = await connect(FIRST_ADMIN, SCOPE_A);
    const b = await connect(FIRST_ADMIN, SCOPE_B, "other.case416.test");
    const all = await auditIds("");
    expect(all).toEqual(expect.arrayContaining([a.connectAuthorizationId, b.connectAuthorizationId]));
    expect(all.length).toBeGreaterThan(1);

    expect(await auditIds(`ids=${a.connectAuthorizationId}`)).toEqual([a.connectAuthorizationId]);
    expect((await auditIds(`ids=${a.connectAuthorizationId},${b.connectAuthorizationId}`)).sort()).toEqual(
      [a.connectAuthorizationId, b.connectAuthorizationId].sort(),
    );
  });

  it("an empty ?ids list matches nothing rather than the whole log", async () => {
    await connect(FIRST_ADMIN, SCOPE_A);
    expect(await auditIds("ids=")).toEqual([]);
    expect(await auditIds("ids=,%20,")).toEqual([]);
  });

  it("?ids never widens past the scope filter, the tenant, or the visibility rule", async () => {
    const a = await connect(FIRST_ADMIN, SCOPE_A);
    const hidden = await db.auditLog.create({
      data: {
        orgId: ORG,
        actorType: "human",
        actorId: FIRST_ADMIN,
        action: "memory.write.applied",
        target: SCOPE_A,
        decision: "allow",
      },
    });

    expect(await auditIds(`ids=${a.connectAuthorizationId}&scope=${SCOPE_B}`)).toEqual([]);
    expect(await auditIds(`ids=${a.connectAuthorizationId}&scope=${SCOPE_A}`)).toEqual([a.connectAuthorizationId]);
    expect(await auditIds(`ids=${a.connectAuthorizationId}`, OTHER_ORG, OTHER_ADMIN)).toEqual([]);
    expect(await auditIds(`ids=${hidden.id}`)).toEqual([]);
  });

  it("a sync change reads only inside its own scope and tenant; every refusal matches an absent change", async () => {
    const a = await connect(FIRST_ADMIN, SCOPE_A);
    await sync(a.sourceId, [{ id: "p0", checksum: "c0", text: "The handbook is reviewed quarterly" }]);
    const [event] = await factEvents();

    expect((await detail(event!.id, SCOPE_A)).status).toBe(200);
    expect((await detail(event!.id, ROOT)).status).toBe(200);

    const sibling = await detail(event!.id, SCOPE_B);
    const absentSibling = await detail(ABSENT, SCOPE_B);
    expect(sibling).toEqual(absentSibling);
    expect(sibling.status).toBe(404);

    const foreign = await detail(event!.id, OTHER_ROOT, OTHER_ORG, OTHER_ADMIN);
    const absentForeign = await detail(ABSENT, OTHER_ROOT, OTHER_ORG, OTHER_ADMIN);
    expect(foreign).toEqual(absentForeign);
    expect(foreign.status).toBe(404);
  });
});
