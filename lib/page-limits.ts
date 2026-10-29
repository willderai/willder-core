/**
 * The highest page each server-paged list's route accepts. The route refuses a page
 * past it, and the list reads one past it in its URL as page 1, so both sides take
 * the number from here. Each keeps the route's OFFSET one Postgres can take.
 */

/** GET /api/audit: far past any real log. */
export const MAX_AUDIT_PAGE = 100_000;
/** GET /api/audit/sessions. */
export const MAX_SESSION_PAGE = 10_000;
/** GET /api/settings/members. */
export const MAX_MEMBER_PAGE = 100_000;
