"""/search returns the ingesting source's id for an extracted fact, against a real Neo4j.

NEO4J_PROVENANCE_TEST_URI=bolt://127.0.0.1:17687 python -m pytest tests/test_citation_provenance_integration.py

Graphiti stamps ingest provenance on the episode only; the RELATES_TO edge its
extractor writes carries just the `episodes` list. These cases write that exact
shape with graphiti-core's own save methods (no model calls), one episode per
connector type, and read it back through the real `/search` route. Only
`Graphiti.search_` is stubbed, to return the stored edges: ranking is not what
is under test. The test database is cleared between cases.

The disconnect cases at the end read the same provenance from the other side:
`DELETE /groups/{group_id}?source_id=` must retire an extracted fact whose
source is named only by its episode, including one another producer later also
asserted, and leave one that another producer created, cited by that producer alone.
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
from graphiti_core.edges import EntityEdge
from graphiti_core.nodes import EntityNode, EpisodeType, EpisodicNode
from neo4j import AsyncGraphDatabase

from app import graphiti_client, main
from app.config import settings
from conftest import API_KEY

URI = os.getenv("NEO4J_PROVENANCE_TEST_URI")
pytestmark = pytest.mark.skipif(not URI, reason="requires disposable local Neo4j")

GROUP = "org_a-source_a"
CONNECTOR_TYPES = ["github", "slack", "figma", "posthog", "gdrive"]
NOW = datetime(2026, 9, 25, tzinfo=timezone.utc)
# Neo4j's vector procedures refuse a null embedding; the value itself is unused.
EMBEDDING = [0.1] * settings.bge_dim


def _provenance(source_id: str | None, actor_name: str = "connector") -> str:
    """The provenance JSON main.py's /ingest stamps on an episode."""
    return json.dumps(
        {
            "actor_type": "extraction",
            "actor_id": f"sync:{source_id}",
            "actor_name": actor_name,
            "source": "text",
            "scope_path": GROUP,
            "source_id": source_id,
        }
    )


async def _write_episode(driver, uuid: str, group_id: str, source_description: str) -> None:
    await EpisodicNode(
        uuid=uuid,
        name=uuid,
        group_id=group_id,
        source=EpisodeType.text,
        source_description=source_description,
        content="body",
        valid_at=NOW,
        created_at=NOW,
    ).save(driver)


async def _write_extracted_fact(
    driver, uuid: str, episodes: list[str], group_id: str = GROUP
) -> EntityEdge:
    """An extracted fact exactly as Graphiti stores it: no source_description on the edge."""
    subject = EntityNode(
        uuid=f"{uuid}-s",
        name=f"{uuid} subject",
        group_id=group_id,
        created_at=NOW,
        name_embedding=EMBEDDING,
    )
    target = EntityNode(
        uuid=f"{uuid}-t",
        name=f"{uuid} object",
        group_id=group_id,
        created_at=NOW,
        name_embedding=EMBEDDING,
    )
    for node in (subject, target):
        await node.save(driver)
    edge = EntityEdge(
        uuid=uuid,
        source_node_uuid=subject.uuid,
        target_node_uuid=target.uuid,
        name="RELATES_TO",
        fact=f"fact {uuid}",
        group_id=group_id,
        episodes=episodes,
        created_at=NOW,
        valid_at=NOW,
        fact_embedding=EMBEDDING,
    )
    await edge.save(driver)
    return edge


async def _search(monkeypatch, seed) -> dict[str, dict]:
    """Seed the graph, then call POST /search and return its facts by uuid."""
    parsed = urlparse(URI)
    assert parsed.scheme == "bolt" and parsed.hostname == "127.0.0.1"
    raw = AsyncGraphDatabase.driver(URI, auth=None)
    graph = Neo4jDriver(uri=URI, user=None, password=None)
    try:
        async with raw.session(database="neo4j") as session:
            await (await session.run("MATCH (n) DETACH DELETE n")).consume()
        edges = await seed(graph)

        class _Graph:
            async def search_(self, **_):
                return SimpleNamespace(edges=edges)

        async def graphiti():
            return _Graph()

        monkeypatch.setattr(graphiti_client, "get_graphiti", graphiti)
        monkeypatch.setattr(main, "get_graphiti", graphiti)
        monkeypatch.setattr(graphiti_client, "get_driver", lambda: raw)
        monkeypatch.setattr(settings, "neo4j_database", "neo4j")
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=main.app), base_url="http://test"
        ) as client:
            response = await client.post(
                "/search",
                json={"group_id": GROUP, "query": "anything"},
                headers={"Authorization": f"Bearer {API_KEY}"},
            )
        assert response.status_code == 200, response.text
        return {f["uuid"]: f for f in response.json()["facts"]}
    finally:
        await graph.close()
        await raw.close()


def test_extracted_fact_carries_its_episode_source_id_for_every_connector_type(monkeypatch):
    async def seed(graph):
        edges = []
        for connector in CONNECTOR_TYPES:
            await _write_episode(graph, f"ep-{connector}", GROUP, _provenance(f"src_{connector}"))
            edges.append(
                await _write_extracted_fact(graph, f"fact-{connector}", [f"ep-{connector}"])
            )
        return edges

    facts = asyncio.run(_search(monkeypatch, seed))

    assert {uuid: f["source_id"] for uuid, f in facts.items()} == {
        f"fact-{c}": f"src_{c}" for c in CONNECTOR_TYPES
    }


def test_first_episode_naming_a_source_wins_in_the_edge_own_order(monkeypatch):
    async def seed(graph):
        await _write_episode(graph, "ep-upload", GROUP, _provenance(None))
        await _write_episode(graph, "ep-later", GROUP, _provenance("src_later"))
        await _write_episode(graph, "ep-first", GROUP, _provenance("src_first"))
        return [await _write_extracted_fact(graph, "fact-1", ["ep-upload", "ep-first", "ep-later"])]

    facts = asyncio.run(_search(monkeypatch, seed))

    assert facts["fact-1"]["source_id"] == "src_first"


def test_episode_in_another_group_is_never_read(monkeypatch):
    # An edge's `episodes` list is data on the edge; the lookup must still stay
    # inside the edge's own partition rather than follow a uuid anywhere.
    async def seed(graph):
        await _write_episode(graph, "ep-foreign", "org_b-source_b", _provenance("src_foreign"))
        return [await _write_extracted_fact(graph, "fact-1", ["ep-foreign"])]

    facts = asyncio.run(_search(monkeypatch, seed))

    assert facts["fact-1"]["source_id"] is None


def test_direct_ingest_without_a_source_stays_uncited_by_source(monkeypatch):
    async def seed(graph):
        await _write_episode(graph, "ep-direct", GROUP, _provenance(None))
        return [await _write_extracted_fact(graph, "fact-1", ["ep-direct"])]

    facts = asyncio.run(_search(monkeypatch, seed))

    assert facts["fact-1"]["source_id"] is None


def test_extracted_fact_keeps_its_ranking_tier_unset(monkeypatch):
    # actor_type drives ranking; inheriting it from the episode is a ranking
    # change this lookup deliberately does not make.
    async def seed(graph):
        await _write_episode(graph, "ep-github", GROUP, _provenance("src_github"))
        return [await _write_extracted_fact(graph, "fact-1", ["ep-github"])]

    facts = asyncio.run(_search(monkeypatch, seed))

    assert facts["fact-1"]["actor_type"] is None
    assert facts["fact-1"]["source_id"] == "src_github"


def test_extracted_fact_carries_every_same_group_episode_chunk_id_in_edge_order(monkeypatch):
    # The caller keeps a fact while any episode asserting it is current, so every
    # episode's chunk_id comes back, once each, in the edge's own order. An
    # episode in another group is never read, even when the edge lists it.
    def stamped(chunk_id: str) -> str:
        return json.dumps({**json.loads(_provenance("src_a")), "chunk_id": chunk_id})

    async def seed(graph):
        # The edge's order is not the uuids' sort order, so a lookup that sorted
        # or followed collect()'s row order would answer differently.
        await _write_episode(graph, "ep-3", GROUP, stamped("chunk_b"))
        await _write_episode(graph, "ep-foreign", "org_b-source_b", stamped("chunk_foreign"))
        await _write_episode(graph, "ep-1", GROUP, stamped("chunk_a"))
        await _write_episode(graph, "ep-2", GROUP, stamped("chunk_b"))
        return [
            await _write_extracted_fact(graph, "fact-1", ["ep-3", "ep-foreign", "ep-1", "ep-2"])
        ]

    facts = asyncio.run(_search(monkeypatch, seed))

    assert facts["fact-1"]["chunk_ids"] == ["chunk_b", "chunk_a"]


def test_extracted_fact_names_its_same_group_episodes_in_edge_order(monkeypatch):
    # A connector sync's change event names the episode it wrote, so the episodes
    # behind a fact are how a reader matches the fact to the synced item. Only
    # episodes in the fact's own group come back, each once, in the edge's order.
    async def seed(graph):
        await _write_episode(graph, "ep-item-2", GROUP, _provenance("src_a"))
        await _write_episode(graph, "ep-foreign", "org_b-source_b", _provenance("src_foreign"))
        await _write_episode(graph, "ep-item-1", GROUP, _provenance("src_a"))
        return [
            await _write_extracted_fact(graph, "fact-one-item", ["ep-foreign", "ep-item-1"]),
            await _write_extracted_fact(
                graph, "fact-two-items", ["ep-item-2", "ep-deleted", "ep-item-1"]
            ),
        ]

    facts = asyncio.run(_search(monkeypatch, seed))

    assert facts["fact-one-item"]["episode_ids"] == ["ep-item-1"]
    assert facts["fact-two-items"]["episode_ids"] == ["ep-item-2", "ep-item-1"]


async def _disconnect(monkeypatch, seed, source_id: str):
    """Seed the graph, call DELETE /groups/{GROUP}?source_id=, then return the
    removed count, each surviving edge's `episodes`, and POST /search's answer
    for the survivors (the stub search returns only edges still stored)."""
    parsed = urlparse(URI)
    assert parsed.scheme == "bolt" and parsed.hostname == "127.0.0.1"
    raw = AsyncGraphDatabase.driver(URI, auth=None)
    graph = Neo4jDriver(uri=URI, user=None, password=None)
    try:
        async with raw.session(database="neo4j") as session:
            await (await session.run("MATCH (n) DETACH DELETE n")).consume()
        edges = await seed(graph)

        async def stored() -> dict[str, list[str]]:
            async with raw.session(database="neo4j") as session:
                result = await session.run(
                    "MATCH ()-[r:RELATES_TO]->() RETURN r.uuid AS uuid, r.episodes AS episodes"
                )
                return {rec["uuid"]: list(rec["episodes"]) async for rec in result}

        class _Graph:
            async def search_(self, **_):
                survivors = await stored()
                return SimpleNamespace(edges=[e for e in edges if e.uuid in survivors])

        async def graphiti():
            return _Graph()

        monkeypatch.setattr(graphiti_client, "get_graphiti", graphiti)
        monkeypatch.setattr(main, "get_graphiti", graphiti)
        monkeypatch.setattr(graphiti_client, "get_driver", lambda: raw)
        monkeypatch.setattr(settings, "neo4j_database", "neo4j")
        headers = {"Authorization": f"Bearer {API_KEY}"}
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=main.app), base_url="http://test"
        ) as client:
            deleted = await client.delete(
                f"/groups/{GROUP}", params={"source_id": source_id}, headers=headers
            )
            assert deleted.status_code == 200, deleted.text
            searched = await client.post(
                "/search", json={"group_id": GROUP, "query": "anything"}, headers=headers
            )
        assert searched.status_code == 200, searched.text
        facts = {f["uuid"]: f for f in searched.json()["facts"]}
        return deleted.json()["removed_count"], await stored(), facts
    finally:
        await graph.close()
        await raw.close()


def test_disconnect_retires_an_extracted_fact_named_only_by_its_episode(monkeypatch):
    async def seed(graph):
        await _write_episode(graph, "ep-github", GROUP, _provenance("src_github"))
        await _write_episode(graph, "ep-slack", GROUP, _provenance("src_slack"))
        return [
            await _write_extracted_fact(graph, "fact-github", ["ep-github"]),
            await _write_extracted_fact(graph, "fact-slack", ["ep-slack"]),
        ]

    removed, stored, facts = asyncio.run(_disconnect(monkeypatch, seed, "src_github"))

    assert removed == 1
    assert stored == {"fact-slack": ["ep-slack"]}
    assert facts["fact-slack"]["source_id"] == "src_slack"


def test_disconnect_retires_a_fact_it_created_that_another_producer_also_asserted(monkeypatch):
    # The edge's text is the creating episode's sentence. Keeping it once the
    # source's episode came off left that sentence answering with no citation.
    async def seed(graph):
        await _write_episode(graph, "ep-github", GROUP, _provenance("src_github"))
        await _write_episode(graph, "ep-direct", GROUP, _provenance(None))
        return [await _write_extracted_fact(graph, "fact-1", ["ep-github", "ep-direct"])]

    removed, stored, facts = asyncio.run(_disconnect(monkeypatch, seed, "src_github"))

    assert removed == 1
    assert stored == {}
    assert facts == {}


def test_disconnect_keeps_a_fact_another_producer_created(monkeypatch):
    async def seed(graph):
        await _write_episode(graph, "ep-github", GROUP, _provenance("src_github"))
        await _write_episode(graph, "ep-slack", GROUP, _provenance("src_slack"))
        return [await _write_extracted_fact(graph, "fact-1", ["ep-slack", "ep-github"])]

    removed, stored, facts = asyncio.run(_disconnect(monkeypatch, seed, "src_github"))

    assert removed == 0
    assert stored == {"fact-1": ["ep-slack"]}
    assert facts["fact-1"]["source_id"] == "src_slack"


def test_disconnect_never_reads_an_episode_in_another_group(monkeypatch):
    async def seed(graph):
        await _write_episode(graph, "ep-foreign", "org_b-source_b", _provenance("src_github"))
        return [await _write_extracted_fact(graph, "fact-1", ["ep-foreign"])]

    removed, stored, _facts = asyncio.run(_disconnect(monkeypatch, seed, "src_github"))

    assert removed == 0
    assert stored == {"fact-1": ["ep-foreign"]}
