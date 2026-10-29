// Which Willder tools a connection lists. An MCP client re-sends every listed tool's
// schema to its model on every turn, whether or not the tool is called, so a coding agent
// that only reads memory and writes findings pays for nine schemas it never uses. A
// connection that sends `X-Willder-Tools: coding` is listed the four tools a coding agent
// calls; every other connection, and every other value, is listed all of them.
//
// The one rule: the set changes what is listed, never what a token may do. A tool left off
// the list is still gated by the same check() when a connection lists it, and a call to it
// on a coding connection is answered with how to list it, not run.

/** The request header a hosted connection names its tool set with. */
export const TOOLS_HEADER = "x-willder-tools";

/** "coding" lists {@link CODING_TOOLS}; "all" lists every Willder tool. */
export type ToolSet = "all" | "coding";

/**
 * What a coding agent calls: read what earlier sessions recorded, open one fact whole, record
 * findings, and read the change feed that every change notice names for what it could not fit
 * (mcp/change-notices.ts, the willder init hook).
 */
export const CODING_TOOLS: readonly string[] = ["memory_query", "memory_version", "memory_ingest", "memory_changes"];

/**
 * Only the documented value selects the coding set, in any case and with surrounding spaces
 * ignored. A header a client or proxy sent twice arrives comma-joined ("coding, coding") and
 * still selects it; any other value, "coding, all" included, lists every tool.
 */
export function toolSetOf(value: unknown): ToolSet {
  if (typeof value !== "string") return "all";
  const values = value.split(",").map((part) => part.trim().toLowerCase());
  return values.every((part) => part === "coding") ? "coding" : "all";
}

/**
 * The tool a JSON-RPC message calls, when it is one `tools/call` with a string name; undefined
 * for anything else, a batch (an array) included.
 */
export function calledToolOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const { method, params } = body as { method?: unknown; params?: { name?: unknown } | null };
  const name = method === "tools/call" && typeof params === "object" && params !== null ? params.name : undefined;
  return typeof name === "string" ? name : undefined;
}

/** Whether a connection asking for `set` is listed the tool `name`. */
export function listsTool(set: ToolSet, name: string): boolean {
  return set === "all" || CODING_TOOLS.includes(name);
}

/** The reply to a call, on a coding connection, to a Willder tool that connection does not list. */
export function unlistedToolMessage(name: string): string {
  return (
    `${name} is not listed on this connection: it sends X-Willder-Tools: coding, which lists ${CODING_TOOLS.join(", ")}. ` +
    `To call ${name}, remove that header from the client's MCP configuration (or set it to all) and reconnect.`
  );
}
