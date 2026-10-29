import { requireAccessContext } from "@/lib/access-context";
import { can, orgRootPath } from "@/services/access";

/** What the Ask and Explore pages need before rendering; null when there is no organization. */
export type MemoryPageAccess = {
  initialScope: string | null;
  rootScope: string;
  canWrite: boolean;
  canManageScopes: boolean;
};

/**
 * Resolves the caller's memory capabilities and the scope named in the URL.
 *
 * The capabilities are non-auditing can() probes that only decide which controls
 * to show; every read and write still goes through the audited /api/memory routes.
 * The URL's ?scope= selects a starting boundary and never grants access: it is
 * kept only if it is a well-formed path inside the caller's organization.
 */
export async function loadMemoryPageAccess(
  requestedScope: string | string[] | undefined,
): Promise<MemoryPageAccess | null> {
  const rc = await requireAccessContext();
  if (!rc) return null;

  const [writeD, manageD] = await Promise.all([
    can(rc.ctx, { action: "memory.write" }),
    can(rc.ctx, { action: "access.manage" }),
  ]);
  const rootScope = orgRootPath(rc.org.id);
  const initialScope =
    typeof requestedScope === "string" &&
    requestedScope.length <= 512 &&
    /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/.test(requestedScope) &&
    requestedScope.startsWith(`${rootScope}.`)
      ? requestedScope
      : null;

  return { initialScope, rootScope, canWrite: writeD.allowed, canManageScopes: manageD.allowed };
}
