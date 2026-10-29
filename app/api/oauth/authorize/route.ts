// POST /api/oauth/authorize — the person's answer on the OAuth authorize page.
//
// Allow connects the client at the scope and permission the person chose and sends
// the browser back to the client with a one-time code; Deny sends it back with
// `access_denied`. The authorization request is checked again here from the posted
// fields, never trusted from the page (services/access/oauth-authorization.ts).
//
// The one rule this route enforces: a decision counts only when it comes from this
// site's own page, in the browser of the signed-in person. A post whose Origin is
// another site is refused before the session is read, so a page elsewhere cannot
// submit a consent on a signed-in person's behalf. A request that fails a check is
// answered here and never redirected, as on the page. Answers 404 unless
// MCP_OAUTH_ENABLED is `true`.
import { requireAccessContext } from "@/lib/access-context";
import { authorizationParamsOf, CONSENT_FIELDS } from "@/lib/oauth-authorize-form";
import { mcpOAuthEnabled, mcpOAuthResources } from "@/mcp/oauth-discovery";
import { approveAuthorization, authorizationResponseUrl, validateAuthorizationRequest } from "@/services/access";

function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });
}

function plainError(status: number, message: string): Response {
  return new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

export async function POST(req: Request): Promise<Response> {
  if (!mcpOAuthEnabled()) return new Response(null, { status: 404 });

  const origin = new URL(req.url).origin;
  if (req.headers.get("origin") !== origin) {
    return plainError(
      403,
      "This consent did not come from Willder's own page. Start the connection again from your app.",
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return plainError(400, "The consent form could not be read. Start the connection again from your app.");
  }
  const entries = [...form.entries()].flatMap(([name, value]): [string, string][] =>
    typeof value === "string" ? [[name, value]] : [],
  );
  const choice = (name: string) => entries.find(([key]) => key === name)?.[1];
  const params = authorizationParamsOf(entries);

  const validation = await validateAuthorizationRequest(params, mcpOAuthResources());
  if (!validation.ok) {
    return plainError(400, validation.show);
  }
  const request = validation.request;

  // Signed out, or signed in with no workspace open: the page handles both.
  const rc = await requireAccessContext();
  if (!rc) return seeOther(`/oauth/authorize?${params}`);

  if (choice(CONSENT_FIELDS.decision) !== "allow") {
    return seeOther(
      authorizationResponseUrl(request.redirectUri, origin, request.state, {
        error: "access_denied",
        error_description: "The person declined to connect this app.",
      }),
    );
  }

  const approved = await approveAuthorization(rc.ctx, request, {
    scopePath: choice(CONSENT_FIELDS.scopePath),
    permission: choice(CONSENT_FIELDS.permission),
    agentName: choice(CONSENT_FIELDS.agentName),
  });
  if (!approved.ok) {
    const retry = new URLSearchParams(params);
    retry.set(CONSENT_FIELDS.error, "1");
    return seeOther(`/oauth/authorize?${retry}`);
  }
  return seeOther(authorizationResponseUrl(request.redirectUri, origin, request.state, { code: approved.code }));
}
