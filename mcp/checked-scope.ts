// The checked-scope note's one lookup: the name of the scope a read was allowed on.
//
// The one rule: it is called only after check() allowed the read on exactly `scopePath`,
// and it looks that path up in the caller's own org, so the name it returns is one the
// caller may already see. Any failure gives no note rather than a wrong one.
import { db } from "@/lib/db";
import { checkedScopeNote } from "./read-notes";

/**
 * The note naming the scope at `scopePath` in `orgId` (mcp/read-notes.ts), or null when no
 * scope is registered at that path (a valid path below a granted scope need not be one), its
 * name has nothing to quote, or the lookup fails.
 */
export async function checkedScopeNoteFor(orgId: string, scopePath: string): Promise<string | null> {
  try {
    const scope = await db.scope.findUnique({
      where: { orgId_path: { orgId, path: scopePath } },
      select: { name: true },
    });
    return scope ? checkedScopeNote(scope.name) : null;
  } catch (error) {
    console.warn(
      "[memory_query] reading the checked scope's name failed; the read is served without its note:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}
