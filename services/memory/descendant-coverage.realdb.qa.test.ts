// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Partial descendant-scope coverage on a read, and entity()'s descendant lookup
// run in parallel, against a real scope registry.
//
// The unit suite stubs descendantScopePaths() and check(). Here both are
// real: the scope registry query runs against Postgres, and every read goes
// through check() with a live capability. The graph store is a fake that
// records which partitions it was asked for, so the assertions turn on which
// scopes the code actually addressed.
//
// Two tenants and two scopes throughout. The other tenant registers a scope
// whose path sits under this tenant's `eng` subtree, so only the orgId
// predicate keeps it out of the descendant list, and the `partial` flag is
// shown to describe the caller's own authorized subtree, not the org's.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never the sandbox's
// inherited DATABASE_URL, which points at live Neon. Skips cleanly without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { toGid } from "@/services/memory/graphiti-store";
// These tests assert on merge, ranking and scope behaviour, not on conflict resolution,
// so the supersession record a guarded read consults
// (services/memory/superseded-facts.ts) is empty here. That a conflicted fact reads as
// one current answer is proven against persisted records in
// services/memory/conflict-read.realdb.test.ts.
// The stand-in graph's facts here have no stored rows behind them, and this file is about
// which scopes a read reaches, not about which facts a stored source supports: the serve-time source check
// (services/memory/graph-fact-sources.ts) supports them all. It is proven against real rows in
// services/memory/graph-fact-sources.realdb.test.ts.
vi.mock("@/services/memory/graph-fact-sources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory/graph-fact-sources")>()),
  loadGraphSources: async () => ({ supports: () => true }),
}));
vi.mock("@/services/memory/superseded-facts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory/superseded-facts")>()),
  loadSupersededVersions: async () => ({ byId: new Map(), byText: new Map() }),
}));

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the
// `@/lib/db` singleton at import time, before beforeAll points DATABASE_URL at
// the QA database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import type { MemoryStore } from "./memory-store";
import type { EntityLookup, MemoryEntity, SearchInput } from "@/types/memory";

vi.mock("./store", () => ({ memory: {} }));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qa_item57";
const OTHER_ORG = "qa_item57_other";
const ROOT = `org_${ORG}`;
const ENG = `${ROOT}.eng`;
const SALES = `${ROOT}.sales`;
/** Registered by OTHER_ORG, under ORG's eng subtree by path. */
const FOREIGN = `${ENG}.zz_foreign`;

const engChild = (i: number) => `${ENG}.t${String(i).padStart(4, "0")}`;

describe.skipIf(!QA_URL)("descendant coverage on a real scope registry", () => {
  let db: PrismaClient;
  let GuardedMemoryStore: (typeof import("./guarded-store"))["GuardedMemoryStore"];
  let appDb: (typeof import("@/lib/db"))["db"];
  let MAX_SEARCHED_DESCENDANT_SCOPES = 0;

  /** Partitions the fake store's retrieve() was asked for, in call order. */
  let retrieved: string[] = [];
  /** The partitions of each retrieve() call that asked descendant scopes (`groupIds` set). */
  let descendantCalls: string[][] = [];

  const recordingStore = (entity?: (input: EntityLookup) => Promise<MemoryEntity | null>): MemoryStore =>
    ({
      retrieve: vi.fn(async (input: SearchInput) => {
        const asked = [input.groupId, ...(input.groupIds ?? [])];
        retrieved.push(...asked);
        if (input.groupIds) descendantCalls.push(asked);
        return { facts: [] };
      }),
      entity: vi.fn((input: EntityLookup) => (entity ? entity(input) : Promise.resolve(null))),
    }) as unknown as MemoryStore;

  async function agent(orgId: string, agentId: string, scopePath: string): Promise<AccessContext> {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath,
        permission: "read",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return { orgId, actor: { type: "agent", id: agentId, capabilityToken: token }, origin: "mcp" };
  }

  async function registerScopes(orgId: string, paths: string[]) {
    await db.scope.createMany({ data: paths.map((path) => ({ orgId, path, name: path })) });
  }

  /** ORG's registry: root, eng, sales, one sales child, and `engChildren` under eng. */
  async function seed(engChildren: number) {
    await registerScopes(ORG, [
      ROOT,
      ENG,
      SALES,
      `${SALES}.s1`,
      ...Array.from({ length: engChildren }, (_, i) => engChild(i)),
    ]);
    await registerScopes(OTHER_ORG, [`org_${OTHER_ORG}`, FOREIGN]);
  }

  /** Calls on the app's $queryRaw that are the descendant registry lookup, not check()'s own queries. */
  const isRegistryLookup = (strings: unknown) => (strings as string[]).join("?").includes('"path" <> ');

  const entity = (name: string): MemoryEntity => ({ uuid: name, name, type: "person", summary: "", facts: [] });

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ GuardedMemoryStore } = await import("./guarded-store"));
    ({ db: appDb } = await import("@/lib/db"));
    ({ MAX_SEARCHED_DESCENDANT_SCOPES } = await import("@/services/access/check"));
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    retrieved = [];
    descendantCalls = [];
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.auditLog.deleteMany({ where: { orgId } });
      await db.capability.deleteMany({ where: { orgId } });
      await db.scope.deleteMany({ where: { orgId } });
      await db.org.upsert({ where: { id: orgId }, update: {}, create: { id: orgId, name: orgId } });
    }
  });

  describe("retrieve()", () => {
    it("asks every one of 60 eng children in one graph call and reports full coverage", async () => {
      await seed(60);
      const reader = await agent(ORG, "eng-reader", ENG);

      const result = await new GuardedMemoryStore(recordingStore()).retrieve(reader, { groupId: ORG, query: "q" }, ENG);

      expect(result.partialScopeCoverage).toBeUndefined();
      expect(descendantCalls).toEqual([Array.from({ length: 60 }, (_, i) => engChild(i))]);
      // Another tenant's scope under the same path, and a sibling subtree, are never asked.
      expect(retrieved).not.toContain(FOREIGN);
      expect(retrieved.some((g) => g.startsWith(SALES))).toBe(false);
    });

    it("past the per-read bound, searches the first ones in path order and names the rest", async () => {
      const extra = 3;
      await seed(MAX_SEARCHED_DESCENDANT_SCOPES + extra);
      const reader = await agent(ORG, "eng-reader", ENG);

      const result = await new GuardedMemoryStore(recordingStore()).retrieve(reader, { groupId: ORG, query: "q" }, ENG);

      const all = Array.from({ length: MAX_SEARCHED_DESCENDANT_SCOPES + extra }, (_, i) => engChild(i));
      expect(result.partialScopeCoverage).toBe(true);
      expect(descendantCalls).toEqual([all.slice(0, MAX_SEARCHED_DESCENDANT_SCOPES)]);
      expect(result.unsearchedScopes).toEqual(all.slice(MAX_SEARCHED_DESCENDANT_SCOPES));
    });

    it("keeps a big eng subtree from marking a sales reader's read partial", async () => {
      await seed(51);
      const salesReader = await agent(ORG, "sales-reader", SALES);

      const result = await new GuardedMemoryStore(recordingStore()).retrieve(
        salesReader,
        { groupId: ORG, query: "q" },
        SALES,
      );

      expect(result.partialScopeCoverage).toBeUndefined();
      expect(retrieved.filter((g) => g.startsWith(`${SALES}.`))).toEqual([`${SALES}.s1`]);
    });

    it("denies an out-of-scope read before the registry is consulted, so no flag or leg leaks", async () => {
      await seed(51);
      const salesReader = await agent(ORG, "sales-reader", SALES);
      const outsider = await agent(OTHER_ORG, "outsider", `org_${OTHER_ORG}`);
      const queryRaw = vi.spyOn(appDb, "$queryRaw");

      await expect(
        new GuardedMemoryStore(recordingStore()).retrieve(salesReader, { groupId: ORG, query: "q" }, ENG),
      ).rejects.toThrow();
      await expect(
        new GuardedMemoryStore(recordingStore()).retrieve(outsider, { groupId: ORG, query: "q" }, ENG),
      ).rejects.toThrow();

      expect(retrieved).toEqual([]);
      expect(queryRaw.mock.calls.filter(([strings]) => isRegistryLookup(strings))).toEqual([]);
    });

    it("treats a failed registry lookup as partial, with no descendant legs and the checked leg intact", async () => {
      await seed(3);
      const reader = await agent(ORG, "eng-reader", ENG);
      const realQueryRaw = appDb.$queryRaw.bind(appDb);
      vi.spyOn(appDb, "$queryRaw").mockImplementation(((strings: TemplateStringsArray, ...values: unknown[]) =>
        isRegistryLookup(strings)
          ? Promise.reject(new Error("connection reset"))
          : realQueryRaw(strings, ...values)) as never);

      const result = await new GuardedMemoryStore(recordingStore()).retrieve(reader, { groupId: ORG, query: "q" }, ENG);

      expect(result.partialScopeCoverage).toBe(true);
      expect(retrieved).toEqual([ENG]);
    });
  });

  describe("an org-root ask over more child scopes than one page of the registry", () => {
    it("finds a fact that lives only in the last of 60 child scopes", async () => {
      await seed(60);
      const rootReader = await agent(ORG, "root-reader", ROOT);
      const last = engChild(59);
      const store = {
        retrieve: vi.fn(async (input: SearchInput) => {
          const asked = [input.groupId, ...(input.groupIds ?? [])];
          retrieved.push(...asked);
          return {
            facts: asked.includes(last)
              ? [
                  {
                    uuid: "f-last",
                    fact: "the renewal date is March 3",
                    validAt: null,
                    store: "graph" as const,
                    graphGroupId: toGid(last),
                  },
                ]
              : [],
          };
        }),
        entity: vi.fn(async () => null),
      } as unknown as MemoryStore;

      const result = await new GuardedMemoryStore(store).retrieve(rootReader, { groupId: ORG, query: "renewal" });

      expect(result.facts.map((f) => f.uuid)).toEqual(["f-last"]);
      expect(result.partialScopeCoverage).toBeUndefined();
      expect(retrieved).toContain(last);
      expect(retrieved).not.toContain(FOREIGN);
    });
  });

  describe("entity()", () => {
    it("asks every eng child in one call, never another tenant's scope", async () => {
      await seed(60);
      const reader = await agent(ORG, "eng-reader", ENG);
      const lookups: string[][] = [];

      const found = await new GuardedMemoryStore(
        recordingStore(async (input) => {
          lookups.push(input.groupIds ?? [input.groupId]);
          return input.groupIds?.includes(engChild(59))
            ? { ...entity("in-the-last-child"), graphGroupId: toGid(engChild(59)) }
            : null;
        }),
      ).entity(reader, { groupId: ORG, entityId: "e" }, ENG);

      expect(found?.name).toBe("in-the-last-child");
      expect(lookups).toEqual([[ENG], Array.from({ length: 60 }, (_, i) => engChild(i))]);
      expect(lookups.flat()).not.toContain(FOREIGN);
    });

    it("looks past the per-read search bound, since a lookup by id is one match", async () => {
      await seed(MAX_SEARCHED_DESCENDANT_SCOPES + 1);
      const reader = await agent(ORG, "eng-reader", ENG);
      const lastChild = engChild(MAX_SEARCHED_DESCENDANT_SCOPES);

      const found = await new GuardedMemoryStore(
        recordingStore(async (input) =>
          input.groupIds?.includes(lastChild) ? { ...entity("past-the-bound"), graphGroupId: toGid(lastChild) } : null,
        ),
      ).entity(reader, { groupId: ORG, entityId: "e" }, ENG);

      expect(found?.name).toBe("past-the-bound");
    });
  });
});
