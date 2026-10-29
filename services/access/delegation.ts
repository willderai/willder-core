// Who an agent acts for: the delegating person an audit row names beside the agent.
//
// The one rule this file enforces: the delegating person is read from the capability
// the agent presented (its token, or the id an OAuth connection binds), never from
// anything the request claims. A capability records the person who provisioned it
// (`createdBy`), so the capability alone answers "on whose behalf", whether or not it
// covers the scope it was used on.
//
// check() already learns the provisioner when the token covers the target, because
// its decision query loads that row. A token refused for asking outside its scope
// matches no row there, so the deny would name the agent but not the person behind
// it. That deny is the row an org most needs to read, so it is looked up here.
import { db } from "@/lib/db";
import { capabilityKey, type AccessContext } from "./check";

/**
 * The internal User.id of the person `ctx`'s agent acts for, or undefined.
 *
 * Undefined for a human actor (they act for themselves, and the principal column
 * already names them), for a token that matches no capability, and for one issued
 * in another org, which says nothing about this org's people.
 */
export async function delegatingPerson(ctx: AccessContext): Promise<string | undefined> {
  if (ctx.actor.type !== "agent") return undefined;
  const capability = await db.capability.findUnique({
    where: capabilityKey(ctx.actor),
    select: { orgId: true, createdBy: true },
  });
  if (!capability || capability.orgId !== ctx.orgId) return undefined;
  return capability.createdBy ?? undefined;
}
