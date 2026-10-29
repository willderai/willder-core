"""GET /entities/{uuid} answers 404 only for an entity the tenant cannot see, against a real Neo4j.

NEO4J_PROVENANCE_TEST_URI=bolt://127.0.0.1:17687 python -m pytest tests/test_entity_lookup_integration.py

A 404 from this route is read downstream as "this entity does not exist" (an erasure
check counts it as erased), so a graph that is down or a query that fails must answer
an error instead. These cases seed one entity with graphiti-core's own save methods and
call the real route: an unknown uuid and another group's entity are 404, an entity with
no facts is 200, and an unreachable graph or a failing query is a 5xx. The failure cases
first read the seeded entity successfully, so the 5xx is the lookup failing, not the
entity being absent. The test database is cleared before each case.
"""

import asyncio
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from urllib.parse import urlparse

import httpx
import pytest
from graphiti_core.driver.neo4j_driver import Neo4jDriver
from graphiti_core.edges import EntityEdge
from graphiti_core.nodes import EntityNode
from neo4j import AsyncGraphDatabase

from app import graphiti_client, main
from app.config import settings
from conftest import API_KEY

URI = os.getenv("NEO4J_PROVENANCE_TEST_URI")
pytestmark = pytest.mark.skipif(not URI, reason="requires disposable local Neo4j")

GROUP = "org_lookup-a"
SIBLING = "org_lookup-b"
NOW = datetime(2026, 10, 8, tzinfo=timezone.utc)
# Neo4j's vector procedures refuse a null embedding; the value itself is unused.
EMBEDDING = [0.1] * settings.bge_dim
# Nothing listens here, so every connection attempt fails.
UNREACHABLE = "bolt://127.0.0.1:1"


async def _get(path: str) -> httpx.Response:
    # raise_app_exceptions=False: an unhandled error reaches the test as the 500 a
    # caller would see, not as a raised exception.
    transport = httpx.ASGITransport(app=main.app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.get(path, headers={"Authorization": f"Bearer {API_KEY}"})


@asynccontextmanager
async def _service(monkeypatch):
    """Point the service at the test database, cleared and seeded with one lone entity
    per group. Yields the graphiti-core driver, for seeding more."""
    parsed = urlparse(URI)
    assert parsed.scheme == "bolt" and parsed.hostname == "127.0.0.1"
    raw = AsyncGraphDatabase.driver(URI, auth=None)
    graph = Neo4jDriver(uri=URI, user=None, password=None)
    try:
        async with raw.session(database="neo4j") as session:
            await (await session.run("MATCH (n) DETACH DELETE n")).consume()
        for uuid, group in [("ent-lone", GROUP), ("ent-sibling", SIBLING)]:
            await _entity(uuid, group).save(graph)

        async def graphiti():
            return None

        async def reset(_seen):
            return None

        monkeypatch.setattr(graphiti_client, "get_graphiti", graphiti)
        monkeypatch.setattr(graphiti_client, "_reset_graphiti", reset)
        monkeypatch.setattr(graphiti_client, "_graph_driver", graph)
        monkeypatch.setattr(graphiti_client, "get_driver", lambda: raw)
        monkeypatch.setattr(settings, "neo4j_database", "neo4j")
        yield graph
    finally:
        await graph.close()
        await raw.close()


def _entity(uuid: str, group: str = GROUP) -> EntityNode:
    return EntityNode(
        uuid=uuid, name=uuid, group_id=group, created_at=NOW, name_embedding=EMBEDDING
    )


async def _statuses(monkeypatch, paths: list[str], *, then_driver=None) -> list[int]:
    """Read `paths`, then (if given) swap the graph driver for `then_driver` and read
    `paths` again. Returns every status in order."""
    async with _service(monkeypatch):
        statuses = [(await _get(p)).status_code for p in paths]
        if then_driver is not None:
            monkeypatch.setattr(graphiti_client, "_graph_driver", then_driver)
            try:
                statuses += [(await _get(p)).status_code for p in paths]
            finally:
                await then_driver.close()
        return statuses


def test_entity_with_no_facts_is_found(monkeypatch):
    statuses = asyncio.run(_statuses(monkeypatch, [f"/entities/ent-lone?group_id={GROUP}"]))
    assert statuses == [200]


def test_unknown_entity_and_another_groups_entity_are_not_found(monkeypatch):
    statuses = asyncio.run(
        _statuses(
            monkeypatch,
            [
                f"/entities/ent-nowhere?group_id={GROUP}",
                f"/entities/ent-sibling?group_id={GROUP}",
            ],
        )
    )
    assert statuses == [404, 404]


def test_unreachable_graph_is_an_error_not_not_found(monkeypatch):
    down = Neo4jDriver(uri=UNREACHABLE, user=None, password=None)
    # Without this the driver's own retries hold each lookup for about 30 seconds.
    down.client = AsyncGraphDatabase.driver(UNREACHABLE, auth=None, max_transaction_retry_time=0)
    statuses = asyncio.run(
        _statuses(
            monkeypatch,
            [f"/entities/ent-lone?group_id={GROUP}"],
            then_driver=down,
        )
    )
    assert statuses[0] == 200
    assert statuses[1] >= 500


def test_failing_query_is_an_error_not_not_found(monkeypatch):
    # A database the server does not have: every query fails with a ClientError.
    broken = Neo4jDriver(uri=URI, user=None, password=None, database="nosuchdb")
    statuses = asyncio.run(
        _statuses(
            monkeypatch,
            [f"/entities/ent-lone?group_id={GROUP}"],
            then_driver=broken,
        )
    )
    assert statuses[0] == 200
    assert statuses[1] >= 500


def test_both_ends_of_a_role_transfer_are_found_with_their_facts(monkeypatch):
    # An org role changing hands (POST /transfer-entity) copies the old holder's facts to
    # the new holder. The copies must be whole edges between nodes that have a uuid, or
    # every entity they touch fails to load.
    async def run():
        async with _service(monkeypatch) as graph:
            for uuid in ("ent-bob", "ent-acme", "ent-carol"):
                await _entity(uuid).save(graph)
            for uuid, source, target, fact in [
                ("edge-ceo", "ent-bob", "ent-acme", "ent-bob is the CEO of ent-acme"),
                ("edge-reports", "ent-carol", "ent-bob", "ent-carol reports to ent-bob"),
            ]:
                await EntityEdge(
                    uuid=uuid,
                    group_id=GROUP,
                    source_node_uuid=source,
                    target_node_uuid=target,
                    created_at=NOW,
                    name="RELATES_TO",
                    fact=fact,
                    fact_embedding=EMBEDDING,
                    episodes=["ep-1"],
                ).save(graph)

            assert await graphiti_client.transfer_entity_edges(GROUP, "ent-bob", "Amy") == 2
            amy_uuid, _ = await graphiti_client.find_entity_by_name(GROUP, "Amy")
            assert amy_uuid, "the new holder has a uuid"

            facts = {}
            for uuid in (amy_uuid, "ent-bob", "ent-acme", "ent-carol"):
                response = await _get(f"/entities/{uuid}?group_id={GROUP}")
                assert response.status_code == 200, (uuid, response.text)
                facts[uuid] = sorted(
                    (f["fact"], f["invalid_at"] is None) for f in response.json()["facts"]
                )
            return amy_uuid, facts

    amy_uuid, facts = asyncio.run(run())
    current_ceo = ("ent-bob is the CEO of ent-acme", True)
    current_report = ("ent-carol reports to ent-bob", True)
    assert facts[amy_uuid] == [current_ceo, current_report]
    assert facts["ent-bob"] == [
        ("ent-bob is the CEO of ent-acme", False),
        ("ent-carol reports to ent-bob", False),
    ]
    assert current_ceo in facts["ent-acme"] and current_report in facts["ent-carol"]


def test_a_role_transfer_written_before_the_fix_is_repaired(monkeypatch):
    # What the earlier transfer_entity_edges left in the graph: a holder with only a name
    # and group_id, and a copied edge with no name, created_at or episodes.
    async def run():
        async with _service(monkeypatch) as graph:
            await _entity("ent-acme").save(graph)
            async with graphiti_client.get_driver().session(database="neo4j") as session:
                await (
                    await session.run(
                        """
                    MATCH (acme:Entity {uuid: 'ent-acme'})
                    MERGE (holder:Entity {name: 'Amy', group_id: $gid})
                    CREATE (holder)-[:RELATES_TO {
                        uuid: 'edge-copy', fact: 'Amy is the CEO of ent-acme',
                        group_id: $gid, valid_at: datetime(), source_description: '{}'
                    }]->(acme)
                    """,
                        gid=GROUP,
                    )
                ).consume()
            before = (await _get(f"/entities/ent-acme?group_id={GROUP}")).status_code

            repaired = await graphiti_client.repair_transferred_entities()
            again = await graphiti_client.repair_transferred_entities()
            amy_uuid, _ = await graphiti_client.find_entity_by_name(GROUP, "Amy")
            after = [
                (await _get(f"/entities/{uuid}?group_id={GROUP}")).status_code
                for uuid in ("ent-acme", amy_uuid)
            ]
            return before, repaired, again, amy_uuid, after

    before, repaired, again, amy_uuid, after = asyncio.run(run())
    assert before == 500, "the unrepaired edge is what fails the lookup"
    assert (repaired, again) == (2, 0), "one holder and one edge, then nothing"
    assert amy_uuid
    assert after == [200, 200]


def test_a_role_transfer_copy_keeps_the_provenance_of_the_fact_it_copies(monkeypatch):
    # Retiring a source finds its facts by episode and by the chunk id in
    # source_description. A copy without them would outlive the source it came from.
    provenance = '{"chunk_id": "chunk-7", "source_id": "src-3"}'

    async def run():
        async with _service(monkeypatch) as graph:
            for uuid in ("ent-bob", "ent-acme"):
                await _entity(uuid).save(graph)
            await EntityEdge(
                uuid="edge-ceo",
                group_id=GROUP,
                source_node_uuid="ent-bob",
                target_node_uuid="ent-acme",
                created_at=NOW,
                name="RELATES_TO",
                fact="ent-bob is the CEO of ent-acme",
                fact_embedding=EMBEDDING,
                episodes=["ep-1", "ep-2"],
            ).save(graph)
            async with graphiti_client.get_driver().session(database="neo4j") as session:
                # graphiti-core does not save an edge's own stamp; memory-service writes it.
                await (
                    await session.run(
                        "MATCH ()-[r:RELATES_TO {uuid: 'edge-ceo'}]->() SET r.source_description = $p",
                        p=provenance,
                    )
                ).consume()

            assert await graphiti_client.transfer_entity_edges(GROUP, "ent-bob", "Amy") == 1
            async with graphiti_client.get_driver().session(database="neo4j") as session:
                rows = await (
                    await session.run(
                        """
                    MATCH (:Entity {name: 'Amy', group_id: $gid})-[c:RELATES_TO]->(:Entity {uuid: 'ent-acme'})
                    RETURN c.uuid AS uuid, c.episodes AS episodes, c.source_description AS provenance
                    """,
                        gid=GROUP,
                    )
                ).data()
            return rows

    [copy] = asyncio.run(run())
    assert copy["uuid"] != "edge-ceo"
    assert copy["episodes"] == ["ep-1", "ep-2"]
    assert copy["provenance"] == provenance


async def _post(path: str, body: dict) -> httpx.Response:
    transport = httpx.ASGITransport(app=main.app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.post(path, json=body, headers={"Authorization": f"Bearer {API_KEY}"})


def test_lookups_over_several_groups_find_an_entity_only_in_a_group_asked(monkeypatch):
    # A reader granted a scope looks below it in one call. "org_lookup" is a prefix of
    # both groups and names neither.
    async def run():
        async with _service(monkeypatch):
            return [
                (
                    await _post(
                        "/entities/lookup", {"uuid": "ent-lone", "group_ids": [SIBLING, GROUP]}
                    )
                ).json(),
                (
                    await _post(
                        "/entities/lookup",
                        {"uuid": "ent-lone", "group_ids": [SIBLING, "org_lookup"]},
                    )
                ).json(),
                (
                    await _post(
                        "/entities/groups",
                        {"name": "ent-lone", "group_ids": ["org_lookup", SIBLING, GROUP]},
                    )
                ).json(),
                (
                    await _post(
                        "/entities/groups",
                        {"name": "ent-lone", "group_ids": ["org_lookup", SIBLING]},
                    )
                ).json(),
            ]

    found, missed, holding, none = asyncio.run(run())
    assert (found["entity"]["uuid"], found["group_id"]) == ("ent-lone", GROUP)
    assert missed == {"entity": None, "group_id": None}
    assert holding == {"group_ids": [GROUP]}
    assert none == {"group_ids": []}
