"""Deleting one stored fact retires what it left in the graph, on a disposable local Neo4j.

NEO4J_DELETE_TEST_URI=bolt://127.0.0.1:17687 python -m pytest tests/test_chunk_retirement_integration.py

The app deletes a fact by its `memory_chunks` id and then calls DELETE /chunks/{id}
with the scope the chunk was stored in. ingest() stamped that id on the episode it
wrote, so the episode, the facts it created and the nodes only it left are this
fact's. Everything another chunk wrote, in the same scope or under the same id in
another scope, must be exactly as it was. Drives the real FastAPI route and the
real Cypher; the database is cleared before each case; no model calls.
"""

import asyncio
import json
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

GROUP = "org_a-deal"
FOREIGN_GROUP = "org_b-deal"
CHUNK = "chunk_1"
OTHER_CHUNK = "chunk_2"
MARKER = "renewal is due in March"


def _stamp(chunk_id: str) -> str:
    return json.dumps({"actor_type": "human", "chunk_id": chunk_id})


# (labels, uuid, group_id, properties)
NODES = [
    # The deleted fact: its episode, an entity only it mentions, a verbatim node.
    (
        "Episodic",
        "ep-1",
        GROUP,
        {"content": f"Acme {MARKER}.", "source_description": _stamp(CHUNK)},
    ),
    ("Entity", "march", GROUP, {"name": "March", "summary": f"Acme {MARKER}."}),
    ("Entity:Fact", "verbatim-1", GROUP, {"name": "fact", "summary": f"Acme {MARKER}."}),
    # Shared with the other fact in the same scope.
    ("Entity", "acme", GROUP, {"name": "Acme", "summary": f"Customer; {MARKER}."}),
    (
        "Episodic",
        "ep-2",
        GROUP,
        {"content": "Acme pays by invoice.", "source_description": _stamp(OTHER_CHUNK)},
    ),
    ("Entity", "invoice", GROUP, {"name": "Invoice", "summary": "How Acme pays."}),
    # A chunk whose id merely starts with the deleted one's.
    (
        "Episodic",
        "ep-10",
        GROUP,
        {"content": "Acme signed.", "source_description": _stamp(CHUNK + "0")},
    ),
    ("Entity:Category", "anchor", GROUP, {"name": "Uncategorized Fact"}),
    # The same chunk id stamped in another scope.
    (
        "Episodic",
        "ep-foreign",
        FOREIGN_GROUP,
        {"content": f"Foreign {MARKER}.", "source_description": _stamp(CHUNK)},
    ),
    ("Entity", "foreign-entity", FOREIGN_GROUP, {"name": "March", "summary": f"Foreign {MARKER}."}),
]

# (type, uuid, from, to, group_id, properties)
EDGES = [
    ("MENTIONS", "m-1-acme", "ep-1", "acme", GROUP, {}),
    ("MENTIONS", "m-1-march", "ep-1", "march", GROUP, {}),
    ("MENTIONS", "m-2-acme", "ep-2", "acme", GROUP, {}),
    ("MENTIONS", "m-2-invoice", "ep-2", "invoice", GROUP, {}),
    # Extracted facts carry only `episodes`; the first is the creator.
    ("RELATES_TO", "f-1", "acme", "march", GROUP, {"fact": f"Acme {MARKER}", "episodes": ["ep-1"]}),
    (
        "RELATES_TO",
        "f-2",
        "acme",
        "invoice",
        GROUP,
        {"fact": "Acme pays by invoice", "episodes": ["ep-2", "ep-1"]},
    ),
    # A verbatim edge carries its own stamp.
    (
        "RELATES_TO",
        "v-1",
        "verbatim-1",
        "anchor",
        GROUP,
        {"fact": f"Acme {MARKER}.", "source_description": _stamp(CHUNK)},
    ),
    ("MENTIONS", "m-foreign", "ep-foreign", "foreign-entity", FOREIGN_GROUP, {}),
]

GONE_NODES = {"ep-1", "march", "verbatim-1"}
GONE_EDGES = {"m-1-acme", "m-1-march", "f-1", "v-1"}


async def _seed(session) -> None:
    await (await session.run("MATCH (n) DETACH DELETE n")).consume()
    for labels, uuid, group_id, props in NODES:
        await (
            await session.run(
                f"CREATE (n:{labels}) SET n = $props, n.uuid = $uuid, n.group_id = $group_id",
                props=props,
                uuid=uuid,
                group_id=group_id,
            )
        ).consume()
    for rel, uuid, start, end, group_id, props in EDGES:
        await (
            await session.run(
                f"MATCH (a {{uuid: $start}}), (b {{uuid: $end}}) "
                f"CREATE (a)-[r:{rel}]->(b) SET r = $props, r.uuid = $uuid, r.group_id = $group_id",
                start=start,
                end=end,
                props=props,
                uuid=uuid,
                group_id=group_id,
            )
        ).consume()


async def _snapshot(session) -> tuple[dict, dict]:
    nodes = await (
        await session.run("MATCH (n) RETURN n.uuid AS uuid, properties(n) AS props")
    ).data()
    edges = await (
        await session.run(
            "MATCH (a)-[r]->(b) RETURN r.uuid AS uuid, a.uuid AS start, b.uuid AS end, properties(r) AS props"
        )
    ).data()
    return {n["uuid"]: n["props"] for n in nodes}, {e["uuid"]: e for e in edges}


async def _delete_chunk(monkeypatch, chunk_id: str = CHUNK, group_id: str = GROUP, headers=None):
    """Seed, call DELETE /chunks/{chunk_id}?group_id={group_id}, and return the
    response with the graph before and after."""
    parsed = urlparse(URI)
    assert parsed.scheme == "bolt" and parsed.hostname == "127.0.0.1"
    driver = AsyncGraphDatabase.driver(URI, auth=None)

    async def initialized():
        pass

    monkeypatch.setattr(graphiti_client, "get_graphiti", initialized)
    monkeypatch.setattr(graphiti_client, "get_driver", lambda: driver)
    monkeypatch.setattr(settings, "neo4j_database", "neo4j")
    try:
        async with driver.session(database="neo4j") as session:
            await _seed(session)
            before = await _snapshot(session)
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=main.app), base_url="http://test"
            ) as client:
                response = await client.delete(
                    f"/chunks/{chunk_id}",
                    params={"group_id": group_id},
                    headers={"Authorization": f"Bearer {API_KEY}"} if headers is None else headers,
                )
            after = await _snapshot(session)
            return response, before, after
    finally:
        await driver.close()


def test_retires_the_chunks_episode_facts_and_the_nodes_only_it_left(monkeypatch):
    response, (nodes_before, edges_before), (nodes_after, edges_after) = asyncio.run(
        _delete_chunk(monkeypatch)
    )

    assert response.status_code == 200, response.text
    assert response.json() == {
        "removed_count": 2,
        "removed_episodes": 1,
        "removed_verbatim_nodes": 1,
        "removed_entities": 1,
        "cleared_summaries": 2,
        # The episodes it retired, so the app can drop records that point at them.
        "removed_episode_ids": ["ep-1"],
    }
    assert set(nodes_before) - set(nodes_after) == GONE_NODES
    assert set(edges_before) - set(edges_after) == GONE_EDGES


def test_leaves_everything_another_chunk_wrote(monkeypatch):
    _, (nodes_before, edges_before), (nodes_after, edges_after) = asyncio.run(
        _delete_chunk(monkeypatch)
    )

    # The other chunk's fact stays and only stops listing the deleted episode.
    assert edges_after["f-2"]["props"]["episodes"] == ["ep-2"]
    assert edges_after["f-2"]["props"]["fact"] == "Acme pays by invoice"
    # A shared entity stays, with its summary cleared since it quoted the deleted fact.
    assert nodes_after["acme"]["summary"] == ""
    for uuid in set(nodes_after) - {"acme"}:
        assert nodes_after[uuid] == nodes_before[uuid], uuid
    for uuid in set(edges_after) - {"f-2"}:
        assert edges_after[uuid] == edges_before[uuid], uuid
    # The prefix-similar chunk and the same id in another scope are untouched.
    assert {"ep-10", "ep-foreign", "foreign-entity", "m-foreign"} <= set(nodes_after) | set(
        edges_after
    )


def test_unknown_chunk_retires_nothing(monkeypatch):
    response, before, after = asyncio.run(_delete_chunk(monkeypatch, chunk_id="chunk_missing"))

    assert response.status_code == 200
    assert response.json()["removed_count"] == 0
    assert response.json()["removed_episode_ids"] == []
    assert after == before


def test_a_chunk_is_retired_only_in_the_group_named(monkeypatch):
    response, before, after = asyncio.run(_delete_chunk(monkeypatch, group_id="org_a-other"))

    assert response.status_code == 200
    assert after == before


def test_requires_service_authentication(monkeypatch):
    response, before, after = asyncio.run(_delete_chunk(monkeypatch, headers={}))

    assert response.status_code == 401
    assert after == before
