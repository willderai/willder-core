// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A scope holding a NUL (U+0000) on PATCH or DELETE /api/memory/facts/:id is refused
// with a 403 that names the NUL and the fix, and leaves one deny row on the audit trail.
// Postgres text cannot hold a NUL, so the deny row the scope refusal writes used to fail
// on insert and the request answered a 500 that named nothing. The fact itself was never
// at risk: the refusal comes before the delete.
//
// Real: Postgres, both route handlers, resolveCallerScopePath and its audit write,
// GuardedMemoryStore, check() and the pgvector store's delete of the memory_chunks row.
// Faked: the Clerk session and the ingest queue (a spy; PATCH re-ingests the corrected
// text through it).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "nulscope";
const ROOT = `org_${ORG}`;
const ADMIN = "u-nulscope-admin";
const FACT = "chunk-nulscope-1";
const NUL = "\u0000";

const NUL_REFUSAL = "scope contains a NUL (\\u0000) character, which is not accepted. Remove it and retry.";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/inngest", () => ({ ingestMemory: vi.fn(async () => ({ readableNow: false })) }));
vi.mock("@/services/memory", async () => {
  const { GuardedMemoryStore } = await import("@/services/memory/guarded-store");
  const { PgvectorMemoryStore } = await import("@/services/memory/pgvector-store");
  const { MemoryServiceError } = await import("@/services/memory/graphiti-store");
  return { guardedMemory: new GuardedMemoryStore(new PgvectorMemoryStore()), MemoryServiceError };
});

describe.skipIf(!QA_URL)("PATCH and DELETE /api/memory/facts/:id refuse a NUL in the scope, real Postgres", () => {
  let db: PrismaClient;
  let PATCH: (typeof import("./route"))["PATCH"];
  let DELETE: (typeof import("./route"))["DELETE"];
  let ingestMemory: (typeof import("@/lib/inngest"))["ingestMemory"];

  const patch = (scope: string) =>
    PATCH(
      new Request(`http://t/api/memory/facts/${FACT}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fact: "Refunds are owned by payments.", scope }),
      }),
      { params: Promise.resolve({ id: FACT }) },
    );
  const del = (scope: string) =>
    DELETE(new Request(`http://t/api/memory/facts/${FACT}?scope=${encodeURIComponent(scope)}`, { method: "DELETE" }), {
      params: Promise.resolve({ id: FACT }),
    });

  const factStored = async () =>
    (
      await db.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM memory_chunks WHERE id = ${FACT}`
    )[0].n === 1;
  const auditRows = () =>
    db.auditLog.findMany({
      where: { orgId: ORG },
      select: { action: true, target: true, decision: true, reason: true },
      orderBy: { at: "asc" },
    });

  async function wipe() {
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
  }

  beforeAll(async () => {
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL! }) });
    ({ PATCH, DELETE } = await import("./route"));
    ({ ingestMemory } = await import("@/lib/inngest"));
    const { requireAccessContext } = await import("@/lib/access-context");
    // The fields the route reads; the full Clerk-backed org and user rows are not needed.
    vi.mocked(requireAccessContext).mockResolvedValue({
      org: { id: ORG },
      user: { id: ADMIN, name: ADMIN },
      ctx: { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "app" },
    } as Awaited<ReturnType<typeof requireAccessContext>>);

    await wipe();
    await db.grant.deleteMany({ where: { orgId: ORG } });
    await db.scope.deleteMany({ where: { orgId: ORG } });
    await db.user.deleteMany({ where: { orgId: ORG } });
    await db.org.deleteMany({ where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: "NUL scope" } });
    await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: `${ADMIN}@nulscope.test`, role: "admin", clerkId: `clerk-${ADMIN}` },
    });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: ROOT } });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
  }, 60_000);

  afterAll(async () => {
    await wipe();
    await db.grant.deleteMany({ where: { orgId: ORG } });
    await db.scope.deleteMany({ where: { orgId: ORG } });
    await db.user.deleteMany({ where: { orgId: ORG } });
    await db.org.deleteMany({ where: { id: ORG } });
    await db.$disconnect();
  });

  beforeEach(async () => {
    vi.mocked(ingestMemory).mockClear();
    await wipe();
    await db.$executeRaw`
      INSERT INTO memory_chunks (id, "orgId", content, "actorType", "scopePath")
      VALUES (${FACT}, ${ORG}, 'Refunds are owned by billing.', 'human', ${ROOT})`;
  });

  describe.each([
    ["PATCH", patch],
    ["DELETE", del],
  ] as const)("%s", (_method, send) => {
    it.each([
      ["at the end", `${ROOT}${NUL}`, `${ROOT}\\u0000`],
      ["inside a label", `${ROOT}.deal${NUL}a`, `${ROOT}.deal\\u0000a`],
    ])(
      "a NUL %s is a 403 naming the fix, the fact stays, and one deny row records it",
      async (_where, scope, recorded) => {
        const res = await send(scope);

        expect(res.status).toBe(403);
        expect((await res.json()).error).toBe(NUL_REFUSAL);
        expect(await factStored()).toBe(true);
        expect(ingestMemory).not.toHaveBeenCalled();
        // The row shows where the NUL was, as the six characters \u0000, since the
        // character itself cannot be stored. A backslash the caller sent is doubled, so
        // the two never read the same (next test).
        expect(await auditRows()).toEqual([
          { action: "memory.delete", target: recorded, decision: "deny", reason: NUL_REFUSAL },
        ]);
      },
    );

    it("the literal text \\u0000 is recorded apart from a NUL: its backslash is doubled", async () => {
      const res = await send(`${ROOT}\\u0000`);

      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(`scope "${ROOT}\\u0000" is not a valid scope path`);
      expect(await factStored()).toBe(true);
      expect((await auditRows()).map((r) => r.target)).toEqual([`${ROOT}\\\\u0000`]);
    });

    it("the same request with a valid scope removes the fact", async () => {
      const res = await send(ROOT);

      expect(res.status).toBeLessThan(300);
      expect(await factStored()).toBe(false);
      expect((await auditRows()).map((r) => [r.action, r.decision])).toContainEqual(["memory.delete", "allow"]);
    });
  });
});
