"""A burst of fallback writes into one scope while extraction saves the same entities,
against a real local Neo4j.

NEO4J_DELETE_TEST_URI=bolt://127.0.0.1:17687 python -m pytest tests/test_graph_visibility_burst_integration.py

Railway, 2026-10-18 17:17-17:18Z: 96 writes into one fresh scope, and five of the
`ensure_graph_visible` writes failed with Neo4j's DeadlockDetected. The fallback edge
of a one-entity sentence runs from each entity extraction resolved to the scope's
anchor, so one transaction locks several entity nodes, one after another. The
extraction of another write in the same scope saves those entities too, in its own
order. Two transactions that lock the same two nodes in opposite orders deadlock, and
Neo4j fails one of them. Graphiti's save runs as a managed transaction and is retried;
the fallback write ran once, so it lost, and /ingest still answered 200.

The same burst found a second defect: a fresh scope has no anchor yet, and Neo4j's MERGE
without a uniqueness constraint let each concurrent write create one. Every later write
then matched all of them and stored its fact once per anchor.

Real: Neo4j, Graphiti's own save of extracted entities and edges
(`add_nodes_and_edges_bulk`, the step `add_episode` ends with), and the service's real
`ensure_graph_visible`. Not real: the embedder, which gives every text one vector, and
the extraction model, which is not called. The disposable database is cleared first.
"""

import asyncio
import logging
import os
import random
import time
from datetime import datetime, timezone
from urllib.parse import urlparse

import pytest
from graphiti_core.driver.neo4j_driver import Neo4jDriver
from graphiti_core.edges import EntityEdge
from graphiti_core.nodes import EntityNode
from graphiti_core.utils.bulk_utils import add_nodes_and_edges_bulk
from neo4j import AsyncGraphDatabase

from app import graphiti_client
from app.graph import visibility
from app.config import settings

URI = os.getenv("NEO4J_DELETE_TEST_URI")
pytestmark = pytest.mark.skipif(not URI, reason="requires a disposable local Neo4j")

GROUP = "org_burst-fresh_scope"
NOW = datetime(2026, 10, 18, tzinfo=timezone.utc)
EMBEDDING = [0.1] * settings.bge_dim
ENTITIES = [f"entity-{i}" for i in range(6)]
# Writes per kind in one burst: each fallback write names three of the six entities,
# each extraction save four. On Neo4j 2026.09 the unfixed write failed in about half of
# them; with the fix a burst sees about 5 to 10 deadlock retries and no failure. That is
# more contention than the production burst (five deadlocks in 96 writes).
BURST = 24
FALLBACK_ENTITIES = 3
SAVED_ENTITIES = 4


class _Embedder:
    async def create(self, _text):
        return EMBEDDING

    async def create_batch(self, texts):
        return [EMBEDDING for _ in texts]


class _Graphiti:
    embedder = _Embedder()


async def _graphiti():
    return _Graphiti()


async def _extraction_save(graph, i, entities):
    """What the end of `add_episode` writes for a sentence about `entities`: each entity
    saved again (its summary updated), and a fact between each neighbouring pair."""
    nodes = [
        EntityNode(
            uuid=u,
            name=u,
            group_id=GROUP,
            labels=["Company"],
            summary=f"seen in write {i}",
            created_at=NOW,
            name_embedding=EMBEDDING,
        )
        for u in entities
    ]
    edges = [
        EntityEdge(
            uuid=f"extracted-{i}-{k}",
            source_node_uuid=a,
            target_node_uuid=b,
            name="RELATES_TO",
            fact=f"write {i} relates {a} to {b}",
            group_id=GROUP,
            episodes=[],
            created_at=NOW,
            valid_at=NOW,
            fact_embedding=EMBEDDING,
        )
        for k, (a, b) in enumerate(zip(entities, entities[1:], strict=False))
    ]
    await add_nodes_and_edges_bulk(graph, [], [], nodes, edges, _Embedder())


async def _burst(monkeypatch):
    """Seed the scope's entities, then run BURST fallback writes and BURST extraction
    saves at once. Returns, per fallback write, its entities and the exception it raised
    (None when it returned), and the fallback edges stored per fact text."""
    parsed = urlparse(URI)
    assert parsed.scheme == "bolt" and parsed.hostname == "127.0.0.1"
    raw = AsyncGraphDatabase.driver(URI, auth=None)
    graph = Neo4jDriver(uri=URI, user=None, password=None)
    monkeypatch.setattr(graphiti_client, "get_graphiti", _graphiti)
    monkeypatch.setattr(graphiti_client, "get_driver", lambda: raw)
    monkeypatch.setattr(settings, "neo4j_database", "neo4j")
    try:
        await raw.execute_query("MATCH (n) DETACH DELETE n", database_="neo4j")
        # What the engine's start-up does before any write (`_build_graphiti`).
        await graphiti_client.ensure_one_fallback_anchor_per_scope()
        for u in ENTITIES:
            await EntityNode(
                uuid=u,
                name=u,
                group_id=GROUP,
                labels=["Company"],
                summary="",
                created_at=NOW,
                name_embedding=EMBEDDING,
            ).save(graph)

        picks = random.Random(20261018)
        fallback_entities = [picks.sample(ENTITIES, FALLBACK_ENTITIES) for _ in range(BURST)]
        save_entities = [picks.sample(ENTITIES, SAVED_ENTITIES) for _ in range(BURST)]

        async def fallback(i):
            try:
                await graphiti_client.ensure_graph_visible(
                    GROUP,
                    f"fallback fact {i}",
                    NOW,
                    f"episode-{i}",
                    entity_uuids=fallback_entities[i],
                )
            except Exception as exc:  # noqa: BLE001 — the outcome under test
                return exc
            return None

        outcomes = await asyncio.gather(
            *(fallback(i) for i in range(BURST)),
            *(_extraction_save(graph, i, save_entities[i]) for i in range(BURST)),
        )
        records, _, _ = await raw.execute_query(
            """
            MATCH (e:Entity {group_id: $gid})-[r:RELATES_TO]->(:Category)
            RETURN r.fact AS fact, collect(e.uuid) AS sources, collect(r.uuid) AS edges
            """,
            gid=GROUP,
            database_="neo4j",
        )
        stored = {r["fact"]: (sorted(r["sources"]), r["edges"]) for r in records}
        anchors, _, _ = await raw.execute_query(
            "MATCH (a:Category {group_id: $gid}) RETURN count(a) AS n",
            gid=GROUP,
            database_="neo4j",
        )
        assert anchors[0]["n"] == 1, f"the scope has {anchors[0]['n']} fallback anchors"
        return list(zip(fallback_entities, outcomes[:BURST], strict=False)), stored
    finally:
        await graph.close()
        await raw.close()


def _retries_logged(caplog):
    return [
        r for r in caplog.records if r.name == visibility.__name__ and "retried" in r.getMessage()
    ]


def test_a_burst_into_one_scope_stores_every_fallback_edge_once(monkeypatch, caplog):
    caplog.set_level(logging.WARNING, logger=visibility.__name__)
    writes, stored = asyncio.run(_burst(monkeypatch))

    failed = [(i, exc) for i, (_, exc) in enumerate(writes) if exc is not None]
    assert failed == [], f"{len(failed)} of {BURST} fallback writes failed; first: {failed[:1]}"
    for i, (entities, _) in enumerate(writes):
        sources, edges = stored.get(f"fallback fact {i}", ([], []))
        # One edge from each entity, none missing and none doubled by a retry.
        assert sources == sorted(entities), f"fallback fact {i}"
        assert len(set(edges)) == len(edges) == len(entities)
    # The burst exercised the contention it is about: a fallback write was failed by
    # Neo4j and retried. Without this, a burst that met no deadlock would pass as well.
    assert _retries_logged(caplog), "no fallback write met a deadlock; the burst proves nothing"


def test_a_write_that_runs_out_of_retries_raises_and_leaves_nothing_behind(monkeypatch, caplog):
    # No retry budget: the first deadlock a fallback write meets is final.
    monkeypatch.setattr(visibility, "VISIBILITY_RETRY_SECONDS", 0.0)
    writes, stored = asyncio.run(_burst(monkeypatch))

    failed = [i for i, (_, exc) in enumerate(writes) if exc is not None]
    assert failed, "no fallback write met a deadlock; the burst proves nothing"
    for i, (entities, exc) in enumerate(writes):
        sources, _ = stored.get(f"fallback fact {i}", ([], []))
        if exc is None:
            assert sources == sorted(
                entities
            ), f"fallback fact {i} returned but is not fully stored"
        else:
            # Raised, never acknowledged, and the rolled-back transaction left no part of it.
            assert isinstance(exc, graphiti_client.GraphVisibilityError), repr(exc)
            assert sources == [], f"fallback fact {i} raised but left {sources}"


def test_duplicate_anchors_are_merged_and_the_constraint_keeps_them_one(monkeypatch):
    """Anchors a burst duplicated before the constraint existed: start-up merges them
    into one, moves each fact edge once, and creates the constraint."""

    async def scenario():
        raw = AsyncGraphDatabase.driver(URI, auth=None)
        monkeypatch.setattr(graphiti_client, "get_driver", lambda: raw)
        monkeypatch.setattr(settings, "neo4j_database", "neo4j")
        anchor = graphiti_client._fallback_anchor_uuid(GROUP)
        try:
            await raw.execute_query("MATCH (n) DETACH DELETE n", database_="neo4j")
            await raw.execute_query(
                "DROP CONSTRAINT fallback_anchor_uuid IF EXISTS", database_="neo4j"
            )
            # A copy an episode mentions, a relationship the merge does not move. Created
            # first, so it has the lowest element id: the copy kept must not be chosen by id.
            await raw.execute_query(
                """
                CREATE (:Episodic {uuid: 'episode-x', group_id: $gid})-[:MENTIONS]->
                       (:Entity:Category {uuid: 'not-yet', group_id: $gid, name: 'Uncategorized Fact'})
                """,
                gid=GROUP,
                database_="neo4j",
            )
            # Three more copies. Fact one was linked to each of them by one MERGE (the same
            # edge uuid on each); fact two only to the last.
            await raw.execute_query(
                """
                UNWIND range(1, 3) AS copy
                CREATE (:Entity:Category {uuid: $anchor, group_id: $gid, name: 'Uncategorized Fact'})
                WITH 1 AS one LIMIT 1
                CREATE (one_fact:Entity:Fact {uuid: 'fact-1', group_id: $gid}),
                       (two_fact:Entity:Fact {uuid: 'fact-2', group_id: $gid})
                WITH one_fact, two_fact
                MATCH (a:Category {uuid: $anchor})
                WITH one_fact, two_fact, collect(a) AS copies
                FOREACH (a IN copies | CREATE (one_fact)-[:RELATES_TO {uuid: 'edge-1', fact: 'one'}]->(a))
                WITH two_fact, copies[2] AS third
                CREATE (two_fact)-[:RELATES_TO {uuid: 'edge-2', fact: 'two'}]->(third)
                """,
                anchor=anchor,
                gid=GROUP,
                database_="neo4j",
            )
            await raw.execute_query(
                "MATCH (a:Category {uuid: 'not-yet'}) SET a.uuid = $anchor",
                anchor=anchor,
                database_="neo4j",
            )
            removed = await graphiti_client.ensure_one_fallback_anchor_per_scope()
            edges, _, _ = await raw.execute_query(
                "MATCH (f:Fact)-[r:RELATES_TO]->(a:Category) RETURN f.uuid AS fact, r.uuid AS edge, r.fact AS text, a.uuid AS anchor",
                database_="neo4j",
            )
            anchors, _, _ = await raw.execute_query(
                "MATCH (a:Category {uuid: $anchor}) RETURN count(a) AS n",
                anchor=anchor,
                database_="neo4j",
            )
            mentioned, _, _ = await raw.execute_query(
                "MATCH (:Episodic {uuid: 'episode-x'})-[:MENTIONS]->(a:Category) RETURN a.uuid AS uuid",
                database_="neo4j",
            )
            assert (
                len(mentioned) == 1 and mentioned[0]["uuid"] != anchor
            ), "the mentioned copy kept its edge under its own uuid"
            # The constraint now refuses a second anchor with this uuid.
            with pytest.raises(Exception, match="already exists"):
                await raw.execute_query(
                    "CREATE (:Entity:Category {uuid: $anchor, group_id: $gid})",
                    anchor=anchor,
                    gid=GROUP,
                    database_="neo4j",
                )
            return (
                removed,
                sorted((e["fact"], e["edge"], e["text"], e["anchor"]) for e in edges),
                anchors[0]["n"],
            )
        finally:
            await raw.close()

    removed, edges, anchors = asyncio.run(scenario())
    assert removed == 2
    assert anchors == 1
    anchor = graphiti_client._fallback_anchor_uuid(GROUP)
    assert edges == [("fact-1", "edge-1", "one", anchor), ("fact-2", "edge-2", "two", anchor)]


@pytest.mark.parametrize("entity_uuids", [ENTITIES[:2], []], ids=["linked to entities", "own node"])
def test_a_rerun_after_the_commit_landed_stores_the_fact_once(monkeypatch, entity_uuids):
    """`_run_with_retry` runs the write again when the connection drops, and the drop can
    come after the commit landed. The second run must find what the first stored."""

    async def twice(fn, **session_config):
        await original(fn, **session_config)
        return await original(fn, **session_config)

    async def scenario():
        raw = AsyncGraphDatabase.driver(URI, auth=None)
        graph = Neo4jDriver(uri=URI, user=None, password=None)
        monkeypatch.setattr(graphiti_client, "get_graphiti", _graphiti)
        monkeypatch.setattr(graphiti_client, "get_driver", lambda: raw)
        monkeypatch.setattr(settings, "neo4j_database", "neo4j")
        try:
            await raw.execute_query("MATCH (n) DETACH DELETE n", database_="neo4j")
            for u in ENTITIES:
                await EntityNode(
                    uuid=u,
                    name=u,
                    group_id=GROUP,
                    labels=["Company"],
                    summary="",
                    created_at=NOW,
                    name_embedding=EMBEDDING,
                ).save(graph)
            monkeypatch.setattr(graphiti_client, "_run_with_retry", twice)
            await graphiti_client.ensure_graph_visible(
                GROUP, "stored once", NOW, "episode-once", entity_uuids=entity_uuids
            )
            records, _, _ = await raw.execute_query(
                """
                MATCH (source)-[r:RELATES_TO {fact: 'stored once'}]->(:Category)
                RETURN source.uuid AS source, labels(source) AS labels
                """,
                database_="neo4j",
            )
            return [(r["source"], "Fact" in r["labels"]) for r in records]
        finally:
            await graph.close()
            await raw.close()

    original = graphiti_client._run_with_retry
    stored = asyncio.run(scenario())
    if entity_uuids:
        assert sorted(stored) == [(u, False) for u in entity_uuids]
    else:
        assert len(stored) == 1 and stored[0][1], stored


def test_an_attempt_stuck_on_a_lock_ends_at_its_timeout_and_raises(monkeypatch):
    """A lock another transaction never lets go of must not hold the write past its
    attempt timeout: the ingest is answered, and nothing of the fact is stored."""
    monkeypatch.setattr(visibility, "VISIBILITY_ATTEMPT_TIMEOUT_S", 1.0)

    async def scenario():
        raw = AsyncGraphDatabase.driver(URI, auth=None)
        monkeypatch.setattr(graphiti_client, "get_graphiti", _graphiti)
        monkeypatch.setattr(graphiti_client, "get_driver", lambda: raw)
        monkeypatch.setattr(settings, "neo4j_database", "neo4j")
        anchor = graphiti_client._fallback_anchor_uuid(GROUP)
        try:
            await raw.execute_query("MATCH (n) DETACH DELETE n", database_="neo4j")
            await raw.execute_query(
                "CREATE (:Entity:Category {uuid: $anchor, group_id: $gid})",
                anchor=anchor,
                gid=GROUP,
                database_="neo4j",
            )
            async with raw.session(database="neo4j") as holder:
                tx = await holder.begin_transaction()
                await (
                    await tx.run(
                        "MATCH (a:Category {uuid: $anchor}) SET a.held = true", anchor=anchor
                    )
                ).consume()
                started = time.monotonic()
                with pytest.raises(graphiti_client.GraphVisibilityError):
                    await graphiti_client.ensure_graph_visible(
                        GROUP, "waits on a held lock", NOW, "episode-held"
                    )
                waited = time.monotonic() - started
                await tx.rollback()
            stored, _, _ = await raw.execute_query(
                "MATCH ()-[r:RELATES_TO {fact: 'waits on a held lock'}]->() RETURN count(r) AS n",
                database_="neo4j",
            )
            return waited, stored[0]["n"]
        finally:
            await raw.close()

    waited, stored = asyncio.run(scenario())
    # Ended by the 1 s attempt timeout, not by the 10 s retry budget or the lock's release.
    assert waited < graphiti_client.VISIBILITY_RETRY_SECONDS
    assert stored == 0


def test_a_hundred_fallback_writes_at_once_into_one_scope_all_store(monkeypatch):
    """Fallback writes alone deadlock each other on the anchor once it has many edges:
    run all at once, about half of a hundred ran out of retries. One at a time per
    scope, every one stores."""
    entities = ENTITIES[:4]
    picks = random.Random(3)
    # Three of the four entities each, in different orders, so the writes' locks cross.
    plans = [picks.sample(entities, 3) for _ in range(100)]

    async def scenario():
        raw = AsyncGraphDatabase.driver(URI, auth=None)
        graph = Neo4jDriver(uri=URI, user=None, password=None)
        monkeypatch.setattr(graphiti_client, "get_graphiti", _graphiti)
        monkeypatch.setattr(graphiti_client, "get_driver", lambda: raw)
        monkeypatch.setattr(settings, "neo4j_database", "neo4j")
        try:
            await raw.execute_query("MATCH (n) DETACH DELETE n", database_="neo4j")
            await graphiti_client.ensure_one_fallback_anchor_per_scope()
            for u in entities:
                await EntityNode(
                    uuid=u,
                    name=u,
                    group_id=GROUP,
                    labels=["Company"],
                    summary="",
                    created_at=NOW,
                    name_embedding=EMBEDDING,
                ).save(graph)

            async def write(i):
                try:
                    await graphiti_client.ensure_graph_visible(
                        GROUP,
                        f"own fact {i}",
                        NOW,
                        f"episode-{i}",
                        entity_uuids=plans[i],
                    )
                except graphiti_client.GraphVisibilityError as exc:
                    return exc
                return None

            outcomes = await asyncio.gather(*(write(i) for i in range(100)))
            stored, _, _ = await raw.execute_query(
                "MATCH (:Entity {group_id: $gid})-[r:RELATES_TO]->(:Category) WHERE r.fact STARTS WITH 'own fact' RETURN count(r) AS n",
                gid=GROUP,
                database_="neo4j",
            )
            return [o for o in outcomes if o is not None], stored[0]["n"]
        finally:
            await graph.close()
            await raw.close()

    failed, stored = asyncio.run(scenario())
    assert failed == []
    assert stored == 100 * 3
