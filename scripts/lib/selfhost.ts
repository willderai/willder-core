// A self-hosted install's org, the person who operates it, and the tokens and exports the
// self-host scripts make as that person, with no Clerk and no willder.ai account.
//
// The one rule: these scripts act only on orgs they created themselves. A self-host org
// is keyed by a fixed `clerkOrgId` that no Clerk org can hold (Clerk's ids start with
// `org_`), so an org a hosted deployment synced from Clerk is never found here, whatever
// database the scripts point at. Inside that org every token is issued, and every export
// made, through the product's own code (issueCapability, exportMemory) as a person who is
// a live member, so a token or an export here passes the same access checks it would in
// the web app. Callers check selfhostTargetRefusal (./local-database-guard.ts) first.
import { db } from "@/lib/db";
import type { UserRole } from "@/lib/generated/prisma/enums";
import {
  authorizeRecord,
  ensureAccessRoot,
  isMintableScopePath,
  issueCapability,
  liveMembership,
  orgRootPath,
  type AccessContext,
  type IssuedCapability,
  type Permission,
} from "@/services/access";

/** The orgs the self-host scripts may create and act on, by the name a script is given. */
const SELFHOST_ORGS = {
  /** The org a self-hosted install works in. */
  default: { key: "self-hosted", name: "Self-hosted" },
  /** The org `npm run selfhost:smoke` writes its probes to, so they never land in the default one. */
  smoke: { key: "self-hosted-smoke", name: "Self-host smoke test" },
} as const;

export type SelfhostOrgName = keyof typeof SELFHOST_ORGS;

/** True when `name` names one of {@link SELFHOST_ORGS}. */
export function isSelfhostOrgName(name: string): name is SelfhostOrgName {
  return Object.prototype.hasOwnProperty.call(SELFHOST_ORGS, name);
}

/** The email of the operator the bootstrap creates. `.invalid` is reserved (RFC 2606): it reaches no one. */
function operatorEmail(org: SelfhostOrgName): string {
  return `operator@${SELFHOST_ORGS[org].key}.invalid`;
}

/** A person in a self-host org, ready to act: their ids and the AccessContext to act with. */
export interface SelfhostPerson {
  orgId: string;
  userId: string;
  email: string;
  role: UserRole;
  ctx: AccessContext;
}

/**
 * The absolute scope path for `relative` in `orgId`: `""` is the org root, `"team"` a child,
 * `"team.alpha"` a grandchild. Throws on anything else, so a caller's typo never becomes a
 * scope: labels are lowercase letters, digits and `_`, the labels this product mints.
 */
export function scopePathIn(orgId: string, relative: string): string {
  const root = orgRootPath(orgId);
  if (relative === "") return root;
  const path = `${root}.${relative}`;
  if (!isMintableScopePath(path) || !relative.split(".").every((label) => /^[a-z0-9_]+$/.test(label))) {
    throw new Error(`"${relative}" is not a scope: use dot-separated labels of a-z, 0-9 and _, like team.alpha`);
  }
  return path;
}

/**
 * Find or create the self-host org `org`, its access root, and its operator: a person with
 * the owner role, so the root's default grants make them its administrator. Re-running
 * changes nothing that exists. Throws when the operator's membership is marked removed,
 * rather than restoring it. A removal that also deleted the person's row (as a Clerk
 * webhook's does; nothing in a self-hosted install removes the operator) leaves nothing to
 * tell it from a first run, so the operator is created again.
 */
export async function ensureSelfhostOperator(org: SelfhostOrgName): Promise<SelfhostPerson> {
  const { key, name } = SELFHOST_ORGS[org];
  const row = await db.org.upsert({ where: { clerkOrgId: key }, create: { clerkOrgId: key, name }, update: {} });
  await ensureAccessRoot(row.id);
  const email = operatorEmail(org);
  // Inserting the row makes the person a member, with this role (trigger `users_join_org`).
  await db.user.upsert({
    where: { clerkId: `${key}:operator` },
    create: { clerkId: `${key}:operator`, orgId: row.id, email, name: "Operator", role: "owner" },
    update: {},
  });
  return selfhostPerson(org, email);
}

/**
 * The live member `email` of the existing self-host org `org`, as a person who can act.
 * Throws when the org was never bootstrapped or `email` is not a live member of it.
 */
export async function selfhostPerson(
  org: SelfhostOrgName,
  email: string = operatorEmail(org),
): Promise<SelfhostPerson> {
  const { key } = SELFHOST_ORGS[org];
  const row = await db.org.findUnique({ where: { clerkOrgId: key }, select: { id: true } });
  if (!row) throw new Error(`no self-host org "${org}" in this database yet; run: npm run selfhost:token`);
  const user = await db.user.findUnique({
    where: { orgId_email: { orgId: row.id, email } },
    select: { id: true, name: true },
  });
  const membership = user ? await liveMembership(row.id, user.id) : null;
  if (!user || !membership) throw new Error(`${email} is not a member of the self-host org "${org}"`);
  return {
    orgId: row.id,
    userId: user.id,
    email,
    role: membership.role,
    ctx: {
      orgId: row.id,
      actor: { type: "human", id: user.id, role: membership.role, name: user.name ?? undefined },
      origin: "script",
    },
  };
}

/** Create `path` and each missing scope above it, up to the root, in `person`'s org. */
export async function ensureScope(person: SelfhostPerson, path: string): Promise<void> {
  const labels = path.split(".");
  for (let depth = 2; depth <= labels.length; depth++) {
    const prefix = labels.slice(0, depth).join(".");
    await db.scope.upsert({
      where: { orgId_path: { orgId: person.orgId, path: prefix } },
      create: { orgId: person.orgId, path: prefix, name: labels[depth - 1] },
      update: {},
    });
  }
}

/** What a self-host token is for. */
export interface SelfhostTokenRequest {
  agent: string;
  /** Absolute scope path; it must exist. */
  scopePath: string;
  permission: Extract<Permission, "read" | "write">;
  ttlHours: number;
}

/**
 * Issue a capability token as `person`, through issueCapability: the same rules as a token
 * issued in the web app, the issuer's own access included. Throws with the refusal's text.
 */
export async function issueSelfhostToken(
  person: SelfhostPerson,
  request: SelfhostTokenRequest,
): Promise<IssuedCapability> {
  const issued = await issueCapability(person.ctx, {
    agentRef: request.agent,
    scopePath: request.scopePath,
    permission: request.permission,
    ttlHours: request.ttlHours,
  });
  if (!issued.ok) throw new Error(`could not issue the token: ${issued.error}`);
  return issued.capability;
}

/** A token as the self-host scripts report it: everything but the secret, which is never stored. */
export interface SelfhostTokenSummary {
  id: string;
  agentId: string;
  scopePath: string;
  permission: Permission;
  expiresAt: Date;
}

/**
 * The live tokens (not revoked, not expired) issued to `agent` in `person`'s org, oldest
 * first. `scopePath`, an absolute path, keeps only the tokens for exactly that scope.
 */
export async function liveSelfhostTokens(
  person: SelfhostPerson,
  agent: string,
  scopePath?: string,
): Promise<SelfhostTokenSummary[]> {
  return db.capability.findMany({
    where: {
      orgId: person.orgId,
      agentId: agent,
      revokedAt: null,
      expiresAt: { gt: new Date() },
      ...(scopePath === undefined ? {} : { scopePath }),
    },
    select: { id: true, agentId: true, scopePath: true, permission: true, expiresAt: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

/**
 * Revoke the tokens `ids` in `person`'s org that are not revoked yet, as the web app's revoke
 * does (DELETE /api/access/capabilities/:id): each is authorized through authorizeRecord on the
 * token's own scope, which writes the same `access.manage` audit row with target
 * `capabilities:revoke:<id>`, then `revokedAt` is set only if it is still unset, so a token
 * revoked already keeps its first timestamp. check() and resolveCapability refuse a token with
 * `revokedAt` set, so its next call is refused and recorded in the audit log. Returns the
 * tokens this call revoked; one revoked already, or by someone else meanwhile, is left out.
 * Throws when `person` may not revoke one of them, before revoking any later one.
 */
export async function revokeSelfhostTokens(
  person: SelfhostPerson,
  ids: readonly string[],
): Promise<SelfhostTokenSummary[]> {
  const revoked: SelfhostTokenSummary[] = [];
  for (const id of ids) {
    const token = await revokeOne(person, id);
    if (token) revoked.push(token);
  }
  return revoked;
}

/** One token of {@link revokeSelfhostTokens}: the token when this call revoked it, else null. */
async function revokeOne(person: SelfhostPerson, id: string): Promise<SelfhostTokenSummary | null> {
  const access = await authorizeRecord(
    person.ctx,
    () =>
      db.capability.findFirst({
        where: { id, orgId: person.orgId },
        select: { id: true, agentId: true, scopePath: true, permission: true, expiresAt: true, revokedAt: true },
      }),
    { action: "access.manage", scopeOf: (c) => c.scopePath, target: `capabilities:revoke:${id}` },
  );
  if (access.status === "absent") return null;
  if (access.status === "denied") throw new Error(`could not revoke token ${id}: ${access.decision.reason}`);
  const { revokedAt, ...token } = access.record;
  if (revokedAt) return null;
  const { count } = await db.capability.updateMany({
    where: { id, orgId: person.orgId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return count === 1 ? token : null;
}
