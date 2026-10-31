// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The other half of routing every REST scope through resolveCallerScopePath: what a
// request that names NO scope, or a valid one, still gets. Refusing malformed scopes
// must not change either.
//
// - A read with no scope keeps its org-wide reach: the query searches with no scope
//   filter (untagged rows included) and the entity routes pass no scope on, so the
//   resolver's org-root fallback is never applied to a read.
// - A write with no scope lands at the org root, as it did before.
// - A valid scope still works, and another tenant's valid scope is still refused by
//   check(), with nothing returned or queued from that tenant.
//
// Real: Postgres, the route handlers, GuardedMemoryStore, check() and its audit write,
// and the pgvector store. Faked: the Clerk session, the embedding service (a fixed
// vector), the ingest queue (a spy) and the LLM client.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "absentscope";
const ROOT = `org_${ORG}`;
const DEAL = `${ROOT}.deal_a`;
const OTHER_ORG = "absentscopeother";
const OTHER_ROOT = `org_${OTHER_ORG}`;
const ADMIN = "u-absentscope-admin";

const store = vi.hoisted(() => ({ retrieveInputs: [] as unknown[], guarded: undefined as unknown }));

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/inngest", () => ({ ingestMemory: vi.fn(async () => ({ readableNow: false })) }));
vi.mock("@/lib/llm", () => ({
  createLLMClient: () => ({}),
  LLM_MODEL_ORCHESTRATOR: "test-model",
  LLM_MODEL_EXTRACT: "test-model",
}));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (fn: () => unknown) => void fn(),
}));
vi.mock("@/services/memory", async () => {
  const { GuardedMemoryStore } = await import("@/services/memory/guarded-store");
  const { PgvectorMemoryStore } = await import("@/services/memory/pgvector-store");
  const { MemoryServiceError } = await import("@/services/memory/graphiti-store");
  const inner = new PgvectorMemoryStore();
  const retrieve = inner.retrieve.bind(inner);
  inner.retrieve = async (input) => {
    store.retrieveInputs.push(input);
    return retrieve(input);
  };
  const guardedMemory = new GuardedMemoryStore(inner);
  store.guarded = guardedMemory;
  return { guardedMemory, MemoryServiceError };
});

function json(body: unknown) {
  return new Request("http://t/api/memory", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Each REST writer, sending one fact with the given body scope (or none). */
const WRITERS: [string, (scope?: string) => Promise<Response>][] = [
  [
    "POST /api/memory/ingest",
    async (scope) => (await import("./ingest/route")).POST(json({ content: "Refunds are owned by payments.", scope })),
  ],
  [
    "POST /api/memory/facts",
    async (scope) => (await import("./facts/route")).POST(json({ fact: "Refunds are owned by payments.", scope })),
  ],
  [
    "POST /api/memory/chat (confirmed save)",
    async (scope) =>
      (await import("./chat/route")).POST(
        json({ query: "save this", confirmed: true, pendingContent: "Refunds are owned by payments.", scope }),
      ),
  ],
];

describe.skipIf(!QA_URL)("absent or valid scopes keep their reach after the scope resolver, real Postgres", () => {
  let db: PrismaClient;
  let ingestMemory: (typeof import("@/lib/inngest"))["ingestMemory"];

  const queuedScopes = () => vi.mocked(ingestMemory).mock.calls.map(([input]) => input.scopePath);

  async function clearTenants() {
    for (const org of [ORG, OTHER_ORG]) {
      await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${org}`;
      await db.changeEvent.deleteMany({ where: { orgId: org } });
      await db.auditLog.deleteMany({ where: { orgId: org } });
      await db.grant.deleteMany({ where: { orgId: org } });
      await db.scope.deleteMany({ where: { orgId: org } });
      await db.user.deleteMany({ where: { orgId: org } });
      await deleteOrgsWithRetry(db, { where: { id: org } });
    }
  }

  async function chunk(id: string, org: string, scopePath: string | null) {
    await db.$executeRaw`
      INSERT INTO memory_chunks (id, "orgId", content, "actorType", "scopePath", embedding)
      VALUES (${id}, ${org}, ${`fact ${id}`}, 'human', ${scopePath}, array_fill(0.01::real, ARRAY[384])::vector)`;
  }

  async function query(body: { query: string; scope?: string }) {
    return (await import("./query/route")).POST(
      new Request("http://t/api/memory/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  beforeAll(async () => {
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL! }) });
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith("/embed")
        ? new Response(JSON.stringify({ embedding: Array.from({ length: 384 }, () => 0.01) }), { status: 200 })
        : realFetch(input, init),
    );
    ({ ingestMemory } = await import("@/lib/inngest"));
    const { requireAccessContext } = await import("@/lib/access-context");
    vi.mocked(requireAccessContext).mockResolvedValue({
      org: { id: ORG },
      user: { id: ADMIN, name: ADMIN, email: `${ADMIN}@absentscope.test` },
      ctx: { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "app" },
    } as Awaited<ReturnType<typeof requireAccessContext>>);

    await clearTenants();
    for (const [org, root] of [
      [ORG, ROOT],
      [OTHER_ORG, OTHER_ROOT],
    ] as const) {
      await db.org.create({ data: { id: org, name: org } });
      await db.scope.create({ data: { orgId: org, path: root, name: root } });
      await db.scope.create({ data: { orgId: org, path: `${root}.deal_a`, name: "deal a" } });
    }
    await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: `${ADMIN}@absentscope.test`, role: "admin", clerkId: `clerk-${ADMIN}` },
    });
    const root = await db.scope.findUniqueOrThrow({ where: { orgId_path: { orgId: ORG, path: ROOT } } });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });

    await chunk("abs-untagged", ORG, null);
    await chunk("abs-root", ORG, ROOT);
    await chunk("abs-deal", ORG, DEAL);
    await chunk("abs-other", OTHER_ORG, `${OTHER_ROOT}.deal_a`);
  }, 60_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    await clearTenants();
    await db.$disconnect();
  });

  beforeEach(() => {
    vi.mocked(ingestMemory).mockClear();
    store.retrieveInputs.length = 0;
  });

  describe("POST /api/memory/query", () => {
    it("with no scope searches org-wide: no scope filter, untagged rows included, never another tenant's", async () => {
      const res = await query({ query: "who owns refunds" });

      expect(res.status).toBe(200);
      const ids = ((await res.json()).facts as { uuid: string }[]).map((f) => f.uuid).sort();
      expect(ids).toEqual(["abs-deal", "abs-root", "abs-untagged"]);
      // The primary leg carries no scope; the store's per-descendant legs name their own.
      const scopes = store.retrieveInputs.map((input) => (input as { scopePath?: string }).scopePath);
      expect(scopes[0]).toBeUndefined();
      expect(scopes).not.toContain(ROOT);
    });

    it("with a valid sub-scope narrows to it", async () => {
      const res = await query({ query: "who owns refunds", scope: DEAL });

      expect(res.status).toBe(200);
      expect(((await res.json()).facts as { uuid: string }[]).map((f) => f.uuid)).toEqual(["abs-deal"]);
    });

    it("with another tenant's valid scope is refused, and nothing of that tenant is read", async () => {
      const res = await query({ query: "who owns refunds", scope: `${OTHER_ROOT}.deal_a` });

      expect(res.status).toBe(403);
      expect(JSON.stringify(await res.json())).not.toContain("abs-other");
      expect(store.retrieveInputs).toEqual([]);
    });
  });

  describe("the entity routes", () => {
    it("with no ?scope= pass no scope on, for read and delete", async () => {
      const guarded = store.guarded as import("@/services/memory/guarded-store").GuardedMemoryStore;
      const entity = vi.spyOn(guarded, "entity").mockResolvedValue(null as never);
      const removeEntity = vi.spyOn(guarded, "removeEntity").mockResolvedValue({ removed: false } as never);
      const route = await import("./entities/[id]/route");
      const params = { params: Promise.resolve({ id: "ent-1" }) };

      expect((await route.GET(new Request("http://t/api/memory/entities/ent-1"), params)).status).toBe(404);
      expect(
        (await route.DELETE(new Request("http://t/api/memory/entities/ent-1", { method: "DELETE" }), params)).status,
      ).toBe(404);
      expect(entity.mock.calls[0]?.[2]).toBeUndefined();
      expect(removeEntity.mock.calls[0]?.[2]).toBeUndefined();

      await route.GET(new Request(`http://t/api/memory/entities/ent-1?scope=${DEAL}`), params);
      expect(entity.mock.calls[1]?.[2]).toBe(DEAL);
      entity.mockRestore();
      removeEntity.mockRestore();
    });
  });

  describe.each(WRITERS)("%s", (_route, send) => {
    it("with no scope writes at the org root", async () => {
      const res = await send(undefined);

      expect(res.status).toBeLessThan(300);
      await res.text();
      expect(queuedScopes()).toEqual([ROOT]);
    });

    it("with a blank scope writes at the org root", async () => {
      const res = await send("   ");

      expect(res.status).toBeLessThan(300);
      await res.text();
      expect(queuedScopes()).toEqual([ROOT]);
    });

    it("with another tenant's valid scope is refused and nothing is queued", async () => {
      const res = await send(`${OTHER_ROOT}.deal_a`);

      // Chat answers inside its event stream, so its refusal is a 200 carrying the error.
      const text = await res.text();
      if (res.status === 200) expect(text).toContain("Access denied.");
      else expect(res.status).toBe(403);
      expect(queuedScopes()).toEqual([]);
    });
  });
});
