// One place that decides what a capability token may never appear in.
//
// Clients echo their own config back in error messages, and a capability token
// in a log is a capability token anyone can use. Every line a probe prints
// passes through here first.

/**
 * Remove the exact token, and anything else shaped like one, from text that is
 * about to be printed.
 */
export function scrub(text: string, token: string): string {
  const withoutToken = token.length > 0 ? text.split(token).join("<token>") : text;
  return withoutToken.replace(/wcap_[A-Za-z0-9_-]+/g, "wcap_<redacted>");
}
