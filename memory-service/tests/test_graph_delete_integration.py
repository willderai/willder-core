"""Real HTTP -> deletion function -> Cypher, using ONLY a disposable local Neo4j.

NEO4J_DELETE_TEST_URI=bolt://127.0.0.1:17687 python -m pytest tests/test_graph_delete_integration.py
The test database is cleared between cases; no model calls or production credentials.
"""

import asyncio
import os
from urllib.parse import urlparse

import httpx
import pytest
from neo4j import AsyncGraphDatabase

from app import graphiti_client, main
from app.config import settings
from conftest import API_KEY

URI = os.getenv("NEO4J_DELETE_TEST_URI")
pytestmark = pytest.mark.skipif(not URI, reason="requires disposable local Neo4j")
ALLOWED = "org_a-deal_a"


async def exercise(
    monkeypatch,
    kind,
    target_group,
    neighbor_group=None,
    edge_group=None,
    metadata=False,
    missing=False,
    authorized=True,
    isolated=False,
    request_group=ALLOWED,
):
    parsed = urlparse(URI)
    assert parsed.scheme == "bolt" and parsed.hostname == "127.0.0.1" and parsed.port == 17687
    driver = AsyncGraphDatabase.driver(URI, auth=None)

    async def initialized():
        pass

    monkeypatch.setattr(graphiti_client, "get_graphiti", initialized)
    monkeypatch.setattr(graphiti_client, "get_driver", lambda: driver)
    monkeypatch.setattr(settings, "neo4j_database", "neo4j")
    try:
        async with driver.session(database="neo4j") as session:
            await (await session.run("MATCH (n) DETACH DELETE n")).consume()
            neighbor_label = "Episodic" if metadata else "Entity"
            await (
                await session.run(
                    'CREATE (:Entity {uuid:"target", group_id:$group}), '
                    f'(:{neighbor_label} {{uuid:"neighbor", group_id:$neighbor}})',
                    group=target_group,
                    neighbor=neighbor_group,
                )
            ).consume()
            if not isolated:
                rel = "MENTIONS" if metadata else "RELATES_TO"
                source, target = ("b", "a") if metadata else ("a", "b")
                await (
                    await session.run(
                        'MATCH (a {uuid:"target"}), (b {uuid:"neighbor"}) '
                        f'CREATE ({source})-[:{rel} {{uuid:"fact", group_id:$edge}}]->({target})',
                        edge=edge_group,
                    )
                ).consume()
            before = await snapshot(session)
            target = "missing" if missing else ("target" if kind == "entities" else "fact")
            headers = {"Authorization": f"Bearer {API_KEY}"} if authorized else {}
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=main.app), base_url="http://test"
            ) as client:
                response = await client.delete(
                    f"/{kind}/{target}", params={"group_id": request_group}, headers=headers
                )
            after = await snapshot(session)
            return response, before, after
    finally:
        await driver.close()


async def snapshot(session):
    nodes = await (
        await session.run("MATCH (n) RETURN n.uuid AS uuid, n.group_id AS gid ORDER BY uuid")
    ).data()
    edges = await (
        await session.run(
            "MATCH (a)-[r]->(b) RETURN r.uuid AS uuid, r.group_id AS gid, "
            "a.uuid AS source, b.uuid AS target ORDER BY uuid"
        )
    ).data()
    return nodes, edges


@pytest.mark.parametrize("kind", ["entities", "facts"])
@pytest.mark.parametrize("group", ["org_a-deal_b", "org_b-deal_a", "org_a-deal_ab", "org_a", None])
def test_outside_partition_is_404_and_leaves_graph_unchanged(monkeypatch, kind, group):
    response, before, after = asyncio.run(exercise(monkeypatch, kind, group, group, group))
    assert response.status_code == 404
    assert after == before


@pytest.mark.parametrize("kind", ["entities", "facts"])
@pytest.mark.parametrize("group", [ALLOWED, "legacy_bare_org"])
def test_allowed_delete_changes_only_target(monkeypatch, kind, group):
    response, before, after = asyncio.run(
        exercise(monkeypatch, kind, group, group, group, request_group=group)
    )
    assert response.status_code == 200
    assert response.json() == {"removed": True}
    expected_nodes = [n for n in before[0] if kind == "facts" or n["uuid"] != "target"]
    assert after == (expected_nodes, [])


@pytest.mark.parametrize("kind", ["entities", "facts"])
@pytest.mark.parametrize(
    "neighbor,edge",
    [
        ("org_b-deal_a", ALLOWED),
        (None, ALLOWED),
        (ALLOWED, "org_b-deal_a"),
        (ALLOWED, None),
    ],
)
def test_mixed_or_unknown_relationship_partition_is_preserved(monkeypatch, kind, neighbor, edge):
    response, before, after = asyncio.run(exercise(monkeypatch, kind, ALLOWED, neighbor, edge))
    assert response.status_code == 404
    assert after == before


def test_same_partition_metadata_edge_without_group_is_allowed(monkeypatch):
    response, before, after = asyncio.run(
        exercise(monkeypatch, "entities", ALLOWED, ALLOWED, metadata=True)
    )
    assert response.status_code == 200
    assert after == ([n for n in before[0] if n["uuid"] != "target"], [])


@pytest.mark.parametrize("kind", ["entities", "facts"])
def test_missing_target_is_404(monkeypatch, kind):
    response, before, after = asyncio.run(
        exercise(monkeypatch, kind, ALLOWED, ALLOWED, ALLOWED, missing=True)
    )
    assert response.status_code == 404
    assert after == before


@pytest.mark.parametrize("kind", ["entities", "facts"])
def test_service_auth_still_required(monkeypatch, kind):
    response, before, after = asyncio.run(
        exercise(monkeypatch, kind, ALLOWED, ALLOWED, ALLOWED, authorized=False)
    )
    assert response.status_code == 401
    assert after == before


def test_allowed_isolated_entity_can_be_deleted(monkeypatch):
    response, before, after = asyncio.run(exercise(monkeypatch, "entities", ALLOWED, isolated=True))
    assert response.status_code == 200
    assert after == ([n for n in before[0] if n["uuid"] != "target"], [])


@pytest.mark.parametrize("neighbor", ["org_b-deal_a", None])
def test_metadata_cannot_cascade_outside_partition(monkeypatch, neighbor):
    response, before, after = asyncio.run(
        exercise(monkeypatch, "entities", ALLOWED, neighbor, metadata=True)
    )
    assert response.status_code == 404
    assert after == before


@pytest.mark.parametrize("group", ["org_a-deal_b", "org_b-deal_a"])
def test_foreign_isolated_entity_cannot_bypass_target_binding(monkeypatch, group):
    response, before, after = asyncio.run(exercise(monkeypatch, "entities", group, isolated=True))
    assert response.status_code == 404
    assert after == before


def test_fact_source_partition_is_checked_independently(monkeypatch):
    response, before, after = asyncio.run(
        exercise(monkeypatch, "facts", "org_b-deal_a", ALLOWED, ALLOWED)
    )
    assert response.status_code == 404
    assert after == before
