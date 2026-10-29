// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Descendant fan-out on a read, against a real scope registry.
//
// retrieve() and entity() query the graph store once per registered descendant
// of the checked scope and do not re-check those paths: descendantScopePaths()
// is trusted to return only real descendants. It used to find them with Prisma
// `startsWith`, an unescaped LIKE, where the `_` in every minted scope label is
// a wildcard. A reader granted `dept_sales` then also got the sibling
// `deptXsales.eu` partition searched and its facts returned. A mocked Prisma
// cannot show this: only Postgres evaluates the pattern.
//
// What runs for real: descendantScopePaths()'s registry query, check() with a
// live capability, and the audit write. The graph store is a fake that returns
// one fact per partition it is asked for, its uuid the partition's path.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never the sandbox's
// inherited DATABASE_URL, which points at live Neon. Skips cleanly without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the
// `@/lib/db` singleton at import time, before beforeAll points DATABASE_URL at
// the QA database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import type { MemoryStore } from "./memory-store";
import type { EntityLookup, SearchInput } from "@/types/memory";

// The stand-in graph's facts here have no stored rows behind them, and this file is about
// which scopes a read reaches, not about which facts a stored source supports: the serve-time source check
// (services/memory/graph-fact-sources.ts) supports them all. It is proven against real rows in
// services/memory/graph-fact-sources.realdb.test.ts.
vi.mock("@/services/memory/graph-fact-sources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory/graph-fact-sources")>()),
  loadGraphSources: async () => ({ supports: () => true }),
}));
vi.mock("./store", () => ({ memory: {} }));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qa_desc_underscore";
const OTHER_ORG = "qa_desc_underscore_other";
const ROOT = `org_${ORG}`;
const GRANTED = `${ROOT}.dept_sales`;
const GRANTED_CHILD = `${GRANTED}.eu`;
// Differs from GRANTED only where GRANTED has `_`: a LIKE match, not a descendant.
const SIBLING = `${ROOT}.deptXsales`;
const SIBLING_CHILD = `${SIBLING}.eu`;
/** Registered by OTHER_ORG under GRANTED's path: only the orgId predicate keeps it out. */
const FOREIGN = `${GRANTED}.foreign`;

describe.skipIf(!QA_URL)("descendant fan-out never reaches an underscore-matching sibling", () => {
  let db: PrismaClient;
  let GuardedMemoryStore: (typeof import("./guarded-store"))["GuardedMemoryStore"];
  let descendantScopePaths: (typeof import("@/services/access/check"))["descendantScopePaths"];

  /** Partitions the fake store was asked for, in call order. */
  let asked: string[] = [];

  const partitionedStore = (): MemoryStore =>
    ({
      retrieve: vi.fn(async (input: SearchInput) => {
        asked.push(input.groupId);
        return { facts: [{ uuid: input.groupId, fact: `lives in ${input.groupId}`, validAt: null }] };
      }),
      entity: vi.fn(async (input: EntityLookup) => {
        asked.push(input.groupId);
        // The entity exists only in the sibling's child partition.
        return input.groupId === SIBLING_CHILD
          ? { uuid: "e", name: "sibling-only", type: "person", summary: "", facts: [] }
          : null;
      }),
    }) as unknown as MemoryStore;

  async function reader(scopePath: string): Promise<AccessContext> {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId: "sales-reader",
        tokenHash: hashCapabilityToken(token),
        scopePath,
        permission: "read",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return { orgId: ORG, actor: { type: "agent", id: "sales-reader", capabilityToken: token }, origin: "mcp" };
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ GuardedMemoryStore } = await import("./guarded-store"));
    ({ descendantScopePaths } = await import("@/services/access/check"));
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  beforeEach(async () => {
    asked = [];
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.auditLog.deleteMany({ where: { orgId } });
      await db.capability.deleteMany({ where: { orgId } });
      await db.scope.deleteMany({ where: { orgId } });
      await db.org.upsert({ where: { id: orgId }, update: {}, create: { id: orgId, name: orgId } });
    }
    await db.scope.createMany({
      data: [ROOT, GRANTED, GRANTED_CHILD, SIBLING, SIBLING_CHILD].map((path) => ({ orgId: ORG, path, name: path })),
    });
    await db.scope.create({ data: { orgId: OTHER_ORG, path: FOREIGN, name: FOREIGN } });
  });

  it("descendantScopePaths returns only real descendants of the target", async () => {
    await expect(descendantScopePaths(ORG, GRANTED)).resolves.toEqual({
      paths: [GRANTED_CHILD],
      unsearched: [],
      partial: false,
    });
  });

  it("retrieve() searches and returns only the granted subtree", async () => {
    const ctx = await reader(GRANTED);

    const result = await new GuardedMemoryStore(partitionedStore()).retrieve(
      ctx,
      { groupId: ORG, query: "q" },
      GRANTED,
    );

    expect(asked.slice().sort()).toEqual([GRANTED, GRANTED_CHILD]);
    expect(result.facts.map((f) => f.uuid).sort()).toEqual([GRANTED, GRANTED_CHILD]);
  });

  it("entity() does not find an entity that lives only in the sibling's subtree", async () => {
    const ctx = await reader(GRANTED);

    const result = await new GuardedMemoryStore(partitionedStore()).entity(
      ctx,
      { groupId: ORG, entityId: "e" },
      GRANTED,
    );

    expect(result).toBeNull();
    expect(asked).not.toContain(SIBLING_CHILD);
  });

  it("still denies a direct read of the sibling", async () => {
    const ctx = await reader(GRANTED);

    await expect(
      new GuardedMemoryStore(partitionedStore()).retrieve(ctx, { groupId: ORG, query: "q" }, SIBLING),
    ).rejects.toThrow();
    expect(asked).toEqual([]);
  });
});
