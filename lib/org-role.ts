// The org-role gate for operations that belong to the organization rather than to a
// scope: settings, integrations, billing, the launch-update export.
//
// The one rule this file enforces: a person without one of the required org roles is
// refused, and the refusal leaves one deny row on the audit trail. The caller still
// answers with its own response, unchanged, so nothing about the row reaches them.
import type { RequestContext } from "@/lib/access-context";
import { orgRoleRequired, orgRootPath, recordRefusal } from "@/services/access";
import type { UserRole } from "@/types";

/** The roles that may change org-wide settings, integrations and billing. */
export const ORG_ADMIN_ROLES: readonly UserRole[] = ["owner", "admin"];

/**
 * Allow the signed-in person only when they hold one of `roles` in their org, and
 * record a deny row when they do not. Returns whether the request may proceed.
 *
 * Such an operation has no scope of its own, so the refusal is recorded against the
 * org root, with `operation` naming what was asked for (e.g. `settings:org-roles:save`).
 */
export async function requireOrgRole(
  rc: RequestContext,
  roles: readonly UserRole[],
  operation: string,
): Promise<boolean> {
  if (roles.includes(rc.user.role)) return true;
  const root = orgRootPath(rc.org.id);
  await recordRefusal(rc.ctx, {
    action: "access.refused",
    target: `${root}/${operation}`,
    auditReason: orgRoleRequired(rc.user.role, roles, root).auditReason,
  });
  return false;
}
