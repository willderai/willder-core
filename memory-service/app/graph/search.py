"""Hybrid edge search over many groups: BM25 and cosine fused by reciprocal rank,
with the groups batched so the keyword half survives a long group list."""

import asyncio
from collections.abc import Sequence
from datetime import datetime, timezone

from graphiti_core import Graphiti
from graphiti_core.edges import EntityEdge
from graphiti_core.helpers import lucene_sanitize
from graphiti_core.search.search_config_recipes import EDGE_HYBRID_SEARCH_RRF
from graphiti_core.search.search_filters import ComparisonOperator, DateFilter, SearchFilters
from graphiti_core.search.search_utils import MAX_QUERY_LENGTH

# Graphiti's fulltext leg answers nothing once the query's words plus the number of
# groups reach MAX_QUERY_LENGTH (graphiti_core.search.search_utils.fulltext_query), so a
# search over many groups would silently lose its keyword half. search_edges splits the
# groups into batches small enough to keep it, but never into more than
# MAX_SEARCH_BATCHES: one request costs at most that many Graphiti searches, whatever
# the query's length.
SEARCH_BATCH_CONCURRENCY = 4
MAX_SEARCH_BATCHES = 10


def group_batches(query: str, group_ids: Sequence[str]) -> list[list[str]]:
    """`group_ids` in order, without repeats, cut into at most MAX_SEARCH_BATCHES batches,
    each small enough for Graphiti to run the fulltext query for `query` when that many
    batches allow it. A batch larger than that (a long query over many groups) is still
    searched by embedding similarity; it loses only the keyword half, as a single-group
    search of a query of MAX_QUERY_LENGTH words already does."""
    unique = list(dict.fromkeys(group_ids))
    words = len(lucene_sanitize(query).split(" "))
    keeps_fulltext = max(1, MAX_QUERY_LENGTH - 1 - words)
    size = max(keeps_fulltext, -(-len(unique) // MAX_SEARCH_BATCHES))
    return [unique[i : i + size] for i in range(0, len(unique), size)]


def interleave(ranked_lists: Sequence[Sequence[EntityEdge]], limit: int) -> list[EntityEdge]:
    """The first `limit` edges taking one from each list in turn, best first. Scores of
    separate searches are not comparable, so rank within each list is the only order."""
    merged: list[EntityEdge] = []
    for rank in range(max((len(edges) for edges in ranked_lists), default=0)):
        merged.extend(edges[rank] for edges in ranked_lists if rank < len(edges))
    return merged[:limit]


async def search_edges(
    g: Graphiti, query: str, group_ids: Sequence[str], limit: int
) -> list[EntityEdge]:
    """Hybrid edge search over `group_ids`, returning at most `limit` facts.

    Graphiti.search() does the same query but writes the limit onto the shared
    EDGE_HYBRID_SEARCH_RRF recipe and reads it back after awaiting the query
    embedding, so concurrent searches overwrite each other's limit. Each call here
    gets its own copy of the recipe instead.

    One Graphiti search covers a batch of groups (group_batches); more groups than one
    batch holds are searched batch by batch, a few at a time, and their results taken
    in turn. Every group is searched or the call raises: there is no partial answer.

    An edge whose `invalid_at` has passed is left out in the query, so it cannot
    take a place in the limit a current fact would fill. That is the only edge
    left out: the caller still applies its own rule to the rest.
    """
    gate = asyncio.Semaphore(SEARCH_BATCH_CONCURRENCY)

    async def search_batch(batch: list[str]) -> list[EntityEdge]:
        config = EDGE_HYBRID_SEARCH_RRF.model_copy(deep=True)
        config.limit = limit
        async with gate:
            results = await g.search_(
                query=query,
                config=config,
                group_ids=batch,
                search_filter=_not_yet_ended(),
            )
        return results.edges

    batches = group_batches(query, group_ids)
    if len(batches) == 1:
        return await search_batch(batches[0])
    return interleave(await asyncio.gather(*(search_batch(batch) for batch in batches)), limit)


def _not_yet_ended() -> SearchFilters:
    """Edges with no `invalid_at`, or one still ahead. `expired_at` is not tested:
    Graphiti sets it whenever it records an `invalid_at`, a future one included."""
    return SearchFilters(
        invalid_at=[
            [DateFilter(comparison_operator=ComparisonOperator.is_null)],
            [
                DateFilter(
                    date=datetime.now(timezone.utc),
                    comparison_operator=ComparisonOperator.greater_than,
                )
            ],
        ]
    )
