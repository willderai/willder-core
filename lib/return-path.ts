// Where sign-in and sign-up send a person once they are in.
//
// The OAuth authorize page sends a signed-out person to /sign-in with the authorize
// request as `redirect_url`, so they come back to the consent step instead of the
// dashboard. The one rule this file enforces: only a path on this origin is followed.
// Anything else (another host, `//host`, `/\host`, a `javascript:` URL) falls back to
// the dashboard, so the parameter cannot be used to send a person off the site.

const DEFAULT_PATH = "/dashboard";
const PROBE_ORIGIN = "https://willder.invalid";
const STORAGE_KEY = "willder.returnPath";

/** The same-origin path `value` names, or the dashboard. */
export function safeReturnPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return DEFAULT_PATH;
  let url: URL;
  try {
    url = new URL(value, PROBE_ORIGIN);
  } catch {
    return DEFAULT_PATH;
  }
  // Checked again after parsing: dot segments fold `/.//host` into `//host`, a
  // protocol-relative URL that a browser would follow to another site.
  if (url.origin !== PROBE_ORIGIN || url.pathname.startsWith("//") || url.pathname.startsWith("/\\"))
    return DEFAULT_PATH;
  return `${url.pathname}${url.search}`;
}

/** The return path the current page's `redirect_url` names. Browser only. */
export function returnPathFromLocation(): string {
  return safeReturnPath(new URLSearchParams(window.location.search).get("redirect_url"));
}

/**
 * Keep the current page's return path across a Google sign-in, whose callback page
 * (app/(auth)/sso-callback) does not receive this page's query. Browser only.
 */
export function rememberReturnPath(): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, returnPathFromLocation());
  } catch {
    // Storage blocked: the person lands on the dashboard, as before.
  }
}

/** The return path {@link rememberReturnPath} kept, read once. Browser only. */
export function takeRememberedReturnPath(): string {
  try {
    const path = window.sessionStorage.getItem(STORAGE_KEY);
    window.sessionStorage.removeItem(STORAGE_KEY);
    return safeReturnPath(path);
  } catch {
    return DEFAULT_PATH;
  }
}
