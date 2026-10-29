// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// GET /api/memory/graph descendant lookup, against a real database.
//
// The route widens `?scope=` to the scope plus every registered descendant, one
// Graphiti partition each. It used to find descendants with Prisma `startsWith`,
// which compiles to an unescaped LIKE; `_` is a LIKE wildcard and every minted
// scope label contains one, so `org_x.dept_sales.` also matched the sibling
// `org_x.deptXsales.eu`. A mocked Prisma cannot show that: only Postgres
// evaluates the pattern.
//
// What runs for real: the route, check() and its grant query, the audit write,
// and GuardedMemoryStore.graph()'s own groupId containment. Only the session
// lookup and the Graphiti HTTP store are stubbed; the store keeps a node only
// when its group_id is in the requested partitions, as memory-service's Cypher does.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never the sandbox's inherited
// DATABASE_URL, which points at live Neon. Skips cleanly without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";
import type { MemoryStore } from "@/services/memory/memory-store";
import type { GraphInput, MemoryGraph } from "@/types/memory";
import { seedMember } from "@/services/access/member.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qagraphdesc";
const ROOT = `org_${ORG}`;
const GRANTED = `${ROOT}.dept_sales`;
const GRANTED_CHILD = `${ROOT}.dept_sales.eu`;
// Differs from GRANTED only where GRANTED has `_`: a LIKE match, not a descendant.
const SIBLING = `${ROOT}.deptXsales`;
const SIBLING_CHILD = `${ROOT}.deptXsales.eu`;
const USER = "user-qa-graph-desc";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

const storeRef = vi.hoisted(() => ({ current: null as MemoryStore | null }));
const routeGroupIds = vi.hoisted(() => ({ current: undefined as string[] | undefined }));
vi.mock("@/services/memory", async () => {
  const { GuardedMemoryStore } = await import("@/services/memory/guarded-store");
  const { MemoryServiceError } = await import("@/services/memory/graphiti-store");
  // Records what the route asked for before the guarded store filters it.
  class RecordingGuardedStore extends GuardedMemoryStore {
    override graph(ctx: AccessContext, input: GraphInput, scope?: string) {
      routeGroupIds.current = input.groupIds;
      return super.graph(ctx, input, scope);
    }
  }
  return {
    get guardedMemory() {
      return new RecordingGuardedStore(storeRef.current as MemoryStore);
    },
    MemoryServiceError,
  };
});

/** One node per scope, named after it, filtered by partition like graph_for_group. */
function partitionedGraphStore() {
  const graph = vi.fn(async (input: GraphInput): Promise<MemoryGraph> => {
    const gids = input.groupIds ?? [input.groupId];
    const nodes = [GRANTED, GRANTED_CHILD, SIBLING, SIBLING_CHILD]
      .filter((path) => gids.includes(path))
      .map((path) => ({ uuid: path, name: path, type: "Entity", groupId: path }));
    return { nodes, edges: [] } as unknown as MemoryGraph;
  });
  return { graph } as unknown as MemoryStore & { graph: typeof graph };
}

describe.skipIf(!QA_URL)("GET /api/memory/graph descendant lookup against a real database", () => {
  let db: PrismaClient;
  let GET: (typeof import("./route"))["GET"];

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ GET } = await import("./route"));

    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
    for (const path of [ROOT, GRANTED, GRANTED_CHILD, SIBLING, SIBLING_CHILD]) {
      await db.scope.upsert({
        where: { orgId_path: { orgId: ORG, path } },
        update: {},
        create: { orgId: ORG, path, name: path },
      });
    }
    const granted = await db.scope.findUniqueOrThrow({
      where: { orgId_path: { orgId: ORG, path: GRANTED } },
    });
    await db.grant.deleteMany({ where: { orgId: ORG } });
    await seedMember(db, { orgId: ORG, userId: USER });
    await db.grant.create({
      data: { orgId: ORG, scopeId: granted.id, granteeType: "user", granteeId: USER, permission: "read" },
    });

    const { requireAccessContext } = await import("@/lib/access-context");
    vi.mocked(requireAccessContext).mockResolvedValue({
      org: { id: ORG } as never,
      user: { id: USER } as never,
      ctx: { orgId: ORG, actor: { type: "human", id: USER, role: "member" }, origin: "app" },
    });
  });

  afterAll(async () => {
    await db.org.delete({ where: { id: ORG } }).catch(() => undefined);
    await db.$disconnect();
  });

  beforeEach(async () => {
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    routeGroupIds.current = undefined;
  });

  const read = (scope: string) => {
    const store = partitionedGraphStore();
    storeRef.current = store;
    return { store, res: GET(new Request(`https://willder.test/api/memory/graph?scope=${scope}`)) };
  };

  it("asks only for the granted scope and its real descendants, never an underscore-matching sibling", async () => {
    const { res } = read(GRANTED);

    expect((await res).status).toBe(200);
    expect(routeGroupIds.current?.slice().sort()).toEqual([GRANTED, GRANTED_CHILD]);
  });

  it("returns the granted subtree and nothing from the sibling", async () => {
    const { store, res } = read(GRANTED);
    const body = (await (await res).json()) as MemoryGraph;

    expect(store.graph.mock.calls[0][0].groupIds?.slice().sort()).toEqual([GRANTED, GRANTED_CHILD]);
    expect(body.nodes.map((n) => n.uuid).sort()).toEqual([GRANTED, GRANTED_CHILD]);
  });

  it("asks for every one of 70 scopes below the granted one, where it used to keep the first 60", async () => {
    const many = Array.from({ length: 70 }, (_, i) => `${GRANTED_CHILD}.run_${String(i).padStart(2, "0")}`);
    await db.scope.createMany({ data: many.map((path) => ({ orgId: ORG, path, name: path })) });
    try {
      const { res } = read(GRANTED);
      const body = (await (await res).json()) as MemoryGraph & { partialScopeCoverage?: true };

      expect(routeGroupIds.current?.slice().sort()).toEqual([GRANTED, GRANTED_CHILD, ...many].sort());
      expect(body.partialScopeCoverage).toBeUndefined();
    } finally {
      await db.scope.deleteMany({ where: { orgId: ORG, path: { in: many } } });
    }
  });

  it("past the per-read bound, shows the first scopes in path order and names the rest", async () => {
    const { MAX_SEARCHED_DESCENDANT_SCOPES } = await import("@/services/access/check");
    const many = Array.from(
      { length: MAX_SEARCHED_DESCENDANT_SCOPES + 1 },
      (_, i) => `${GRANTED_CHILD}.run_${String(i).padStart(4, "0")}`,
    );
    await db.scope.createMany({ data: many.map((path) => ({ orgId: ORG, path, name: path })) });
    try {
      const { res } = read(GRANTED);
      const body = (await (await res).json()) as MemoryGraph & {
        partialScopeCoverage?: true;
        unsearchedScopes?: string[];
      };

      expect(body.partialScopeCoverage).toBe(true);
      expect(body.unsearchedScopes).toEqual(many.slice(-2));
      expect(routeGroupIds.current).toHaveLength(MAX_SEARCHED_DESCENDANT_SCOPES + 1);
    } finally {
      await db.scope.deleteMany({ where: { orgId: ORG, path: { in: many } } });
    }
  });

  it("still denies the sibling itself, and audits the denial", async () => {
    const { store, res } = read(SIBLING);

    expect((await res).status).toBe(403);
    expect(store.graph).not.toHaveBeenCalled();
    const audit = await db.auditLog.findMany({ where: { orgId: ORG, actorId: USER } });
    expect(audit.map((row) => row.decision)).toEqual(["deny"]);
  });
});
