"""POST /orgs/purge at sizes past one batch, and twice at once, on a disposable local Neo4j.

NEO4J_DELETE_TEST_URI=bolt://127.0.0.1:17687 python -m pytest tests/test_org_purge_batches_integration.py

The purge deletes in batches of ORG_PURGE_BATCH, each its own transaction: an org larger
than a batch must still be removed whole, and two deletion runs that overlap must both
succeed and leave nothing. Setup and safety rules match test_org_purge_integration.py.
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

ORG = "crt1"


async def _run(monkeypatch, seed_cypher, calls):
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
            for q in seed_cypher:
                await (await session.run(q)).consume()
        transport = httpx.ASGITransport(app=main.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            responses = await asyncio.gather(
                *[
                    client.post(
                        path, json={"org_id": ORG}, headers={"Authorization": f"Bearer {API_KEY}"}
                    )
                    for path in calls
                ]
            )
        async with driver.session(database="neo4j") as session:
            left = await (
                await session.run("MATCH (n) RETURN n.group_id AS g, count(*) AS c ORDER BY g")
            ).values()
        return responses, left
    finally:
        await driver.close()


def test_purge_more_than_one_batch_removes_every_node(monkeypatch):
    seed = [
        f"UNWIND range(1, 2500) AS i CREATE (:Entity {{uuid: 'n' + i, group_id: 'org_{ORG}-sales'}})",
        f"MATCH (a:Entity {{group_id: 'org_{ORG}-sales'}}) WITH collect(a) AS ns "
        f"UNWIND range(0, size(ns) - 2) AS i WITH ns[i] AS a, ns[i+1] AS b "
        f"CREATE (a)-[:RELATES_TO {{group_id: 'org_{ORG}-sales'}}]->(b)",
        "CREATE (:Entity {uuid: 'keep', group_id: 'org_cother'})",
    ]
    (purge,), left = asyncio.run(_run(monkeypatch, seed, ["/orgs/purge"]))
    assert purge.status_code == 200, purge.text
    assert purge.json()["nodes"] == 2500
    assert left == [["org_cother", 1]]


def test_two_concurrent_purges_both_succeed_and_leave_nothing(monkeypatch):
    seed = [
        f"UNWIND range(1, 3000) AS i CREATE (:Entity {{uuid: 'n' + i, group_id: 'org_{ORG}'}})",
        f"MATCH (a:Entity {{group_id: 'org_{ORG}'}}) WITH collect(a) AS ns "
        f"UNWIND range(0, size(ns) - 2) AS i WITH ns[i] AS a, ns[i+1] AS b "
        f"CREATE (a)-[:RELATES_TO {{group_id: 'org_{ORG}'}}]->(b)",
    ]
    responses, left = asyncio.run(_run(monkeypatch, seed, ["/orgs/purge", "/orgs/purge"]))
    assert [r.status_code for r in responses] == [200, 200], [r.text for r in responses]
    assert left == []
