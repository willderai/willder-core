// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The ordering rule in services/access/membership.ts: a write
// asserted before the stored state is ignored, and a removal wins a tie. Clerk
// session tokens carry `iat` in whole seconds, so a re-add and a removal asserted
// in the same second is a real case, not a theoretical one; whichever arrives
// second, the person must end up removed.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never a live one.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;
const IMPORT_TIMEOUT_MS = 60_000;

const ORG_A = "org-qa-mo-a";
const ORG_B = "org-qa-mo-b";
const ORGS = { in: [ORG_A, ORG_B] };
const USER_ID = "u-qa-mo-person";

describe.skipIf(!QA_URL)("membership writes: older is ignored, a removal wins a tie (real Postgres)", () => {
  let db: PrismaClient;
  let membership: typeof import("./membership");

  async function reset() {
    await db.user.deleteMany({ where: { OR: [{ orgId: ORGS }, { id: USER_ID }] } });
    await db.org.deleteMany({ where: { id: ORGS } });
  }

  async function stored(orgId: string) {
    return db.orgMembership.findUniqueOrThrow({ where: { orgId_userId: { orgId, userId: USER_ID } } });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    ({ db } = await import("@/lib/db"));
    membership = await import("./membership");
  }, IMPORT_TIMEOUT_MS);

  beforeEach(async () => {
    await reset();
    for (const id of [ORG_A, ORG_B]) {
      await db.org.create({ data: { id, clerkOrgId: `clerk_${id}`, name: id } });
    }
    // The person also belongs to B, so a removal from A keeps their user row.
    await db.user.create({
      data: { id: USER_ID, orgId: ORG_B, clerkId: "clerk_user_qa_mo", email: "mo@example.test", role: "admin" },
    });
    await membership.recordMembership({
      orgId: ORG_A,
      userId: USER_ID,
      role: "admin",
      assertedAt: new Date(Date.UTC(2026, 9, 10, 0, 0, 0)),
    });
  });

  afterAll(async () => {
    await reset();
  });

  const tie = new Date(Date.UTC(2026, 9, 10, 0, 0, 30));

  it("a re-add asserted in the same instant as a stored removal does not restore the membership", async () => {
    await membership.recordMembershipRemoved({ orgId: ORG_A, userId: USER_ID, removedAt: tie });

    const after = await membership.recordMembership({ orgId: ORG_A, userId: USER_ID, role: "admin", assertedAt: tie });

    expect(after.removedAt).not.toBeNull();
    expect(await membership.liveMembership(ORG_A, USER_ID)).toBeNull();
  });

  it("a removal asserted in the same instant as a stored membership still removes it", async () => {
    await membership.recordMembership({ orgId: ORG_A, userId: USER_ID, role: "admin", assertedAt: tie });

    await membership.recordMembershipRemoved({ orgId: ORG_A, userId: USER_ID, removedAt: tie });

    expect((await stored(ORG_A)).removedAt).not.toBeNull();
    expect(await membership.liveMembership(ORG_A, USER_ID)).toBeNull();
  });

  it("a role change asserted in the same instant as the stored role does not overwrite it", async () => {
    await membership.recordMembership({ orgId: ORG_A, userId: USER_ID, role: "member", assertedAt: tie });

    const after = await membership.recordMembership({ orgId: ORG_A, userId: USER_ID, role: "admin", assertedAt: tie });

    expect(after.role).toBe("member");
  });

  it("a removal asserted one millisecond before the stored membership changes nothing", async () => {
    await membership.recordMembership({ orgId: ORG_A, userId: USER_ID, role: "admin", assertedAt: tie });

    await membership.recordMembershipRemoved({ orgId: ORG_A, userId: USER_ID, removedAt: new Date(tie.getTime() - 1) });

    expect(await membership.liveMembership(ORG_A, USER_ID)).toMatchObject({ role: "admin" });
  });
});
