// The Server-Timing value the hosted MCP endpoint (app/api/mcp/route.ts) sends.
//
// A client times a tool call end to end. That number holds the handler's own work, the
// start of a function instance when the request was the reason one started, and the
// network. The entries here split it, so a slow call can be read without server logs:
//
//   handler                the route's own time, request in to response ready, database
//                          round trips and connection setup included.
//   instance-age           how long this server instance had been up when the request
//                          arrived. Close to zero means the instance started for it, and
//                          the start itself is in the client's time but not the handler's.
//   db-connections-opened  connections the pool opened while the request ran. On a busy
//                          instance a concurrent request may have caused one, so this says
//                          "a handshake happened during this call", not "this call opened it".
//   task-start             one per tool call that ran the task-start block.
//
// The one rule: entries describe time and counts only. None names a scope, rule, session
// or anything a caller's token could not already see.

/** What one request measured, for {@link mcpServerTiming}. */
export interface McpRequestTiming {
  handlerMs: number;
  instanceAgeMs: number;
  connectionsOpened: number;
  /** How long each tool call's task-start block took; empty when none ran. */
  taskStartMs: readonly number[];
}

/** The Server-Timing header value for one /api/mcp request. */
export function mcpServerTiming({
  handlerMs,
  instanceAgeMs,
  connectionsOpened,
  taskStartMs,
}: McpRequestTiming): string {
  return [
    `handler;dur=${handlerMs.toFixed(1)}`,
    `instance-age;dur=${instanceAgeMs.toFixed(1)}`,
    `db-connections-opened;desc="${connectionsOpened}"`,
    ...taskStartMs.map((ms) => `task-start;dur=${ms.toFixed(1)}`),
  ].join(", ");
}
