// Denials for routes that load one record by id and then authorize against the
// scope that record is stored at.
//
// The rule: a caller who cannot read the record's scope cannot learn the record
// exists. A record in another org, a record at a scope the caller holds no read
// grant on, and an id that was never issued all get the route's one 404. A 403
// goes only to a caller who can already read that scope; then "no" tells them
// nothing new. The 403 body matters too: a deny reason names the scope path it
// was decided on, so returning it for a hidden record would hand over the name
// of a scope the caller cannot see.
//
// lib/brief-access.ts applies the same rule to the /api/briefs/:id routes.
import type { AccessContext } from "@/services/access";
import { can } from "@/services/access";

/**
 * True when the caller holds no read on `scopePath`, so a denial on a record
 * stored there must be answered exactly like an absent id.
 *
 * Uses `can()`, not `check()`: the route's own `check()` already audited the
 * decision being answered, and this probe is not a decision of its own.
 */
export async function isHiddenFrom(ctx: AccessContext, scopePath: string): Promise<boolean> {
  const readable = await can(ctx, { action: "memory.read", scope: scopePath });
  return !readable.allowed;
}
