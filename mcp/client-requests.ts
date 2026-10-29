// Requests the hosted MCP endpoint sends a client in the middle of a tool call
// (sampling/createMessage, elicitation/create), on an endpoint that keeps no state between
// HTTP requests.
//
// A client answers such a request with a new POST. The endpoint builds a fresh server for
// every request and runs on many instances (app/api/mcp/route.ts), so that POST reaches a
// server that never sent the request, often on another instance. The asking call therefore
// sends its request under a random UUID, stores a row under that id (mcp_client_requests), and
// polls the row; the route hands every reply it receives to deliverClientReplies, which writes
// it into the row.
//
// The one rule: a reply is taken only from the token the asking call runs with (as its agent,
// in its org), and only once. A POST from anyone else naming the same id changes nothing,
// another token of the same agent included (it may hold another scope, or belong to another
// app), and the id is a UUID nobody else was sent.
//
// A reply arrives through the route only, so askClient serves the hosted endpoint; the stdio
// server (mcp/server.ts) offers nothing that calls it.
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  ErrorCode,
  McpError,
  isJSONRPCErrorResponse,
  isJSONRPCResultResponse,
  type ServerNotification,
  type ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { db } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
// A leaf module, not the `@/services/access` barrel, so this file adds no import-time work.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { CapabilityCredential } from "@/services/access/check";

/** How long a call waits for the client's reply before it gives up and says so. Under the route's 60 s limit. */
export const CLIENT_REPLY_TIMEOUT_MS = 30_000;

/** How often the waiting call reads its row. */
const POLL_INTERVAL_MS = 200;

/** A row older than this was left by a call that died while waiting, and is deleted. */
const ABANDONED_AFTER_MS = 10 * 60_000;

/** The largest reply stored, in characters of JSON. A sampling or elicitation answer is far smaller. */
export const MAX_REPLY_CHARS = 256_000;

/** The most replies one POST is read for. A client answers each request on its own POST. */
export const MAX_REPLIES_PER_BODY = 8;

/** Who a request is asked as, and so whose reply is taken: the authenticated caller. */
export interface Asker {
  orgId: string;
  agentId: string;
  /** The caller's token, as {@link credentialKeyOf} names it. */
  credential: string;
}

/**
 * The key a pending request stores for the token that asked, and a reply must come with: a
 * bearer token's hash (as capabilities store it), or the capability an OAuth access token was
 * issued for, which stays the same when the app refreshes its token. Never the raw token.
 */
export function credentialKeyOf(credential: CapabilityCredential): string {
  return "capabilityId" in credential
    ? `capability:${credential.capabilityId}`
    : `hash:${hashCapabilityToken(credential.capabilityToken)}`;
}

/** A tool handler's `extra`: the request it serves, and the signal that aborts when its caller hangs up. */
type CallExtra = Pick<RequestHandlerExtra<ServerRequest, ServerNotification>, "requestId" | "signal">;

/** Anything with a zod-style `parse`, such as the SDK's result schemas. */
interface ResultSchema<T> {
  parse(value: unknown): T;
}

export interface AskOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

/**
 * Send `request` to the client on the stream of the call `extra` serves, wait for the
 * client's reply, and return its result parsed by `schema`.
 *
 * @throws McpError when the client answers with an error (its code and message), when no
 *   reply arrives within the timeout, or when the call's own caller hangs up first.
 */
export async function askClient<T>(
  server: McpServer,
  extra: CallExtra,
  asker: Asker,
  request: { method: string; params: Record<string, unknown> },
  schema: ResultSchema<T>,
  options: AskOptions = {},
): Promise<T> {
  const transport = server.server.transport;
  if (!transport) throw new McpError(ErrorCode.InternalError, "The server is not connected to a client.");
  const timeoutMs = options.timeoutMs ?? CLIENT_REPLY_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;

  const id = randomUUID();
  await db.mcpClientRequest.deleteMany({
    where: { orgId: asker.orgId, createdAt: { lt: new Date(Date.now() - ABANDONED_AFTER_MS) } },
  });
  await db.mcpClientRequest.create({
    data: { id, orgId: asker.orgId, agentId: asker.agentId, credential: asker.credential },
  });
  try {
    await transport.send(
      { jsonrpc: "2.0", id, method: request.method, params: request.params },
      { relatedRequestId: extra.requestId },
    );
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const row = await db.mcpClientRequest.findUnique({ where: { id }, select: { reply: true } });
      if (row?.reply != null) return resultOf(row.reply, schema);
      if (extra.signal.aborted)
        throw new McpError(
          ErrorCode.RequestTimeout,
          `The caller hung up before the client answered ${request.method}.`,
        );
      if (Date.now() >= deadline) {
        throw new McpError(
          ErrorCode.RequestTimeout,
          `The client did not answer ${request.method} within ${timeoutMs / 1000} s. A client that does not support it may not answer at all.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  } finally {
    await db.mcpClientRequest.deleteMany({ where: { id } });
  }
}

/** The result a stored reply carries, or the client's error thrown as one. */
function resultOf<T>(reply: Prisma.JsonValue, schema: ResultSchema<T>): T {
  if (isJSONRPCErrorResponse(reply))
    throw new McpError(reply.error.code, `The client refused the request: ${reply.error.message}`);
  if (!isJSONRPCResultResponse(reply))
    throw new McpError(ErrorCode.InternalError, "The client's reply was not a JSON-RPC response.");
  try {
    return schema.parse(reply.result);
  } catch {
    throw new McpError(ErrorCode.InvalidParams, "The client's reply did not have the shape the request asks for.");
  }
}

/** Whether `message` could answer a request askClient sent: a JSON-RPC result or error under a string id. */
function isReplyToAsk(message: unknown): message is { id: string } {
  if (typeof message !== "object" || message === null || typeof (message as { id?: unknown }).id !== "string")
    return false;
  return isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message);
}

/**
 * Store every JSON-RPC reply in a POST body for the call waiting on it, when that call runs as
 * `asker` and has no reply yet. A reply to anything else, or from anyone else, is ignored, and
 * so is every message past the first {@link MAX_REPLIES_PER_BODY}.
 *
 * @param body the POST's parsed JSON: one message or an array of them
 * @returns how many replies were stored
 */
export async function deliverClientReplies(asker: Asker, body: unknown): Promise<number> {
  const messages = (Array.isArray(body) ? body : [body]).slice(0, MAX_REPLIES_PER_BODY);
  let stored = 0;
  for (const message of messages) {
    if (!isReplyToAsk(message) || JSON.stringify(message).length > MAX_REPLY_CHARS) continue;
    const { count } = await db.mcpClientRequest.updateMany({
      where: {
        id: message.id,
        orgId: asker.orgId,
        agentId: asker.agentId,
        credential: asker.credential,
        reply: { equals: Prisma.DbNull },
      },
      data: { reply: message as Prisma.InputJsonValue },
    });
    stored += count;
  }
  return stored;
}
