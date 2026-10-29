// What the signed-in person may load on the Access, Integrations and Settings pages, decided on
// the server before the page renders.
//
// The one rule this file enforces: a page asks for a list only when the route that
// serves it would allow the request. Each answer below is the same rule that route
// checks, probed with can(), which writes no audit row. Without it a member's visit
// made the page call admin-only routes, and every refusal landed on the audit trail
// as an attempt the member never made.
import type { RequestContext } from "@/lib/access-context";
import { ORG_ADMIN_ROLES } from "@/lib/org-role";
import { can } from "@/services/access";

export interface PagePermissions {
  /**
   * `access.manage` on the org root: the check behind the grant, scope, token and
   * audit lists (/api/access/grants, /scopes, /capabilities, /api/audit).
   */
  manageAccess: boolean;
  /** `memory.write` on the org root: the check behind /api/sources. */
  writeMemory: boolean;
  /**
   * An owner or admin of the org whom `memory.read` on the org root allows: the two
   * checks behind listing /api/settings/org-roles and /aliases. Saving or removing an
   * entry also needs `memory.write` there, which the panels report when refused.
   */
  orgAdmin: boolean;
}

/** Probe each check the Access, Integrations and Settings pages' lists depend on, without auditing. */
export async function pagePermissions(rc: RequestContext): Promise<PagePermissions> {
  const [manage, write, read] = await Promise.all([
    can(rc.ctx, { action: "access.manage" }),
    can(rc.ctx, { action: "memory.write" }),
    can(rc.ctx, { action: "memory.read" }),
  ]);
  return {
    manageAccess: manage.allowed,
    writeMemory: write.allowed,
    orgAdmin: ORG_ADMIN_ROLES.includes(rc.user.role) && read.allowed,
  };
}
