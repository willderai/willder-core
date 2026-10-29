// Test support: make a fixture person a live member of an org, as a signed-in
// request or Clerk's membership webhook leaves them.
//
// check() decides a person's access from their membership of the org
// (services/access/member-grants.ts), never from the role a context claims, so
// a test that hands check() a person must make that person a member first.
import type { PrismaClient } from "@/lib/generated/prisma/client";
import type { UserRole } from "@/types";

/**
 * Give `userId` a `users` row in `orgId` if they have none, and a live
 * membership of `orgId` with `role`. Safe to call again: a second call updates
 * the role and restores a removed membership.
 */
export async function seedMember(
  db: Pick<PrismaClient, "$executeRaw">,
  member: { orgId: string; userId: string; role?: UserRole },
): Promise<void> {
  const { orgId, userId, role = "member" } = member;
  await db.$executeRaw`
    INSERT INTO "users" ("id", "orgId", "clerkId", "email", "role", "createdAt", "updatedAt")
    VALUES (${userId}, ${orgId}, ${`clerk_${userId}`}, ${`${userId}@member.test`}, ${role}::"UserRole",
            (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC'))
    ON CONFLICT ("id") DO NOTHING`;
  await db.$executeRaw`
    INSERT INTO "org_memberships" ("orgId", "userId", "role", "assertedAt", "createdAt", "updatedAt")
    VALUES (${orgId}, ${userId}, ${role}::"UserRole", TIMESTAMP '1970-01-01',
            (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC'))
    ON CONFLICT ("orgId", "userId") DO UPDATE
    SET "role" = EXCLUDED."role", "removedAt" = NULL, "updatedAt" = EXCLUDED."updatedAt"`;
}
