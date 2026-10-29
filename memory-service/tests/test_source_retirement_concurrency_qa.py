"""Six sources in one scope disconnected at once, on a disposable local Neo4j.

NEO4J_DELETE_TEST_URI=bolt://127.0.0.1:17687 python -m pytest tests/test_source_retirement_concurrency_qa.py

The concurrent load class for bar 2 of docs/consent-deletion-suite.md: six
DELETE /groups/{group_id}?source_id= calls sent together through the real
FastAPI route and the real Cypher, against one scope where every source mentions
the same entity. Each run reseeds and is repeated, because an interleaving that
loses a delete may not happen on the first try. A bystander source in the same
scope must come through exactly as it was.
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

GROUP = "org_a-support"
SOURCES = [f"src_{i}" for i in range(6)]
BYSTANDER = "src_keep"
REPEATS = 5


def _stamp(source_id: str) -> str:
    return json.dumps({"actor_type": "extraction", "source_id": source_id})


def _marker(source_id: str) -> str:
    return f"only {source_id} said this"


async def _seed(session, with_bystander: bool) -> None:
    await (await session.run("MATCH (n) DETACH DELETE n")).consume()
    await (
        await session.run(
            "CREATE (:Entity {uuid: 'hub', group_id: $g, name: 'Dana', summary: 'Dana, per every source.'})"
            " CREATE (:Entity:Category {uuid: 'anchor', group_id: $g, name: 'Uncategorized Fact'})",
            g=GROUP,
        )
    ).consume()
    sources = SOURCES + ([BYSTANDER] if with_bystander else [])
    for source in sources:
        marker = _marker(source)
        await (
            await session.run(
                """
            MATCH (hub {uuid: 'hub'}), (anchor {uuid: 'anchor'})
            CREATE (ep:Episodic {uuid: 'ep-' + $s, group_id: $g, content: $m, source_description: $stamp})
            CREATE (own:Entity {uuid: 'own-' + $s, group_id: $g, name: 'Own ' + $s, summary: $m})
            CREATE (p:Entity:Passage {uuid: 'passage-' + $s, group_id: $g, name: 'passage', summary: $m})
            CREATE (ep)-[:MENTIONS {uuid: 'm-hub-' + $s, group_id: $g}]->(hub)
            CREATE (ep)-[:MENTIONS {uuid: 'm-own-' + $s, group_id: $g}]->(own)
            CREATE (own)-[:RELATES_TO {uuid: 'f-' + $s, group_id: $g, fact: $m, episodes: ['ep-' + $s]}]->(hub)
            CREATE (p)-[:RELATES_TO {uuid: 'v-' + $s, group_id: $g, fact: $m, source_description: $stamp}]->(anchor)
            """,
                s=source,
                g=GROUP,
                m=marker,
                stamp=_stamp(source),
            )
        ).consume()


async def _snapshot(session) -> tuple[dict, dict]:
    nodes = await (
        await session.run("MATCH (n) RETURN n.uuid AS uuid, properties(n) AS props")
    ).data()
    edges = await (
        await session.run("MATCH ()-[r]->() RETURN r.uuid AS uuid, properties(r) AS props")
    ).data()
    return {n["uuid"]: n["props"] for n in nodes}, {e["uuid"]: e["props"] for e in edges}


async def _disconnect_six(monkeypatch, with_bystander: bool, together: bool = True):
    """Seed, send the six disconnects together (or one after another), and
    return the responses with the graph before and after."""
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
            await _seed(session, with_bystander)
            before = await _snapshot(session)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=main.app), base_url="http://test"
        ) as client:

            def disconnect(source):
                return client.delete(
                    f"/groups/{GROUP}",
                    params={"source_id": source},
                    headers={"Authorization": f"Bearer {API_KEY}"},
                )

            if together:
                responses = await asyncio.gather(*(disconnect(source) for source in SOURCES))
            else:
                responses = [await disconnect(source) for source in SOURCES]
        async with driver.session(database="neo4j") as session:
            after = await _snapshot(session)
        return responses, before, after
    finally:
        await driver.close()


def _leaks(nodes: dict, edges: dict) -> list[str]:
    """Every node or edge still carrying text only a disconnected source wrote."""
    markers = [_marker(s) for s in SOURCES]
    return [
        uuid
        for uuid, props in {**nodes, **edges}.items()
        if any(m in str(v) for m in markers for v in props.values())
    ]


@pytest.mark.parametrize("attempt", range(REPEATS))
def test_six_concurrent_disconnects_each_retire_their_source(monkeypatch, attempt):
    responses, (nodes_before, edges_before), (nodes, edges) = asyncio.run(
        _disconnect_six(monkeypatch, with_bystander=True)
    )

    assert [r.status_code for r in responses] == [200] * len(SOURCES), [r.text for r in responses]
    assert sum(r.json()["removed_episodes"] for r in responses) == len(SOURCES)
    assert _leaks(nodes, edges) == []
    for source in SOURCES:
        assert {f"ep-{source}", f"own-{source}", f"passage-{source}"}.isdisjoint(nodes)
    # The bystander's own records are exactly as they were, and the entity it
    # still mentions is kept, without the summary the disconnected sources wrote.
    kept = [u for u in nodes_before if u.endswith(BYSTANDER)]
    assert {u: nodes[u] for u in kept} == {u: nodes_before[u] for u in kept}
    kept_edges = [u for u in edges_before if u.endswith(BYSTANDER)]
    assert {u: edges[u] for u in kept_edges} == {u: edges_before[u] for u in kept_edges}
    assert nodes["hub"]["summary"] == ""


@pytest.mark.parametrize("attempt", range(REPEATS))
def test_an_entity_only_the_six_mentioned_is_removed_when_all_six_disconnect_at_once(
    monkeypatch, attempt
):
    # Disconnected one after another, the last disconnect finds the shared
    # entity with no relationship left and removes it. Sent together, each
    # transaction may still see another source's mention; the bar is the same.
    responses, _before, (nodes, edges) = asyncio.run(
        _disconnect_six(monkeypatch, with_bystander=False)
    )

    assert [r.status_code for r in responses] == [200] * len(SOURCES), [r.text for r in responses]
    assert _leaks(nodes, edges) == []
    assert (
        "hub" not in nodes
    ), f"entity named {nodes['hub'].get('name')!r} outlived every source that mentioned it"


def test_control_one_after_another_the_last_disconnect_removes_the_shared_entity(monkeypatch):
    responses, _before, (nodes, edges) = asyncio.run(
        _disconnect_six(monkeypatch, with_bystander=False, together=False)
    )

    assert [r.status_code for r in responses] == [200] * len(SOURCES)
    assert _leaks(nodes, edges) == []
    assert "hub" not in nodes
