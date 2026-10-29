"""Probes for a source-scoped disconnect, on a disposable local Neo4j.

NEO4J_DELETE_TEST_URI=bolt://127.0.0.1:17687 python -m pytest tests/test_source_retirement_qa_probes.py

Complements test_source_retirement_integration.py with the cases its fixture
does not hold: a source id that is a prefix of another source's id, an entity
this source mentioned that another source's fact still links to, a verbatim
node of another source, an unparseable legacy episode stamp, and a disconnect
of a source that never wrote anything.
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


def _stamp(source_id: str | None) -> str:
    return json.dumps({"actor_type": "extraction", "source_id": source_id})


NODES = [
    # Disconnected source "src_g": one episode, one verbatim decision.
    (
        "Episodic",
        "ep-g",
        GROUP,
        {"content": "Kai approved the budget.", "source_description": _stamp("src_g")},
    ),
    ("Entity", "kai", GROUP, {"name": "Kai", "summary": "Kai approved the budget."}),
    ("Entity:Decision", "decision-g", GROUP, {"name": "decision", "summary": "Budget approved."}),
    # Another source whose id has the disconnected id as a prefix.
    (
        "Episodic",
        "ep-gh",
        GROUP,
        {"content": "Kai joined Acme.", "source_description": _stamp("src_gh")},
    ),
    ("Entity", "acme", GROUP, {"name": "Acme", "summary": "Kai's employer."}),
    ("Entity:Fact", "fact-gh", GROUP, {"name": "fact", "summary": "Kai joined Acme."}),
    # A legacy episode with an unparseable stamp that names the source id.
    (
        "Episodic",
        "ep-legacy",
        GROUP,
        {"content": "legacy src_g text", "source_description": "src_g legacy"},
    ),
    ("Entity:Category", "anchor", GROUP, {"name": "Uncategorized Fact"}),
]

EDGES = [
    ("MENTIONS", "m-g-kai", "ep-g", "kai", GROUP, {}),
    ("MENTIONS", "m-gh-acme", "ep-gh", "acme", GROUP, {}),
    # Created by src_gh, between an entity only src_g mentioned and acme.
    (
        "RELATES_TO",
        "f-gh",
        "kai",
        "acme",
        GROUP,
        {"fact": "Kai works at Acme", "episodes": ["ep-gh"]},
    ),
    (
        "RELATES_TO",
        "v-g",
        "decision-g",
        "anchor",
        GROUP,
        {"fact": "Budget approved.", "source_description": _stamp("src_g")},
    ),
    (
        "RELATES_TO",
        "v-gh",
        "fact-gh",
        "anchor",
        GROUP,
        {"fact": "Kai joined Acme.", "source_description": _stamp("src_gh")},
    ),
]


async def _run(monkeypatch, source_id: str, seed: bool = True):
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
            await (await session.run("MATCH (n) DETACH DELETE n")).consume()
            if seed:
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
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=main.app), base_url="http://test"
            ) as client:
                response = await client.delete(
                    f"/groups/{GROUP}",
                    params={"source_id": source_id},
                    headers={"Authorization": f"Bearer {API_KEY}"},
                )
            nodes = await (
                await session.run("MATCH (n) RETURN n.uuid AS uuid, properties(n) AS props")
            ).data()
            edges = await (await session.run("MATCH ()-[r]->() RETURN r.uuid AS uuid")).data()
            return response, {n["uuid"]: n["props"] for n in nodes}, {e["uuid"] for e in edges}
    finally:
        await driver.close()


def test_prefix_source_id_retires_only_its_own_records(monkeypatch):
    response, nodes, edges = asyncio.run(_run(monkeypatch, "src_g"))

    assert response.status_code == 200, response.text
    assert response.json() == {
        "removed_count": 1,
        "removed_episodes": 1,
        "removed_verbatim_nodes": 1,
        "removed_entities": 0,
        "cleared_summaries": 1,
    }
    assert {"ep-g", "decision-g"}.isdisjoint(nodes)
    assert {"m-g-kai", "v-g"}.isdisjoint(edges)
    # src_gh's episode, verbatim node and fact are untouched.
    assert {"ep-gh", "fact-gh", "acme"} <= set(nodes)
    assert {"f-gh", "v-gh", "m-gh-acme"} <= edges
    # Kai stays: src_gh's fact still links to it. Its summary quoted src_g.
    assert nodes["kai"]["summary"] == ""
    assert nodes["kai"]["name"] == "Kai"
    # An unparseable legacy stamp is never treated as this source's.
    assert nodes["ep-legacy"]["content"] == "legacy src_g text"


def test_unknown_source_changes_nothing(monkeypatch):
    response, nodes, edges = asyncio.run(_run(monkeypatch, "src_none"))

    assert response.status_code == 200
    assert response.json() == {
        "removed_count": 0,
        "removed_episodes": 0,
        "removed_verbatim_nodes": 0,
        "removed_entities": 0,
        "cleared_summaries": 0,
    }
    assert set(nodes) == {n[1] for n in NODES}
    assert nodes["kai"]["summary"] == "Kai approved the budget."
    assert edges == {e[1] for e in EDGES}


def test_source_id_with_cypher_metacharacters_is_inert(monkeypatch):
    response, nodes, edges = asyncio.run(_run(monkeypatch, "x' OR 1=1 //"))

    assert response.status_code == 200
    assert set(nodes) == {n[1] for n in NODES}
    assert edges == {e[1] for e in EDGES}


def test_empty_graph_is_a_zero_count(monkeypatch):
    response, nodes, edges = asyncio.run(_run(monkeypatch, "src_g", seed=False))

    assert response.status_code == 200
    assert response.json()["removed_episodes"] == 0
    assert not nodes and not edges
