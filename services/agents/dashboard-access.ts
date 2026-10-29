// Whether the agents dashboard may include what only an access manager may see:
// connected agents (the capability token table) and agent access decisions (the
// audit log). Both already require `access.manage` at the org root on their own
// pages (GET /api/access/capabilities, GET /api/audit).
//
// The one rule: a member is never refused, because a member asked for the
// dashboard, not for the token table; the admin-only parts are left out of what
// they did ask for, as the agent configuration is (config-access.ts). A manager's
// read is audited like any other read of the audit log.
import { can, check, orgRootPath, type AccessContext } from "@/services/access";

/** Decide, and for a manager record, the dashboard's admin-only read. */
export async function mayReadAgentAccessActivity(ctx: AccessContext, target: string): Promise<boolean> {
  const scope = orgRootPath(ctx.orgId);
  const allowed = (await can(ctx, { action: "access.manage", scope })).allowed;
  if (!allowed) return false;
  return (await check(ctx, { action: "access.manage", scope, target })).allowed;
}
