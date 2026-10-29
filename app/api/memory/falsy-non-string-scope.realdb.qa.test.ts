// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A scope sent as a JSON value that is not a string is refused by name with one deny
// row, including the falsy ones (0, false) and empty containers that a truthiness or
// emptiness check would read as "no scope" and replace with the org root. Covers the two
// writers the builder suite does not (PATCH /api/memory/facts/:id and POST
// /api/memory/facts/:id/provenance) plus ingest, facts and query, so a refusal keyed
// on truthiness instead of type fails here on every route.
//
// Real: Postgres, the route handlers, resolveCallerScopePath and its audit write,
// GuardedMemoryStore and check(). Faked: the Clerk session and the ingest queue (a spy).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "falsyscope";
const ROOT = `org_${ORG}`;
const ADMIN = "u-falsyscope-admin";
const FACT = "chunk-falsyscope-1";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/inngest", () => ({ ingestMemory: vi.fn(async () => ({ readableNow: false })) }));
vi.mock("@/services/memory", async () => {
  const { GuardedMemoryStore } = await import("@/services/memory/guarded-store");
  const { PgvectorMemoryStore } = await import("@/services/memory/pgvector-store");
  const { MemoryServiceError } = await import("@/services/memory/graphiti-store");
  return { guardedMemory: new GuardedMemoryStore(new PgvectorMemoryStore()), MemoryServiceError };
});

/** Falsy or empty JSON values that are not strings, with the type the refusal names and the
 * audit target it records. */
const FALSY: [string, unknown, string][] = [
  ["a number", 0, "0"],
  ["a boolean", false, "false"],
  ["an array", [], "[]"],
  ["an object", {}, "{}"],
];

function request(url: string, method: string, body: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
const factParams = { params: Promise.resolve({ id: FACT }) };

/** Each route, its audit action, and a sender for one request at the given scope. */
const ROUTES: [string, string, (scope: unknown) => Promise<Response>][] = [
  [
    "POST /api/memory/ingest",
    "memory.write",
    async (scope) =>
      (await import("./ingest/route")).POST(
        request("http://t/api/memory/ingest", "POST", { content: "Refunds are owned by payments.", scope }),
      ),
  ],
  [
    "POST /api/memory/facts",
    "memory.write",
    async (scope) =>
      (await import("./facts/route")).POST(
        request("http://t/api/memory/facts", "POST", { fact: "Refunds are owned by payments.", scope }),
      ),
  ],
  [
    "PATCH /api/memory/facts/:id",
    "memory.delete",
    async (scope) =>
      (await import("./facts/[id]/route")).PATCH(
        request(`http://t/api/memory/facts/${FACT}`, "PATCH", { fact: "Refunds are owned by payments.", scope }),
        factParams,
      ),
  ],
  [
    "POST /api/memory/facts/:id/provenance",
    "memory.write",
    async (scope) =>
      (await import("./facts/[id]/provenance/route")).POST(
        request(`http://t/api/memory/facts/${FACT}/provenance`, "POST", { sourceType: "pr", sourceRef: "pr-1", scope }),
        factParams,
      ),
  ],
  [
    "POST /api/memory/query",
    "memory.read",
    async (scope) =>
      (await import("./query/route")).POST(
        request("http://t/api/memory/query", "POST", { query: "who owns refunds", scope }),
      ),
  ],
];

describe.skipIf(!QA_URL)("a falsy non-string scope is refused by type, never read as absent, real Postgres", () => {
  let db: PrismaClient;
  let ingestMemory: (typeof import("@/lib/inngest"))["ingestMemory"];

  const auditRows = () =>
    db.auditLog.findMany({
      where: { orgId: ORG },
      select: { action: true, target: true, decision: true, reason: true },
      orderBy: { at: "asc" },
    });
  const factStored = async () =>
    (
      await db.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM memory_chunks WHERE id = ${FACT}`
    )[0].n === 1;

  async function clearTenant() {
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
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
      org: { id: ORG },
      user: { id: ADMIN, name: ADMIN, email: `${ADMIN}@falsyscope.test` },
      ctx: { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "app" },
    } as Awaited<ReturnType<typeof requireAccessContext>>);

    await clearTenant();
    await db.org.create({ data: { id: ORG, name: "Falsy scope" } });
    await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: `${ADMIN}@falsyscope.test`, role: "admin", clerkId: `clerk-${ADMIN}` },
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
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.$executeRaw`
      INSERT INTO memory_chunks (id, "orgId", content, "actorType", "scopePath")
      VALUES (${FACT}, ${ORG}, 'Refunds are owned by billing.', 'human', ${ROOT})`;
  });

  describe.each(ROUTES)("%s", (_route, action, send) => {
    it.each(FALSY)(
      "a scope sent as %s (falsy or empty) is a 403 naming its type, nothing changes, one deny row",
      async (kind, scope, recorded) => {
        const refusal = `scope must be a string scope path, not ${kind}`;
        const res = await send(scope);

        expect(res.status).toBe(403);
        expect((await res.json()).error).toBe(refusal);
        expect(ingestMemory).not.toHaveBeenCalled();
        expect(await factStored()).toBe(true);
        expect(await auditRows()).toEqual([{ action, target: recorded, decision: "deny", reason: refusal }]);
      },
    );

    it("null is no scope: the request is not refused for its scope", async () => {
      const res = await send(null);

      expect(res.status).not.toBe(403);
      expect((await auditRows()).filter((r) => r.decision === "deny")).toEqual([]);
    });
  });
});
