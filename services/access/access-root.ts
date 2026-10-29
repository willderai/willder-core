// The access-control root every org starts with: its root scope, and the grants that make
// its owners and admins administrators of it.
//
// The one rule: members get nothing by default. Owner and admin roles get `admin` on the
// root scope; anyone else reads only what a grant gives them, which keeps a new org
// deny by default until a person widens it.
import { db } from "@/lib/db";
import { orgRootPath } from "./org-root";

/**
 * Seed the org-root scope and its default grants. Idempotent (upsert), so it is safe to
 * run on every tenant sync and on every self-host bootstrap.
 */
export async function ensureAccessRoot(orgId: string): Promise<void> {
  const path = orgRootPath(orgId);
  const scope = await db.scope.upsert({
    where: { orgId_path: { orgId, path } },
    create: { orgId, path, name: "Organization" },
    update: {},
  });
  await Promise.all(
    (["owner", "admin"] as const).map((role) =>
      db.grant.upsert({
        where: {
          scopeId_granteeType_granteeId_permission: {
            scopeId: scope.id,
            granteeType: "role",
            granteeId: role,
            permission: "admin",
          },
        },
        create: { orgId, scopeId: scope.id, granteeType: "role", granteeId: role, permission: "admin" },
        update: {},
      }),
    ),
  );
}
