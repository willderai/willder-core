// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The REST routes that write memory at a caller-named `scope` (POST /api/memory/ingest,
// POST /api/memory/facts, and a confirmed save on POST /api/memory/chat) accept only a
// scope every read path accepts. A malformed scope used to throw in check()'s `::ltree`
// cast (a 500), and a label Postgres takes but the read paths refuse (`café`) was
// queued for storage at a scope nothing could read back by name. A scope sent as
// another JSON type (a number, an array) threw a TypeError before any check. Each is
// now a 403 naming the field, with nothing queued and one deny row.
//
// Real: Postgres, the three route handlers, the scope refusal and its audit write, and
// check(). Faked: the Clerk session, the ingest queue (a spy, which is where a write is
// accepted), the LLM client (a confirmed save never calls it) and `after()` (run inline).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "writerscope";
const ROOT = `org_${ORG}`;
const DEAL = `${ROOT}.deal_a`;
const ADMIN = "u-writerscope-admin";
const NUL = "\u0000";
const NUL_REFUSAL = "scope contains a NUL (\\u0000) character, which is not accepted. Remove it and retry.";

/** A scope sent as another JSON type, the refusal that names it, and its audit target. */
const NOT_A_STRING: [string, unknown, string][] = [
  ["a number", 42, "42"],
  ["a boolean", true, "true"],
  ["an array", [DEAL], `["${DEAL}"]`],
  ["an object", { path: DEAL }, `{"path":"${DEAL}"}`],
];

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

/** Each writer, sending one fact at the given scope. */
const WRITERS: [string, (scope: unknown) => Promise<Response>][] = [
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

function json(body: unknown) {
  return new Request("http://t/api/memory", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe.skipIf(!QA_URL)("memory writers refuse a scope no read path accepts, real Postgres", () => {
  let db: PrismaClient;
  let ingestMemory: (typeof import("@/lib/inngest"))["ingestMemory"];

  const auditRows = () =>
    db.auditLog.findMany({
      where: { orgId: ORG },
      select: { action: true, target: true, decision: true, reason: true },
      orderBy: { at: "asc" },
    });
  const queuedScopes = () => vi.mocked(ingestMemory).mock.calls.map(([input]) => input.scopePath);

  async function clearTenant() {
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.grant.deleteMany({ where: { orgId: ORG } });
    await db.scope.deleteMany({ where: { orgId: ORG } });
    await db.user.deleteMany({ where: { orgId: ORG } });
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
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
      user: { id: ADMIN, name: ADMIN, email: `${ADMIN}@writerscope.test` },
      ctx: { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "app" },
    } as Awaited<ReturnType<typeof requireAccessContext>>);

    await clearTenant();
    await db.org.create({ data: { id: ORG, name: "Writer scope" } });
    await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: `${ADMIN}@writerscope.test`, role: "admin", clerkId: `clerk-${ADMIN}` },
    });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: ROOT } });
    await db.scope.create({ data: { orgId: ORG, path: DEAL, name: "deal a" } });
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
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
  });

  describe.each(WRITERS)("%s", (_route, send) => {
    it.each([
      ["a space", `${ROOT}.deal A`, "is not a valid scope path"],
      ["a non-ASCII label", `${ROOT}.café`, "is not a valid scope path"],
      // Valid ltree, but `deal-A` reads as `deal.A`; no minted scope holds a dash.
      ["a dash", `${ROOT}.deal-A`, "holds a dash; scope labels are letters, digits and underscores"],
    ])("a scope holding %s is a 403 naming it, nothing is queued, one deny row", async (_what, scope, why) => {
      const refusal = `scope "${scope}" ${why}`;
      const res = await send(scope);

      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(refusal);
      expect(queuedScopes()).toEqual([]);
      expect(await auditRows()).toEqual([{ action: "memory.write", target: scope, decision: "deny", reason: refusal }]);
    });

    it("a valid scope is written there", async () => {
      const res = await send(DEAL);

      expect(res.status).toBeLessThan(300);
      await res.text();
      expect(queuedScopes()).toEqual([DEAL]);
    });

    it("a NUL in the scope is a 403 naming it, not stripped and stored at the remaining path, one deny row", async () => {
      const res = await send(`${DEAL}${NUL}`);

      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(NUL_REFUSAL);
      expect(queuedScopes()).toEqual([]);
      expect(await auditRows()).toEqual([
        { action: "memory.write", target: `${DEAL}\\u0000`, decision: "deny", reason: NUL_REFUSAL },
      ]);
    });

    it.each(NOT_A_STRING)(
      "a scope sent as %s is a 403 naming the field, nothing is queued, one deny row",
      async (kind, scope, recorded) => {
        const refusal = `scope must be a string scope path, not ${kind}`;
        const res = await send(scope);

        expect(res.status).toBe(403);
        expect((await res.json()).error).toBe(refusal);
        expect(queuedScopes()).toEqual([]);
        expect(await auditRows()).toEqual([
          { action: "memory.write", target: recorded, decision: "deny", reason: refusal },
        ]);
      },
    );
  });
});
