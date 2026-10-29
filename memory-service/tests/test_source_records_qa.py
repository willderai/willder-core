"""QA: POST /sources/records keeps one org's count out of an org whose id starts the same.

NEO4J_DELETE_TEST_URI=bolt://127.0.0.1:17687 python -m pytest tests/test_source_records_qa.py

Org "a" partitions are `a`, `org_a` and `org_a-*`. Org "ab" partitions are `ab`, `org_ab`
and `org_ab-*`, and `org_ab-support` starts with `org_a`. The source id is the same in both
orgs, as the stamp is all the count matches on. Each case seeds the real graph and asks the
real route; setup and safety rules match test_source_records_integration.py.
"""

import asyncio

from test_source_records_integration import (
    EDGES,
    GROUP,
    NODES,
    SOURCE,
    URI,  # noqa: F401  (the skip below reads it through pytestmark)
    ZERO,
    _groups,
    _records_body,
    _run,
    _stamp,
    pytestmark,  # noqa: F401
)

PREFIX_GROUP = "org_ab-support"

PREFIX_NODES = NODES + [
    (
        "Episodic",
        "ep-ab",
        PREFIX_GROUP,
        {"content": "Prefix tenant.", "source_description": _stamp(SOURCE)},
    ),
    (
        "Episodic",
        "ep-ab-root",
        "org_ab",
        {"content": "Prefix tenant root.", "source_description": _stamp(SOURCE)},
    ),
    (
        "Episodic",
        "ep-ab-bare",
        "ab",
        {"content": "Prefix tenant bare.", "source_description": _stamp(SOURCE)},
    ),
    ("Entity", "ab-x", PREFIX_GROUP, {"name": "X"}),
    ("Entity", "ab-y", PREFIX_GROUP, {"name": "Y"}),
]
PREFIX_EDGES = EDGES + [
    ("MENTIONS", "m-ab-x", "ep-ab", "ab-x", PREFIX_GROUP, {}),
    (
        "RELATES_TO",
        "f-ab",
        "ab-x",
        "ab-y",
        PREFIX_GROUP,
        {"fact": "Prefix tenant fact", "episodes": ["ep-ab"], "fact_embedding": [0.1]},
    ),
]


def test_an_org_whose_id_extends_this_ones_is_not_counted(monkeypatch):
    [answer] = asyncio.run(
        _run(
            monkeypatch,
            nodes=PREFIX_NODES,
            edges=PREFIX_EDGES,
            steps=[
                ("records", _records_body()),
            ],
        )
    )

    groups = _groups(answer)
    assert not any(g in groups for g in (PREFIX_GROUP, "org_ab", "ab"))
    assert groups[GROUP] == {
        **ZERO,
        "episodes": 1,
        "facts": 3,
        "fact_embeddings": 3,
        "verbatim_nodes": 1,
    }


def test_the_other_org_still_counts_its_own(monkeypatch):
    # The same graph, asked by org "ab": its three episodes and one fact, and none of org a's.
    [answer] = asyncio.run(
        _run(
            monkeypatch,
            nodes=PREFIX_NODES,
            edges=PREFIX_EDGES,
            steps=[
                ("records", _records_body(org_id="ab", group_ids=(PREFIX_GROUP,))),
            ],
        )
    )

    assert _groups(answer) == {
        "ab": {**ZERO, "episodes": 1},
        "org_ab": {**ZERO, "episodes": 1},
        PREFIX_GROUP: {**ZERO, "episodes": 1, "facts": 1, "fact_embeddings": 1},
    }


def test_a_group_of_an_org_whose_id_extends_this_ones_is_refused(monkeypatch):
    answers = asyncio.run(
        _run(
            monkeypatch,
            steps=[
                ("records", _records_body(group_ids=(PREFIX_GROUP,))),
                ("records", _records_body(group_ids=("org_ab",))),
                ("records", _records_body(group_ids=("ab",))),
            ],
        )
    )

    assert [a.status_code for a in answers] == [422, 422, 422]


class _SlowBetweenQueries:
    """Wraps a real transaction so the client idles before each query: every query is fast,
    only the whole read is long. A per-query timeout never fires on it; a transaction one does."""

    def __init__(self, tx, pause_s):
        self._tx = tx
        self._pause_s = pause_s

    async def run(self, query, **params):
        await asyncio.sleep(self._pause_s)
        return await self._tx.run(query, **params)

    async def __aenter__(self):
        await self._tx.__aenter__()
        return self

    async def __aexit__(self, *exc):
        return await self._tx.__aexit__(*exc)


def test_the_real_server_stops_the_whole_count_not_each_query(monkeypatch):
    # Four fast queries with 1.5 s of client idle before each, under a 1 s deadline: only a
    # deadline on the whole read stops this. Neo4j checks transaction deadlines every 2 s.
    import pytest
    from neo4j import AsyncGraphDatabase
    from neo4j.exceptions import Neo4jError

    from app import graphiti_client
    from app.config import settings
    from app.graph import residue

    driver = AsyncGraphDatabase.driver(URI, auth=None)
    real_session = driver.session

    class _Session:
        def __init__(self, **kwargs):
            self._session = real_session(**kwargs)

        async def begin_transaction(self, **kwargs):
            return _SlowBetweenQueries(await self._session.begin_transaction(**kwargs), 1.5)

        async def run(self, query, **params):
            await asyncio.sleep(1.5)
            return await self._session.run(query, **params)

        async def __aenter__(self):
            await self._session.__aenter__()
            return self

        async def __aexit__(self, *exc):
            return await self._session.__aexit__(*exc)

    class _Driver:
        def session(self, **kwargs):
            return _Session(**kwargs)

    async def initialized():
        pass

    monkeypatch.setattr(graphiti_client, "get_graphiti", initialized)
    monkeypatch.setattr(graphiti_client, "get_driver", lambda: _Driver())
    monkeypatch.setattr(settings, "neo4j_database", "neo4j")
    monkeypatch.setattr(residue, "SOURCE_RECORDS_TIMEOUT_S", 1.0)

    async def count():
        try:
            return await graphiti_client.count_source_records("a", SOURCE, [GROUP])
        finally:
            await driver.close()

    with pytest.raises(Neo4jError) as stopped:
        asyncio.run(count())
    assert "terminated" in str(stopped.value).lower() or "timeout" in str(stopped.value).lower()
