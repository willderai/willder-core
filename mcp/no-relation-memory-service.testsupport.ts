// A fake of the memory service on its no-relation path, for real-database MCP tests:
// it answers embeddings with one fixed vector and serves each ingested episode back from
// /search as one fact, carrying the chunk id its ingest stamped, the way the real service
// does when extraction finds no relation. A test may also seed a graph-only fact, one with
// no stored chunk behind it, which is what extraction produces for content the request
// path never stored.
import { createServer, type IncomingMessage, type Server } from "node:http";

interface StoredEpisode {
  uuid: string;
  content: string;
  actorType: string | null;
  actorName: string | null;
  chunkId: string | null;
  /** The connected source a graph-only fact was synced from, and the episode it was synced as. */
  sourceId?: string;
}

export class NoRelationMemoryService {
  private server: Server | null = null;
  private readonly episodes = new Map<string, StoredEpisode[]>();

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

  /** The graph group an ingest of `content` landed in. Throws when none did. */
  groupHolding(content: string): string {
    for (const [group, stored] of this.episodes) if (stored.some((ep) => ep.content === content)) return group;
    throw new Error(`no episode holds: ${content}`);
  }

  /**
   * Serve `content` from `group` as a graph fact with no stored chunk behind it. With `from`,
   * it is a connector item's: synced from that source as that episode, which is what keeps a
   * graph-only fact served (services/memory/graph-fact-sources.ts: a source's synced-file
   * record must still list the episode). Without it, nothing stored stands behind the fact.
   */
  seedGraphOnly(group: string, content: string, from?: { sourceId: string; episodeId: string }): void {
    const stored = this.episodes.get(group) ?? [];
    this.episodes.set(group, [
      ...stored,
      {
        uuid: from?.episodeId ?? `graph-only-${group}-${stored.length + 1}`,
        content,
        actorType: null,
        actorName: null,
        chunkId: null,
        sourceId: from?.sourceId,
      },
    ]);
  }

  private async handle(req: IncomingMessage): Promise<[number, unknown]> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {};
    const path = new URL(req.url ?? "/", "http://memory").pathname;
    if (path === "/embed") return [200, { embedding: new Array(384).fill(0.01) }];
    if (path === "/ingest") {
      const group = String(body.group_id);
      const stored = this.episodes.get(group) ?? [];
      const episode: StoredEpisode = {
        uuid: `ep-${group}-${stored.length + 1}`,
        content: String(body.content),
        actorType: (body.actor_type as string | undefined) ?? null,
        actorName: (body.actor_name as string | undefined) ?? null,
        chunkId: (body.chunk_id as string | undefined) ?? null,
      };
      this.episodes.set(group, [...stored, episode]);
      return [200, { episode_id: episode.uuid }];
    }
    if (path === "/search") {
      // The real service searches `group_id` plus every one of `group_ids` in one call.
      const groups = [...new Set([String(body.group_id), ...((body.group_ids as string[] | undefined) ?? [])])];
      const facts = groups.flatMap((group) =>
        (this.episodes.get(group) ?? []).map((ep) => ({
          uuid: `edge-${ep.uuid}`,
          group_id: group,
          fact: ep.content,
          valid_at: null,
          actor_type: ep.actorType,
          actor_name: ep.actorName,
          source_id: ep.sourceId ?? null,
          chunk_ids: ep.chunkId ? [ep.chunkId] : [],
          episode_ids: [ep.uuid],
        })),
      );
      return [200, { facts, groups_searched: groups.length }];
    }
    if (path === "/graph") return [200, { nodes: [], edges: [] }];
    return [404, { detail: `no route ${path}` }];
  }
}
