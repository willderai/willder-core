// Origin validation for the hosted MCP endpoint.
//
// The Streamable HTTP transport requires a server to validate the Origin header
// on every request and to answer 403 when one is present and invalid, to prevent
// DNS rebinding (https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#security-warning).
// A rebinding page points a host name it controls at this server, so its request
// carries that foreign name in Host and the same foreign name in Origin. The rule
// enforced here follows from that:
//
// - No Origin: a native client. It passes, whatever the configuration.
// - The opaque `null` Origin, or one that does not parse: never valid.
// - The app's own public origin (`NEXT_PUBLIC_APP_URL`): valid.
// - A loopback Origin on a request addressed to a loopback host: valid.
// - Any other Origin: valid only on a request addressed to the app's public
//   origin, and only when that origin is https on a non-loopback host. Such a
//   request named this server by its real name, so it is not a rebinding, and
//   hosted clients such as claude.ai's custom connectors send their own Origin
//   from their servers. The endpoint authenticates by bearer header alone and
//   reads no cookie, so a browser page gains no ambient credential this way.
//
// Everywhere else, and always on loopback, a foreign Origin gets 403. Comparing
// Origin with the request's own host alone would not be enough: a rebinding page
// is same-origin with the name it rebinds, so the trusted names are fixed by
// configuration and by loopback, never derived from Host.
//
// Because the public name comes from configuration, a missing or wrong
// NEXT_PUBLIC_APP_URL refuses the hosted clients that send an Origin. That is
// never silent: the web server logs publicOriginConfigProblem() at startup
// (instrumentation.ts), and a refusal on an https public host the configuration
// does not name says which variable to set.

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Where an operator reads what NEXT_PUBLIC_APP_URL must hold. */
const FIX_REFERENCE = "docs/environment.md, NEXT_PUBLIC_APP_URL";

const REFUSED = "Forbidden: this endpoint does not accept requests from the Origin this request came from.";

/** The outcome of checking one request's Origin header; `message` is the 403's. */
export type OriginCheck = { allowed: true } | { allowed: false; message: string };

function parseUrl(url: string | undefined): URL | null {
  if (!url?.trim()) return null;
  try {
    return new URL(url.trim());
  } catch {
    return null;
  }
}

function isLoopback(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

function isPublicHttps(url: URL): boolean {
  return url.protocol === "https:" && !isLoopback(url.hostname);
}

/**
 * Why `appUrl` cannot name this server's public origin, or null when it can: an
 * absolute https URL on a non-loopback host.
 *
 * @param appUrl the value of NEXT_PUBLIC_APP_URL
 * @returns one line naming the problem, its effect on /api/mcp and the fix, or null
 */
export function publicOriginConfigProblem(appUrl: string | undefined): string | null {
  const app = parseUrl(appUrl);
  if (app !== null && isPublicHttps(app)) return null;
  const state = !appUrl?.trim()
    ? "is not set"
    : app === null
      ? `is not an absolute URL (${JSON.stringify(appUrl)})`
      : `is ${app.origin}, not an https origin on a public host`;
  return (
    `NEXT_PUBLIC_APP_URL ${state}, so /api/mcp refuses every request that carries an Origin header off loopback, ` +
    "including the Origin hosted MCP clients such as claude.ai send; clients that send no Origin are unaffected. " +
    `Set it to the https origin clients use to reach this server and rebuild (${FIX_REFERENCE}).`
  );
}

/**
 * Checks a request's Origin header against the rule at the top of this file.
 *
 * @param req the incoming request; its URL is the origin the client addressed
 * @param appUrl the app's public URL (`NEXT_PUBLIC_APP_URL`); its origin is always accepted
 * @returns allowed when there is no Origin header or the request cannot be a DNS
 *   rebinding; otherwise the 403 message, which names the configuration fix when the
 *   request reached an https public host that the configuration does not name
 */
export function checkOrigin(req: Request, appUrl: string | undefined = process.env.NEXT_PUBLIC_APP_URL): OriginCheck {
  const header = req.headers.get("origin");
  if (header === null) return { allowed: true };

  const origin = parseUrl(header);
  // "null", "file://" and other unparsable values are opaque origins: never valid.
  if (origin === null || origin.origin === "null") return { allowed: false, message: REFUSED };

  const app = parseUrl(appUrl);
  if (app !== null && origin.origin === app.origin) return { allowed: true };

  const addressed = new URL(req.url);
  const publicOrigin = app !== null && isPublicHttps(app) ? app.origin : null;
  if (addressed.origin === publicOrigin) return { allowed: true };
  if (isLoopback(addressed.hostname) && isLoopback(origin.hostname)) return { allowed: true };

  // A rebinding page reaches a server over plain http or on loopback: a browser will
  // not complete TLS for the attacker's name against a certificate this host holds.
  // Only an https request to a public host points at configuration, so only that one
  // is told what to change.
  if (!isPublicHttps(addressed)) return { allowed: false, message: REFUSED };
  const configProblem = publicOriginConfigProblem(appUrl);
  if (configProblem !== null) return { allowed: false, message: `${REFUSED} ${configProblem}` };
  return {
    allowed: false,
    message:
      `${REFUSED} A request carrying an Origin header is served only on this server's public origin, ` +
      `${publicOrigin} (NEXT_PUBLIC_APP_URL), and this one was addressed to ${addressed.origin}. ` +
      `If ${addressed.origin} is this server's public address, set NEXT_PUBLIC_APP_URL to it and rebuild (${FIX_REFERENCE}).`,
  };
}
