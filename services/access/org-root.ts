// The org-root scope path, on its own so callers that only need the path
// (the memory stores, tests) can import it without loading `@/lib/db`, which
// the access barrel and check.ts build at import time.

/** Deterministic org-root scope path. ltree labels are [A-Za-z0-9_]; cuids
 * (lowercase alphanumeric) qualify, so `org_<cuid>` is a valid single label. */
export const orgRootPath = (orgId: string): string => `org_${orgId}`;
