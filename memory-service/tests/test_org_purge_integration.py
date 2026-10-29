"""POST /orgs/purge and /orgs/residue against real Cypher on a disposable local Neo4j.

NEO4J_DELETE_TEST_URI=bolt://127.0.0.1:17687 python -m pytest tests/test_org_purge_integration.py

An org deletion (the app's services/memory/org-deletion) calls the purge once the seven days
are up and finishes only when the residue count is zero. Each case seeds a graph with
the org being deleted and its neighbours (an org whose id starts with this one's, an
untagged node, another org), purges, and checks both the response and the whole graph
left behind: everything of the org is gone and nothing else changed. Setup and safety
rules match test_graph_delete_integration.py.
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

ORG = "cdel1"

# (labels, uuid, group_id or None)
NODES = [
    ("Entity", "own-bare", ORG),  # the legacy bare-org partition
    ("Entity", "own-root", f"org_{ORG}"),  # the root scope
    ("Entity:Fact", "own-sales", f"org_{ORG}-sales"),  # a scope under it
    ("Episodic", "own-ep", f"org_{ORG}-sales-eu"),  # deeper
    ("Community", "own-comm", f"org_{ORG}"),
    ("Entity", "prefix-root", f"org_{ORG}x"),  # an org whose id starts with this one
    ("Entity", "prefix-scope", f"org_{ORG}x-sales"),
    ("Entity", "prefix-bare", f"{ORG}x"),
    ("Entity", "other-root", "org_cother"),
    ("Entity", "other-under", "org_cother-sales"),
    ("Entity", "untagged", None),
]
# (uuid, start, end, group_id)
EDGES = [
    ("own-f1", "own-root", "own-sales", f"org_{ORG}"),
    ("own-f2", "own-sales", "own-ep", f"org_{ORG}-sales"),
    ("prefix-f", "prefix-root", "prefix-scope", f"org_{ORG}x"),
    ("other-f", "other-root", "other-under", "org_cother"),
    # An edge stamped with this org between two nodes that are not: still the org's.
    ("stray-own", "other-root", "untagged", f"org_{ORG}-sales"),
    # An edge of another org between this org's nodes: goes with the nodes.
    ("cross", "own-bare", "own-root", "org_cother"),
]
KEPT_NODES = {"prefix-root", "prefix-scope", "prefix-bare", "other-root", "other-under", "untagged"}
KEPT_EDGES = {"prefix-f", "other-f"}


async def _call(monkeypatch, path, org_id=ORG, api_key=API_KEY, seed=True):
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
            if seed:
                await (await session.run("MATCH (n) DETACH DELETE n")).consume()
                for labels, uuid, group_id in NODES:
                    await (
                        await session.run(
                            f"CREATE (n:{labels}) SET n.uuid = $uuid, n.name = $uuid, n.group_id = $g",
                            uuid=uuid,
                            g=group_id,
                        )
                    ).consume()
                for uuid, start, end, group_id in EDGES:
                    await (
                        await session.run(
                            "MATCH (a {uuid: $start}), (b {uuid: $end}) "
                            "CREATE (a)-[r:RELATES_TO]->(b) SET r.uuid = $uuid, r.group_id = $g",
                            start=start,
                            end=end,
                            uuid=uuid,
                            g=group_id,
                        )
                    ).consume()
        transport = httpx.ASGITransport(app=main.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                path,
                json={"org_id": org_id},
                headers={"Authorization": f"Bearer {api_key}"},
            )
        async with driver.session(database="neo4j") as session:
            nodes = await (await session.run("MATCH (n) RETURN n.uuid AS u")).values()
            edges = await (await session.run("MATCH ()-[r]->() RETURN r.uuid AS u")).values()
        return response, {u for (u,) in nodes}, {u for (u,) in edges}
    finally:
        await driver.close()


def test_residue_counts_every_partition_of_the_org_and_nothing_else(monkeypatch):
    response, _, _ = asyncio.run(_call(monkeypatch, "/orgs/residue"))
    assert response.status_code == 200, response.text
    # 5 own nodes; 4 edges stamped with the org's partitions (own-f1, own-f2, stray-own,
    # and none other): `cross` carries another org's stamp.
    assert response.json() == {"nodes": 5, "relationships": 3}


def test_purge_removes_the_org_and_leaves_every_other_node_and_edge(monkeypatch):
    response, nodes, edges = asyncio.run(_call(monkeypatch, "/orgs/purge"))
    assert response.status_code == 200, response.text
    assert response.json() == {
        "nodes": 5,
        "relationships": 1,
    }  # stray-own; the rest went with their nodes
    assert nodes == KEPT_NODES
    assert edges == KEPT_EDGES

    residue, _, _ = asyncio.run(_call(monkeypatch, "/orgs/residue", seed=False))
    assert residue.json() == {"nodes": 0, "relationships": 0}


def test_purge_twice_removes_nothing_the_second_time(monkeypatch):
    asyncio.run(_call(monkeypatch, "/orgs/purge"))
    response, nodes, edges = asyncio.run(_call(monkeypatch, "/orgs/purge", seed=False))
    assert response.json() == {"nodes": 0, "relationships": 0}
    assert nodes == KEPT_NODES
    assert edges == KEPT_EDGES


def test_purging_the_prefix_org_does_not_reach_the_shorter_one(monkeypatch):
    response, nodes, _ = asyncio.run(_call(monkeypatch, "/orgs/purge", org_id=f"{ORG}x"))
    assert response.json()["nodes"] == 3
    assert {"own-bare", "own-root", "own-sales", "own-ep", "own-comm"} <= nodes


@pytest.mark.parametrize("org_id", [f"org_{ORG}", "", "a-b", "a.b", "x" * 65, f"{ORG} "])
def test_refuses_anything_but_a_bare_org_id(monkeypatch, org_id):
    response, nodes, _ = asyncio.run(_call(monkeypatch, "/orgs/purge", org_id=org_id))
    assert response.status_code == 422
    assert len(nodes) == len(NODES)


def test_requires_service_authentication(monkeypatch):
    response, nodes, _ = asyncio.run(_call(monkeypatch, "/orgs/purge", api_key="wrong"))
    assert response.status_code == 401
    assert len(nodes) == len(NODES)
