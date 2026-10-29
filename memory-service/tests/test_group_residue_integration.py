"""POST /groups/residue against real Cypher on a disposable local Neo4j.

NEO4J_DELETE_TEST_URI=bolt://127.0.0.1:17687 python -m pytest tests/test_group_residue_integration.py

Scope deletion (services/memory/scope-deletion.ts) refuses while this route
reports any fact or episode in the scope's group. Each case seeds the graph
directly and checks the count the route returns. The fact-shape cases are the
ones a paged `/graph` read with `limit: 1` reports as empty: there the page is
the lowest-uuid entity and its outgoing edges, so a fact whose target sorts
first is not seen. Setup and safety rules match test_graph_delete_integration.py.
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

GROUP = "org_sr-dept_a"
SIBLING = "org_sr-dept_ab"


async def _residue(monkeypatch, nodes=(), edges=(), group=GROUP, api_key=API_KEY):
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
            for labels, uuid, group_id in nodes:
                await (
                    await session.run(
                        f"CREATE (n:{labels}) SET n.uuid = $uuid, n.name = $uuid, n.group_id = $g",
                        uuid=uuid,
                        g=group_id,
                    )
                ).consume()
            for uuid, start, end, group_id in edges:
                await (
                    await session.run(
                        "MATCH (a {uuid: $start}), (b {uuid: $end}) "
                        "CREATE (a)-[r:RELATES_TO]->(b) SET r.uuid = $uuid, r.group_id = $g, r.fact = $uuid",
                        start=start,
                        end=end,
                        uuid=uuid,
                        g=group_id,
                    )
                ).consume()
        transport = httpx.ASGITransport(app=main.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            return await client.post(
                "/groups/residue",
                json={"group_id": group},
                headers={"Authorization": f"Bearer {api_key}"},
            )
    finally:
        await driver.close()


def _counts(monkeypatch, **kwargs) -> dict:
    response = asyncio.run(_residue(monkeypatch, **kwargs))
    assert response.status_code == 200, response.text
    return response.json()


def test_empty_group_counts_nothing(monkeypatch):
    assert _counts(monkeypatch) == {"facts": 0, "episodes": 0}


def test_fact_whose_source_has_the_lower_uuid(monkeypatch):
    counts = _counts(
        monkeypatch,
        nodes=[("Entity", "a-pricing", GROUP), ("Entity", "z-q3", GROUP)],
        edges=[("f1", "a-pricing", "z-q3", GROUP)],
    )
    assert counts == {"facts": 1, "episodes": 0}


def test_fact_whose_target_has_the_lower_uuid(monkeypatch):
    counts = _counts(
        monkeypatch,
        nodes=[("Entity", "z-pricing", GROUP), ("Entity", "a-q3", GROUP)],
        edges=[("f1", "z-pricing", "a-q3", GROUP)],
    )
    assert counts == {"facts": 1, "episodes": 0}


def test_verbatim_fact_pointing_at_the_scope_anchor(monkeypatch):
    # Every verbatim fact points at one anchor per scope, which sorts first and
    # is only ever a target.
    counts = _counts(
        monkeypatch,
        nodes=[("Entity:Category", "0-anchor", GROUP), ("Entity:Fact", "f-node", GROUP)],
        edges=[("v1", "f-node", "0-anchor", GROUP)],
    )
    assert counts == {"facts": 1, "episodes": 0}


def test_episodes_with_no_facts_left_are_counted(monkeypatch):
    counts = _counts(
        monkeypatch,
        nodes=[("Episodic", "ep-1", GROUP), ("Episodic", "ep-2", GROUP), ("Entity", "lone", GROUP)],
    )
    assert counts == {"facts": 0, "episodes": 2}


def test_other_groups_are_not_counted(monkeypatch):
    counts = _counts(
        monkeypatch,
        nodes=[
            ("Entity", "a", SIBLING),
            ("Entity", "b", SIBLING),
            ("Episodic", "ep-s", SIBLING),
            ("Entity", "c", "org_other-dept_a"),
            ("Entity", "d", "org_other-dept_a"),
        ],
        edges=[("fs", "a", "b", SIBLING), ("fo", "c", "d", "org_other-dept_a")],
    )
    assert counts == {"facts": 0, "episodes": 0}


def test_requires_service_authentication(monkeypatch):
    response = asyncio.run(_residue(monkeypatch, api_key="wrong"))
    assert response.status_code == 401
