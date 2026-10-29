// Keeps the credentials a failed request carried out of anything a script prints.
//
// Playwright's request errors end with a call log that lists every request header,
// so a timed-out admin call prints the session's whole `cookie:` header. Clerk's
// cookies are not all JWT-shaped (`__refresh_*`, `__client`), so redacting known
// token shapes is not enough: the value of every credential-carrying header line is
// removed, whatever it looks like. Playwright wraps each call-log line in ANSI dim
// codes (`\x1b[2m … \x1b[22m`), with or without NO_COLOR, so escape codes are
// stripped before any line is matched.

/** Header names whose values are credentials. */
const CREDENTIAL_HEADERS = [
  "cookie",
  "set-cookie",
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "x-vercel-protection-bypass",
];

/**
 * A header line as Playwright's call log prints it (`  -   cookie: a=b`) or as a raw
 * request dump does (`Cookie: a=b`): only at the start of a line, so prose that
 * mentions "authorization:" mid-sentence is left alone.
 */
const HEADER_LINE = new RegExp(`^([\\s-]*)(${CREDENTIAL_HEADERS.join("|")})([ \\t]*:[ \\t]*)\\S[^\\r\\n]*$`, "gim");

/** An ANSI control sequence (CSI), such as the colour codes Playwright puts around call-log lines. */
const ANSI_ESCAPE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * Credential shapes this product and its connectors use, a JWT (three base64url segments,
 * the first a `{"` header), and a Clerk `__session=` cookie. Matched even when unregistered.
 */
export const SECRET_SHAPES =
  /\b(?:wcap_|github_pat_|gh[pousr]_|sk-)[A-Za-z0-9_-]{8,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|__session=[^;\s"']+/g;

/** `text` without ANSI escape codes. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, "");
}

/** `text` without ANSI codes, and with the value of every credential header line replaced by `<redacted>`. */
export function redactRequestHeaders(text: string): string {
  return stripAnsi(text).replace(HEADER_LINE, "$1$2$3<redacted>");
}

/** True when `text` still carries a credential header line with an unredacted value. */
export function exposesRequestHeaders(text: string): boolean {
  const plain = stripAnsi(text);
  return redactRequestHeaders(plain) !== plain;
}

/**
 * What to print for a failure: an Error's stack (or message) or any other value, with
 * credential header values and credential-shaped strings removed. For scripts that would
 * otherwise print the raw error.
 */
export function printableError(error: unknown): string {
  const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
  return redactRequestHeaders(text).replace(SECRET_SHAPES, "<redacted>");
}

/**
 * A response body to print, at most `maxLength` characters. Redaction runs on the whole
 * body before the cut: cutting first can leave a credential's head shorter than the shape
 * that recognises it, and that head would then print unredacted.
 */
export function printableBody(body: string, maxLength: number): string {
  return printableError(body).slice(0, maxLength);
}
