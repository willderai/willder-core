"""A burst that takes every pooled Neo4j connection, against a real local Neo4j.

NEO4J_POOL_TEST_URI=bolt://127.0.0.1:17697 python -m pytest tests/test_pool_burst_integration.py

Railway, 2026-10-10 00:42Z: about 1,350 /search calls in 70 s held every connection
in the pool, acquisitions timed out after 10 s, and each caller that timed out closed
the shared driver and engine. That killed everyone else's queries, every request
after it failed or hung, and /health stopped answering while the process stayed up.

Here other work holds every connection of both pools in open transactions, the way a
burst of slow searches does, with the production acquisition timeout (10 s). Then
a burst of /search and /graph calls arrives. The service must answer each one 503
"overloaded", keep answering /health, leave the drivers and the transactions holding
the connections alone, and answer a search once the connections come free.

Real: Neo4j, both drivers and their pools, the Graphiti engine, its hybrid search
queries and the routes. Not real: the embedder, which gives every text the same
vector, so it changes no connection a request takes and needs no model download.
The service runs no cross-encoder. The disposable database is cleared first; no
model API, no production credentials.
"""

import asyncio
import os
import time
from urllib.parse import urlparse

import httpx
import pytest
from graphiti_core.embedder.client import EmbedderClient, EmbedderConfig

from app import graphiti_client, main
from app.config import settings
from conftest import API_KEY

URI = os.getenv("NEO4J_POOL_TEST_URI")
pytestmark = pytest.mark.skipif(not URI, reason="requires a disposable local Neo4j")

GROUP = "org_burst-deal_a"
BURST = 24
HEADERS = {"Authorization": f"Bearer {API_KEY}"}


class _SameVectorEmbedder(EmbedderClient):
    def __init__(self, _model_name, dim):
        self.config = EmbedderConfig(embedding_dim=dim)
        self.models = None

    async def create(self, input_data):
        return [1.0] + [0.0] * (self.config.embedding_dim - 1)

    async def create_batch(self, input_data_list):
        return [await self.create(text) for text in input_data_list]


async def _hold_every_connection(driver, count: int) -> list:
    """Open `count` transactions on `driver`, each holding one pooled connection."""
    held = []
    for _ in range(count):
        session = driver.session(database="neo4j")
        held.append((session, await session.begin_transaction()))
    return held


async def _release(held: list) -> None:
    for session, tx in held:
        await tx.rollback()
        await session.close()


async def _search(client: httpx.AsyncClient, query: str) -> httpx.Response:
    return await client.post(
        "/search", json={"group_id": GROUP, "query": query, "limit": 5}, headers=HEADERS
    )


async def _graph(client: httpx.AsyncClient) -> httpx.Response:
    """A read on the raw driver's pool, the one /health and the provenance lookup use."""
    return await client.post("/graph", json={"group_ids": [GROUP]}, headers=HEADERS)


@pytest.fixture
def service(monkeypatch):
    parsed = urlparse(URI)
    assert parsed.scheme == "bolt" and parsed.hostname == "127.0.0.1"
    monkeypatch.setattr(settings, "neo4j_uri", URI)
    monkeypatch.setattr(settings, "neo4j_database", "neo4j")
    monkeypatch.setattr(settings, "graphiti_service_api_key", API_KEY)
    # The engine builds its LLM client eagerly and the OpenAI SDK refuses an empty key.
    # No request reaches a model here (the RRF recipe never calls it), so a placeholder
    # is enough, and it keeps the test from depending on the runner's environment.
    monkeypatch.setattr(settings, "openai_api_key", "test-placeholder-not-a-key")
    monkeypatch.setattr(graphiti_client, "BGEEmbedder", _SameVectorEmbedder)
    monkeypatch.setattr(graphiti_client, "_embedder", None, raising=False)
    for name, value in [
        ("_driver", None),
        ("_graphiti", None),
        ("_graph_driver", None),
        ("_indices_built", False),
    ]:
        monkeypatch.setattr(graphiti_client, name, value)
    # Undo the suite-wide stub: this test is about the real health check.
    monkeypatch.setattr(main, "neo4j_healthy", graphiti_client.neo4j_healthy)


def test_a_burst_on_a_full_pool_is_answered_503_and_the_service_recovers(service):
    async def scenario():
        transport = httpx.ASGITransport(app=main.app)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://test", timeout=60
        ) as client:
            raw = graphiti_client.get_driver()
            async with raw.session(database="neo4j") as session:
                await (await session.run("MATCH (n) DETACH DELETE n")).consume()
            # Written through the service's own fallback write path, so the search
            # after recovery has a real fact to find.
            await graphiti_client.ensure_graph_visible(GROUP, "Acme's renewal is owned by Dana")
            assert (await _search(client, "who owns the Acme renewal")).status_code == 200

            engine = graphiti_client._graphiti
            graph_pool = graphiti_client._graph_driver.client
            pool_size = raw._pool.pool_config.max_connection_pool_size
            held = await _hold_every_connection(graph_pool, pool_size)
            held += await _hold_every_connection(raw, pool_size)
            try:
                started = time.monotonic()
                burst = asyncio.gather(
                    *(_search(client, f"renewal owner {i}") for i in range(BURST)),
                    *(_graph(client) for _ in range(BURST // 4)),
                )
                await asyncio.sleep(0.5)
                health_started = time.monotonic()
                health = await client.get("/health")
                health_seconds = time.monotonic() - health_started
                answers = await burst
                burst_seconds = time.monotonic() - started

                # The shared engine, both drivers and the work holding the connections
                # were all left alone: every held transaction still runs a query.
                assert graphiti_client._graphiti is engine
                assert graphiti_client._graph_driver.client is graph_pool
                assert graphiti_client._driver is raw
                for _session, tx in held:
                    await (await tx.run("RETURN 1")).consume()
            finally:
                await _release(held)

            recovered = await _search(client, "who owns the Acme renewal")
            healthy = (await client.get("/health")).json()
            await graphiti_client.close_graphiti()
            await graphiti_client.close_driver()
            return answers, burst_seconds, health, health_seconds, recovered, healthy

    answers, burst_seconds, health, health_seconds, recovered, healthy = asyncio.run(scenario())

    assert [r.status_code for r in answers] == [503] * (BURST + BURST // 4)
    assert all(
        "overloaded" in r.json()["detail"] and r.headers["retry-after"] == "1" for r in answers
    )
    # One acquisition timeout each, at the same time: no retry, no rebuild after it.
    assert burst_seconds < settings.neo4j_connection_acquisition_timeout_s + 5
    assert health.status_code == 200
    assert health.json()["status"] == "degraded"
    assert health_seconds < main.HEALTH_NEO4J_TIMEOUT_S + 1
    assert recovered.status_code == 200
    assert [f["fact"] for f in recovered.json()["facts"]] == ["Acme's renewal is owned by Dana"]
    # No ingest ran, so extraction has no outcome to report and does not degrade health.
    assert healthy == {
        "status": "ok",
        "neo4j": True,
        "error": None,
        "extraction": healthy["extraction"],
    }
    assert healthy["extraction"]["status"] == "unknown"
