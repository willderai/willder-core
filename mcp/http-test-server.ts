// Shared test infrastructure for driving the REAL hosted MCP endpoint
// (app/api/mcp/route.ts) through a genuine MCP-SDK client, without needing a
// full `next dev`/`next start` process. Route handlers in this Next.js version
// are plain (Request) => Promise<Response> functions (Web standard), the same
// convention this repo's other route tests already rely on (see
// app/api/inbox/route.test.ts: `import { GET } from "./route"` + `new
// Request(...)`) — this just goes one step further and puts a real socket in
// front of those same handlers so a transport-level MCP client (which needs an
// actual URL to `fetch()`, not a function to call) can talk to them.
//
// Used by both scripts/check-mcp.ts (live, against a real DB) and
// app/api/mcp/route.test.ts (offline, DB/store mocked) — same harness, same
// route.ts code path, only what's behind `@/lib/db` / `@/services/memory`
// differs between the two.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { DELETE, GET, POST } from "@/app/api/mcp/route";

const HANDLERS: Record<string, (req: Request) => Promise<Response>> = {
  GET,
  POST,
  DELETE,
};

async function toWebRequest(req: IncomingMessage, url: string): Promise<Request> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(key, v);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.method !== "DELETE";
  let body: Buffer | undefined;
  if (hasBody) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    body = Buffer.concat(chunks);
  }
  return new Request(url, {
    method: req.method,
    headers,
    body: body && body.length > 0 ? new Uint8Array(body) : undefined,
  });
}

async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  const body = response.body;
  if (!body) {
    res.end();
    return;
  }
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
}

export interface McpTestServer {
  /** Base URL of the hosted MCP endpoint, e.g. http://127.0.0.1:54321/api/mcp */
  url: string;
  close(): Promise<void>;
}

/** Other routes the server answers beside /api/mcp, by path, then method: the hook's notice route, say. */
export type ExtraRoutes = Record<string, Record<string, (req: Request) => Promise<Response>>>;

/** Boot an ephemeral HTTP server wrapping the real POST/GET/DELETE handlers
 * from app/api/mcp/route.ts, plus any `extraRoutes`, listening on a random loopback port. */
export async function startMcpTestServer(extraRoutes: ExtraRoutes = {}): Promise<McpTestServer> {
  const server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      const handler = (extraRoutes[path] ?? HANDLERS)[req.method ?? "GET"];
      if (!handler) {
        res.writeHead(405).end();
        return;
      }
      try {
        const url = `http://127.0.0.1${req.url}`;
        const webReq = await toWebRequest(req, url);
        const webRes = await handler(webReq);
        await writeWebResponse(res, webRes);
      } catch (e) {
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: String(e) }, id: null }));
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind test server");

  return {
    url: `http://127.0.0.1:${address.port}/api/mcp`,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
