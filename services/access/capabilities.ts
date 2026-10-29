// Agent capability tokens. A token is an opaque random string an agent presents
// to read memory; only its SHA-256 hash is stored (capabilities.tokenHash), so a
// DB leak never exposes a usable credential. The raw token is shown to the caller
// exactly once at issue time. check() (./check.ts) verifies a presented token by
// hashing it and matching the row, then checking expiry/revocation/scope/permission
// and, for a token a person issued, that the person can still do the same thing.
//
// The one rule: a token is never wider than the person who minted it. The
// database refuses the mint (see isIssuerBoundRefusal) and check() refuses the use.

import { createHash, randomBytes } from "node:crypto";

const TOKEN_PREFIX = "wcap_"; // "willder capability" — identifies the token kind

/** Mint a fresh opaque capability token (raw, to be shown once). */
export function generateCapabilityToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

/** Hash a token for storage / lookup. Deterministic; no salt by design (the token
 * is high-entropy random, so a plain SHA-256 is sufficient and lets us index it). */
export function hashCapabilityToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The message the database raises when a mint would make a token wider than
 * its issuer (trigger `capabilities_issuer_bound`, migration
 * 20261010010000_capability_issuer_bound). */
const ISSUER_BOUND_MESSAGE = "capability wider than its issuer";

/**
 * Is `error` the database refusing a capability wider than the person issuing
 * it? Every mint path ends in an insert the database checks; a route uses this
 * to answer that refusal with a 403 instead of a 500. The driver may surface the
 * Postgres error directly or wrapped, so the cause chain is walked.
 */
export function isIssuerBoundRefusal(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && typeof e === "object" && depth < 5; depth++) {
    const fields = e as { message?: unknown; code?: unknown; originalCode?: unknown; cause?: unknown };
    const code = fields.originalCode ?? fields.code;
    if (code === "42501" && fields.message === ISSUER_BOUND_MESSAGE) return true;
    e = fields.cause;
  }
  return false;
}
