// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// PATCH /api/memory/facts/:id, real-Postgres QA.
//
// An edit is a delete followed by a re-ingest of the corrected text. The mocked
// companions (memory-routes.test.ts, facts-id-route-scope-guard.test.ts) assert
// which functions the route calls. They cannot count what lands in audit_log,
// which is the claim here: one edit writes exactly one `memory.delete` decision
// row, the one check() writes inside guardedMemory.removeFact(), same as DELETE.
//
// This file drives the real handler through the real GuardedMemoryStore and the
// real check() against Postgres 16 with ltree. Only the memory backend (an
// in-memory fact set keyed by tenant, executed partition and fact id) and the
// Inngest send are faked.
//
// Fixture: org `pq1` with a writer and a reader on `org_pq1.deal_a`, an admin at
// org root, one fact stored at `org_pq1.deal_a`, and a second org `pq2` whose
// admin holds byte-identical scope paths but none of pq1's facts.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never the sandbox's
// inherited DATABASE_URL. Skips cleanly without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { Permission } from "@/lib/generated/prisma/enums";
import type { MemoryStore } from "@/services/memory/memory-store";
import type { RemoveFactInput } from "@/types/memory";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "pq1";
const OTHER_ORG = "pq2";
const ROOT = "org_pq1";
const DEAL = `${ROOT}.deal_a`;
const OTHER_ROOT = "org_pq2";
const OTHER_DEAL = `${OTHER_ROOT}.deal_a`;
const WRITER = "u-pq-writer";
const READER = "u-pq-reader";
const ADMIN = "u-pq-admin";
const OTHER_ADMIN = "u-pq2-admin";
const FACT = "fact-pq-1";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/inngest", () => ({ ingestMemory: vi.fn(async () => undefined) }));

// Stored facts as `${tenantId}|${partition}|${factId}`: removeFact removes only
// a fact in the caller's tenant at the partition the guarded store executes on.
const stored = vi.hoisted(() => ({ facts: new Set<string>() }));
const removeFact = vi.hoisted(() =>
  vi.fn(async (input: RemoveFactInput) => {
    const key = `${input.tenantId}|${input.groupId}|${input.factId}`;
    return { removed: stored.facts.delete(key) };
  }),
);
vi.mock("@/services/memory", async () => {
  const { GuardedMemoryStore } = await import("@/services/memory/guarded-store");
  const { MemoryServiceError } = await import("@/services/memory/graphiti-store");
  return {
    guardedMemory: new GuardedMemoryStore({ removeFact } as unknown as MemoryStore),
    MemoryServiceError,
  };
});

describe.skipIf(!QA_URL)("PATCH /api/memory/facts/:id: one audited decision per edit, real Postgres", () => {
  let db: PrismaClient;
  let PATCH: (typeof import("./[id]/route"))["PATCH"];
  let requireAccessContext: ReturnType<typeof vi.fn>;
  let ingestMemory: ReturnType<typeof vi.fn>;

  const as = (orgId: string, userId: string, role: "admin" | "member") =>
    requireAccessContext.mockResolvedValue({
      org: { id: orgId },
      user: { id: userId, name: userId },
      ctx: { orgId, actor: { type: "human", id: userId, role } },
    });
  const edit = (scope: string | undefined, factId = FACT) =>
    PATCH(
      new Request(`http://t/api/memory/facts/${factId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fact: "corrected text", ...(scope ? { scope } : {}) }),
      }),
      { params: Promise.resolve({ id: factId }) },
    );
  const rows = (orgId: string, action: string) =>
    db.auditLog.findMany({ where: { orgId, action }, select: { decision: true, target: true } });

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ PATCH } = await import("./[id]/route"));
    ({ requireAccessContext } = (await import("@/lib/access-context")) as never);
    ({ ingestMemory } = (await import("@/lib/inngest")) as never);

    const orgs = [ORG, OTHER_ORG];
    await db.auditLog.deleteMany({ where: { orgId: { in: orgs } } });
    await db.grant.deleteMany({ where: { orgId: { in: orgs } } });
    await db.scope.deleteMany({ where: { orgId: { in: orgs } } });
    await db.user.deleteMany({ where: { orgId: { in: orgs } } });
    await db.org.deleteMany({ where: { id: { in: orgs } } });

    for (const id of orgs) await db.org.create({ data: { id, name: `QA patch ${id}` } });
    const users: [string, string, "admin" | "member"][] = [
      [WRITER, ORG, "member"],
      [READER, ORG, "member"],
      [ADMIN, ORG, "admin"],
      [OTHER_ADMIN, OTHER_ORG, "admin"],
    ];
    for (const [id, orgId, role] of users) {
      await db.user.create({ data: { id, orgId, email: `${id}@pq.test`, role, clerkId: `clerk-${id}` } });
    }

    const scope = async (orgId: string, path: string) =>
      (await db.scope.create({ data: { orgId, path, name: path } })).id;
    const root = await scope(ORG, ROOT);
    const deal = await scope(ORG, DEAL);
    const otherRoot = await scope(OTHER_ORG, OTHER_ROOT);
    await scope(OTHER_ORG, OTHER_DEAL);
    const grant = (orgId: string, scopeId: string, granteeId: string, permission: Permission) =>
      db.grant.create({ data: { orgId, scopeId, granteeType: "user", granteeId, permission } });
    await grant(ORG, deal, WRITER, "write");
    await grant(ORG, deal, READER, "read");
    await grant(ORG, root, ADMIN, "admin");
    await grant(OTHER_ORG, otherRoot, OTHER_ADMIN, "admin");
  });

  afterAll(async () => {
    const orgs = [ORG, OTHER_ORG];
    await db.auditLog.deleteMany({ where: { orgId: { in: orgs } } });
    await db.grant.deleteMany({ where: { orgId: { in: orgs } } });
    await db.scope.deleteMany({ where: { orgId: { in: orgs } } });
    await db.user.deleteMany({ where: { orgId: { in: orgs } } });
    await db.org.deleteMany({ where: { id: { in: orgs } } });
    await db.$disconnect();
  });

  beforeEach(async () => {
    await db.auditLog.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
    stored.facts = new Set([`${ORG}|${DEAL}|${FACT}`]);
    removeFact.mockClear();
    ingestMemory.mockClear();
  });

  it("a permitted edit writes exactly one memory.delete decision, removes the fact, and re-ingests once", async () => {
    as(ORG, WRITER, "member");
    const res = await edit(DEAL);

    expect(res.status).toBe(202);
    expect(await rows(ORG, "memory.delete")).toEqual([
      { decision: "allow", target: expect.stringMatching(new RegExp(`fact:${FACT}$`)) },
    ]);
    expect(await rows(ORG, "memory.delete.applied")).toHaveLength(1);
    expect(stored.facts.size).toBe(0);
    expect(ingestMemory).toHaveBeenCalledTimes(1);
    expect(ingestMemory).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: ORG, content: "corrected text", scopePath: DEAL }),
    );
  });

  it("a fact that is not at the checked scope returns 404, keeps the fact, and re-ingests nothing", async () => {
    // Admin may delete at org root, but the fact lives at deal_a: removed:false.
    as(ORG, ADMIN, "admin");
    const res = await edit(undefined);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "fact not found" });
    expect(await rows(ORG, "memory.delete")).toEqual([
      { decision: "allow", target: expect.stringMatching(new RegExp(`fact:${FACT}$`)) },
    ]);
    expect(stored.facts.size).toBe(1);
    expect(ingestMemory).not.toHaveBeenCalled();
  });

  it("another tenant editing the same fact id at the same path returns 404 and re-ingests nothing", async () => {
    as(OTHER_ORG, OTHER_ADMIN, "admin");
    const res = await edit(OTHER_DEAL);

    expect(res.status).toBe(404);
    expect(removeFact).toHaveBeenCalledWith(expect.objectContaining({ tenantId: OTHER_ORG }));
    expect(stored.facts.size).toBe(1);
    expect(await rows(ORG, "memory.delete")).toHaveLength(0);
    expect(ingestMemory).not.toHaveBeenCalled();
  });

  it("a read-only member is denied 403 with one deny row, and nothing is removed or ingested", async () => {
    as(ORG, READER, "member");
    const res = await edit(DEAL);

    expect(res.status).toBe(403);
    expect(await rows(ORG, "memory.delete")).toEqual([
      { decision: "deny", target: expect.stringMatching(new RegExp(`fact:${FACT}$`)) },
    ]);
    expect(removeFact).not.toHaveBeenCalled();
    expect(stored.facts.size).toBe(1);
    expect(ingestMemory).not.toHaveBeenCalled();
  });

  it("a writer outside their granted scope is denied 403, and nothing is removed or ingested", async () => {
    as(ORG, WRITER, "member");
    const res = await edit(undefined);

    expect(res.status).toBe(403);
    expect(await rows(ORG, "memory.delete")).toEqual([
      { decision: "deny", target: expect.stringMatching(new RegExp(`fact:${FACT}$`)) },
    ]);
    expect(removeFact).not.toHaveBeenCalled();
    expect(ingestMemory).not.toHaveBeenCalled();
  });
});
