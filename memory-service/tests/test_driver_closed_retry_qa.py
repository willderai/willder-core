"""The "Driver closed" retry retries only on a driver or engine that
another caller replaced, and a busy pool is never retried, on every path that has the
retry.

A caller whose query fails with DriverError("Driver closed") because another caller's
lost connection closed the shared driver should move to the replacement once. The same
error on the driver that is still current means nothing replaced it, so a retry would
only repeat the failure. A busy pool (ConnectionAcquisitionTimeoutError, itself a
DriverError) is answered at once even when the driver was replaced meanwhile: a retry
adds load to the burst that caused it.

The entity lookup (`get_entity_with_facts`) and the Graphiti search path
(`main._graphiti_with_retry`) carry their own copy of the rule; these tests cover the
cases the other retry tests leave open there and on the raw driver path.
"""

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from graphiti_core.errors import NodeNotFoundError
from graphiti_core.nodes import EntityNode
from neo4j.exceptions import ConnectionAcquisitionTimeoutError, DriverError

from app import graphiti_client, main

DRIVER_CLOSED = DriverError("Driver closed")
POOL_TIMEOUT = ConnectionAcquisitionTimeoutError(
    "failed to obtain a connection from the pool within 10.0s (timeout)"
)


def _engines(monkeypatch):
    """get_graphiti hands out the current engine; `replace()` swaps in a new one the
    way a reset by another caller does. Returns (engines handed out, replace)."""
    handed_out = []
    monkeypatch.setattr(graphiti_client, "_graphiti", SimpleNamespace(name="first"))

    async def _get_graphiti():
        handed_out.append(graphiti_client._graphiti)
        return graphiti_client._graphiti

    def replace():
        graphiti_client._graphiti = SimpleNamespace(name="replacement")

    async def _no_reset(_seen):
        raise AssertionError("nothing may be reset for this error")

    monkeypatch.setattr(graphiti_client, "get_graphiti", _get_graphiti)
    monkeypatch.setattr(graphiti_client, "_reset_graphiti", _no_reset)
    monkeypatch.setattr(main, "get_graphiti", _get_graphiti)
    monkeypatch.setattr(main, "_reset_graphiti", _no_reset)
    return handed_out, replace


def _entity_lookups(monkeypatch, *steps):
    """Each node lookup runs the next step: (replace_first, error to raise). When the
    steps run out the entity is not found, which answers None."""
    handed_out, replace = _engines(monkeypatch)
    pending = list(steps)

    async def _get_by_uuid(_driver, _uuid):
        if not pending:
            raise NodeNotFoundError("ent-1")
        replace_first, error = pending.pop(0)
        if replace_first:
            replace()
        raise error

    monkeypatch.setattr(EntityNode, "get_by_uuid", _get_by_uuid)
    return handed_out


def test_entity_lookup_on_an_engine_another_caller_closed_retries_on_the_replacement(monkeypatch):
    handed_out = _entity_lookups(monkeypatch, (True, DRIVER_CLOSED))

    assert asyncio.run(graphiti_client.get_entity_with_facts("org_1", "ent-1")) is None
    assert [engine.name for engine in handed_out] == ["first", "replacement"]


def test_entity_lookup_driver_closed_on_the_current_engine_is_raised_not_retried(monkeypatch):
    handed_out = _entity_lookups(monkeypatch, (False, DRIVER_CLOSED))

    with pytest.raises(DriverError, match="Driver closed"):
        asyncio.run(graphiti_client.get_entity_with_facts("org_1", "ent-1"))
    assert len(handed_out) == 1


def test_entity_lookup_driver_closed_twice_is_raised_after_one_retry(monkeypatch):
    handed_out = _entity_lookups(monkeypatch, (True, DRIVER_CLOSED), (True, DRIVER_CLOSED))

    with pytest.raises(DriverError, match="Driver closed"):
        asyncio.run(graphiti_client.get_entity_with_facts("org_1", "ent-1"))
    assert len(handed_out) == 2


def test_entity_lookup_on_a_busy_pool_is_raised_even_when_the_engine_was_replaced(monkeypatch):
    handed_out = _entity_lookups(monkeypatch, (True, POOL_TIMEOUT))

    with pytest.raises(ConnectionAcquisitionTimeoutError):
        asyncio.run(graphiti_client.get_entity_with_facts("org_1", "ent-1"))
    assert len(handed_out) == 1


def test_search_driver_closed_on_the_current_engine_is_raised_not_retried(monkeypatch):
    handed_out, _replace = _engines(monkeypatch)

    async def _search(_engine):
        raise DRIVER_CLOSED

    with pytest.raises(DriverError, match="Driver closed"):
        asyncio.run(main._graphiti_with_retry(_search))
    assert len(handed_out) == 1


def test_search_whose_engine_build_fails_with_driver_error_is_not_retried(monkeypatch):
    """No engine was handed out, so nothing this caller held was replaced."""
    _engines(monkeypatch)
    builds = []

    async def _failing_build():
        builds.append(1)
        raise DRIVER_CLOSED

    monkeypatch.setattr(main, "get_graphiti", _failing_build)

    with pytest.raises(DriverError, match="Driver closed"):
        asyncio.run(main._graphiti_with_retry(lambda _engine: None))
    assert len(builds) == 1


def test_search_on_a_busy_pool_answers_503_even_when_the_engine_was_replaced(monkeypatch):
    handed_out, replace = _engines(monkeypatch)

    async def _search(_engine):
        replace()
        raise POOL_TIMEOUT

    with pytest.raises(HTTPException) as answered:
        asyncio.run(main._graphiti_with_retry(_search))
    assert answered.value.status_code == 503
    assert len(handed_out) == 1


def test_raw_query_on_a_busy_pool_is_raised_even_when_the_driver_was_replaced(monkeypatch):
    class _Driver:
        def __init__(self):
            self.sessions = 0

        def session(self, **_kwargs):
            self.sessions += 1

            class _Session:
                async def __aenter__(self):
                    # Another caller's reset replaces the driver while this one waits.
                    graphiti_client._driver = _Driver()
                    return self

                async def __aexit__(self, *_exc):
                    return False

            return _Session()

        async def close(self):
            raise AssertionError("a busy pool must not close the driver")

    first = _Driver()
    monkeypatch.setattr(graphiti_client, "_driver", first)
    queries = []

    async def _query(_session):
        queries.append(1)
        raise POOL_TIMEOUT

    with pytest.raises(ConnectionAcquisitionTimeoutError):
        asyncio.run(graphiti_client._run_with_retry(_query))
    assert len(queries) == 1
