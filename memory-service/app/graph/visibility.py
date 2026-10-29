"""Keeping a fact graph-visible: the fallback node and edge `ensure_graph_visible`
writes when extraction found no relation, linked to one anchor per scope."""

import asyncio
import logging
import uuid as _uuid
import weakref
from collections.abc import Sequence
from datetime import datetime, timezone

from graphiti_core import Graphiti
from neo4j import unit_of_work
from neo4j.exceptions import Neo4jError

from .. import graphiti_client as client

logger = logging.getLogger(__name__)


FALLBACK_ANCHOR_NAME = "Uncategorized Fact"

# Node labels `ensure_graph_visible` may write. Closed, because the label is part of
# the Cypher text rather than a parameter.
VERBATIM_NODE_LABELS = frozenset({"Fact", "Decision", "Passage"})

# How long a graph-visibility write keeps retrying a transient Neo4j failure before it
# gives up. The usual one is a deadlock with the extraction of another write in the same
# scope (see `ensure_graph_visible`). The driver checks this budget only between
# attempts, so one call can take up to the budget plus one attempt's timeout.
VISIBILITY_RETRY_SECONDS = 10.0
# The server ends an attempt that runs longer, waiting on a lock included. A timed-out
# attempt is not retried: the write fails as if its retries had run out.
VISIBILITY_ATTEMPT_TIMEOUT_S = 5.0
# The wait before the first retry, and how much longer each next wait is (the driver adds
# jitter). A deadlock clears as soon as the other transaction commits, so retries start
# fast and grow slowly instead of doubling.
VISIBILITY_FIRST_RETRY_DELAY_S = 0.05
VISIBILITY_RETRY_DELAY_MULTIPLIER = 1.5


# One graph-visibility write at a time per scope in this process. Every one of them links
# to the scope's anchor, and two that run at once deadlock each other on it once it has
# many edges; queued here they cannot. A lock no write holds or waits on is dropped.
_visibility_locks: "weakref.WeakValueDictionary[str, asyncio.Lock]" = weakref.WeakValueDictionary()


def _visibility_lock(group_id: str) -> asyncio.Lock:
    lock = _visibility_locks.get(group_id)
    if lock is None:
        lock = _visibility_locks[group_id] = asyncio.Lock()
    return lock


class GraphVisibilityError(RuntimeError):
    """The node and edge that make a fact graph-visible were not stored, retries
    included. The ingest that asked for them must not be answered as done."""


def fallback_anchor_uuid(group_id: str) -> str:
    """Deterministic uuid so every fallback fact in a scope links to the SAME anchor
    node instead of minting a fresh one each time."""
    return str(_uuid.uuid5(_uuid.NAMESPACE_URL, f"willder-fallback-anchor:{group_id}"))


# A scope's anchor is unique by uuid. Without this constraint Neo4j's MERGE does not stop
# two concurrent transactions from each creating the anchor neither found.
_ANCHOR_CONSTRAINT = (
    "CREATE CONSTRAINT fallback_anchor_uuid IF NOT EXISTS "
    "FOR (anchor:Category) REQUIRE anchor.uuid IS UNIQUE"
)


async def ensure_one_fallback_anchor_per_scope() -> int:
    """Give every scope one fallback anchor, and keep it one under concurrent writes.

    Before this, a burst of fallback writes into a fresh scope created one anchor per
    concurrent transaction (eleven from a local burst of 24), and every later write's
    MERGE matched all of them and linked its fact to each one, storing it once per
    anchor. This merges anchors already duplicated: their edges move to the anchor kept,
    an edge the kept anchor already has (same node, same uuid) is dropped instead, and a
    duplicate left with no relationship is deleted. A duplicate that still has another
    relationship (one this merge does not move, such as an episode's MENTIONS) keeps it
    and is given a uuid of its own, so it no longer stands in for the scope's anchor.
    Then it creates the uniqueness constraint, under which MERGE locks the uuid and only
    one transaction creates the anchor. Idempotent; returns the number of duplicate
    anchors removed."""
    # The copy kept is one with no relationship the merge cannot move, so a copy something
    # else points at (an episode's MENTIONS) is the one set apart, never the anchor.
    duplicates = """
        MATCH (a:Category) WHERE a.uuid IS NOT NULL
        WITH a, COUNT {
            MATCH (a)-[r]-()
            WHERE NOT (type(r) = 'RELATES_TO' AND endNode(r) = a AND r.uuid IS NOT NULL)
        } AS unmovable
        ORDER BY unmovable, elementId(a)
        WITH a.uuid AS uuid, collect(a) AS anchors
        WHERE size(anchors) > 1
        WITH head(anchors) AS keep, tail(anchors) AS extras
        UNWIND extras AS extra
    """

    async def _merge(tx) -> int:
        await (
            await tx.run(
                duplicates
                + """
            MATCH (source)-[r:RELATES_TO]->(extra)
            WHERE r.uuid IS NOT NULL
            MERGE (source)-[moved:RELATES_TO {uuid: r.uuid}]->(keep)
            ON CREATE SET moved = properties(r)
            DELETE r
        """
            )
        ).consume()
        removed = await (
            await tx.run(
                duplicates
                + """
            WITH extra WHERE NOT (extra)--()
            DELETE extra
            RETURN count(extra) AS removed
        """
            )
        ).single()
        kept_apart = await (
            await tx.run(
                duplicates
                + """
            SET extra.uuid = randomUUID()
            RETURN count(extra) AS kept_apart
        """
            )
        ).single()
        if kept_apart["kept_apart"]:
            logger.warning(
                "%d duplicate fallback anchors still had other relationships; each kept them under a uuid of its own",
                kept_apart["kept_apart"],
            )
        return removed["removed"]

    async def _in_transaction(session) -> int:
        return await session.execute_write(_merge)

    async def _constrain(session) -> None:
        await (await session.run(_ANCHOR_CONSTRAINT)).consume()

    removed = await client._run_with_retry(_in_transaction)
    if removed:
        logger.warning(
            "Merged %d duplicate fallback anchors into the one each scope keeps", removed
        )
    try:
        await client._run_with_retry(_constrain)
    except Neo4jError:
        logger.exception(
            "could not create the fallback anchor constraint; concurrent writes into a fresh scope can duplicate an anchor"
        )
    return removed


# Both statements start by merging the scope's anchor, and both merge every node and
# edge they add on a uuid chosen before the first attempt, so running one twice stores
# what running it once does.
_MERGE_ANCHOR = """
MERGE (anchor:Entity:Category {uuid: $anchor_uuid})
ON CREATE SET anchor.name = $anchor_name,
              anchor.group_id = $gid,
              anchor.created_at = datetime()
"""

_ATTACH_TO_ENTITIES = (
    _MERGE_ANCHOR
    + """
WITH anchor
MATCH (entity:Entity {group_id: $gid})
WHERE entity.uuid IN $entity_uuids
  AND NOT (entity:Category OR entity:Fact OR entity:Decision OR entity:Passage)
MERGE (entity)-[r:RELATES_TO {uuid: $edge_uuids[entity.uuid]}]->(anchor)
ON CREATE SET r += $edge, r.created_at = datetime()
RETURN count(r) AS attached
"""
)

_WRITE_VERBATIM_NODE = (
    _MERGE_ANCHOR
    + """
MERGE (fact:Entity:%s {uuid: $fact_uuid})
ON CREATE SET fact.name = $name,
              fact.group_id = $gid,
              fact.summary = $content,
              fact.created_at = datetime()
MERGE (fact)-[r:RELATES_TO {uuid: $fact_edge_uuid}]->(anchor)
ON CREATE SET r += $edge, r.created_at = datetime()
"""
)


async def ensure_graph_visible(
    group_id: str,
    content: str,
    reference_time: datetime | None = None,
    episode_uuid: str | None = None,
    source_description: str | None = None,
    node_label: str = "Fact",
    entity_uuids: Sequence[str] = (),
) -> None:
    """Guarantee at least one graph node + edge exists for a fact even when Graphiti's
    entity extractor produces zero entities for it — common for abstract/technical
    content (architecture decisions, tradeoffs, constraints) that isn't shaped like a
    person/company fact.

    Creates a generic 'Fact' node carrying the full fact text, linked via a RELATES_TO
    edge (also carrying the full fact text) to a shared per-scope 'Uncategorized Fact'
    anchor node. This makes the content graph-visible (shows up in /graph, retrievable
    via /search's graph traversal) instead of being silently invisible to the graph and
    relying on pgvector alone.

    `source_description` is the same provenance JSON `main.py` stamps on a normal
    extracted edge (see `ingest`/`ingest_bulk`) — this fallback path fires for exactly
    the abstract/technical content that's common here, so without it the fact comes
    back with no actor_type from `fetch_edge_provenance()` and silently ranks as
    extraction-tier. Passed through by the caller, not re-derived here.

    Deliberately writes via raw Cypher instead of `Graphiti.add_triplet` — tried that
    first and it was actively counterproductive: `add_triplet` runs the SAME LLM-driven
    node/edge resolution step Graphiti uses during normal extraction, and on a small
    graph of mostly-unrelated short facts it kept merging the fallback fact into an
    unrelated existing node (or invalidating it against an unrelated existing edge)
    instead of making it visible — i.e. it silently swallowed the fact a second way.
    Raw Cypher always creates a genuinely new Fact node, so nothing is lost to a
    mis-resolution. The one node we deliberately reuse across calls is the anchor
    (deterministic uuid per group_id via `fallback_anchor_uuid`), which is inert (no
    semantic content of its own) so reusing it can't cause a mismatch.

    `node_label` types the node: "Fact" for this fallback, "Decision" when the caller
    stores a decision verbatim, "Passage" for a source passage whose number
    extraction dropped (see `main.py`'s `ingest`). Anything outside
    `VERBATIM_NODE_LABELS` raises ValueError, since the label is written into the
    Cypher text (a label cannot be a query parameter).

    `entity_uuids` are the entities extraction resolved for the fact when it found
    no relation between them, the usual result for a one-entity sentence such as
    "Kestrel Logistics is a Project that ...". The fact's edge then runs from each
    of those entities in `group_id` to the anchor, and no node of its own is made:
    a later fact about Kestrel Logistics resolves to the same entity, so a reader
    of that entity sees both. A node named after the sentence is one no later fact
    can resolve to. Only when none of them is an entity of `group_id` (the anchor
    and verbatim nodes never count) is the fact given its own node as above.

    Linking those entities locks each of them, and the extraction of another write in
    the same scope saves the same entities in its own order, so the two transactions
    can deadlock and Neo4j fails one of them (in production, five failures in a
    burst of 96 writes into one scope). The write is therefore one managed transaction,
    retried on a transient failure for up to VISIBILITY_RETRY_SECONDS, each retry
    logged, and each attempt ends after VISIBILITY_ATTEMPT_TIMEOUT_S. Writes into one
    scope run one at a time in this process, since two of them deadlock each other on
    the anchor once it has many edges. If it still fails, GraphVisibilityError is raised and nothing of the fact
    is stored: the caller answers the ingest with an error, so the write is extracted
    again later instead of being reported as done while the graph lacks it.
    """
    if node_label not in VERBATIM_NODE_LABELS:
        raise ValueError(f"unsupported node label {node_label!r}")
    attempts = 0
    try:
        g = await client.get_graphiti()
        params = _edge_params(
            group_id,
            content,
            when=reference_time or datetime.now(timezone.utc),
            episode_uuid=episode_uuid,
            source_description=source_description,
            node_label=node_label,
            embedding=await _embedding_or_none(g, content),
        )
        edge_uuids = {uuid: str(_uuid.uuid4()) for uuid in entity_uuids}
        verbatim_node = {
            "fact_uuid": str(_uuid.uuid4()),
            "fact_edge_uuid": str(_uuid.uuid4()),
            "name": _node_name(content),
            "content": content,
        }

        async def _store(tx) -> None:
            nonlocal attempts
            attempts += 1
            if attempts > 1:
                logger.warning(
                    "graph-visibility write retried after a transient Neo4j error (attempt %d, group=%s)",
                    attempts,
                    group_id,
                )
            if edge_uuids:
                result = await tx.run(
                    _ATTACH_TO_ENTITIES,
                    entity_uuids=list(edge_uuids),
                    edge_uuids=edge_uuids,
                    **params,
                )
                record = await result.single()
                if record and record["attached"] > 0:
                    return
            await (
                await tx.run(_WRITE_VERBATIM_NODE % node_label, **verbatim_node, **params)
            ).consume()

        async def _in_transaction(session) -> None:
            await session.execute_write(unit_of_work(timeout=VISIBILITY_ATTEMPT_TIMEOUT_S)(_store))

        async with _visibility_lock(group_id):
            await client._run_with_retry(
                _in_transaction,
                max_transaction_retry_time=VISIBILITY_RETRY_SECONDS,
                initial_retry_delay=VISIBILITY_FIRST_RETRY_DELAY_S,
                retry_delay_multiplier=VISIBILITY_RETRY_DELAY_MULTIPLIER,
            )
    except Exception as exc:
        logger.exception(
            "graph-visibility write failed for group=%s after %d attempt(s)",
            group_id,
            attempts,
        )
        raise GraphVisibilityError(
            f"the graph-visibility write for group {group_id} failed after {attempts} attempt(s): "
            f"{type(exc).__name__}"
        ) from exc


def _node_name(content: str) -> str:
    """A verbatim node's name: the fact's text, cut to 90 characters."""
    return content if len(content) <= 90 else content[:89].rstrip() + "…"


async def _embedding_or_none(g: Graphiti, content: str) -> list[float] | None:
    """The fact's embedding, or None when the embedder fails: it is a nice-to-have
    for this path, never a reason to leave the fact invisible."""
    try:
        return list(await g.embedder.create(content))
    except Exception:  # noqa: BLE001 — embedding is a nice-to-have for this path
        return None


def _edge_params(
    group_id: str,
    content: str,
    *,
    when: datetime,
    episode_uuid: str | None,
    source_description: str | None,
    node_label: str,
    embedding: list[float] | None,
) -> dict:
    """The parameters both visibility statements share: the scope's anchor and the
    properties of the edge they write."""
    return {
        "gid": group_id,
        "anchor_uuid": fallback_anchor_uuid(group_id),
        "anchor_name": FALLBACK_ANCHOR_NAME,
        "edge": {
            "group_id": group_id,
            "name": "RELATES_TO",
            "fact": content,
            "valid_at": when,
            "episodes": [episode_uuid] if episode_uuid else [],
            "fallback": node_label == "Fact",
            "embedding": embedding,
            "source_description": source_description or "{}",
        },
    }
