"""A fact extraction found entities for but no relation lands on those entities, on a disposable local Neo4j.

NEO4J_DELETE_TEST_URI=bolt://127.0.0.1:17687 python -m pytest tests/test_fallback_entity_integration.py

A one-entity sentence ("Kestrel Logistics is a Project that runs the north depot")
is the common case: Graphiti's extractor resolves the entity but has no second one
to relate it to, so the episode comes back with nodes and no edges. The fallback
must then hang the fact on the entity extraction resolved, the one a later write
about Kestrel Logistics resolves to as well. A node named after the whole sentence
is an entity no later write can ever land on, so an agent reading the entity its
fact named would never see its next write about it.

Graphiti's model call is replaced by its result: the episode uuid and the entity
nodes it resolved, seeded into the database first. Everything after it, /ingest's
fallback decision and the Cypher it writes, runs for real. No model calls; the
database is cleared before each case.
"""

import asyncio
import json
import os
from datetime import datetime, timezone
from types import SimpleNamespace
from urllib.parse import urlparse

import httpx
import pytest
from graphiti_core.driver.neo4j_driver import Neo4jDriver
from graphiti_core.nodes import EntityNode
from neo4j import AsyncGraphDatabase

from app import graphiti_client, main
from app.config import settings
from conftest import API_KEY

URI = os.getenv("NEO4J_DELETE_TEST_URI")
pytestmark = pytest.mark.skipif(not URI, reason="requires disposable local Neo4j")

GROUP = "org_a-deal"
OTHER_GROUP = "org_b-deal"
AUTH = {"Authorization": f"Bearer {API_KEY}"}
SEED = "Kestrel 22 Logistics is a Project that runs the north depot in Tromso."
EMBEDDING = [0.1] * settings.bge_dim


class _Service:
    """The ingest routes on the test database, with Graphiti's extraction resolving
    `resolved` and no edges, for /ingest's one episode and for each of /ingest-bulk's."""

    def __init__(self, monkeypatch, resolved: list[str]):
        parsed = urlparse(URI)
        assert parsed.scheme == "bolt" and parsed.hostname == "127.0.0.1"
        self.driver = AsyncGraphDatabase.driver(URI, auth=None)
        self.graph = Neo4jDriver(uri=URI, user=None, password=None)

        class _Extraction:
            async def add_episode(self, **_kwargs):
                return SimpleNamespace(
                    episode=SimpleNamespace(uuid="ep-seed"),
                    nodes=[SimpleNamespace(uuid=uuid) for uuid in resolved],
                    edges=[],
                )

            async def add_episode_bulk(self, bulk_episodes, **_kwargs):
                episodes = [SimpleNamespace(uuid=f"ep-{i}") for i in range(len(bulk_episodes))]
                mentions = [
                    SimpleNamespace(source_node_uuid=episode.uuid, target_node_uuid=uuid)
                    for episode in episodes
                    for uuid in resolved
                ]
                return SimpleNamespace(
                    episodes=episodes, episodic_edges=mentions, nodes=[], edges=[]
                )

        async def extraction():
            return _Extraction()

        async def initialized():
            pass

        monkeypatch.setattr(main, "get_graphiti", extraction)
        monkeypatch.setattr(graphiti_client, "get_graphiti", initialized)
        monkeypatch.setattr(graphiti_client, "_graph_driver", self.graph)
        monkeypatch.setattr(graphiti_client, "get_driver", lambda: self.driver)
        monkeypatch.setattr(settings, "neo4j_database", "neo4j")

    async def seed_entity(self, uuid: str, name: str, group_id: str = GROUP) -> None:
        """An entity as Graphiti saves one, so Graphiti's own entity read can load it."""
        await EntityNode(
            uuid=uuid,
            name=name,
            group_id=group_id,
            created_at=datetime.now(timezone.utc),
            name_embedding=EMBEDDING,
        ).save(self.graph)

    async def _call(self, method: str, path: str, **kwargs) -> httpx.Response:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=main.app), base_url="http://test"
        ) as client:
            return await client.request(method, path, headers=AUTH, **kwargs)

    async def ingest(self, content: str) -> httpx.Response:
        return await self._call(
            "POST",
            "/ingest",
            json={
                "group_id": GROUP,
                "content": content,
                "actor_type": "agent",
                "actor_id": "agent_1",
                "chunk_id": "chunk_seed",
            },
        )

    async def ingest_bulk(self, content: str) -> httpx.Response:
        episode = {
            "group_id": GROUP,
            "content": content,
            "actor_type": "agent",
            "actor_id": "agent_1",
            "chunk_id": "chunk_seed",
        }
        return await self._call(
            "POST", "/ingest-bulk", json={"group_id": GROUP, "episodes": [episode]}
        )

    async def entity(self, uuid: str) -> httpx.Response:
        return await self._call("GET", f"/entities/{uuid}", params={"group_id": GROUP})

    async def delete_chunk(self, chunk_id: str) -> httpx.Response:
        return await self._call("DELETE", f"/chunks/{chunk_id}", params={"group_id": GROUP})

    async def facts(self) -> list[dict]:
        """Every RELATES_TO edge: the names at both ends, its group and its text."""
        async with self.driver.session(database="neo4j") as session:
            return await (
                await session.run(
                    """
                MATCH (a)-[r:RELATES_TO]->(b)
                RETURN a.name AS source, b.name AS target, r.group_id AS group_id, r.fact AS fact,
                       r.episodes AS episodes, r.source_description AS source_description
                ORDER BY source
                """
                )
            ).data()

    async def names(self) -> set[str]:
        async with self.driver.session(database="neo4j") as session:
            return {
                r["name"]
                for r in await (await session.run("MATCH (n) RETURN n.name AS name")).data()
            }

    async def clear(self) -> None:
        async with self.driver.session(database="neo4j") as session:
            await (await session.run("MATCH (n) DETACH DELETE n")).consume()


def _run(monkeypatch, resolved, case):
    async def run():
        service = _Service(monkeypatch, resolved)
        try:
            await service.clear()
            await case(service)
        finally:
            await service.graph.close()
            await service.driver.close()

    asyncio.run(run())


def test_a_fact_with_a_resolved_entity_and_no_relation_lands_on_that_entity(monkeypatch):
    async def case(service: _Service):
        await service.seed_entity("kestrel", "Kestrel 22 Logistics")

        response = await service.ingest(SEED)
        assert response.status_code == 200, response.text

        facts = await service.facts()
        assert [(f["source"], f["fact"]) for f in facts] == [("Kestrel 22 Logistics", SEED)]
        assert facts[0]["group_id"] == GROUP
        assert facts[0]["episodes"] == ["ep-seed"]
        assert json.loads(facts[0]["source_description"])["chunk_id"] == "chunk_seed"
        # No node is named after the sentence: the fact's only entity is Kestrel's.
        assert not any(
            name.startswith("Kestrel 22 Logistics is a") for name in await service.names()
        )

    _run(monkeypatch, ["kestrel"], case)


def test_the_entity_read_serves_the_fact(monkeypatch):
    # GET /entities/{id} is what an agent's memory_entity reads: the fact must come
    # back on the entity it names, cited to the row that stored it.
    async def case(service: _Service):
        await service.seed_entity("kestrel", "Kestrel 22 Logistics")
        assert (await service.ingest(SEED)).status_code == 200

        response = await service.entity("kestrel")
        assert response.status_code == 200, response.text
        assert [(f["fact"], f["chunk_ids"]) for f in response.json()["facts"]] == [
            (SEED, ["chunk_seed"])
        ]

    _run(monkeypatch, ["kestrel"], case)


def test_a_bulk_episode_with_a_resolved_entity_and_no_relation_lands_on_that_entity(monkeypatch):
    # /ingest-bulk is the path a distilled fact takes.
    async def case(service: _Service):
        await service.seed_entity("kestrel", "Kestrel 22 Logistics")

        response = await service.ingest_bulk(SEED)
        assert response.status_code == 200, response.text

        facts = await service.facts()
        assert [(f["source"], f["fact"], f["episodes"]) for f in facts] == [
            ("Kestrel 22 Logistics", SEED, ["ep-0"])
        ]

    _run(monkeypatch, ["kestrel"], case)


def test_deleting_the_stored_fact_removes_it_from_the_entity(monkeypatch):
    async def case(service: _Service):
        await service.seed_entity("kestrel", "Kestrel 22 Logistics")
        assert (await service.ingest(SEED)).status_code == 200

        response = await service.delete_chunk("chunk_seed")
        assert response.status_code == 200, response.text

        assert await service.facts() == []
        assert (await service.entity("kestrel")).json()["facts"] == []

    _run(monkeypatch, ["kestrel"], case)


def test_every_resolved_entity_carries_the_fact(monkeypatch):
    async def case(service: _Service):
        await service.seed_entity("kestrel", "Kestrel 22 Logistics")
        await service.seed_entity("tromso", "Tromso")

        response = await service.ingest(SEED)
        assert response.status_code == 200, response.text

        assert sorted(f["source"] for f in await service.facts()) == [
            "Kestrel 22 Logistics",
            "Tromso",
        ]

    _run(monkeypatch, ["kestrel", "tromso"], case)


def test_an_entity_in_another_group_is_never_attached_to(monkeypatch):
    # Entity uuids are global, so the group in the MATCH is what keeps a fact in its
    # tenant: an entity another group owns gets no edge, and the fact falls back to
    # its own node in its own group.
    async def case(service: _Service):
        await service.seed_entity("kestrel-b", "Kestrel 22 Logistics", group_id=OTHER_GROUP)

        response = await service.ingest(SEED)
        assert response.status_code == 200, response.text

        facts = await service.facts()
        assert [(f["source"], f["target"], f["group_id"]) for f in facts] == [
            (SEED, graphiti_client.FALLBACK_ANCHOR_NAME, GROUP),
        ]

    _run(monkeypatch, ["kestrel-b"], case)


def test_a_fact_extraction_resolved_no_entity_for_keeps_its_own_node(monkeypatch):
    async def case(service: _Service):
        response = await service.ingest(SEED)
        assert response.status_code == 200, response.text

        facts = await service.facts()
        assert [(f["source"], f["target"]) for f in facts] == [
            (SEED, graphiti_client.FALLBACK_ANCHOR_NAME)
        ]

    _run(monkeypatch, [], case)


# The nodes the fallback itself writes, each one extraction can resolve a later fact
# to: the group's anchor and one verbatim node of each label.
VERBATIM_LABELS = ("Fact", "Decision", "Passage")
EXCLUDED = [graphiti_client._fallback_anchor_uuid(GROUP)] + [
    f"verbatim-{label.lower()}" for label in VERBATIM_LABELS
]


async def _seed_excluded_nodes(service: _Service) -> None:
    async with service.driver.session(database="neo4j") as session:
        await (
            await session.run(
                "CREATE (:Entity:Category {uuid: $uuid, name: $name, group_id: $gid})",
                uuid=EXCLUDED[0],
                name=graphiti_client.FALLBACK_ANCHOR_NAME,
                gid=GROUP,
            )
        ).consume()
        for label, uuid in zip(VERBATIM_LABELS, EXCLUDED[1:], strict=False):
            await (
                await session.run(
                    f"CREATE (:Entity:{label} {{uuid: $uuid, name: $name, group_id: $gid}})",
                    uuid=uuid,
                    name=f"An earlier {label.lower()}",
                    gid=GROUP,
                )
            ).consume()


def test_the_anchor_and_verbatim_nodes_never_carry_the_fact(monkeypatch):
    # Extraction can resolve a mention to a node the fallback wrote earlier. The
    # fact still lands only on the real entity it resolved.
    async def case(service: _Service):
        await service.seed_entity("kestrel", "Kestrel 22 Logistics")
        await _seed_excluded_nodes(service)

        assert (await service.ingest(SEED)).status_code == 200

        facts = await service.facts()
        assert [(f["source"], f["target"]) for f in facts if f["fact"] == SEED] == [
            ("Kestrel 22 Logistics", graphiti_client.FALLBACK_ANCHOR_NAME),
        ]

    _run(monkeypatch, ["kestrel", *EXCLUDED], case)


def test_a_fact_resolved_only_to_anchor_or_verbatim_nodes_keeps_its_own_node(monkeypatch):
    async def case(service: _Service):
        await _seed_excluded_nodes(service)

        assert (await service.ingest(SEED)).status_code == 200

        facts = await service.facts()
        assert [(f["source"], f["target"]) for f in facts if f["fact"] == SEED] == [
            (SEED, graphiti_client.FALLBACK_ANCHOR_NAME),
        ]

    _run(monkeypatch, EXCLUDED, case)
