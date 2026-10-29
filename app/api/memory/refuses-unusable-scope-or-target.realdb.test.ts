// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Two ways a memory request used to answer a 500 that named nothing, each now a 403
// naming the fix with one deny row on the audit trail:
//
// - A malformed `scope` on POST /api/memory/query or GET/DELETE /api/memory/entities/:id
//   (a space, or a NUL) reached check()'s `::ltree` cast raw and threw there, and a query
//   scope sent as another JSON type threw a TypeError. These routes now refuse it the way
//   the facts routes do.
// - A NUL in what a request names (the query text, an entity or fact id) reached the
//   audit row check() writes for the decision, which Postgres text cannot hold. check()
//   now refuses it by name before deciding, and the row stores the NUL as `\u0000`.
//
// Real: Postgres, the route handlers, GuardedMemoryStore, check() and its audit write,
// and the pgvector store. Faked: the Clerk session, and the embedding service the
// pgvector store calls for a query (a fixed vector).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "nulmemroutes";
const ROOT = `org_${ORG}`;
const ADMIN = "u-nulmemroutes-admin";
/** A member of the org with no grant anywhere. */
const MEMBER = "u-nulmemroutes-member";
const FACT = "chunk-nulmemroutes-1";
const NUL = "\u0000";

const NUL_SCOPE = "scope contains a NUL (\\u0000) character, which is not accepted. Remove it and retry.";
const NUL_TARGET = "the request contains a NUL (\\u0000) character, which is not accepted. Remove it and retry.";
const SPACED = `${ROOT}.deal A`;

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/services/memory", async () => {
  const { GuardedMemoryStore } = await import("@/services/memory/guarded-store");
  const { PgvectorMemoryStore } = await import("@/services/memory/pgvector-store");
  const { MemoryServiceError } = await import("@/services/memory/graphiti-store");
  return { guardedMemory: new GuardedMemoryStore(new PgvectorMemoryStore()), MemoryServiceError };
});

type Send = (value: string) => Promise<Response>;

describe.skipIf(!QA_URL)("memory routes refuse an unusable scope or target by name, real Postgres", () => {
  let db: PrismaClient;
  let query: (body: { query: string; scope?: unknown }) => Promise<Response>;
  let getEntity: (id: string, scope?: string) => Promise<Response>;
  let deleteEntity: (id: string, scope?: string) => Promise<Response>;
  let deleteFact: (id: string) => Promise<Response>;

  const withScope = (path: string, scope?: string) =>
    scope === undefined ? `http://t${path}` : `http://t${path}?scope=${encodeURIComponent(scope)}`;

  const auditRows = () =>
    db.auditLog.findMany({
      where: { orgId: ORG },
      select: { action: true, target: true, decision: true, reason: true },
      orderBy: { at: "asc" },
    });
  const factStored = async () =>
    (await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM memory_chunks WHERE id = ${FACT}`)[0].n === 1;

  async function wipe() {
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
  }

  async function clearTenant() {
    await wipe();
    await db.grant.deleteMany({ where: { orgId: ORG } });
    await db.scope.deleteMany({ where: { orgId: ORG } });
    await db.user.deleteMany({ where: { orgId: ORG } });
    await db.org.deleteMany({ where: { id: ORG } });
  }

  beforeAll(async () => {
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL! }) });
    // The pgvector store embeds a query through the memory service before searching.
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith("/embed")
        ? new Response(JSON.stringify({ embedding: Array.from({ length: 384 }, () => 0.01) }), { status: 200 })
        : realFetch(input, init),
    );

    const queryRoute = await import("./query/route");
    const entityRoute = await import("./entities/[id]/route");
    const factRoute = await import("./facts/[id]/route");
    const params = (id: string) => ({ params: Promise.resolve({ id }) });
    query = (body) =>
      queryRoute.POST(
        new Request("http://t/api/memory/query", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    getEntity = (id, scope) => entityRoute.GET(new Request(withScope("/api/memory/entities/x", scope)), params(id));
    deleteEntity = (id, scope) =>
      entityRoute.DELETE(new Request(withScope("/api/memory/entities/x", scope), { method: "DELETE" }), params(id));
    deleteFact = (id) =>
      factRoute.DELETE(new Request(withScope("/api/memory/facts/x", ROOT), { method: "DELETE" }), params(id));

    const { requireAccessContext } = await import("@/lib/access-context");
    // The fields the routes read; the full Clerk-backed org and user rows are not needed.
    vi.mocked(requireAccessContext).mockResolvedValue({
      org: { id: ORG },
      user: { id: ADMIN, name: ADMIN },
      ctx: { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "app" },
    } as Awaited<ReturnType<typeof requireAccessContext>>);

    await clearTenant();
    await db.org.create({ data: { id: ORG, name: "NUL memory routes" } });
    await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: `${ADMIN}@nulmemroutes.test`, role: "admin", clerkId: `clerk-${ADMIN}` },
    });
    await db.user.create({
      data: {
        id: MEMBER,
        orgId: ORG,
        email: `${MEMBER}@nulmemroutes.test`,
        role: "member",
        clerkId: `clerk-${MEMBER}`,
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
    await wipe();
    await db.$executeRaw`
      INSERT INTO memory_chunks (id, "orgId", content, "actorType", "scopePath")
      VALUES (${FACT}, ${ORG}, 'Refunds are owned by billing.', 'human', ${ROOT})`;
  });

  describe("a malformed scope", () => {
    const routes: [string, string, Send][] = [
      ["POST /api/memory/query", "memory.read", (scope) => query({ query: "who owns refunds", scope })],
      ["GET /api/memory/entities/:id", "memory.entity", (scope) => getEntity("ent-1", scope)],
      ["DELETE /api/memory/entities/:id", "memory.delete", (scope) => deleteEntity("ent-1", scope)],
    ];

    describe.each(routes)("%s", (_route, action, send) => {
      it.each([
        ["a NUL", `${ROOT}${NUL}`, `${ROOT}\\u0000`, NUL_SCOPE],
        ["a space", SPACED, SPACED, `scope "${SPACED}" is not a valid scope path`],
      ])("holding %s is a 403 naming it, with one deny row", async (_what, scope, recorded, refusal) => {
        const res = await send(scope);

        expect(res.status).toBe(403);
        expect((await res.json()).error).toBe(refusal);
        expect(await auditRows()).toEqual([{ action, target: recorded, decision: "deny", reason: refusal }]);
      });

      it("a valid scope gets past the scope check and is decided by check()", async () => {
        const res = await send(ROOT);

        // The query answers; no entity "ent-1" exists, so the entity routes answer 404.
        expect([200, 404]).toContain(res.status);
        expect((await auditRows()).map((r) => [r.action, r.decision])).toContainEqual([action, "allow"]);
      });
    });
  });

  it.each([
    ["a number", 42, "42"],
    ["an array", [ROOT], `["${ROOT}"]`],
  ])("a query scope sent as %s is a 403 naming the field, with one deny row", async (kind, scope, recorded) => {
    const refusal = `scope must be a string scope path, not ${kind}`;
    const res = await query({ query: "who owns refunds", scope });

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(refusal);
    expect(await auditRows()).toEqual([{ action: "memory.read", target: recorded, decision: "deny", reason: refusal }]);
  });

  describe("a NUL in what the request names", () => {
    const requests: [string, string, Send, (value: string) => string][] = [
      ["the query text", "memory.read", (text) => query({ query: text }), (text) => `${ROOT}/query:${text}`],
      ["an entity id read", "memory.entity", (id) => getEntity(id), (id) => `${ROOT}/${id}`],
      ["an entity id deleted", "memory.delete", (id) => deleteEntity(id), (id) => `${ROOT}/entity:${id}`],
      ["a fact id deleted", "memory.delete", (id) => deleteFact(id), (id) => `${ROOT}/fact:${id}`],
    ];

    it.each(requests)(
      "in %s is a 403 naming it, the fact stays, one deny row records it",
      async (_what, action, send, target) => {
        const res = await send(`refunds${NUL}`);

        expect(res.status).toBe(403);
        expect((await res.json()).error).toBe(NUL_TARGET);
        expect(await factStored()).toBe(true);
        expect(await auditRows()).toEqual([
          { action, target: target("refunds\\u0000"), decision: "deny", reason: NUL_TARGET },
        ]);
      },
    );

    it("from a caller the grants already refuse keeps that refusal's reason, with the NUL added", async () => {
      const { requireAccessContext } = await import("@/lib/access-context");
      vi.mocked(requireAccessContext).mockResolvedValueOnce({
        org: { id: ORG },
        user: { id: MEMBER, name: MEMBER },
        ctx: { orgId: ORG, actor: { type: "human", id: MEMBER, role: "member" }, origin: "app" },
      } as Awaited<ReturnType<typeof requireAccessContext>>);

      const res = await query({ query: `refunds${NUL}` });

      // The caller's half and the row's half each keep what the grants said, then the NUL.
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(
        `no read grant for user ${MEMBER} as a member of this org on the target scope — ` +
          `ask an org admin for a read grant covering the scope you need; ${NUL_TARGET}`,
      );
      expect(await auditRows()).toEqual([
        {
          action: "memory.read",
          target: `${ROOT}/query:refunds\\u0000`,
          decision: "deny",
          reason: `no read grant for user ${MEMBER} as a member of this org on ${ROOT}; ${NUL_TARGET}`,
        },
      ]);
    });

    it("the typed text \\u0000 is not a NUL: it is decided as usual and recorded as sent", async () => {
      const res = await query({ query: "refunds\\u0000" });

      expect(res.status).toBe(200);
      expect(await auditRows()).toContainEqual(
        expect.objectContaining({ action: "memory.read", target: `${ROOT}/query:refunds\\u0000`, decision: "allow" }),
      );
    });

    it("the same fact delete without a NUL removes the fact", async () => {
      const res = await deleteFact(FACT);

      expect(res.status).toBeLessThan(300);
      expect(await factStored()).toBe(false);
    });
  });
});
