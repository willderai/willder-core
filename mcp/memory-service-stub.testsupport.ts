// A fake for the memory service (memory-service/), for database tests that drive the
// real write path. memory_ingest stores a fact in Postgres and asks the memory service for
// its embedding and for graph extraction; this answers both on a real socket without a
// model: a healthy /health, one fixed embedding, an accepted ingest, an empty graph. Point
// GRAPHITI_SERVICE_URL at start()'s address before the store module is imported.
import { createServer, type IncomingMessage, type Server } from "node:http";

/** A memory service on a real socket: a fixed embedding, an accepted ingest, an empty graph. */
export class EmptyGraphMemoryService {
  private server: Server | null = null;

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      void this.handle(req).then(
        ([status, body]) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body)),
        (e: unknown) => res.writeHead(500).end(String(e)),
      );
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("memory service did not bind");
    return `http://127.0.0.1:${address.port}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private async handle(req: IncomingMessage): Promise<[number, unknown]> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {};
    const path = new URL(req.url ?? "/", "http://memory").pathname;
    if (path === "/health") return [200, { status: "ok", neo4j: true, extraction: { status: "stub", reason: null } }];
    if (path === "/embed") return [200, { embedding: new Array(384).fill(0.01) }];
    if (path === "/ingest") return [200, { episode_id: "ep-1" }];
    if (path === "/search") {
      const groups = new Set([String(body.group_id), ...((body.group_ids as string[] | undefined) ?? [])]);
      return [200, { facts: [], groups_searched: groups.size }];
    }
    if (path === "/graph") return [200, { nodes: [], edges: [] }];
    return [404, { detail: `no route ${path}` }];
  }
}
