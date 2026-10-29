// The one way GuardedMemoryStore reads the graph: each read of the backing store, with every
// graph answer it returns checked against the stored sources behind it
// (services/memory/graph-fact-sources.ts) before the guarded store sees it. Kept apart from
// that rule so a test of the guarded store's merge and ranking can stand the check in
// (vi.mock of graph-fact-sources) without standing in the reads themselves.
import type {
  EntityLookup,
  FindFactByIdInput,
  FindFactByIdResult,
  GraphInput,
  MemoryEdge,
  MemoryEntity,
  MemoryFact,
  MemoryGraph,
  SearchInput,
  SearchResult,
} from "@/types/memory";
import { loadGraphSources, servedFacts } from "./graph-fact-sources";
import { toGid } from "./graphiti-store";
import type { MemoryStore } from "./memory-store";

/** Every item a list of facts asks about: the facts and the rows they were kept over. */
const withDisplaced = (facts: readonly MemoryFact[]): MemoryFact[] =>
  facts.flatMap((f) => [f, ...(f.displacedCopies ?? [])]);

/**
 * The graph reads of `store`, each answering only what a stored source still supports.
 * GuardedMemoryStore reads the graph through this and nothing else
 * (services/memory/guarded-store.sole-graph-path.test.ts), so no graph text reaches a
 * reader around the check.
 */
export interface SourceCheckedReads {
  /** `store.retrieve`, its graph facts checked; an unscoped fact is matched against `partition`. */
  retrieve(orgId: string, input: SearchInput, partition: string | null): Promise<SearchResult>;
  /** `store.entity`, its facts checked against the partition the entity was found in. */
  entity(orgId: string, lookup: EntityLookup): Promise<MemoryEntity | null>;
  /** `store.graph`, its edges checked; a node is dropped once every edge it had is. */
  graph(orgId: string, input: GraphInput): Promise<MemoryGraph>;
  /** `store.findFactById`; a graph fact no stored source supports reads as not found. */
  findFactById(orgId: string, input: FindFactByIdInput): Promise<FindFactByIdResult | null>;
}

export function sourceCheckedReads(store: MemoryStore): SourceCheckedReads {
  return {
    async retrieve(orgId, input, partition) {
      const result = await store.retrieve(input);
      const sources = await loadGraphSources(orgId, withDisplaced(result.facts));
      const groupOf = (fact: MemoryFact) => fact.graphGroupId ?? (partition === null ? null : toGid(partition));
      return { ...result, facts: servedFacts(result.facts, sources, groupOf) };
    },
    async entity(orgId, lookup) {
      const entity = await store.entity(lookup);
      if (!entity?.facts?.length) return entity;
      const group = entity.graphGroupId ?? toGid(lookup.groupId);
      const sources = await loadGraphSources(orgId, entity.facts);
      return { ...entity, facts: servedFacts(entity.facts, sources, () => group) };
    },
    async graph(orgId, input) {
      const graph = await store.graph(input);
      if (graph.edges.length === 0) return graph;
      const sources = await loadGraphSources(orgId, graph.edges);
      const edges = graph.edges.filter((edge: MemoryEdge) => sources.supports(edge, edge.graphGroupId ?? null));
      if (edges.length === graph.edges.length) return graph;
      const hadEdges = new Set(graph.edges.flatMap((e) => [e.source, e.target]));
      const keepsEdges = new Set(edges.flatMap((e) => [e.source, e.target]));
      return { ...graph, nodes: graph.nodes.filter((n) => !hadEdges.has(n.uuid) || keepsEdges.has(n.uuid)), edges };
    },
    async findFactById(orgId, input) {
      const found = await store.findFactById(input);
      if (!found || found.store !== "graph") return found;
      const sources = await loadGraphSources(orgId, [found]);
      return sources.supports(found, toGid(input.groupId)) ? found : null;
    },
  };
}
