"""/search end to end with the service's real engine and its no-op cross-encoder, against
a real local Neo4j.

NEO4J_POOL_TEST_URI=bolt://127.0.0.1:17697 python -m pytest tests/test_search_without_reranker_integration.py

Real: Neo4j, both drivers, the Graphiti engine built by get_graphiti (with the
UnusedCrossEncoder it passes), the BGE embedder and the /search route. A fact is
written through the service's own fallback write path, which calls no model API.
Loading any cross-encoder model, or building Graphiti's OpenAI reranker, fails the
test. The disposable database is cleared first; no production credentials.
"""

import asyncio
import os
from urllib.parse import urlparse

import graphiti_core.graphiti as graphiti_module
import httpx
import pytest
import sentence_transformers
from graphiti_core.cross_encoder import bge_reranker_client

from app import graphiti_client, main
from app.config import settings
from conftest import API_KEY

URI = os.getenv("NEO4J_POOL_TEST_URI")
pytestmark = pytest.mark.skipif(not URI, reason="requires a disposable local Neo4j")

GROUP = "org_rerank-e2e"


def _forbid(what):
    def _called(*_args, **_kwargs):
        raise AssertionError(f"{what} was constructed")

    return _called


@pytest.fixture
def service(monkeypatch):
    parsed = urlparse(URI)
    assert parsed.scheme == "bolt" and parsed.hostname == "127.0.0.1"
    monkeypatch.setattr(settings, "neo4j_uri", URI)
    monkeypatch.setattr(settings, "neo4j_database", "neo4j")
    monkeypatch.setattr(settings, "graphiti_service_api_key", API_KEY)
    # The engine builds its LLM client eagerly and the OpenAI SDK refuses an empty key.
    # Search never calls it, so a placeholder is enough.
    monkeypatch.setattr(settings, "openai_api_key", "test-placeholder-not-a-key")
    monkeypatch.setenv("GRAPHITI_TELEMETRY_ENABLED", "false")
    monkeypatch.setattr(
        graphiti_module, "OpenAIRerankerClient", _forbid("Graphiti's OpenAI reranker")
    )
    monkeypatch.setattr(sentence_transformers, "CrossEncoder", _forbid("a cross-encoder model"))
    monkeypatch.setattr(bge_reranker_client, "CrossEncoder", _forbid("a cross-encoder model"))
    for name, value in [
        ("_driver", None),
        ("_graphiti", None),
        ("_graph_driver", None),
        ("_indices_built", False),
        ("_building", None),
    ]:
        monkeypatch.setattr(graphiti_client, name, value, raising=False)
    monkeypatch.setattr(main, "get_graphiti", graphiti_client.get_graphiti)
    monkeypatch.setattr(main, "neo4j_healthy", graphiti_client.neo4j_healthy)


def test_search_finds_a_written_fact_with_no_reranker(service):
    async def scenario():
        transport = httpx.ASGITransport(app=main.app)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://test", timeout=120
        ) as client:
            raw = graphiti_client.get_driver()
            async with raw.session(database="neo4j") as session:
                await (await session.run("MATCH (n) DETACH DELETE n")).consume()
            await graphiti_client.ensure_graph_visible(GROUP, "Acme's renewal is owned by Dana")
            response = await client.post(
                "/search",
                json={"group_id": GROUP, "query": "who owns the Acme renewal", "limit": 5},
                headers={"Authorization": f"Bearer {API_KEY}"},
            )
            engine = graphiti_client._graphiti
            await graphiti_client.close_graphiti()
            await graphiti_client.close_driver()
            return response, engine

    response, engine = asyncio.run(scenario())

    assert response.status_code == 200
    assert [f["fact"] for f in response.json()["facts"]] == ["Acme's renewal is owned by Dana"]
    assert isinstance(engine.cross_encoder, graphiti_client.UnusedCrossEncoder)
