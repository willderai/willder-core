"""Every view that returns fact text reports Graphiti's own retirement of an edge, against a real Neo4j.

NEO4J_PROVENANCE_TEST_URI=bolt://127.0.0.1:17687 python -m pytest tests/test_retired_edges_integration.py

When a newer fact contradicts an older one, Graphiti keeps the older edge and sets
`invalid_at` (when it stopped being true) and `expired_at` (when the graph recorded
that). It sets `expired_at` the moment it records any `invalid_at`, a future one
included. These cases write an edge in force, an invalidated one, one with
`expired_at` alone and one true until a later date, with graphiti-core's own save
methods (no model calls), and read them back through the real GET /entities,
POST /graph and GET /facts/{uuid}/resolve routes and the filter /search applies, so
the queries those run are the ones under test. The test database is cleared before
each case.
"""

import asyncio
import os
from datetime import datetime, timezone
from urllib.parse import urlparse

import httpx
import pytest
from graphiti_core.driver.neo4j_driver import Neo4jDriver
from graphiti_core.edges import EntityEdge
from graphiti_core.nodes import EntityNode
from graphiti_core.search.search_utils import edge_similarity_search
from neo4j import AsyncGraphDatabase

from app import graphiti_client, main
from app.config import settings
from conftest import API_KEY

URI = os.getenv("NEO4J_PROVENANCE_TEST_URI")
pytestmark = pytest.mark.skipif(not URI, reason="requires disposable local Neo4j")

GROUP = "org_a-release"
NOW = datetime(2026, 9, 25, tzinfo=timezone.utc)
INVALID_AT = datetime(2026, 1, 5, tzinfo=timezone.utc)
EXPIRED_AT = datetime(2026, 1, 6, tzinfo=timezone.utc)
ENDS_LATER = datetime(2099, 1, 1, tzinfo=timezone.utc)
# Neo4j's vector procedures refuse a null embedding; the value itself is unused.
EMBEDDING = [0.1] * settings.bge_dim


async def _seed(driver) -> None:
    """One entity with an edge in force, one Graphiti invalidated, one it only expired,
    and one true until a date still ahead."""
    subject = EntityNode(
        uuid="ent-train",
        name="Release train",
        group_id=GROUP,
        created_at=NOW,
        name_embedding=EMBEDDING,
    )
    target = EntityNode(
        uuid="ent-day",
        name="Departure day",
        group_id=GROUP,
        created_at=NOW,
        name_embedding=EMBEDDING,
    )
    for node in (subject, target):
        await node.save(driver)
    for uuid, invalid_at, expired_at in [
        ("e-current", None, None),
        ("e-invalidated", INVALID_AT, EXPIRED_AT),
        ("e-expired", None, EXPIRED_AT),
        ("e-ends-later", ENDS_LATER, EXPIRED_AT),
    ]:
        await EntityEdge(
            uuid=uuid,
            source_node_uuid=subject.uuid,
            target_node_uuid=target.uuid,
            name="RELATES_TO",
            fact=f"fact {uuid}",
            group_id=GROUP,
            episodes=[],
            created_at=NOW,
            valid_at=NOW,
            invalid_at=invalid_at,
            expired_at=expired_at,
            fact_embedding=EMBEDDING,
        ).save(driver)


async def _read(monkeypatch, method: str, path: str, **kwargs) -> dict:
    """Seed the graph, then call one route and return its JSON body."""
    parsed = urlparse(URI)
    assert parsed.scheme == "bolt" and parsed.hostname == "127.0.0.1"
    raw = AsyncGraphDatabase.driver(URI, auth=None)
    graph = Neo4jDriver(uri=URI, user=None, password=None)
    try:
        async with raw.session(database="neo4j") as session:
            await (await session.run("MATCH (n) DETACH DELETE n")).consume()
        await _seed(graph)

        async def graphiti():
            return None

        monkeypatch.setattr(graphiti_client, "get_graphiti", graphiti)
        monkeypatch.setattr(graphiti_client, "_graph_driver", graph)
        monkeypatch.setattr(graphiti_client, "get_driver", lambda: raw)
        monkeypatch.setattr(settings, "neo4j_database", "neo4j")
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=main.app), base_url="http://test"
        ) as client:
            response = await client.request(
                method, path, headers={"Authorization": f"Bearer {API_KEY}"}, **kwargs
            )
        assert response.status_code == 200, response.text
        return response.json()
    finally:
        await graph.close()
        await raw.close()


def _retirement(facts: list[dict]) -> dict[str, tuple[bool, bool]]:
    """Which of Graphiti's two marks each fact carries."""
    return {f["uuid"]: (f["invalid_at"] is not None, f["expired_at"] is not None) for f in facts}


EXPECTED = {
    "e-current": (False, False),
    "e-invalidated": (True, True),
    "e-expired": (False, True),
    "e-ends-later": (True, True),
}


def test_entity_view_reports_each_edges_retirement(monkeypatch):
    body = asyncio.run(_read(monkeypatch, "GET", f"/entities/ent-train?group_id={GROUP}"))

    assert _retirement(body["facts"]) == EXPECTED
    invalidated = next(f for f in body["facts"] if f["uuid"] == "e-invalidated")
    assert invalidated["invalid_at"].startswith("2026-01-05")
    assert invalidated["expired_at"].startswith("2026-01-06")


def test_graph_view_reports_each_edges_retirement(monkeypatch):
    body = asyncio.run(_read(monkeypatch, "POST", "/graph", json={"group_ids": [GROUP]}))

    assert _retirement(body["edges"]) == EXPECTED


def test_resolve_reports_both_retirement_marks(monkeypatch):
    body = asyncio.run(_read(monkeypatch, "GET", f"/facts/e-expired/resolve?group_id={GROUP}"))

    assert body["found"] is True
    assert body["invalid_at"] is None
    assert body["expired_at"].startswith("2026-01-06")


def test_search_filter_leaves_out_only_edges_whose_end_has_passed():
    async def search() -> set[str]:
        graph = Neo4jDriver(uri=URI, user=None, password=None)
        try:
            await graph.execute_query("MATCH (n) DETACH DELETE n")
            await _seed(graph)
            edges = await edge_similarity_search(
                graph,
                EMBEDDING,
                None,
                None,
                graphiti_client._not_yet_ended(),
                [GROUP],
                10,
                min_score=0,
            )
            return {edge.uuid for edge in edges}
        finally:
            await graph.close()

    # The expired-only edge reaches the app, whose own rule leaves it out of an answer.
    assert asyncio.run(search()) == {"e-current", "e-expired", "e-ends-later"}
