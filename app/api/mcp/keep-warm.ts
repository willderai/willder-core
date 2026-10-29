// The keep-warm ping for /api/mcp.
//
// A cold /api/mcp instance spends about 1.2 s starting before it answers, and that
// start set the concurrent p95 of the sync measure. vercel.json schedules a Vercel cron job
// that GETs /api/mcp every minute, so the production deployment keeps one instance of this
// function loaded. The cron request is served by this same route file, so it loads the same
// function bundle real MCP calls run in.
//
// Vercel sends a cron request with `Authorization: Bearer <CRON_SECRET>` when CRON_SECRET is
// set on the project. GET answers such a request 204 before authentication, so the ping
// touches no database and writes no audit row. The check:
//   - runs after the Origin check, so a web page is refused as before;
//   - is off while CRON_SECRET is unset, blank or shorter than MIN_SECRET_LENGTH, and the cron
//     request then gets the 401 any caller without a token gets, which also warms the instance
//     and also touches no database;
//   - compares SHA-256 digests of the header and the expected value with timingSafeEqual, so
//     neither the secret's bytes nor its length can be read from response times;
//   - grants nothing: the 204 has no body and no header a caller could use, and POST and
//     DELETE, where tools run, never look at it.
// CRON_SECRET is shared by every cron on the Vercel project, and this route confirms a correct
// guess of it with a 204. A future cron route that does privileged work must check its own
// secret, not this one.
import { createHash, timingSafeEqual } from "node:crypto";

/** Shorter than this, CRON_SECRET is treated as unset: a guessable secret should not open a path before auth. */
export const MIN_SECRET_LENGTH = 16;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Whether `req` carries Vercel's cron authorization for this project.
 *
 * @param req the incoming request
 * @param secret the project's CRON_SECRET; defaults to the environment
 * @returns true only when a usable secret is configured and the Authorization header is exactly `Bearer <secret>`
 */
export function isVercelCronPing(req: Request, secret: string | undefined = process.env.CRON_SECRET): boolean {
  // Trimmed, as a header value is: a stray newline from `vercel env add` must not leave the 204 dead.
  const expected = secret?.trim();
  if (!expected || expected.length < MIN_SECRET_LENGTH) return false;
  const sent = req.headers.get("authorization");
  if (sent === null) return false;
  return timingSafeEqual(digest(sent), digest(`Bearer ${expected}`));
}
