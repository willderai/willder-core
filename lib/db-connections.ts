// How many database connections this server instance's pool has opened.
//
// A tool call that has to open a connection first waits a full network and TLS
// handshake before its first query. The count lets /api/mcp report, per request,
// whether that happened (mcp/server-timing.ts). Kept apart from lib/db.ts so a test
// that replaces the database client still has a real counter.

let opened = 0;

/** Called by lib/db.ts's pool each time it finishes opening a connection. */
export function countConnectionOpened(): void {
  opened += 1;
}

/** Connections this instance's pool has opened since the instance started. */
export function connectionsOpened(): number {
  return opened;
}
