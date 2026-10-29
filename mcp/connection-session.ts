// The session an MCP connection is, for the task-start block.
//
// The block is told once per session (services/memory/task-start.ts). A client may name its
// sessions with `_meta["willder/session"]`, but the common clients send no `_meta` at all.
// What an MCP client does is open each connection with an `initialize` request, and a
// Streamable HTTP client then sends the `Mcp-Session-Id` the server answered it with on every
// later request of that connection (MCP specification, Streamable HTTP, "Session
// Management"). So the hosted endpoint (app/api/mcp/route.ts) answers each initialize with a
// fresh id, and a tool call carrying one belongs to that connection's session: a new
// connection is told the block again, however soon after the last one it opens. The stdio
// server (mcp/server.ts) serves one connection per process, so its process gets one id.
//
// The endpoint stays stateless: the id is not remembered, only read back from the request.
// A connection that stays open is still one session until it goes SESSION_IDLE_MS without a
// call, and a client that skips initialize or does not send the id back (a bare curl
// `tools/call`, the capture hook) falls back to that idle rule alone.
//
// A block is claimed for a session only while its caller still waits for the reply
// (TaskStartRequest.abandoned): a reply the caller hung up on, or gave up waiting for, would
// otherwise use up the session's block with nobody told. The hook that polls
// /api/changes/notice waits 2 s; on a cold start the block can take longer.
//
// The one rule this file enforces: the id decides only when the block is told again, never
// what it holds or who may read it. It is a hint the client sends back, like `_meta`, and the
// delivery is keyed under the token's own org and agent, so a forged or replayed id can only
// change when that same agent is told its own block again.
import { randomUUID } from "node:crypto";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { headerSessionOf } from "./task-start-notice";

/** The Streamable HTTP header that carries a connection's session id, as Fetch lower-cases it. */
export const MCP_SESSION_HEADER = "mcp-session-id";

/**
 * Prefix of a connection's session key, so a key in the delivery and served-vs-used tables
 * says it came from a connection rather than from a name the client chose.
 */
const CONNECTION_SESSION_PREFIX = "mcp:";

/** A new connection's session id: a random UUID, which is visible ASCII as the specification requires. */
export function newMcpSessionId(): string {
  return randomUUID();
}

/**
 * The session key of the connection whose session id is `id`, as the task-start delivery is
 * keyed on it, or "" when there is none. The id is bounded as `_meta` hints are
 * (mcp/task-start-notice.ts): control characters replaced, trimmed, cut to 512 characters.
 */
export function connectionSessionKeyOf(id: string | null | undefined): string {
  const bounded = headerSessionOf(id);
  return bounded === "" ? "" : `${CONNECTION_SESSION_PREFIX}${bounded}`;
}

/**
 * How long after a hook poll arrives its block may still be claimed. The hook waits
 * NOTICE_TIMEOUT_MS, 2,000 ms, from sending (cli/hooks/willder-capture.mjs); the rest is left
 * for the reply's way back. A block not claimed in time is told on the session's next poll.
 */
export const HOOK_CLAIM_BUDGET_MS = 1500;

/**
 * A signal aborted when `request`'s caller hangs up, or `waitMs` after now when the caller is
 * known to give up then: a reply finished after either is not read.
 */
export function abandonedSignal(request: Request, waitMs?: number): AbortSignal {
  return waitMs === undefined ? request.signal : AbortSignal.any([request.signal, AbortSignal.timeout(waitMs)]);
}

/**
 * Whether a parsed JSON-RPC body opens a connection: it is an `initialize` request, alone or
 * in a batch. The transport refuses a batch that holds one beside anything else, and the
 * caller only sends the new id back on a response that succeeded.
 */
export function opensConnection(body: unknown): boolean {
  return Array.isArray(body) ? body.some((message) => isInitializeRequest(message)) : isInitializeRequest(body);
}
