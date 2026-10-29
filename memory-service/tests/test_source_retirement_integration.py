"""Disconnecting one source retires everything it left in the graph, on a disposable local Neo4j.

NEO4J_DELETE_TEST_URI=bolt://127.0.0.1:17687 python -m pytest tests/test_source_retirement_integration.py

Bar 2 of docs/consent-deletion-suite.md: after a disconnect, nothing traceable to
the source is retrievable — not its facts only, but its episodes (the raw body),
its verbatim Fact/Passage nodes, and the entity summaries that quote it. Drives
the real FastAPI route and the real Cypher. The fixture puts the source's content
next to a second source in the same scope and the same source id in another
tenant's scope; everything that is not this source's must be exactly as it was.
The database is cleared before each case; no model calls or production credentials.
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
FOREIGN_GROUP = "org_b-support"
SOURCE = "src_gh"
OTHER_SOURCE = "src_slack"
# Text only the disconnected source ever wrote.
MARKER = "renewal at risk"


def _stamp(source_id: str | None) -> str:
    return json.dumps({"actor_type": "extraction", "source_id": source_id})


# (labels, uuid, group_id, properties)
NODES = [
    # The disconnected source: one episode, the entity only it mentions, and a
    # verbatim passage node.
    (
        "Episodic",
        "ep-gh",
        GROUP,
        {"content": f"Dana says the {MARKER}.", "source_description": _stamp(SOURCE)},
    ),
    ("Entity", "dana", GROUP, {"name": "Dana", "summary": f"Dana reports the {MARKER}."}),
    ("Entity:Passage", "passage-gh", GROUP, {"name": "passage", "summary": f"Q3: {MARKER}."}),
    # Shared with the other source: mentioned by both episodes.
    ("Entity", "acme", GROUP, {"name": "Acme", "summary": f"Customer; {MARKER}."}),
    # The other source in the same scope.
    (
        "Episodic",
        "ep-slack",
        GROUP,
        {"content": "Acme renewed the seats.", "source_description": _stamp(OTHER_SOURCE)},
    ),
    ("Entity", "beta", GROUP, {"name": "Beta", "summary": "Partner of Acme."}),
    ("Entity:Fact", "fact-slack", GROUP, {"name": "fact", "summary": "Acme renewed the seats."}),
    # A source whose id merely starts with the disconnected one's.
    (
        "Episodic",
        "ep-gh2",
        GROUP,
        {"content": "Beta signed.", "source_description": _stamp(SOURCE + "2")},
    ),
    # The verbatim anchor every fallback fact in a scope links to.
    ("Entity:Category", "anchor", GROUP, {"name": "Uncategorized Fact"}),
    # The same source id in another tenant's scope.
    (
        "Episodic",
        "ep-foreign",
        FOREIGN_GROUP,
        {"content": f"Foreign {MARKER}.", "source_description": _stamp(SOURCE)},
    ),
    ("Entity", "foreign-entity", FOREIGN_GROUP, {"name": "Dana", "summary": f"Foreign {MARKER}."}),
]

# (type, uuid, from, to, group_id, properties)
EDGES = [
    ("MENTIONS", "m-gh-dana", "ep-gh", "dana", GROUP, {}),
    ("MENTIONS", "m-gh-acme", "ep-gh", "acme", GROUP, {}),
    ("MENTIONS", "m-slack-acme", "ep-slack", "acme", GROUP, {}),
    ("MENTIONS", "m-slack-beta", "ep-slack", "beta", GROUP, {}),
    # Extracted facts carry only `episodes`; the first is the creator.
    (
        "RELATES_TO",
        "f-gh",
        "dana",
        "acme",
        GROUP,
        {"fact": f"Dana: {MARKER}", "episodes": ["ep-gh"]},
    ),
    (
        "RELATES_TO",
        "f-slack",
        "acme",
        "beta",
        GROUP,
        {"fact": "Acme partners with Beta", "episodes": ["ep-slack", "ep-gh"]},
    ),
    # Verbatim edges carry their own stamp.
    (
        "RELATES_TO",
        "v-gh",
        "passage-gh",
        "anchor",
        GROUP,
        {"fact": f"Q3: {MARKER}.", "source_description": _stamp(SOURCE)},
    ),
    (
        "RELATES_TO",
        "v-slack",
        "fact-slack",
        "anchor",
        GROUP,
        {"fact": "Acme renewed the seats.", "source_description": _stamp(OTHER_SOURCE)},
    ),
    ("MENTIONS", "m-foreign", "ep-foreign", "foreign-entity", FOREIGN_GROUP, {}),
    # A link that should not exist, from this source's episode into another
    # tenant. The episode's own link goes with it; the foreign entity is not
    # this partition's to clear or delete.
    ("MENTIONS", "m-gh-foreign", "ep-gh", "foreign-entity", None, {}),
]

GONE_NODES = {"ep-gh", "dana", "passage-gh"}
GONE_EDGES = {"m-gh-dana", "m-gh-acme", "m-gh-foreign", "f-gh", "v-gh"}


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


async def _disconnect(monkeypatch, calls: int = 1):
    """Seed, call DELETE /groups/{GROUP}?source_id={SOURCE} `calls` times, and
    return each response body with the graph before and after."""
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
            bodies = []
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=main.app), base_url="http://test"
            ) as client:
                for _ in range(calls):
                    response = await client.delete(
                        f"/groups/{GROUP}",
                        params={"source_id": SOURCE},
                        headers={"Authorization": f"Bearer {API_KEY}"},
                    )
                    assert response.status_code == 200, response.text
                    bodies.append(response.json())
            after = await _snapshot(session)
            return bodies, before, after
    finally:
        await driver.close()


def test_disconnect_removes_episodes_verbatim_nodes_and_quoting_summaries(monkeypatch):
    [body], _before, (nodes, edges) = asyncio.run(_disconnect(monkeypatch))

    assert body == {
        "removed_count": 2,  # f-gh and v-gh
        "removed_episodes": 1,  # ep-gh
        "removed_verbatim_nodes": 1,  # passage-gh
        "removed_entities": 1,  # dana: nothing else linked to it
        "cleared_summaries": 2,  # dana and acme quoted the source
    }
    assert GONE_NODES.isdisjoint(nodes)
    assert GONE_EDGES.isdisjoint(edges)
    # Nothing left in the scope says what only this source said.
    in_scope = [props for props in nodes.values() if props.get("group_id") == GROUP]
    in_scope += [e["props"] for e in edges.values() if e["props"].get("group_id") == GROUP]
    assert not [p for p in in_scope if any(MARKER in str(v) for v in p.values())]


def test_disconnect_keeps_the_other_source_and_other_tenant_exactly(monkeypatch):
    [_body], (nodes_before, edges_before), (nodes, edges) = asyncio.run(_disconnect(monkeypatch))

    # A shared entity stays, without the summary that quoted the source.
    assert nodes["acme"] == {**nodes_before["acme"], "summary": ""}
    # A fact another source created only loses this source's episode.
    assert edges["f-slack"]["props"]["episodes"] == ["ep-slack"]
    untouched_nodes = set(nodes_before) - GONE_NODES - {"acme"}
    untouched_edges = set(edges_before) - GONE_EDGES - {"f-slack"}
    assert {u: nodes[u] for u in untouched_nodes} == {u: nodes_before[u] for u in untouched_nodes}
    assert {u: edges[u] for u in untouched_edges} == {u: edges_before[u] for u in untouched_edges}


def test_a_second_disconnect_removes_nothing(monkeypatch):
    bodies, _before, _after = asyncio.run(_disconnect(monkeypatch, calls=2))

    assert bodies[1] == {
        "removed_count": 0,
        "removed_episodes": 0,
        "removed_verbatim_nodes": 0,
        "removed_entities": 0,
        "cleared_summaries": 0,
    }
