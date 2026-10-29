// The form the OAuth authorize page posts to POST /api/oauth/authorize.
//
// The page carries the client's authorization request through as hidden fields, and
// adds the person's choice under the names below. The route reads the request back
// with authorizationParamsOf() and checks it again from scratch: nothing the page
// rendered is trusted, because the form can be edited before it is sent.

/** Fields the page sets itself. An authorization request may not supply them. */
export const CONSENT_FIELDS = {
  decision: "willder_decision",
  scopePath: "willder_scope_path",
  permission: "willder_permission",
  agentName: "willder_agent_name",
  /** A refusal from the last submit, shown on the page when it reloads. */
  error: "willder_error",
} as const;

const OWN_FIELDS = new Set<string>(Object.values(CONSENT_FIELDS));

/** The authorization request's own parameters, in order, without the page's fields. */
export function authorizationParamsOf(entries: Iterable<[string, string]>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [name, value] of entries) if (!OWN_FIELDS.has(name)) params.append(name, value);
  return params;
}
