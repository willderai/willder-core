// Tenant sync: mirror the active Clerk organization + user into Postgres so the
// app has a stable internal `orgId` to use as the Neo4j `group_id` and to join
// CRM/outbound data against. Clerk owns identity; this keeps our system-of-record
// in step. Lazy + idempotent (upsert) — call it from server context where the
// tenant must exist (e.g. the memory routes, the org settings page).
//
// A person can belong to several orgs. Their membership and role in the org of
// this request is recorded per org (services/access/membership.ts), which is what
// authorization reads; `users.orgId`/`users.role` only remember the org they last
// had open. The Clerk webhook (app/api/webhooks/clerk) records membership changes
// that happen while the person is not signed in to that org.
import { auth, clerkClient, currentUser } from "@clerk/nextjs/server";
import { db } from "@/lib/db";
import { clerkRoleToUserRole, ensureAccessRoot, recordMembership } from "@/services/access";
import { orgDeletionOpen } from "@/services/access/org-deletion-gate";
import { HANDOFF_AGENT_ID, HANDOFF_AGENT_NAME } from "@/lib/handoff-agent";
import { ARCHITECTURE_AGENT_ID, ARCHITECTURE_AGENT_NAME } from "@/lib/architecture-agent";
import { WELCOME_BONUS_CREDITS } from "@/services/billing/plans";
import { QA_AGENT_ID, QA_AGENT_NAME } from "@/lib/qa-agent";
import {
  DEFAULT_TOOLS,
  DEFAULT_HANDOFF_PROMPT,
  DEFAULT_ARCHITECTURE_PROMPT,
  DEFAULT_QA_PROMPT,
} from "@/services/agents/runner";
import { inngest, MEMORY_INGEST_EVENT } from "@/lib/inngest";
import { emailsOfClerkUser, storedEmailVerified } from "@/lib/clerk-email";
import type { IngestInput } from "@/types/memory";

/** When Clerk issued this request's session token: the time its claims (active
 * org, role) were true. Without one, the epoch, so the claims never override a
 * membership change Clerk reported with a real time. */
function sessionIssuedAt(sessionClaims: { iat?: number } | null | undefined): Date {
  const iat = sessionClaims?.iat;
  return new Date(typeof iat === "number" ? iat * 1000 : 0);
}

const AGENT_SEEDS = [
  {
    agentKey: HANDOFF_AGENT_ID,
    name: HANDOFF_AGENT_NAME,
    role: "handoff" as const,
    model: "gpt-4o-mini",
    systemPrompt: DEFAULT_HANDOFF_PROMPT,
    tools: DEFAULT_TOOLS.handoff,
  },
  {
    agentKey: ARCHITECTURE_AGENT_ID,
    name: ARCHITECTURE_AGENT_NAME,
    role: "architecture" as const,
    model: "claude-opus-4-8",
    systemPrompt: DEFAULT_ARCHITECTURE_PROMPT,
    tools: DEFAULT_TOOLS.architecture,
  },
  {
    agentKey: QA_AGENT_ID,
    name: QA_AGENT_NAME,
    role: "qa" as const,
    model: "claude-sonnet-5",
    systemPrompt: DEFAULT_QA_PROMPT,
    tools: DEFAULT_TOOLS.qa,
  },
];

/** Seed the two pre-configured agents for an org. Idempotent (upsert).
 *  On update, name and model sync but systemPrompt/tools are left alone
 *  so admin customisations survive re-seeding. */
async function ensureAgents(orgId: string): Promise<void> {
  await Promise.all(
    AGENT_SEEDS.map((seed) =>
      db.agent.upsert({
        where: { orgId_agentKey: { orgId, agentKey: seed.agentKey } },
        create: { orgId, ...seed },
        update: { name: seed.name, model: seed.model },
      }),
    ),
  );
}

/**
 * Whether Clerk verified `email` for the signed-in user, or null when Clerk could
 * not be asked. Null keeps `User.emailVerified` unknown, which widening treats as
 * unverified, so a failed lookup never makes a match more likely.
 */
async function signedInEmailVerified(email: string): Promise<boolean | null> {
  try {
    const user = await currentUser();
    return user ? storedEmailVerified(email, emailsOfClerkUser(user)) : null;
  } catch {
    return null;
  }
}

/**
 * Ensure the signed-in user's active org and membership exist in Postgres.
 * Returns the internal Org row, or null if there's no signed-in user / active org,
 * or if the session token predates a recorded removal from that org.
 *
 * Fast path: both rows already exist → skip Clerk API calls entirely. The role
 * follows the session token (auth() is a local decode, no network) unless Clerk
 * has reported a newer change through the webhook.
 * Slow path: missing rows → fetch from Clerk, upsert, seed access + agents. A
 * person with no row is created only if Clerk lists them as a member of the org.
 */
export async function ensureTenant() {
  const { userId, orgId, orgRole, sessionClaims } = await auth();
  if (!userId || !orgId) return null;

  const role = clerkRoleToUserRole(orgRole);
  const assertedAt = sessionIssuedAt(sessionClaims);

  // Fast path — both rows exist: skip the two Clerk API calls.
  const [existingOrg, existingUser] = await Promise.all([
    db.org.findUnique({ where: { clerkOrgId: orgId } }),
    db.user.findUnique({ where: { clerkId: userId } }),
  ]);

  if (existingOrg && existingUser) {
    const membership = await recordMembership({ orgId: existingOrg.id, userId: existingUser.id, role, assertedAt });
    if (membership.removedAt) return null;
    const updates: { role?: typeof role; orgId?: string; emailVerified?: boolean } = {};
    if (existingUser.role !== membership.role) updates.role = membership.role;
    if (existingUser.orgId !== existingOrg.id) updates.orgId = existingOrg.id;
    // A user synced before verification was stored: ask Clerk once. After this the
    // Clerk user.updated webhook keeps it current, so the fast path stays free of
    // Clerk calls for everyone else.
    if (existingUser.emailVerified === null) {
      const emailVerified = await signedInEmailVerified(existingUser.email);
      if (emailVerified !== null) updates.emailVerified = emailVerified;
    }
    if (Object.keys(updates).length) {
      await db.user.update({ where: { clerkId: userId }, data: updates });
    }
    // Seed memory if user is appearing in this org for the first time.
    if (existingUser.orgId !== existingOrg.id) {
      const memberName = existingUser.name ?? existingUser.email;
      void inngest
        .send({
          id: `seed-member-${existingOrg.id}-${userId}`,
          name: MEMORY_INGEST_EVENT,
          data: {
            groupId: existingOrg.id,
            content: `${memberName} is a member of ${existingOrg.name}.`,
            source: "text",
            name: memberName,
            actorType: "extraction",
            actorId: existingOrg.id,
            actorName: "system",
            origin: "app",
          } satisfies IngestInput,
        })
        .catch(() => {});
    }
    // Backfill built-in agents added after this org was first seeded (e.g. the
    // handoff/architecture agents shipped later). Cheap: one indexed count, and
    // the upserts run only when a built-in is missing — a no-op once backfilled.
    // Not while the org is being deleted: the database refuses its new rows then, and a
    // refused seed would turn every page of the org into an error for the 7 days.
    const builtinCount = await db.agent.count({
      where: { orgId: existingOrg.id, agentKey: { in: AGENT_SEEDS.map((s) => s.agentKey) } },
    });
    if (builtinCount < AGENT_SEEDS.length && !(await orgDeletionOpen(existingOrg.id)))
      await ensureAgents(existingOrg.id);

    return existingOrg;
  }

  // Slow path — first visit for this org or user: fetch from Clerk and upsert.
  const client = await clerkClient();
  const [clerkOrg, user] = await Promise.all([
    existingOrg ? null : client.organizations.getOrganization({ organizationId: orgId }),
    existingUser ? null : currentUser(),
  ]);

  const org = await db.org.upsert({
    where: { clerkOrgId: orgId },
    // One-time welcome credits granted on creation only (never on update, so it can't
    // be re-granted by re-syncing) — a taste to reach the first "aha".
    create: { clerkOrgId: orgId, name: clerkOrg?.name ?? orgId, creditBalance: WELCOME_BONUS_CREDITS },
    update: clerkOrg ? { name: clerkOrg.name } : {},
  });

  // An org being deleted keeps the root and agents it has; the database refuses writes to them.
  if (!(await orgDeletionOpen(org.id))) await Promise.all([ensureAccessRoot(org.id), ensureAgents(org.id)]);

  const userIsNewToThisOrg = !existingUser || existingUser.orgId !== org.id;

  let memberRole = role;
  if (existingUser) {
    const membership = await recordMembership({ orgId: org.id, userId: existingUser.id, role, assertedAt });
    if (membership.removedAt) return null;
    memberRole = membership.role;
  }

  if (user) {
    // No row: a first visit, or a person removed from their last org, whose row
    // was deleted along with the record of that removal. A session token issued
    // before the removal still names the org until it expires, so ask Clerk
    // whether they are a member now, and with what role.
    const { data: current } = await client.organizations.getOrganizationMembershipList({
      organizationId: orgId,
      userId: [userId],
    });
    const clerkMembership = current.find((m) => m.publicUserData?.userId === userId);
    if (!clerkMembership) return null;
    const currentRole = clerkRoleToUserRole(clerkMembership.role);

    // Inserting their row records their membership of this org (trigger
    // `users_join_org`).
    const email =
      user.primaryEmailAddress?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? `${userId}@no-email.local`;
    const emailVerified = storedEmailVerified(email, emailsOfClerkUser(user));
    const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || null;
    await db.user.upsert({
      where: { clerkId: userId },
      create: { clerkId: userId, orgId: org.id, email, emailVerified, name, role: currentRole },
      update: { orgId: org.id, email, emailVerified, name, role: currentRole },
    });
  } else if (existingUser && userIsNewToThisOrg) {
    // Existing user moving to a new org — update their org FK.
    await db.user.update({ where: { clerkId: userId }, data: { orgId: org.id, role: memberRole } });
  }

  return org;
}
