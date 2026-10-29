// Where a request entered the system: the "source" an audit record names.
//
// Every audit row and every change event records the entry point the action came in
// through, so a reader of the trail can tell an agent's MCP call from the same agent's
// REST call, and a person's click from a background job acting on the person's behalf.
// NIST SP 800-53 AU-3 asks every audit record for its source; this is that field.
//
// The one rule this file enforces: an origin is one of a closed set, named where the
// request is authenticated, never guessed from the actor afterwards. An agent can reach
// memory through MCP, the REST change feed or a run the product starts itself, so its
// actor type alone does not say which.
//
// This file must stay free of runtime imports: the audit timeline screen imports it into
// a client bundle, the same constraint services/audit/audit-actions.ts has.

/** Every origin an audit row or change event can carry, with what each one means. */
export const AUDIT_ORIGINS = {
  /** A signed-in person, through the web app or its session-authenticated API routes. */
  app: "Web app",
  /** An agent presenting a capability token to the MCP server, hosted or stdio. */
  mcp: "MCP",
  /** An agent presenting a capability token to the REST API (the change feed). */
  api: "REST API",
  /** An agent the product runs itself: a briefing, QA, architecture or workflow run. */
  "agent-run": "Agent run",
  /** A connected source's sync job writing what it fetched upstream. */
  "connector-sync": "Connector sync",
  /** An inbound webhook from another service, e.g. GitHub secret scanning. */
  webhook: "Webhook",
  /** An operator's command-line script run against the database. */
  script: "Operator script",
} as const;

/** The entry point an audited action came in through. */
export type AuditOrigin = keyof typeof AUDIT_ORIGINS;

/** True when `value` is one of {@link AUDIT_ORIGINS}. Rows written before origins were
 * recorded carry none, which is not an origin. */
export function isAuditOrigin(value: unknown): value is AuditOrigin {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(AUDIT_ORIGINS, value);
}
