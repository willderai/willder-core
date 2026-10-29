// A fake of the memory service (memory-service/) that extracts facts the way Graphiti
// does, for database tests that drive a real connector sync and read the result back through
// memory_query. Test-only: not collected by vitest (its include is `**/*.test.ts`) and not
// reachable from the served application.
//
// What it plays, on a real socket and without a model:
//   - /ingest and /ingest-bulk store one episode per input, with the provenance the app sent.
//   - /extract splits a file into the passages a test set with `passagesOfNextFile`.
//   - /search returns the facts extraction made of the group's episodes, in the shape the real
//     /search returns them: an extracted edge carries no provenance stamp of its own, so its
//     actor fields are null and its source is the first of its episodes that names one
//     (graphiti_client.fetch_edge_provenance). A fact several episodes state is one edge
//     listing every one of them, as Graphiti merges a duplicate edge.
//   - `reportsEpisodes = false` answers as a memory service older than /search's
//     `episode_ids`, which leaves the field out.
//   - A connected source's item (`record_type: "document"`) with a `heading` also states its
//     heading in its own words, as the real /ingest keeps it.
//   - `searchesByWords = true` finds a fact only when it holds at least half of the query's
//     words, the way the real search's full-text leg needs words in common; a fact stated
//     in other words is then not found by a query that names the item.
// What it does not play: ranking (every fact found is returned) and entity extraction
// itself: a test says what each episode's text extracts to with `extracts`.
import { createServer, type IncomingMessage, type Server } from "node:http";

interface Episode {
  uuid: string;
  group: string;
  content: string;
  sourceId: string | null;
  chunkId: string | null;
  heading: string | null;
}

/** A text's words, lower-cased, for `searchesByWords`. */
function wordsOf(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

export class ExtractingMemoryService {
  /** False to answer /search as a memory service that predates `episode_ids`. */
  reportsEpisodes = true;
  /** False to answer as a memory service that predates `heading`, which stores none. */
  keepsHeadings = true;
  /** True to find a fact only by words it shares with the query (see the file comment). */
  searchesByWords = false;
  private server: Server | null = null;
  private readonly episodes: Episode[] = [];
  private readonly extractions = new Map<string, string[]>();
  private passages: string[] = [];

  /** The facts extraction makes of an episode whose text is `content`, in their own words.
   * An episode whose text was never registered yields no fact. */
  extracts(content: string, facts: string[]): void {
    this.extractions.set(content, facts);
  }

  /** The passages /extract returns for the next file it is asked to read. */
  passagesOfNextFile(passages: string[]): void {
    this.passages = passages;
  }

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

  private store(body: Record<string, unknown>): string {
    const episode: Episode = {
      uuid: `ep-${this.episodes.length + 1}-${Math.random().toString(36).slice(2, 8)}`,
      group: String(body.group_id),
      content: String(body.content),
      sourceId: (body.source_id as string | undefined) ?? null,
      chunkId: (body.chunk_id as string | undefined) ?? null,
      heading:
        body.record_type === "document" && typeof body.heading === "string" && body.heading.trim()
          ? body.heading.trim()
          : null,
    };
    this.episodes.push(episode);
    return episode.uuid;
  }

  /** The edges of each of `groups`, as the real service searches several groups in one call. */
  private search(groups: string[], query: string): Record<string, unknown>[] {
    return groups.flatMap((group) => this.searchGroup(group, query));
  }

  private searchGroup(group: string, query: string): Record<string, unknown>[] {
    // An extracted fact several episodes state is one edge; a heading is written verbatim as an
    // edge of its own every time, as ensure_graph_visible does, so two items with the same
    // heading are two edges with the same text.
    const edges = new Map<string, [fact: string, asserting: Episode[]]>();
    for (const episode of this.episodes.filter((e) => e.group === group)) {
      for (const fact of this.extractions.get(episode.content) ?? [])
        edges.set(fact, [fact, [...(edges.get(fact)?.[1] ?? []), episode]]);
      if (episode.heading && this.keepsHeadings)
        edges.set(`${episode.uuid}\0${episode.heading}`, [episode.heading, [episode]]);
    }
    const asked = wordsOf(query);
    const found = (fact: string) => {
      if (!this.searchesByWords) return true;
      const words = wordsOf(fact);
      return [...asked].filter((word) => words.has(word)).length * 2 >= asked.size;
    };
    // Numbered before the filter, so a fact keeps its uuid whatever the query.
    return [...edges.values()]
      .map((edge, i) => [edge, i] as const)
      .filter(([[fact]]) => found(fact))
      .map(([[fact, asserting], i]) => ({
        uuid: `edge-${group}-${i + 1}`,
        group_id: group,
        fact,
        valid_at: null,
        actor_type: null,
        actor_name: null,
        source_id: asserting.find((e) => e.sourceId)?.sourceId ?? null,
        chunk_ids: asserting.flatMap((e) => (e.chunkId ? [e.chunkId] : [])),
        ...(this.reportsEpisodes ? { episode_ids: asserting.map((e) => e.uuid) } : {}),
      }));
  }

  private async handle(req: IncomingMessage): Promise<[number, unknown]> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {};
    const path = new URL(req.url ?? "/", "http://memory").pathname;
    if (path === "/embed") return [200, { embedding: new Array(384).fill(0.01) }];
    if (path === "/ingest") return [200, { episode_id: this.store(body) }];
    if (path === "/ingest-bulk") {
      const episodes = body.episodes as Record<string, unknown>[];
      return [200, { episode_ids: episodes.map((episode) => this.store(episode)) }];
    }
    if (path === "/extract") return [200, { chunks: this.passages }];
    if (path === "/search") {
      const groups = [...new Set([String(body.group_id), ...((body.group_ids as string[] | undefined) ?? [])])];
      return [200, { facts: this.search(groups, String(body.query ?? "")), groups_searched: groups.length }];
    }
    if (path === "/graph") return [200, { nodes: [], edges: [] }];
    return [404, { detail: `no route ${path}` }];
  }
}
