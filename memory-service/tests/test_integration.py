"""Real round-trip against Neo4j + Groq. Opt-in (slow, costs Groq tokens, needs env):

    RUN_INTEGRATION=1 <env from repo root .env> pytest tests/test_integration.py

Ingests a sample episode into a throwaway group, then asserts search returns facts.
"""

import asyncio
import os

import pytest

pytestmark = pytest.mark.skipif(
    not os.getenv("RUN_INTEGRATION"),
    reason="set RUN_INTEGRATION=1 (and Neo4j/Groq env) to run the real round-trip",
)

GROUP = "pytest_integration_org"
SAMPLE = "Jane Doe is the CTO of Acme Corp. Acme is headquartered in Austin, Texas."


def test_ingest_then_search_round_trip():
    asyncio.run(_round_trip())


async def _round_trip():
    from datetime import datetime, timezone

    from graphiti_core.nodes import EpisodeType

    from app.graphiti_client import close_driver, close_graphiti, get_graphiti, search_edges

    g = await get_graphiti()
    try:
        result = await g.add_episode(
            name="pytest",
            episode_body=SAMPLE,
            source_description='{"actor_type":"human","actor_id":"pytest"}',
            reference_time=datetime.now(timezone.utc),
            source=EpisodeType.text,
            group_id=GROUP,
        )
        assert result.episode.uuid

        edges = await search_edges(g, "Who is the CTO of Acme?", GROUP, 5)
        facts = [e.fact for e in edges]
        assert any("CTO" in f or "Acme" in f for f in facts), facts
    finally:
        await close_graphiti()
        await close_driver()
