// GET /api/changes — the change feed over plain HTTP, for clients that do not
// speak MCP.
//
// Same authentication as /api/mcp: a capability token in an Authorization
// bearer header, resolved once at the door. Same authorization as every other
// read: check(), inside readChanges, on every call. This route adds no access
// decision of its own — it only translates HTTP to that one call and back.
//
// `?after=<change id>` is the whole cursor vocabulary. A client that keeps its own
// position passes back the `id` of the last change it processed; there is no
// numeric sequence in the response, because the org's own `seq` counts writes the
// caller may not read (services/memory/change-feed.ts).
import { AccessDeniedError, resolveCallerScopePath, resolveCapability } from "@/services/access";
import type { AccessContext } from "@/services/access";
import { MISSING_BEARER_TOKEN_MESSAGE, bearerToken } from "@/lib/bearer-token";
import { MAX_CHANGES_PER_READ, readChanges, UnknownChangeCursorError } from "@/services/memory/change-feed";

export const runtime = "nodejs";
// Every call re-authenticates and re-reads live grants; nothing here may be cached.
export const dynamic = "force-dynamic";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function GET(req: Request): Promise<Response> {
  const token = bearerToken(req);
  if (!token) {
    return json(401, { error: MISSING_BEARER_TOKEN_MESSAGE });
  }

  const cap = await resolveCapability(token, "api");
  if (!cap) {
    // A revoked or expired token gets the same answer as an unknown one, so the
    // response cannot tell them apart.
    return json(401, { error: "Invalid or unknown capability token." });
  }

  const url = new URL(req.url);
  const after = url.searchParams.get("after")?.trim();
  const limit = parseUnsignedInteger(url.searchParams.get("limit"));
  if (limit === "invalid" || (limit !== null && (limit < 1 || limit > MAX_CHANGES_PER_READ))) {
    return json(400, { error: `\`limit\` must be an integer between 1 and ${MAX_CHANGES_PER_READ}.` });
  }

  const ctx: AccessContext = {
    orgId: cap.orgId,
    actor: { type: "agent", id: cap.agentId, capabilityToken: token },
    origin: "api",
  };
  // Falls back to the token's own scope on an absent or malformed path, which
  // can never widen what the caller already covers.
  const scopePath = await resolveCallerScopePath(ctx, url.searchParams.get("scope") ?? undefined, cap, {
    onInvalid: "fallback",
  });

  try {
    const { changes, hasMore } = await readChanges(ctx, scopePath, {
      after: after || undefined,
      limit: limit ?? undefined,
    });
    return json(200, {
      changes: changes.map((c) => ({ ...c, createdAt: c.createdAt.toISOString() })),
      hasMore,
    });
  } catch (e) {
    // An `after` naming a change outside this caller's scope is answered exactly
    // like one that was never issued, so a cursor cannot probe what exists.
    if (e instanceof UnknownChangeCursorError) return json(400, { error: e.message });
    // decision.reason is the half a refused caller may see: the missing
    // permission and how to get it, never the scope path the server resolved the
    // request to. The resolved path stays in decision.auditReason and in the
    // audit row (services/access/deny-reason.ts).
    if (e instanceof AccessDeniedError) return json(403, { error: e.decision.reason });
    throw e;
  }
}

/** Parse an optional unsigned-integer query parameter. Returns null when absent,
 * `"invalid"` when present but not one. Range is the caller's to check. */
function parseUnsignedInteger(raw: string | null): number | null | "invalid" {
  if (raw === null) return null;
  if (!/^\d+$/.test(raw.trim())) return "invalid";
  return Number(raw.trim());
}
