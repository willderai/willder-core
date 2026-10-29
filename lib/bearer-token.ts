/**
 * The token in a request's `Authorization: Bearer <token>` header, or null when the
 * header is missing, uses another scheme, or carries nothing after it.
 *
 * Parsing only. Whether the token is any good is the access layer's question
 * (resolveCapability), asked by the route that receives it.
 */
export function bearerToken(req: Request): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization")?.trim() ?? "");
  return match?.[1]?.trim() || null;
}

/**
 * The refusal for a request that carries no bearer token. It names where a person issues
 * one (the Access page, not an API path) and the header that carries it.
 */
export const MISSING_BEARER_TOKEN_MESSAGE =
  "Missing bearer capability token. Issue one in Access, then Tokens, and send it as Authorization: Bearer <token>.";
