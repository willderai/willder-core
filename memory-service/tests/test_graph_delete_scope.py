"""Always-on query-boundary checks; real Neo4j coverage is in the companion file."""

import asyncio
import re

import pytest

from app import graphiti_client


@pytest.mark.parametrize("name", ["remove_entity", "remove_fact"])
@pytest.mark.parametrize("removed", [0, 1])
def test_delete_binds_scope_to_target(monkeypatch, name, removed):
    calls = []

    class Session:
        async def run(self, query, **params):
            calls.append((query, params))
            return self

        async def single(self):
            return {"removed": removed}

    async def initialized():
        pass

    async def run(fn):
        return await fn(Session())

    monkeypatch.setattr(graphiti_client, "get_graphiti", initialized)
    monkeypatch.setattr(graphiti_client, "_run_with_retry", run)
    result = asyncio.run(getattr(graphiti_client, name)("org_a-deal_a", "target"))
    assert result is bool(removed)
    query, params = calls[0]
    assert params["group_id"] == "org_a-deal_a"
    target_label = "Entity" if name == "remove_entity" else "RELATES_TO"
    target = re.search(r":" + target_label + r"\s*\{([^}]+)\}", query).group(1)
    assert re.search(r"uuid\s*:\s*\$uuid\b", target)
    assert re.search(r"group_id\s*:\s*\$group_id\b", target)
    if name == "remove_entity":
        # Never reintroduce an unchecked implicit cascade.
        assert "DETACH DELETE" not in query.upper()
        assert "NOT EXISTS" in query.upper()


@pytest.mark.parametrize("name", ["remove_entity", "remove_fact"])
@pytest.mark.parametrize("scope", ["", "   "])
def test_empty_partition_never_reaches_database(monkeypatch, name, scope):
    async def unexpected():
        pytest.fail("empty partition must not initialize the database")

    monkeypatch.setattr(graphiti_client, "get_graphiti", unexpected)
    assert asyncio.run(getattr(graphiti_client, name)(scope, "target")) is False
