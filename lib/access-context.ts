// Resolve the human AccessContext for the current request from Clerk. This is the
// bridge between the auth session and the UC2 check() gate: it ensures the tenant
// rows exist (ensureTenant) and returns the internal org + user + a ready-to-use
// AccessContext whose actor is the signed-in human (internal User.id + role).
//
// The role is the person's role in THIS request's org, read from their membership
// of it (services/access/membership.ts), never the role stored on the user row,
// which belongs to whichever org they last had open.
//
// Returns null when there's no signed-in user or no active org / synced user, so
// route handlers can map that to 401/403. Agents don't go through here — they
// authenticate with a capability token (see services/access/check.ts).
import { auth } from "@clerk/nextjs/server";
import { db } from "@/lib/db";
import { ensureTenant } from "@/lib/tenant";
import { liveMembership, type AccessContext } from "@/services/access";
import type { Org, User } from "@/lib/generated/prisma/client";

export interface RequestContext {
  org: Org;
  /** The signed-in person, with `role` set to their role in `org`. */
  user: User;
  /** Pass straight to check()/the guarded memory store. */
  ctx: AccessContext;
}

export async function requireAccessContext(): Promise<RequestContext | null> {
  const { userId } = await auth();
  if (!userId) return null;

  const org = await ensureTenant(); // upserts org + user, seeds the access root
  if (!org) return null;

  const user = await db.user.findUnique({ where: { clerkId: userId } });
  if (!user) return null;

  const membership = await liveMembership(org.id, user.id);
  if (!membership) return null;

  return {
    org,
    user: { ...user, role: membership.role },
    ctx: {
      orgId: org.id,
      actor: {
        type: "human",
        id: user.id,
        role: membership.role,
        name: user.name ?? undefined,
      },
      origin: "app",
    },
  };
}
