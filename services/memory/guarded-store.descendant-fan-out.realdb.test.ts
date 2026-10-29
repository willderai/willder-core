// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A read over a scope with sixty registered scopes below it.
//
// A guarded read used to ask the graph store once per registered descendant scope. On
// 2026-10-10 an org whose root had more than fifty of them (left by measurement
// runs) turned each read into 51 memory-service searches started together; four such
// reads sent about 1,350 searches in 70 s and took every connection in the memory
// service's Neo4j pool. Capping that at fifty then hid every scope past the fiftieth.
// These tests hold a read to ONE graph call for all its descendant scopes, and to an
// honest, incomplete answer when the graph store is busy or does not answer.
//
// What runs for real: the sixty scopes are created through POST /api/access/scopes
// by an org admin; descendantScopePaths()'s registry query; check() with a live
// agent capability; the audit write; HybridMemoryStore's per-store ceiling and retry.
// The graph and vector stores are fakes standing in for the memory service, which
// counts the searches it has in flight and answers, refuses as overloaded (the 503
// the memory service now sends when its pool is busy), or never answers.
//
// Not simulated: several reads at once across serverless instances (the cap is per
// read), and the memory service itself; its side is tested in memory-service/tests.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { toGid } from "@/services/memory/graphiti-store";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import type { MemoryStore } from "./memory-store";
import type { EntityLookup, SearchInput, SearchResult } from "@/types/memory";

// The stand-in graph's facts here have no stored rows behind them, and this file is about
// how a read fans out over descendant scopes, not about which facts a stored source supports: the serve-time source check
// (services/memory/graph-fact-sources.ts) supports them all. It is proven against real rows in
// services/memory/graph-fact-sources.realdb.test.ts.
vi.mock("@/services/memory/graph-fact-sources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory/graph-fact-sources")>()),
  loadGraphSources: async () => ({ supports: () => true }),
}));
vi.mock("./store", () => ({ memory: {} }));
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

const QA_URL = process.env.QA_DATABASE_URL;

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const ORG = `qa-fan-out-${RUN}`;
const ROOT = `org_${ORG}`;
const ADMIN = `user-qa-fan-out-admin-${RUN}`;
const SCOPES = 60;
/** The enterprise tier's latency ceiling: an org with no tier recorded reads on it. */
const CEILING_MS = 10_000;
/** How far the fake clock moves each time a store call is waiting on it. */
const CLOCK_STEP_MS = 1_000;
/** Ten steps reach the ceiling; the rest is slack, so a read that never stops fails instead of hanging. */
const MAX_CLOCK_STEPS = 3 * (CEILING_MS / CLOCK_STEP_MS);

type Behaviour = "answers" | "overloaded" | "never answers";

describe.skipIf(!QA_URL)("a read over sixty descendant scopes asks them in one graph call", () => {
  let db: PrismaClient;
  let GuardedMemoryStore: (typeof import("./guarded-store"))["GuardedMemoryStore"];
  let HybridMemoryStore: (typeof import("./hybrid-store"))["HybridMemoryStore"];
  let MemoryServiceError: (typeof import("./graphiti-store"))["MemoryServiceError"];
  let descendants: string[] = [];

  /** The memory service, as a fake that records the calls that asked descendant scopes. */
  function graphService(descendantBehaviour: Behaviour) {
    const seen = { descendantCalls: 0, asked: new Set<string>() };
    const call = async <R>(groups: string[], answer: () => R): Promise<R> => {
      const below = groups.filter((groupId) => groupId.startsWith(`${ROOT}.`));
      if (below.length > 0) {
        seen.descendantCalls += 1;
        for (const groupId of below) seen.asked.add(groupId);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (below.length > 0 && descendantBehaviour === "overloaded") {
        throw new MemoryServiceError("memory service /search failed: memory graph overloaded", 503);
      }
      if (below.length > 0 && descendantBehaviour === "never answers") await new Promise(() => {});
      return answer();
    };
    const store = {
      retrieve: (input: SearchInput) => {
        const groups = [input.groupId, ...(input.groupIds ?? [])];
        return call(groups, () => ({
          facts: groups.map((groupId) => ({
            uuid: `fact-${groupId}`,
            fact: `decision recorded in ${groupId}`,
            validAt: null,
          })),
          storesRead: [{ store: "graph" }],
        }));
      },
      entity: (input: EntityLookup) => {
        const groups = input.groupIds ?? [input.groupId];
        return call(groups, () =>
          groups.includes(descendants[57])
            ? {
                uuid: input.entityId,
                name: "Dana",
                type: "person",
                summary: "",
                facts: [],
                graphGroupId: toGid(descendants[57]),
              }
            : null,
        );
      },
    } as unknown as MemoryStore;
    return { seen, store };
  }

  const vectorStore = {
    retrieve: async (): Promise<SearchResult> => ({ facts: [], storesRead: [{ store: "semantic" }] }),
  } as unknown as MemoryStore;

  async function rootReader(): Promise<AccessContext> {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId: "fan-out-reader",
        tokenHash: hashCapabilityToken(token),
        scopePath: ROOT,
        permission: "read",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return { orgId: ORG, actor: { type: "agent", id: "fan-out-reader", capabilityToken: token }, origin: "mcp" };
  }

  function guarded(descendantBehaviour: Behaviour) {
    const graph = graphService(descendantBehaviour);
    return { seen: graph.seen, store: new GuardedMemoryStore(new HybridMemoryStore(graph.store, vectorStore)) };
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ GuardedMemoryStore } = await import("./guarded-store"));
    ({ HybridMemoryStore } = await import("./hybrid-store"));
    ({ MemoryServiceError } = await import("./graphiti-store"));

    await db.org.create({ data: { id: ORG, name: "Fan-out QA" } });
    const admin = await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: `${ADMIN}@fan-out.test`, role: "admin", clerkId: `clerk-${ADMIN}` },
    });
    // The tenant default (lib/tenant.ts): the root scope, and org admins hold admin on it.
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "Organization" } });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "role", granteeId: "admin", permission: "admin" },
    });

    const { requireAccessContext } = await import("@/lib/access-context");
    const org = await db.org.findUniqueOrThrow({ where: { id: ORG } });
    vi.mocked(requireAccessContext).mockResolvedValue({
      org,
      user: admin,
      ctx: { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "app" },
    } as never);
    const { POST } = await import("@/app/api/access/scopes/route");
    for (let i = 0; i < SCOPES; i++) {
      const res = await POST(
        new Request("http://test/api/access/scopes", {
          method: "POST",
          body: JSON.stringify({ name: `beam run ${String(i).padStart(2, "0")}`, parentPath: ROOT }),
        }),
      );
      expect(res.status).toBe(201);
      descendants.push(((await res.json()) as { scope: { path: string } }).scope.path);
    }
    descendants = descendants.sort();
    // Sixty scope POSTs, one after another: vitest's 10 s hook default timed out on a loaded
    // laptop (2 of 20 runs at load average ~190). This bounds a hang, not a speed claim.
  }, 6 * CEILING_MS);

  afterAll(async () => {
    await db.user.deleteMany({ where: { orgId: ORG } });
    await db.org.deleteMany({ where: { id: ORG } });
    await db.$disconnect();
  });

  beforeEach(async () => {
    await db.capability.deleteMany({ where: { orgId: ORG } });
  });

  it("searches every scope in one graph call", async () => {
    const { seen, store } = guarded("answers");

    const result = await store.retrieve(await rootReader(), { groupId: ORG, query: "renewal owner", limit: 100 }, ROOT);

    expect(seen.asked.size).toBe(SCOPES);
    expect(seen.descendantCalls).toBe(1);
    expect(result.partialScopeCoverage).toBeUndefined();
    expect(result.degraded).toBeUndefined();
    expect(result.facts.map((f) => f.uuid)).toContain(`fact-${descendants[SCOPES - 1]}`);
  });

  it("answers with what it has, marked degraded, when the graph store is overloaded", async () => {
    const { store } = guarded("overloaded");

    const result = await store.retrieve(await rootReader(), { groupId: ORG, query: "renewal owner" }, ROOT);

    expect(result.degraded).toEqual(["graph"]);
    expect(result.facts.some((f) => !f.uuid.startsWith(`fact-${ROOT}.`))).toBe(true);
  });

  it(
    "drops a descendant call that never answers at the latency ceiling, and says the graph failed",
    async () => {
      const graph = graphService("never answers");
      const hybrid = new HybridMemoryStore(graph.store, vectorStore);
      // Store calls the read is waiting on. Inside one, the only work is the fakes' and the
      // ceiling's timers, so only the clock can end it.
      const waiting = { calls: 0, descendantStartedAt: 0 };
      const retrieve = hybrid.retrieve.bind(hybrid);
      hybrid.retrieve = async (input) => {
        if (input.groupId.startsWith(`${ROOT}.`)) waiting.descendantStartedAt = Date.now();
        waiting.calls += 1;
        try {
          return await retrieve(input);
        } finally {
          waiting.calls -= 1;
        }
      };
      const store = new GuardedMemoryStore(hybrid);
      const reader = await rootReader();

      // On the real clock this test waited out the ceiling and bounded the read by wall time,
      // which a loaded runner can break. The fake clock moves only while a store call is
      // waiting, so database work outside one adds no steps, however long it takes; stepping
      // on any pending timer let pg-pool's 10 s idle timer step it during that work.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      try {
        let finished = false;
        const read = store.retrieve(reader, { groupId: ORG, query: "renewal owner" }, ROOT);
        read.then(
          () => (finished = true),
          () => (finished = true),
        );

        let steps = 0;
        while (!finished) {
          await new Promise((resolve) => setImmediate(resolve));
          if (waiting.calls === 0) continue;
          expect(vi.getTimerCount(), "a store call is waiting with no timer left that could end it").toBeGreaterThan(0);
          expect(++steps, "the read was still waiting on a store long past its latency ceiling").toBeLessThanOrEqual(
            MAX_CLOCK_STEPS,
          );
          await vi.advanceTimersByTimeAsync(CLOCK_STEP_MS);
        }
        const result = await read;
        const waited = Date.now() - waiting.descendantStartedAt;

        expect(graph.seen.asked.size).toBe(SCOPES);
        // Dropped at the ceiling, within the one clock step that crossed it.
        expect(waiting.descendantStartedAt).toBeGreaterThan(0);
        expect(waited).toBeGreaterThanOrEqual(CEILING_MS);
        expect(waited).toBeLessThan(CEILING_MS + CLOCK_STEP_MS);
        expect(result.degraded).toEqual(["graph"]);
      } finally {
        vi.useRealTimers();
      }
    },
    3 * CEILING_MS,
  );

  it("a descendant search that throws fails the read instead of being dropped", async () => {
    // Under the guarded store directly, with no HybridMemoryStore turning a failure
    // into `degraded`: a rejected leg must reach the caller, not vanish from the page.
    const failing = {
      retrieve: async (input: SearchInput): Promise<SearchResult> => {
        if (input.groupId.startsWith(`${ROOT}.`)) throw new MemoryServiceError("descendant search broke", 500);
        return { facts: [], storesRead: [{ store: "graph" }] };
      },
    } as unknown as MemoryStore;
    const store = new GuardedMemoryStore(failing);

    await expect(store.retrieve(await rootReader(), { groupId: ORG, query: "renewal owner" }, ROOT)).rejects.toThrow(
      /descendant search broke/,
    );
  });

  it("finds an entity in the 58th scope in one call", async () => {
    const { seen, store } = guarded("answers");

    const entity = await store.entity(await rootReader(), { groupId: ORG, entityId: "ent-dana" }, ROOT);

    expect(entity?.name).toBe("Dana");
    expect(seen.descendantCalls).toBe(1);
  });

  it("an entity lookup the graph store refuses is an error, not 'not found'", async () => {
    const { store } = guarded("overloaded");

    await expect(store.entity(await rootReader(), { groupId: ORG, entityId: "ent-dana" }, ROOT)).rejects.toThrow(
      /overloaded/,
    );
  });
});
