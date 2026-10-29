// Hosted Willder MCP endpoint — the shippable path for EXTERNAL customers.
//
// mcp/server.ts (stdio) only works if the caller has Willder's own source code
// cloned locally and a raw DATABASE_URL/GRAPHITI_SERVICE_URL in their .env —
// fine for our own dev/testing, but not something we can hand a customer. This
// route serves the same tools over the network: any MCP client (Claude
// Desktop, Claude Code, ChatGPT, custom agents) points at
// `https://willder.ai/api/mcp` with a bearer capability token and gets the
// exact same tool set, over the network, with no source access and no DB
// credentials.
//
// Transport: MCP Streamable HTTP via the SDK's Web Standard transport
// (`WebStandardStreamableHTTPServerTransport`, @modelcontextprotocol/sdk
// server/webStandardStreamableHttp) — built on Fetch API Request/Response, so
// it drops directly into a Next.js route handler with no Node http shim. Run
// in **stateless mode** (`sessionIdGenerator` omitted): a fresh McpServer +
// transport per HTTP request, matching the SDK's own serverless/stateless
// example (examples/server/simpleStatelessStreamableHttp.ts). This is a
// multi-tenant endpoint serving many customers' tokens concurrently — there is
// no in-memory session to pin a customer to a specific server instance across
// requests, and MCP's Streamable HTTP spec supports this (client resends
// context each call; no long-lived session required: anything the server sends
// while a call runs goes on that call's own reply, see below).
//
// Auth model (multi-tenant — this is the part that must not regress): identity
// comes ONLY from the `Authorization: Bearer <token>` header, resolved via the
// same `resolveCapability` used by the stdio server. The token is a capability
// token, or, with MCP_OAUTH_ENABLED on, an OAuth access token from Willder's own
// authorization server (services/access/oauth-authorization.ts), which runs as the
// capability the person connected and as nothing else. We never read an org/user id from the
// request body, query params, or any client-supplied field — a hosted endpoint
// serving many orgs' tokens must not trust caller-asserted identity. Once
// resolved, every tool call runs through the SAME `check()` gate + audit trail as
// the stdio server and the REST API, because both transports share mcp/tools.ts's
// tool implementations.
//
// Additional headers are read. Origin is checked before authentication: a request
// whose Origin could be a DNS rebinding is refused with 403, as the transport spec
// requires (./origin.ts). X-Willder-Task is the task every call on the request
// names, for IDE clients that cannot set `_meta["willder/task"]` per call. It only
// selects which of the token's readable context is served first; a call's own `_meta`
// task wins over it (mcp/task-start-notice.ts). X-Willder-Context selects full or
// compact supplementary context for read tools (mcp/context-policy.ts). X-Willder-Tools:
// coding lists only the tools a coding agent calls (mcp/tool-set.ts); a call to another
// Willder tool on such a connection is answered with how to list it.
//
// Every initialize result carries the server instructions (mcp/willder-server.ts): record a
// lasting rule the person states through memory_ingest and show them the confirm link.
//
// Stateless does not mean sessionless. Each `initialize` is answered with a fresh
// Mcp-Session-Id, which a Streamable HTTP client sends back on every later request of
// that connection, so a new connection is a new session for the task-start block.
// The id is read back, never remembered, and decides nothing but when the block is told
// again (mcp/connection-session.ts).
//
// Every connection is also served Willder's resources (mcp/resources.ts) and prompts
// (mcp/prompts.ts). A connection that sends X-Willder-Conformance: fixtures is served the
// official conformance suite's fixtures as well (mcp/conformance-fixtures.ts), if its agent is
// one MCP_CONFORMANCE_AGENTS lists (any other gets a plain connection), and its replies
// stream as server-sent events, because those fixtures send notifications and requests while
// a call runs and a JSON reply has nowhere to carry them. A POST that carries a client's reply
// to such a request is handed to the call waiting on it (mcp/client-requests.ts).
import { isOAuthAccessToken, resolveCapability, resolveOAuthAccessToken, type AccessContext } from "@/services/access";
import type { CapabilityCredential } from "@/services/access/check";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { mcpBearerChallenge, mcpOAuthEnabled, mcpOAuthResources } from "@/mcp/oauth-discovery";
import { CONTEXT_HEADER, contextModeOf } from "@/mcp/context-policy";
import { WILLDER_TOOL_NAMES, registerWillderTools, type ResolvedCapability } from "@/mcp/tools";
import { createWillderServer } from "@/mcp/willder-server";
import { TOOLS_HEADER, type ToolSet, calledToolOf, listsTool, toolSetOf, unlistedToolMessage } from "@/mcp/tool-set";
import { checkOrigin } from "./origin";
import { isVercelCronPing } from "./keep-warm";
import { TASK_HEADER, connectionTaskOf } from "@/mcp/task-start-notice";
import {
  MCP_SESSION_HEADER,
  abandonedSignal,
  connectionSessionKeyOf,
  newMcpSessionId,
  opensConnection,
} from "@/mcp/connection-session";
import { mcpServerTiming } from "@/mcp/server-timing";
import { connectionsOpened } from "@/lib/db-connections";
import { MISSING_BEARER_TOKEN_MESSAGE } from "@/lib/bearer-token";
import { registerWillderResources } from "@/mcp/resources";
import { registerWillderPrompts } from "@/mcp/prompts";
import {
  CONFORMANCE_HEADER,
  conformanceFixturesAllowed,
  conformanceFixturesRequested,
  registerConformanceFixtures,
} from "@/mcp/conformance-fixtures";
import { credentialKeyOf, deliverClientReplies, type Asker } from "@/mcp/client-requests";

/** When this server instance loaded the route, for the `instance-age` timing entry. */
const instanceStartedAt = performance.now();

// Needs the Node runtime: Prisma (`@/lib/db`) and the rest of the tool chain
// use Node-only APIs (node:crypto, TCP/pg sockets), not Edge-compatible.
export const runtime = "nodejs";

// A tool call stops after 60 s. memory_ingest's idempotency-key lease is derived from this
// number (KEYED_ROUTE_MAX_DURATION_SECONDS in services/memory/ingest-key.ts); change both.
export const maxDuration = 60;

// Every call re-authenticates and re-resolves org state; nothing here should
// ever be cached by the framework.
export const dynamic = "force-dynamic";

function jsonRpcError(status: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The 401 for a request without a usable capability token. When MCP OAuth
 * discovery is on, it also carries the RFC 9728 challenge naming where an
 * OAuth-capable client can read how to sign in (mcp/oauth-discovery.ts), with
 * `error="invalid_token"` when the refused token was an OAuth access token.
 */
function unauthorized(req: Request, message: string, { invalidToken = false } = {}): Response {
  const response = jsonRpcError(401, message);
  const challenge = mcpBearerChallenge(new URL(req.url).origin, { invalidToken });
  if (challenge) response.headers.set("www-authenticate", challenge);
  return response;
}

/** `asker` is who a request sent to the client is asked as: this caller's token, not just its agent. */
type Caller = { ctx: AccessContext; cap: ResolvedCapability; asker: Asker };

function askerOf(cap: ResolvedCapability, credential: CapabilityCredential): Asker {
  return { orgId: cap.orgId, agentId: cap.agentId, credential: credentialKeyOf(credential) };
}

/** The 403 for a request whose Origin ./origin.ts refuses, or null to continue. Runs before
 * authentication, so a refused page gets the same answer whether or not it guessed a token. */
function refuseForeignOrigin(req: Request): Response | null {
  const origin = checkOrigin(req);
  return origin.allowed ? null : jsonRpcError(403, origin.message);
}

/**
 * Resolves an OAuth access token to the capability it was issued for, or returns the
 * response to send. A token that is unknown, expired, revoked or for another resource
 * is refused, and so is one whose connection was revoked or reconnected since: it never
 * runs as the person or at the org root. A dead capability is refused through
 * resolveCapability, which records the refusal as it does for a dead capability token.
 */
async function authenticateOAuth(req: Request, token: string): Promise<Caller | Response> {
  const refused = () =>
    unauthorized(req, "The Willder access for this app was revoked or has expired. Connect the app again.", {
      invalidToken: true,
    });
  // A token is accepted only on the resource it was issued for: this URL, if it is listed.
  const here = `${new URL(req.url).origin}/api/mcp`;
  const resolved = await resolveOAuthAccessToken(
    token,
    mcpOAuthResources().filter((resource) => resource === here),
  );
  if (!resolved) return refused();
  const credential = { capabilityId: resolved.capabilityId };
  const cap = await resolveCapability(credential, "mcp");
  if (!cap || !resolved.bindingLive) return refused();

  const ctx: AccessContext = {
    orgId: cap.orgId,
    actor: { type: "agent", id: cap.agentId, ...credential },
    origin: "mcp",
  };
  return { ctx, cap, asker: askerOf(cap, credential) };
}

/** Resolves the bearer token to a caller, or returns the response to send. */
async function authenticate(req: Request): Promise<Caller | Response> {
  const authHeader = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  const token = match?.[1]?.trim();
  if (!token) {
    return unauthorized(req, MISSING_BEARER_TOKEN_MESSAGE);
  }
  if (mcpOAuthEnabled() && isOAuthAccessToken(token)) return authenticateOAuth(req, token);

  const cap = await resolveCapability(token, "mcp");
  if (!cap) {
    // Also covers a revoked or expired token (mcp-session-expiry-gate-gap-
    // 20260918): resolveCapability rejects those at the door now, the same
    // shape as an unknown token, so this response can't tell the two apart —
    // deliberately, since a dead token shouldn't get further than a wrong one.
    return unauthorized(req, "Invalid or unknown capability token.");
  }
  // NOTE: resolveCapability's lifecycle gate above is a one-time check at
  // session establishment. Scope + permission are still per-tool-call only,
  // via check() inside mcp/tools.ts, exactly like the stdio server and the
  // REST API — that part we deliberately do not duplicate here.

  const ctx: AccessContext = {
    orgId: cap.orgId,
    actor: { type: "agent", id: cap.agentId, capabilityToken: token },
    origin: "mcp",
  };
  return { ctx, cap, asker: askerOf(cap, { capabilityToken: token }) };
}

/**
 * A POST's JSON body, read once so the route can see whether it opens a connection and the
 * transport need not read it again. Undefined when it is not JSON: the transport then reads
 * the spent body itself and answers with its own parse error, as it would have.
 */
async function jsonBodyOf(req: Request): Promise<{ value: unknown } | undefined> {
  if (req.method !== "POST") return undefined;
  try {
    return { value: JSON.parse(await req.text()) };
  } catch {
    return undefined;
  }
}

/**
 * The reply to a `tools/call` request naming a Willder tool this connection's tool set does not
 * list, or null for any other message. The SDK would answer "Tool <name> not found", which reads
 * as though the tool does not exist; this names the header that hides it. Only a single request
 * with a JSON-RPC id is answered here: a notification gets no reply, and a JSON-RPC batch
 * (dropped from MCP in 2025-06-18) gets the SDK's.
 */
function refuseUnlistedTool(body: unknown, toolSet: ToolSet): Response | null {
  if (toolSet === "all" || typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const { jsonrpc, method, id, params } = body as {
    jsonrpc?: unknown;
    method?: unknown;
    id?: unknown;
    params?: { name?: unknown };
  };
  const name = params?.name;
  if (
    jsonrpc !== "2.0" ||
    method !== "tools/call" ||
    (typeof id !== "string" && typeof id !== "number") ||
    typeof name !== "string"
  )
    return null;
  if (listsTool(toolSet, name) || !WILLDER_TOOL_NAMES.includes(name)) return null;
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: unlistedToolMessage(name) }], isError: true },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

async function handleMcpRequest(req: Request): Promise<Response> {
  const refused = refuseForeignOrigin(req);
  if (refused) return refused;
  const receivedAt = performance.now();
  const connectionsBefore = connectionsOpened();
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const { ctx, cap, asker } = caller;

  const body = await jsonBodyOf(req);
  if (body) await deliverClientReplies(asker, body.value);
  // An initialize opens a new connection, and so a new session; any other request belongs
  // to the connection whose id it sends back, or to none.
  const openedSessionId = body && opensConnection(body.value) ? newMcpSessionId() : undefined;
  const toolSet = toolSetOf(req.headers.get(TOOLS_HEADER));
  const unlisted = body && refuseUnlistedTool(body.value, toolSet);
  if (unlisted) return unlisted;

  // Fresh server + transport per request (stateless mode — no
  // sessionIdGenerator). registerWillderTools does no I/O, only attaches closures
  // over `ctx`/`cap`; a single tools/call registers just the tool it calls, since
  // every tool's schemas cost CPU that each request on a shared instance pays.
  const server = createWillderServer();
  const taskStartDurations: number[] = [];
  registerWillderTools(server, ctx, cap, {
    task: connectionTaskOf(req.headers.get(TASK_HEADER)),
    context: contextModeOf(req.headers.get(CONTEXT_HEADER)),
    session: connectionSessionKeyOf(req.headers.get(MCP_SESSION_HEADER)),
    abandoned: abandonedSignal(req),
    taskStartTimed: (ms) => taskStartDurations.push(ms),
    tools: toolSet,
    calls: body && calledToolOf(body.value),
  });
  registerWillderResources(server, ctx, cap);
  registerWillderPrompts(server, ctx, cap);
  const fixtures = conformanceFixturesRequested(req.headers.get(CONFORMANCE_HEADER)) && conformanceFixturesAllowed(cap);
  if (fixtures) registerConformanceFixtures(server, asker);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: !fixtures,
  });
  await server.connect(transport);
  const close = () => {
    void transport.close();
    void server.close();
  };

  try {
    const response = await transport.handleRequest(req, body && { parsedBody: body.value });
    // JSON responses are complete when handleRequest resolves, so every tool call in
    // the request has been timed by now. A streamed response (a conformance connection's)
    // is still running; it gets whatever finished first.
    const headers = new Headers(response.headers);
    if (openedSessionId !== undefined && response.ok) headers.set(MCP_SESSION_HEADER, openedSessionId);
    headers.append(
      "server-timing",
      mcpServerTiming({
        handlerMs: performance.now() - receivedAt,
        instanceAgeMs: receivedAt - instanceStartedAt,
        connectionsOpened: connectionsOpened() - connectionsBefore,
        taskStartMs: taskStartDurations,
      }),
    );
    // Best-effort cleanup; stateless mode holds no session to leak, but close
    // out the per-request server/transport pair explicitly rather than
    // relying on GC. A streamed reply is still being written, so its pair is
    // closed once the body ends instead of now.
    const replyBody = fixtures && response.body ? closingAfter(response.body, close) : response.body;
    if (replyBody === response.body) close();
    return new Response(replyBody, { status: response.status, statusText: response.statusText, headers });
  } catch (e) {
    close();
    throw e;
  }
}

/** `body`, calling `close` once it has been read to its end, has failed, or was cancelled. */
function closingAfter(body: ReadableStream<Uint8Array>, close: () => void): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (!done) return controller.enqueue(value);
        controller.close();
      } catch (e) {
        controller.error(e);
      }
      close();
    },
    async cancel(reason) {
      close();
      await reader.cancel(reason);
    },
  });
}

export async function POST(req: Request): Promise<Response> {
  return handleMcpRequest(req);
}

// GET is where a Streamable HTTP client opens a server-to-client event stream,
// and where a legacy HTTP+SSE client starts its handshake. This endpoint is
// stateless and sends nothing outside the reply to a POST, so it serves neither: the
// SDK transport would open an empty event stream that never ends, which a
// legacy SSE client reads as a handshake that hangs. A 405 is the answer the
// Streamable HTTP spec gives for "no GET stream here", and it tells an SSE
// client to switch transport instead of waiting. The Origin check and
// authentication still run first, so a web page gets the same 403 and an
// unauthenticated caller the same 401 as on POST.
//
// One GET is answered before authentication: the every-minute Vercel cron ping that keeps an
// instance of this function warm (./keep-warm.ts). It gets a bare 204 and touches no database.
export async function GET(req: Request): Promise<Response> {
  const refused = refuseForeignOrigin(req);
  if (refused) return refused;
  if (isVercelCronPing(req)) return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  return new Response(null, { status: 405, headers: { allow: "POST, DELETE" } });
}

export async function DELETE(req: Request): Promise<Response> {
  return handleMcpRequest(req);
}
