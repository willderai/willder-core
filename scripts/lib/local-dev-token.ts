// A first capability token for a fresh local install, minted without Clerk.
//
// POST /api/access/capabilities needs a signed-in Clerk session, which a local
// checkout does not have until someone sets up a Clerk development instance. The
// MCP server itself never needs Clerk, so this writes the rows that route would
// have written, straight into the local database: an org, its root scope, and one
// capability for one agent.
//
// The one rule: it runs only against a database on this machine and never in a
// production environment. `localTargetRefusal` (./local-database-guard.ts) is
// that guard; the CLI in scripts/dev-token.ts checks it before importing this.
import type { PrismaClient } from "@/lib/generated/prisma/client";
import type { Permission } from "@/lib/generated/prisma/enums";
import { generateCapabilityToken, hashCapabilityToken, orgRootPath } from "@/services/access";

/** The Clerk org id field of the local org. Clerk ids start with `org_`, so no synced org can take it. */
export const LOCAL_DEV_ORG_KEY = "local-dev";

export interface LocalDevTokenOptions {
  agentId: string;
  permission: Permission;
  ttlHours: number;
}

export interface LocalDevToken {
  orgId: string;
  scopePath: string;
  agentId: string;
  permission: Permission;
  expiresAt: Date;
  /** The raw token. Only its hash is stored; nothing can recover it later. */
  token: string;
}

/**
 * Find or create the local org and its root scope, then mint one capability on
 * that root for `agentId`. Re-running reuses the org and adds a new token; it
 * never revokes an earlier one.
 */
export async function mintLocalDevToken(db: PrismaClient, opts: LocalDevTokenOptions): Promise<LocalDevToken> {
  const org = await db.org.upsert({
    where: { clerkOrgId: LOCAL_DEV_ORG_KEY },
    create: { clerkOrgId: LOCAL_DEV_ORG_KEY, name: "Local development" },
    update: {},
  });
  const scopePath = orgRootPath(org.id);
  await db.scope.upsert({
    where: { orgId_path: { orgId: org.id, path: scopePath } },
    create: { orgId: org.id, path: scopePath, name: "Organization" },
    update: {},
  });

  const token = generateCapabilityToken();
  const expiresAt = new Date(Date.now() + opts.ttlHours * 60 * 60 * 1000);
  await db.capability.create({
    data: {
      orgId: org.id,
      agentId: opts.agentId,
      tokenHash: hashCapabilityToken(token),
      scopePath,
      permission: opts.permission,
      expiresAt,
      createdBy: "system:scripts/dev-token.ts",
    },
  });
  return { orgId: org.id, scopePath, agentId: opts.agentId, permission: opts.permission, expiresAt, token };
}
