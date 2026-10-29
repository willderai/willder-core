// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// POST /api/memory/facts accepts only a string `fact` in a JSON object body. A fact sent
// as another JSON type (a number, a boolean, an array, an object) used to throw a
// TypeError on `.trim()`, and a body of `null` threw reading `.fact`; both answered a
// 500 that named nothing. Each is now a 400 naming the field and the type it was sent
// as, refused before check() runs, so nothing is queued and no audit row is written.
// A null or missing fact is no fact: the existing "fact is required".
//
// Real: Postgres, the route handler, the scope resolver and check() with its audit
// write. Faked: the Clerk session and the ingest queue (a spy, which is where a write
// is accepted).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "factnonstring";
const ROOT = `org_${ORG}`;
const ADMIN = "u-factnonstring-admin";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/inngest", () => ({ ingestMemory: vi.fn(async () => ({ readableNow: false })) }));

/** A fact sent as another JSON type, and the type the refusal names. Includes the falsy
 * values a truthiness check would read as "no fact". */
const NOT_A_STRING: [string, unknown][] = [
  ["a number", 42],
  ["a number", 0],
  ["a boolean", true],
  ["a boolean", false],
  ["an array", ["Refunds are owned by payments."]],
  ["an object", { text: "Refunds are owned by payments." }],
];

function post(body: string) {
  return new Request("http://t/api/memory/facts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

describe.skipIf(!QA_URL)("POST /api/memory/facts refuses a fact that is not a string by name, real Postgres", () => {
  let db: PrismaClient;
  let ingestMemory: (typeof import("@/lib/inngest"))["ingestMemory"];
  let POST: (typeof import("./route"))["POST"];

  const auditRows = () =>
    db.auditLog.findMany({ where: { orgId: ORG }, select: { action: true, decision: true }, orderBy: { at: "asc" } });

  async function clearTenant() {
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
    ({ POST } = await import("./route"));
    const { requireAccessContext } = await import("@/lib/access-context");
    // The fields the route reads; the full Clerk-backed org and user rows are not needed.
    vi.mocked(requireAccessContext).mockResolvedValue({
      org: { id: ORG },
      user: { id: ADMIN, name: ADMIN, email: `${ADMIN}@factnonstring.test` },
      ctx: { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "app" },
    } as Awaited<ReturnType<typeof requireAccessContext>>);

    await clearTenant();
    await db.org.create({ data: { id: ORG, name: "Fact not a string" } });
    await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: `${ADMIN}@factnonstring.test`, role: "admin", clerkId: `clerk-${ADMIN}` },
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
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
  });

  it.each(NOT_A_STRING)(
    "a fact sent as %s (%j) is a 400 naming its type; nothing queued, no audit row",
    async (kind, fact) => {
      const res = await POST(post(JSON.stringify({ fact })));

      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(`fact must be a string, not ${kind}`);
      expect(ingestMemory).not.toHaveBeenCalled();
      expect(await auditRows()).toEqual([]);
    },
  );

  it.each([
    ["null", "null"],
    ["a string", JSON.stringify("Refunds are owned by payments.")],
    ["an array", JSON.stringify([{ fact: "Refunds are owned by payments." }])],
  ])("a body that is %s, not a JSON object, is a 400 naming that; nothing queued, no audit row", async (kind, body) => {
    const res = await POST(post(body));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(`request body must be a JSON object, not ${kind}`);
    expect(ingestMemory).not.toHaveBeenCalled();
    expect(await auditRows()).toEqual([]);
  });

  it("a null fact is no fact: refused as missing, not by type", async () => {
    const res = await POST(post(JSON.stringify({ fact: null })));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("fact is required");
    expect(ingestMemory).not.toHaveBeenCalled();
  });

  it("a string fact is still accepted: trimmed, queued at the org root, one allow row", async () => {
    const res = await POST(post(JSON.stringify({ fact: "  Refunds are owned by payments.  " })));

    expect(res.status).toBe(202);
    expect(ingestMemory).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ingestMemory).mock.calls[0][0]).toMatchObject({
      groupId: ORG,
      content: "Refunds are owned by payments.",
      scopePath: ROOT,
    });
    expect(await auditRows()).toEqual([{ action: "memory.write", decision: "allow" }]);
  });
});
