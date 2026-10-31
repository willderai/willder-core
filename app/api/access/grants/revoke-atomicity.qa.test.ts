// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A failed cleanup must not leave agent access behind.
//
// If DELETE /api/access/grants/:id deleted the Grant row and then SEPARATELY
// updated the handoff capabilities, with no transaction linking them, a
// failure in the capability write would leave the grant already gone and its
// minted token still usable, and a retry would return 404, so the operator
// would have no way to finish the revoke.
//
// This asserts the revoke is ATOMIC: a failure in the capability step must
// leave the grant intact so the caller can retry.
//
// Set QA_DATABASE_URL to an ISOLATED test database; skips cleanly without it.
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "org-qa-atomic";
const SCOPE = "org_1.dept_sales";
const ADMIN = "u-admin-atomic";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

describe.skipIf(!QA_URL)("grant revoke must be atomic with the capability cascade", () => {
  let db: PrismaClient;
  let DELETE: (typeof import("./[id]/route"))["DELETE"];
  let requireAccessContext: ReturnType<typeof vi.fn>;
  let grantId: string;

  beforeEach(async () => {
    process.env.DATABASE_URL = QA_URL;
    db ??= new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ DELETE } = await import("./[id]/route"));
    ({ requireAccessContext } = (await import("@/lib/access-context")) as never);

    await db.capability.deleteMany({ where: { orgId: ORG } });
    await db.grant.deleteMany({ where: { orgId: ORG } });
    await db.scope.deleteMany({ where: { orgId: ORG } });
    await db.user.deleteMany({ where: { orgId: ORG } });
    await deleteOrgsWithRetry(db, { where: { id: ORG } });

    await db.org.create({ data: { id: ORG, name: "QA atomic" } });
    await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: "a@atomic.test", role: "admin", clerkId: "clerk-atomic" },
    });
    const scope = await db.scope.create({ data: { orgId: ORG, path: SCOPE, name: "sales" } });
    await db.grant.create({
      data: { orgId: ORG, scopeId: scope.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    const grant = await db.grant.create({
      data: { orgId: ORG, scopeId: scope.id, granteeType: "user", granteeId: ADMIN, permission: "read" },
    });
    grantId = grant.id;
    await db.capability.create({
      data: {
        id: "cap-atomic",
        orgId: ORG,
        agentId: "handoff-agent",
        scopePath: SCOPE,
        tokenHash: "hash-atomic",
        permission: "read",
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });

    requireAccessContext.mockResolvedValue({
      org: { id: ORG },
      ctx: { orgId: ORG, actor: { type: "human", id: ADMIN }, role: "admin" },
    } as never);
  });

  afterAll(async () => {
    await db.capability.deleteMany({ where: { orgId: ORG } });
    await db.grant.deleteMany({ where: { orgId: ORG } });
    await db.scope.deleteMany({ where: { orgId: ORG } });
    await db.user.deleteMany({ where: { orgId: ORG } });
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.$disconnect();
  });

  it("a failure in the capability step leaves the grant intact, so the revoke can be retried", async () => {
    const { db: routeDb } = await import("@/lib/db");
    const spy = vi
      .spyOn(routeDb.capability, "updateMany")
      .mockRejectedValueOnce(new Error("simulated database failure during capability revoke"));

    await DELETE(new Request("http://t", { method: "DELETE" }), {
      params: Promise.resolve({ id: grantId }),
    } as never).catch(() => undefined);

    spy.mockRestore();

    const grant = await db.grant.findUnique({ where: { id: grantId } });
    const cap = await db.capability.findUniqueOrThrow({ where: { id: "cap-atomic" } });

    // Either both happened or neither did. The state that must never exist is
    // "grant gone, capability still live": the token keeps passing check() for
    // its full TTL and a retry returns 404, so nothing can finish the revoke.
    expect(
      grant === null && cap.revokedAt === null,
      "grant was deleted while its handoff capability stayed live — revoke is not atomic",
    ).toBe(false);
  });
});
