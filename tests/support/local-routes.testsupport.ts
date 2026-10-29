// The routes a live-API suite writes and cleans up through, served in-process by the real route
// handlers, for suites that drive the app over HTTP against a real Postgres (test-only; not
// collected by vitest, whose include is `**/*.test.ts`).
//
// Served: listing, creating and deleting a scope, listing who can read one, creating and deleting
// a grant, minting, listing and revoking capability tokens, `/api/mcp`, a session's memory query,
// store overview and member list, deleting one fact and retiring one rule — the calls a
// suite's seeding, its checks and its cleanup make. Anything else is refused with a 404 naming
// it, so a suite that strays off them fails instead of reading an empty answer. The memory
// service's `/embed` is answered by the deterministic double in
// memory-service-double.testsupport.ts. `localBrowserContext` is the signed-in browser over any
// such fetch, sending JSON or a multipart form.
//
// The handlers read the signed-in session from `@/lib/access-context`; the suite mocks that
// module to its admin before calling any of these.
import { textEmbedding } from "./memory-service-double.testsupport";

/** The origin the handlers are served at. */
export const LOCAL_BASE_URL = "http://local.test";

type Handler = (request: Request, context?: { params: Promise<{ id: string }> }) => Promise<Response>;

interface RouteTable {
  listScopes: Handler;
  createScope: Handler;
  deleteScope: Handler;
  scopeReaders: Handler;
  mintToken: Handler;
  listTokens: Handler;
  revokeToken: Handler;
  createGrant: Handler;
  deleteGrant: Handler;
  mcp: Handler;
  deleteFact: Handler;
  retireRule: Handler;
  memoryQuery: Handler;
  storeOverview: Handler;
  members: Handler;
}

async function loadRoutes(): Promise<RouteTable> {
  const [
    scopes,
    scope,
    readers,
    capabilities,
    capability,
    grants,
    grant,
    mcp,
    fact,
    convention,
    memoryQuery,
    stores,
    members,
  ] = await Promise.all([
    import("@/app/api/access/scopes/route"),
    import("@/app/api/access/scopes/[id]/route"),
    import("@/app/api/access/scopes/[id]/readers/route"),
    import("@/app/api/access/capabilities/route"),
    import("@/app/api/access/capabilities/[id]/route"),
    import("@/app/api/access/grants/route"),
    import("@/app/api/access/grants/[id]/route"),
    import("@/app/api/mcp/route"),
    import("@/app/api/memory/facts/[id]/route"),
    import("@/app/api/memory/conventions/[id]/route"),
    import("@/app/api/memory/query/route"),
    import("@/app/api/memory/stores/route"),
    import("@/app/api/settings/members/route"),
  ]);
  return {
    listScopes: scopes.GET as Handler,
    createScope: scopes.POST as Handler,
    deleteScope: scope.DELETE as Handler,
    scopeReaders: readers.GET as Handler,
    mintToken: capabilities.POST as Handler,
    listTokens: capabilities.GET as Handler,
    revokeToken: capability.DELETE as Handler,
    createGrant: grants.POST as Handler,
    deleteGrant: grant.DELETE as Handler,
    mcp: mcp.POST as Handler,
    deleteFact: fact.DELETE as Handler,
    retireRule: convention.DELETE as Handler,
    memoryQuery: memoryQuery.POST as Handler,
    storeOverview: stores.GET as Handler,
    members: members.GET as Handler,
  };
}

/** The routes served by method and an `:id` path, each with the handler that answers it. */
const BY_ID: ReadonlyArray<[string, RegExp, keyof RouteTable]> = [
  ["DELETE", /^\/api\/memory\/facts\/([^/]+)$/, "deleteFact"],
  ["DELETE", /^\/api\/memory\/conventions\/([^/]+)$/, "retireRule"],
  ["DELETE", /^\/api\/access\/capabilities\/([^/]+)$/, "revokeToken"],
  ["DELETE", /^\/api\/access\/grants\/([^/]+)$/, "deleteGrant"],
  ["DELETE", /^\/api\/access\/scopes\/([^/]+)$/, "deleteScope"],
  ["GET", /^\/api\/access\/scopes\/([^/]+)\/readers$/, "scopeReaders"],
];

/**
 * A `fetch` that serves the routes above from their handlers and the memory service's
 * `/embed` from the double. Load it after the suite has pointed DATABASE_URL at its database.
 */
export async function localFetch(): Promise<typeof fetch> {
  const routes = await loadRoutes();
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname.endsWith("/embed")) {
      const body = (await request.json()) as { text?: string };
      return Response.json({ embedding: textEmbedding(body.text ?? "") });
    }
    if (url.origin !== LOCAL_BASE_URL) throw new Error(`unexpected fetch to ${url.href}`);
    if (request.method === "GET" && url.pathname === "/api/access/scopes") return routes.listScopes(request);
    if (request.method === "POST" && url.pathname === "/api/access/scopes") return routes.createScope(request);
    if (request.method === "POST" && url.pathname === "/api/access/capabilities") return routes.mintToken(request);
    if (request.method === "GET" && url.pathname === "/api/access/capabilities") return routes.listTokens(request);
    if (request.method === "POST" && url.pathname === "/api/access/grants") return routes.createGrant(request);
    if (request.method === "POST" && url.pathname === "/api/mcp") return routes.mcp(request);
    if (request.method === "POST" && url.pathname === "/api/memory/query") return routes.memoryQuery(request);
    if (request.method === "GET" && url.pathname === "/api/memory/stores") return routes.storeOverview(request);
    if (request.method === "GET" && url.pathname === "/api/settings/members") return routes.members(request);
    for (const [method, path, handler] of BY_ID) {
      const id = path.exec(url.pathname)?.[1];
      if (request.method === method && id !== undefined)
        return routes[handler](request, { params: Promise.resolve({ id: decodeURIComponent(id) }) });
    }
    return Response.json({ error: `the local target serves no ${request.method} ${url.pathname}` }, { status: 404 });
  }) as typeof fetch;
}

export { localBrowserContext } from "./local-browser-context";
