"""Unit tests for graphiti_client internals that no endpoint test reaches.

`test_api.py`'s two fallback-provenance tests monkeypatch
`main.ensure_graph_visible` away entirely, so they prove only that `/ingest`
and `/ingest-bulk` PASS the provenance JSON down. They do not cover
`ensure_graph_visible()` actually storing it on the fallback `RELATES_TO`
edge, the only property `fetch_edge_provenance()` reads: reverting that edge
write to omit `source_description` on the edge entirely must turn this suite
red, or the mock is honest about the field while nothing proves the real
writer emits it.

These drive the REAL `ensure_graph_visible` against a fake Neo4j driver that
records the Cypher and its bound parameters, which is as close to the stored
property as this suite gets without a live graph (the live round-trip is
`test_integration.py`, opt-in). Asserting the parameter alone would NOT catch
a bound-but-unused parameter, so these assert the parameter AND that the
edge's own property map binds it.
"""

import asyncio
import json
from datetime import datetime, timezone

import pytest

from app import graphiti_client
from graphiti_core import graphiti as graphiti_module
from graphiti_core.edges import EntityEdge
from graphiti_core.graphiti import Graphiti
from graphiti_core.search.search_config import SearchResults
from graphiti_core.search.search_config_recipes import EDGE_HYBRID_SEARCH_RRF
from graphiti_core.search.search_filters import edge_search_filter_query_constructor
from graphiti_core.driver.driver import GraphProvider
from graphiti_core.errors import NodeNotFoundError
from graphiti_core.nodes import EntityNode
from neo4j.exceptions import ClientError, ServiceUnavailable


class _FakeSession:
    """Records every Cypher call. Mirrors the `async with ... as session` +
    `await session.run(query, **params)` shape `_run_with_retry` uses, and
    `session.execute_write(fn)`, which runs fn once with the session as its
    transaction."""

    def __init__(self, calls):
        self._calls = calls

    async def run(self, query, **params):
        self._calls.append((query, params))
        return _FakeSingleResult(None)

    async def execute_write(self, fn):
        return await fn(self)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class _FakeDriver:
    def __init__(self, calls):
        self._calls = calls

    def session(self, **_kwargs):
        return _FakeSession(self._calls)


class _FakeSingleResult:
    def __init__(self, record):
        self._record = record

    async def single(self):
        return self._record

    async def consume(self):
        return None


class _FakeDeleteSession:
    """Same call-recording shape as `_FakeSession`, but `run()` returns an
    object supporting `.single()` — what `remove_episode_facts`'s
    `RETURN size(rels) AS removed` statement needs, and what plain
    `_FakeSession` (built for `ensure_graph_visible`, which never reads a
    return value) does not provide.

    `matched` holds the (group_id, episode_uuid) pairs that "exist" — modeling
    Neo4j's real AND-filter semantics for a `WHERE r.group_id = $group_id AND
    $episode_uuid IN r.episodes` match, so a query that silently drops the
    group_id predicate (and would therefore match on uuid alone, cross-tenant)
    is exactly what these tests must be able to catch."""

    def __init__(self, calls, matched: set[tuple[str, str]]):
        self._calls = calls
        self._matched = matched

    async def run(self, query, **params):
        self._calls.append((query, params))
        pair = (params.get("group_id"), params.get("episode_uuid"))
        removed = 1 if pair in self._matched else 0
        return _FakeSingleResult({"removed": removed})

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class _FakeDeleteDriver:
    def __init__(self, calls, matched: set[tuple[str, str]]):
        self._calls = calls
        self._matched = matched

    def session(self, **_kwargs):
        return _FakeDeleteSession(self._calls, self._matched)


class _FakeEmbedder:
    async def create(self, _content):
        return [0.1, 0.2, 0.3]


class _FakeGraphiti:
    embedder = _FakeEmbedder()


@pytest.fixture
def cypher_calls(monkeypatch):
    """Capture what `ensure_graph_visible` actually writes."""
    calls: list[tuple[str, dict]] = []

    async def _get_graphiti():
        return _FakeGraphiti()

    monkeypatch.setattr(graphiti_client, "get_graphiti", _get_graphiti)
    monkeypatch.setattr(graphiti_client, "get_driver", lambda: _FakeDriver(calls))
    return calls


def _edge_creation(query: str) -> str:
    """What the statement sets on the fallback edge it creates, so an `$edge` binding
    somewhere else in the statement (or on the Fact node) can't pass for one on the
    edge that `/search`'s provenance lookup reads."""
    start = query.index("MERGE (fact)-[r:RELATES_TO")
    return query[start:]


def test_fallback_edge_stores_source_description_on_the_edge(cypher_calls):
    provenance = json.dumps(
        {"actor_type": "human", "actor_id": "user_42", "actor_name": "Jane Doe"}
    )

    # asyncio.run rather than an async test: this suite has no pytest-asyncio
    # (requirements-dev.txt is pytest + httpx only), same pattern as
    # test_integration.py's own round-trip.
    asyncio.run(
        graphiti_client.ensure_graph_visible(
            group_id="org_1",
            content="the board approved the raise",
            episode_uuid="ep-123",
            source_description=provenance,
        )
    )

    assert len(cypher_calls) == 1
    query, params = cypher_calls[0]

    # The edge is created with the `$edge` map — this is the assertion that
    # fails if the round-2 fix is reverted.
    assert "ON CREATE SET r += $edge" in _edge_creation(query)

    # And the bound value must be readable by the other half of the feature:
    # fetch_edge_provenance() json.loads this exact string and reads actor_type.
    assert json.loads(params["edge"]["source_description"])["actor_type"] == "human"


def test_decision_label_writes_a_decision_node_carrying_the_verbatim_text(cypher_calls):
    decision = "Decision by Jordan on 2026-09-24: every agent run reads Willder memory after its control check."
    asyncio.run(
        graphiti_client.ensure_graph_visible(
            group_id="org_1",
            content=decision,
            episode_uuid="ep-123",
            node_label="Decision",
        )
    )

    query, params = cypher_calls[0]
    assert "MERGE (fact:Entity:Decision {uuid: $fact_uuid})" in query
    assert "fact.summary = $content" in query
    assert params["content"] == params["edge"]["fact"] == decision
    assert params["edge"]["episodes"] == ["ep-123"]
    assert params["edge"]["fallback"] is False


def test_verbatim_write_refuses_a_label_outside_the_closed_set(cypher_calls):
    # The label is spliced into the Cypher text, so an open value would be an
    # injection point; it must never reach the driver.
    with pytest.raises(ValueError):
        asyncio.run(
            graphiti_client.ensure_graph_visible(
                group_id="org_1",
                content="x",
                node_label="Fact {uuid: 'x'}) DETACH DELETE (n",
            )
        )
    assert cypher_calls == []


@pytest.fixture
def delete_episode_calls(monkeypatch):
    """Capture what `remove_episode_facts` actually sends to Neo4j, with a fake
    driver whose `run()` reports a match only for (group_id, episode_uuid)
    pairs in `matched` — see `_FakeDeleteSession` for why the pair, not just
    the uuid, matters."""
    calls: list[tuple[str, dict]] = []
    matched: set[tuple[str, str]] = set()

    async def _get_graphiti():
        return _FakeGraphiti()

    monkeypatch.setattr(graphiti_client, "get_graphiti", _get_graphiti)
    monkeypatch.setattr(graphiti_client, "get_driver", lambda: _FakeDeleteDriver(calls, matched))
    return calls, matched


def test_remove_episode_facts_binds_group_id_and_episode_uuid(delete_episode_calls):
    """Retiring an episode's facts must be tenant-scoped from the start, not
    accept a group_id and silently never use it, the same gap class
    remove_fact/remove_entity had elsewhere in this file."""
    calls, matched = delete_episode_calls
    matched.add(("org_1", "ep-1"))

    removed = asyncio.run(graphiti_client.remove_episode_facts("org_1", "ep-1"))

    assert removed == 1
    assert len(calls) == 1
    query, params = calls[0]
    assert params["group_id"] == "org_1"
    assert params["episode_uuid"] == "ep-1"
    # The predicate itself must be IN the MATCH/WHERE clause, not merely bound
    # and ignored — the same defect class found elsewhere in this file.
    assert "r.group_id = $group_id" in query
    assert "$episode_uuid IN r.episodes" in query


def test_remove_episode_facts_guard_removal_differential(delete_episode_calls):
    """The SAME episode uuid exists for org_1 only (per the fixture's `matched`
    set). A caller passing org_2 must retire nothing, even though the uuid is
    real — pins that `group_id` is threaded per-call, not fixed/ignored. Note:
    this fake session's `removed` outcome is driven by the fixture's `matched`
    set membership, not by actually parsing the Cypher, so on its own it can't
    catch the real query silently dropping the group_id predicate — that's
    what `test_remove_episode_facts_binds_group_id_and_episode_uuid`'s literal
    `"r.group_id = $group_id" in query` assertion is for: deleting
    `r.group_id = $group_id AND` from the real query in graphiti_client.py
    must turn THAT test red."""
    calls, matched = delete_episode_calls
    matched.add(("org_1", "ep-1"))

    same_tenant = asyncio.run(graphiti_client.remove_episode_facts("org_1", "ep-1"))
    cross_tenant = asyncio.run(graphiti_client.remove_episode_facts("org_2", "ep-1"))

    assert same_tenant == 1
    assert cross_tenant == 0
    assert calls[1][1]["group_id"] == "org_2"


def test_remove_episode_facts_zero_for_an_episode_with_no_facts(delete_episode_calls):
    removed = asyncio.run(graphiti_client.remove_episode_facts("org_1", "ep-empty"))
    assert removed == 0


class _FakeGroupDeleteSession:
    """Same shape as `_FakeDeleteSession`, but `matched` holds group_ids
    directly (no episode uuid) — modeling `remove_group_facts`'s single
    `WHERE r.group_id = $group_id` predicate, with no second field to drop."""

    def __init__(self, calls, matched: set[str]):
        self._calls = calls
        self._matched = matched

    async def run(self, query, **params):
        self._calls.append((query, params))
        removed = 1 if params.get("group_id") in self._matched else 0
        return _FakeSingleResult({"removed": removed})

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class _FakeGroupDeleteDriver:
    def __init__(self, calls, matched: set[str]):
        self._calls = calls
        self._matched = matched

    def session(self, **_kwargs):
        return _FakeGroupDeleteSession(self._calls, self._matched)


@pytest.fixture
def delete_group_calls(monkeypatch):
    calls: list[tuple[str, dict]] = []
    matched: set[str] = set()

    async def _get_graphiti():
        return _FakeGraphiti()

    monkeypatch.setattr(graphiti_client, "get_graphiti", _get_graphiti)
    monkeypatch.setattr(
        graphiti_client, "get_driver", lambda: _FakeGroupDeleteDriver(calls, matched)
    )
    return calls, matched


def test_remove_group_facts_binds_group_id(delete_group_calls):
    """Purging a whole disconnected source's content must stay tenant/scope-
    scoped from the start, the same discipline `remove_episode_facts`
    establishes elsewhere, not accept a group_id and silently never use it."""
    calls, matched = delete_group_calls
    matched.add("org_1.slack_general")

    removed = asyncio.run(graphiti_client.remove_group_facts("org_1.slack_general"))

    assert removed["facts"] == 1
    assert len(calls) == 1
    query, params = calls[0]
    assert params["group_id"] == "org_1.slack_general"
    # The predicate itself must be IN the MATCH/WHERE clause, not merely bound
    # and ignored — the same defect class found elsewhere in this file.
    assert "r.group_id = $group_id" in query


def test_remove_group_facts_guard_removal_differential(delete_group_calls):
    """The SAME scope's facts exist for org_1.slack_general only (per the
    fixture's `matched` set). A caller passing a different scope/tenant must
    retire nothing, even though facts genuinely exist elsewhere in the graph —
    pins that `group_id` is threaded per-call, not fixed/ignored. Manually
    confirmed: replacing the real query's `WHERE r.group_id = $group_id` with
    an unconditional match (deleting every RELATES_TO edge regardless of
    scope) turns this test red; restored before commit."""
    calls, matched = delete_group_calls
    matched.add("org_1.slack_general")

    same_scope = asyncio.run(graphiti_client.remove_group_facts("org_1.slack_general"))
    other_scope = asyncio.run(graphiti_client.remove_group_facts("org_2.slack_general"))

    assert same_scope["facts"] == 1
    assert other_scope["facts"] == 0
    assert calls[1][1]["group_id"] == "org_2.slack_general"


def test_remove_group_facts_zero_for_a_group_with_no_facts(delete_group_calls):
    removed = asyncio.run(graphiti_client.remove_group_facts("org_1.empty_source"))
    assert removed["facts"] == 0


class _FakeAsyncIterResult:
    """Models a Neo4j streaming result for `async for rec in result` — what
    `remove_group_facts`'s source_id-scoped SELECT step consumes, same shape
    `graph_for_group`/`fetch_edge_provenance` already use against the real
    driver (see their own `async for rec in result` loops)."""

    def __init__(self, records: list[dict]):
        self._records = records

    def __aiter__(self):
        return self._iter()

    async def _iter(self):
        for rec in self._records:
            yield rec


class _FakeSourceMarkerSession:
    """Models `remove_group_facts`'s source_id path — a group_id-scoped SELECT
    of edges and of the group's episodes, then one write transaction keyed on
    the resulting uuid lists. `edges` is a real dict so a test can inspect
    survivors after the call: assert against actual surviving rows, not
    argument assertions. The node retirement in that transaction is covered
    against a real Neo4j in test_source_retirement_integration.py; here it
    only answers empty."""

    def __init__(self, calls, edges: dict[str, list[dict]], episodes: dict[str, dict[str, str]]):
        self._calls = calls
        self._edges = edges
        self._episodes = episodes

    async def execute_write(self, work):
        return await work(self)

    async def begin_transaction(self, timeout=None):
        return self

    def _exists(self, episode_uuid: str) -> bool:
        return any(episode_uuid in group for group in self._episodes.values())

    async def run(self, query, **params):
        self._calls.append((query, params))
        group_id = params.get("group_id")
        group_edges = self._edges.get(group_id, [])
        # Episodes are read only from the edge's own group, as the real query does.
        episodes = self._episodes.get(group_id, {})
        if "RETURN r.uuid AS uuid, r.source_description AS source_description" in query:
            return _FakeAsyncIterResult(
                [
                    {
                        "uuid": e["uuid"],
                        "source_description": e["source_description"],
                        "episode_order": e.get("episodes", []),
                        "episodes": [
                            [u, episodes[u]] for u in e.get("episodes", []) if u in episodes
                        ],
                        "existing_episodes": [u for u in e.get("episodes", []) if self._exists(u)],
                    }
                    for e in group_edges
                ]
            )
        if "RETURN ep.uuid AS uuid, ep.source_description AS source_description" in query:
            return _FakeAsyncIterResult(
                [
                    {"uuid": u, "source_description": desc}
                    for u, desc in episodes.items()
                    if params["stamp_value"] in (desc or "")
                ]
            )
        if "SET r.episodes" in query:
            own = set(params["own_episodes"])
            for e in group_edges:
                if e["uuid"] in params["prune_uuids"]:
                    e["episodes"] = [u for u in e.get("episodes", []) if u not in own]
            return _FakeSingleResult(None)
        if "r.uuid IN $dead_uuids" in query and "FOREACH" in query:
            before = len(group_edges)
            group_edges[:] = [
                e
                for e in group_edges
                if e["uuid"] not in params["dead_uuids"]
                or any(self._exists(u) for u in e.get("episodes", []))
            ]
            return _FakeSingleResult({"removed": before - len(group_edges), "ends": []})
        if "FOREACH (x IN rels | DELETE x)" in query:
            before = len(group_edges)
            group_edges[:] = [e for e in group_edges if e["uuid"] not in params["delete_uuids"]]
            return _FakeSingleResult({"removed": before - len(group_edges)})
        if "DETACH DELETE ep" in query:
            gone = [u for u in params["own_episodes"] if u in episodes]
            for u in gone:
                del episodes[u]
            return _FakeSingleResult({"removed": len(gone)})
        return _FakeSingleResult({"uuids": [], "cleared": 0, "verbatim": 0, "entities": 0})

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class _FakeSourceMarkerDriver:
    def __init__(self, calls, edges, episodes):
        self._calls = calls
        self._edges = edges
        self._episodes = episodes

    def session(self, **_kwargs):
        return _FakeSourceMarkerSession(self._calls, self._edges, self._episodes)


@pytest.fixture
def source_marker_graph(monkeypatch):
    """Edges by group, and each group's episode provenance by episode uuid."""
    calls: list[tuple[str, dict]] = []
    edges: dict[str, list[dict]] = {}
    episodes: dict[str, dict[str, str]] = {}

    async def _get_graphiti():
        return _FakeGraphiti()

    monkeypatch.setattr(graphiti_client, "get_graphiti", _get_graphiti)
    monkeypatch.setattr(
        graphiti_client, "get_driver", lambda: _FakeSourceMarkerDriver(calls, edges, episodes)
    )
    return calls, edges, episodes


@pytest.fixture
def source_marker_calls(source_marker_graph):
    calls, edges, _episodes = source_marker_graph
    return calls, edges


def test_remove_group_facts_with_source_id_purges_only_the_matching_edge(source_marker_calls):
    """A shared scope, two producers: only the edge stamped with the given
    source_id is removed. The co-located producer's edge (src_figma) and a
    completely unmarked legacy/pre-migration edge both survive — this must
    neither over-preserve (refuse the whole scope) nor over-delete (purge the
    whole scope)."""
    calls, edges = source_marker_calls
    edges["org_1.engineering"] = [
        {"uuid": "e1", "source_description": json.dumps({"source_id": "src_slack"})},
        {"uuid": "e2", "source_description": json.dumps({"source_id": "src_figma"})},
        {"uuid": "e3", "source_description": "{}"},
    ]

    removed = asyncio.run(
        graphiti_client.remove_group_facts("org_1.engineering", source_id="src_slack")
    )

    assert removed["facts"] == 1
    assert {e["uuid"] for e in edges["org_1.engineering"]} == {"e2", "e3"}


def test_remove_group_facts_with_source_id_no_match_removes_nothing_and_skips_the_delete_call(
    source_marker_calls,
):
    """Zero matching edges must not even issue the delete query — proves the
    short-circuit is real, not just a same-outcome coincidence."""
    calls, edges = source_marker_calls
    edges["org_1.engineering"] = [
        {"uuid": "e1", "source_description": json.dumps({"source_id": "src_figma"})},
    ]

    removed = asyncio.run(
        graphiti_client.remove_group_facts("org_1.engineering", source_id="src_slack")
    )

    assert removed == {
        "facts": 0,
        "episodes": 0,
        "verbatim_nodes": 0,
        "entities": 0,
        "summaries": 0,
    }
    assert len(edges["org_1.engineering"]) == 1
    # Only the two selects ran; no write transaction was opened.
    assert len(calls) == 2


def test_remove_group_facts_with_source_id_survives_malformed_source_description(
    source_marker_calls,
):
    """A non-JSON source_description (any pre-provenance-JSON edge, if one
    ever existed) must not crash the purge — treated as no match, same as an
    edge with no source_id key at all."""
    calls, edges = source_marker_calls
    edges["org_1.engineering"] = [
        {"uuid": "e1", "source_description": "not json"},
        {"uuid": "e2", "source_description": json.dumps({"source_id": "src_slack"})},
    ]

    removed = asyncio.run(
        graphiti_client.remove_group_facts("org_1.engineering", source_id="src_slack")
    )

    assert removed["facts"] == 1
    assert {e["uuid"] for e in edges["org_1.engineering"]} == {"e1"}


def test_remove_group_facts_with_source_id_select_stays_group_scoped(source_marker_calls):
    """The same source_id can legitimately exist in another org's/scope's
    group — the select step's own group_id predicate must stop it from
    being reached, the same tenant/scope discipline every other function in
    this file enforces."""
    calls, edges = source_marker_calls
    edges["org_1.engineering"] = [
        {"uuid": "e1", "source_description": json.dumps({"source_id": "src_slack"})},
    ]
    edges["org_1.sales"] = [
        {"uuid": "e2", "source_description": json.dumps({"source_id": "src_slack"})},
    ]

    removed = asyncio.run(
        graphiti_client.remove_group_facts("org_1.engineering", source_id="src_slack")
    )

    assert removed["facts"] == 1
    assert len(edges["org_1.sales"]) == 1

    select_query = calls[0][0]
    assert "r.group_id = $group_id" in select_query


def _episode(source_id):
    return json.dumps({"actor_type": "extraction", "source_id": source_id})


def test_remove_group_facts_with_source_id_removes_an_extracted_edge_by_its_episode(
    source_marker_graph,
):
    """Graphiti's extractor writes edges with no source_description; the
    source_id is only on the episode that asserted them (the citation fix in
    fetch_edge_provenance reads it there). Disconnect must read it there too,
    or a disconnected connector's extracted facts stay retrievable and keep
    citing the source. Without the episode lookup, e1 survives."""
    calls, edges, episodes = source_marker_graph
    episodes["org_1.engineering"] = {
        "ep_gh": _episode("src_github"),
        "ep_other": _episode("src_slack"),
    }
    edges["org_1.engineering"] = [
        {"uuid": "e1", "source_description": None, "episodes": ["ep_gh"]},
        {"uuid": "e2", "source_description": None, "episodes": ["ep_other"]},
    ]

    removed = asyncio.run(
        graphiti_client.remove_group_facts("org_1.engineering", source_id="src_github")
    )

    assert removed["facts"] == 1
    assert [e["uuid"] for e in edges["org_1.engineering"]] == ["e2"]


def test_remove_group_facts_deletes_an_edge_this_source_created_that_another_episode_also_asserts(
    source_marker_graph,
):
    """Graphiti writes an edge's text from the episode that created it (the first
    in `episodes`) and only appends a later episode it judges a duplicate. So an
    edge this source created still says what this source said, however many
    episodes later matched it: disconnect deletes it. Keeping it (the old rule)
    left the source's sentence answering on production with no citation at all
    once this source's episodes came off it."""
    calls, edges, episodes = source_marker_graph
    episodes["org_1.engineering"] = {
        "ep_gh": _episode("src_github"),
        "ep_direct": _episode(None),
        "ep_slack": _episode("src_slack"),
    }
    edges["org_1.engineering"] = [
        {"uuid": "e1", "source_description": None, "episodes": ["ep_gh", "ep_direct"]},
        {"uuid": "e2", "source_description": None, "episodes": ["ep_gh", "ep_slack"]},
    ]

    removed = asyncio.run(
        graphiti_client.remove_group_facts("org_1.engineering", source_id="src_github")
    )

    assert removed["facts"] == 2
    assert edges["org_1.engineering"] == []


def test_remove_group_facts_keeps_an_edge_another_producer_created(source_marker_graph):
    """An edge a direct write or a second source created is that producer's text,
    even when this source later asserted it too: it stays, and only this source's
    episodes come off it, so it no longer cites the disconnected source."""
    calls, edges, episodes = source_marker_graph
    episodes["org_1.engineering"] = {
        "ep_gh": _episode("src_github"),
        "ep_direct": _episode(None),
        "ep_slack": _episode("src_slack"),
    }
    edges["org_1.engineering"] = [
        {"uuid": "e1", "source_description": None, "episodes": ["ep_direct", "ep_gh"]},
        {"uuid": "e2", "source_description": None, "episodes": ["ep_slack", "ep_gh"]},
    ]

    removed = asyncio.run(
        graphiti_client.remove_group_facts("org_1.engineering", source_id="src_github")
    )

    assert removed["facts"] == 0
    assert {e["uuid"]: e["episodes"] for e in edges["org_1.engineering"]} == {
        "e1": ["ep_direct"],
        "e2": ["ep_slack"],
    }


def test_remove_group_facts_ignores_an_episode_outside_the_group(source_marker_graph):
    """An edge's `episodes` list is data on the edge. An episode in another
    group that names this source is never read, so it cannot make an edge
    here look like this source's: an edge created by such an episode stays.
    An edge this source created in the group is still this source's, whatever
    unreadable episode was appended after it."""
    calls, edges, episodes = source_marker_graph
    episodes["org_2.engineering"] = {"ep_foreign": _episode("src_github")}
    episodes["org_1.engineering"] = {"ep_gh": _episode("src_github")}
    edges["org_1.engineering"] = [
        {"uuid": "e1", "source_description": None, "episodes": ["ep_foreign"]},
        {"uuid": "e2", "source_description": None, "episodes": ["ep_foreign", "ep_gh"]},
        {"uuid": "e3", "source_description": None, "episodes": ["ep_gh", "ep_foreign"]},
    ]

    removed = asyncio.run(
        graphiti_client.remove_group_facts("org_1.engineering", source_id="src_github")
    )

    assert removed["facts"] == 1
    assert {e["uuid"]: e["episodes"] for e in edges["org_1.engineering"]} == {
        "e1": ["ep_foreign"],
        "e2": ["ep_foreign"],
    }


def test_remove_group_facts_an_edge_own_stamp_outranks_its_episodes(source_marker_graph):
    """A fallback/verbatim edge stamped with another source is that source's,
    whatever its episodes say, the same precedence fetch_edge_provenance uses."""
    calls, edges, episodes = source_marker_graph
    episodes["org_1.engineering"] = {"ep_gh": _episode("src_github")}
    edges["org_1.engineering"] = [
        {
            "uuid": "e1",
            "source_description": json.dumps({"source_id": "src_slack"}),
            "episodes": ["ep_gh"],
        },
    ]

    removed = asyncio.run(
        graphiti_client.remove_group_facts("org_1.engineering", source_id="src_github")
    )

    assert removed["facts"] == 0
    assert edges["org_1.engineering"][0]["episodes"] == ["ep_gh"]


def test_fallback_edge_defaults_to_empty_json_not_null(cypher_calls):
    """A caller with no provenance must still write parseable JSON, never None:
    `fetch_edge_provenance()` does `json.loads(rec[...] or "{}")`, so a null
    property is survivable, but a null here would also mean an unset property on
    every fallback edge written by a path that doesn't pass provenance — which is
    indistinguishable from the round-2 bug when read back."""
    asyncio.run(
        graphiti_client.ensure_graph_visible(
            group_id="org_1",
            content="the job queue uses SQS",
        )
    )

    _query, params = cypher_calls[0]
    assert json.loads(params["edge"]["source_description"]) == {}


def test_remove_group_facts_with_source_id_does_not_match_a_similarly_prefixed_id(
    source_marker_calls,
):
    """`remove_group_facts`'s own docstring gives the reason it parses
    `source_description` as JSON and compares `source_id` for equality,
    rather than doing the cheaper `CONTAINS` substring test in Cypher: a raw
    substring match "could false-positive on a similarly-prefixed id". No
    existing case pins that, because every fixture above uses ids with no
    shared prefix (`src_slack` vs `src_figma`), so swapping the exact
    comparison for `source_id in rec["source_description"]` would keep the
    rest of the suite green while silently deleting a co-located source's
    facts — the exact cross-source data loss this test exists to prevent.

    Two ids where one is a prefix of the other is not a contrived shape:
    `Source.id` values are generated, and a disconnect of `src_a` must not
    reach `src_a2`'s content. Verified to FAIL against the substring
    mutation and PASS against the shipped exact match."""
    calls, edges = source_marker_calls
    edges["org_1.engineering"] = [
        {"uuid": "e1", "source_description": json.dumps({"source_id": "src_a"})},
        {"uuid": "e2", "source_description": json.dumps({"source_id": "src_a2"})},
    ]

    removed = asyncio.run(
        graphiti_client.remove_group_facts("org_1.engineering", source_id="src_a")
    )

    # Only the exactly-matching edge goes; the longer id that merely *contains*
    # the disconnected source's id is a different source and must survive.
    assert removed["facts"] == 1
    assert {e["uuid"] for e in edges["org_1.engineering"]} == {"e2"}


class _FakeGraphSession:
    """Records the Cypher `graph_for_group` runs and answers it with `records`."""

    def __init__(self, calls, records):
        self._calls = calls
        self._records = records

    async def run(self, query, **params):
        self._calls.append((query, params))
        return _FakeAsyncIterResult(self._records)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class _FakeGraphDriver:
    def __init__(self, calls, records=()):
        self._calls = calls
        self._records = list(records)

    def session(self, **_kwargs):
        return _FakeGraphSession(self._calls, self._records)


@pytest.fixture
def graph_cypher_calls(monkeypatch):
    """Capture the Cypher `graph_for_group` actually runs."""
    calls: list[tuple[str, dict]] = []

    async def _get_graphiti():
        return _FakeGraphiti()

    monkeypatch.setattr(graphiti_client, "get_graphiti", _get_graphiti)
    monkeypatch.setattr(graphiti_client, "get_driver", lambda: _FakeGraphDriver(calls))
    return calls


def test_graph_for_group_orders_the_node_window_before_limiting(graph_cypher_calls):
    """A caller that treats this call's fixed-size node window as "the scope's
    current facts" (services/facts/conflicts.ts findScopeContradictions) needs
    that window to be the same set on two reads of an unchanged scope. Without an
    ORDER BY, `WITH n LIMIT $limit` takes whichever `limit` matches come back in —
    not guaranteed stable between calls — so the window itself could drift for no
    real reason, independent of anything actually changing."""
    asyncio.run(graphiti_client.graph_for_group(["org_1.eng"], limit=20))

    query, params = graph_cypher_calls[0]
    assert "ORDER BY n.uuid" in query
    # Ordering has to happen before the cap, or it doesn't stabilize the window.
    assert query.index("ORDER BY n.uuid") < query.index("WITH n LIMIT")
    assert params["gids"] == ["org_1.eng"]
    assert params["limit"] == 20


class _Neo4jTime:
    """A neo4j.time.DateTime as the driver returns it: formatted by iso_format()."""

    def __init__(self, iso):
        self._iso = iso

    def iso_format(self):
        return self._iso


def test_graph_for_group_returns_both_of_graphitis_retirement_marks(monkeypatch):
    """Graphiti retires a contradicted edge by setting `invalid_at` and `expired_at`,
    and an edge may carry `expired_at` alone. The graph view marks a retired edge, so it reads and
    returns both, unset on an edge still in force."""
    calls: list[tuple[str, dict]] = []

    def row(uuid, invalid_at=None, expired_at=None):
        return {
            "n_uuid": "n1",
            "n_name": "Release train",
            "n_labels": ["Entity"],
            "r_uuid": uuid,
            "r_fact": uuid,
            "r_valid_at": None,
            "r_invalid_at": invalid_at,
            "r_expired_at": expired_at,
            "r_source_desc": None,
            "r_group_id": "org_1-eng",
            "r_leaves_n": True,
            "m_uuid": "n2",
            "m_name": "Platform",
            "m_labels": ["Entity"],
        }

    records = [
        row("e-current"),
        row(
            "e-invalidated", _Neo4jTime("2026-01-05T00:00:00Z"), _Neo4jTime("2026-01-06T00:00:00Z")
        ),
        row("e-expired", None, _Neo4jTime("2026-01-06T00:00:00Z")),
    ]

    async def _get_graphiti():
        return _FakeGraphiti()

    monkeypatch.setattr(graphiti_client, "get_graphiti", _get_graphiti)
    monkeypatch.setattr(graphiti_client, "get_driver", lambda: _FakeGraphDriver(calls, records))

    _, edges = asyncio.run(graphiti_client.graph_for_group(["org_1-eng"]))

    query, _ = calls[0]
    assert "r.expired_at AS r_expired_at" in query
    assert {e["uuid"]: (e["invalid_at"], e["expired_at"]) for e in edges} == {
        "e-current": (None, None),
        "e-invalidated": ("2026-01-05T00:00:00Z", "2026-01-06T00:00:00Z"),
        "e-expired": (None, "2026-01-06T00:00:00Z"),
    }


class _FakeProvenanceSession:
    """Models `fetch_edge_provenance`'s one query: RELATES_TO edges by uuid,
    returning the stored `source_description` string as written. An edge with no
    entry in `episodes` has no episode (the OPTIONAL MATCH's collect() of no row
    is one all-null pair); an entry lists the edge's episodes in its own order as
    (uuid, source_description) pairs. The episode fallback also runs against a
    real Neo4j in test_citation_provenance_integration.py."""

    def __init__(
        self,
        stored: dict[str, str | None],
        episodes: dict[str, list[tuple[str, str | None]]] | None = None,
        listed: dict[str, list[str]] | None = None,
    ):
        self._stored = stored
        self._episodes = episodes or {}
        # The edge's own `episodes` list, when it names more than the episodes the
        # query matched (one in another group, or one since deleted).
        self._listed = listed or {}

    def _record(self, uuid: str) -> dict:
        episodes = self._episodes.get(uuid)
        listed = self._listed.get(uuid)
        if not episodes:
            return {
                "uuid": uuid,
                "source_description": self._stored[uuid],
                "episode_order": listed or [],
                "episodes": [[None, None]],
            }
        return {
            "uuid": uuid,
            "source_description": self._stored[uuid],
            "episode_order": listed or [episode_uuid for episode_uuid, _ in episodes],
            "episodes": [[episode_uuid, desc] for episode_uuid, desc in episodes],
        }

    async def run(self, query, **params):
        return _FakeAsyncIterResult([self._record(u) for u in params["uuids"] if u in self._stored])

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


def test_fetch_edge_provenance_reads_actor_and_source_from_the_stamped_json(monkeypatch):
    """The citation fields come from the same JSON ingest() stamps on the edge:
    a connector edge yields its source_id and actor_name, a manual edge its actor
    with no source, and a null or non-object property yields all-None instead of
    failing the lookup for every other edge in the batch."""
    stored = {
        "e-synced": json.dumps(
            {"actor_type": "extraction", "actor_name": "eng-updates", "source_id": "src_1"}
        ),
        "e-manual": json.dumps({"actor_type": "human", "actor_name": "Dana", "source_id": None}),
        "e-null": None,
        "e-list": "[]",
    }

    async def _get_graphiti():
        return _FakeGraphiti()

    class _Driver:
        def session(self, **_kwargs):
            return _FakeProvenanceSession(stored)

    monkeypatch.setattr(graphiti_client, "get_graphiti", _get_graphiti)
    monkeypatch.setattr(graphiti_client, "get_driver", lambda: _Driver())

    got = asyncio.run(graphiti_client.fetch_edge_provenance(list(stored)))

    empty = {
        "actor_type": None,
        "actor_name": None,
        "source_id": None,
        "chunk_ids": [],
        "episode_ids": [],
    }
    assert got == {
        "e-synced": {
            "actor_type": "extraction",
            "actor_name": "eng-updates",
            "source_id": "src_1",
            "chunk_ids": [],
            "episode_ids": [],
        },
        "e-manual": {
            "actor_type": "human",
            "actor_name": "Dana",
            "source_id": None,
            "chunk_ids": [],
            "episode_ids": [],
        },
        "e-null": empty,
        "e-list": empty,
    }


def test_fetch_edge_provenance_collects_the_chunk_id_of_every_asserting_episode(monkeypatch):
    """An edge several ingests asserted is current while any one of them is, so
    `chunk_ids` holds the edge's own stamp and then every episode's, in the
    edge's episode order, each once. A stamp with no chunk_id, an empty one or a
    non-string one adds nothing rather than a placeholder the caller would treat
    as a real row."""
    stored = {
        "e-raced": json.dumps(
            {"actor_type": "agent", "actor_name": "writer", "chunk_id": "chunk_b"}
        ),
        "e-unstamped-edge": None,
    }
    episodes = {
        "e-raced": [
            ("ep-1", json.dumps({"chunk_id": "chunk_a"})),
            ("ep-2", json.dumps({"chunk_id": "chunk_b"})),
            ("ep-3", json.dumps({"chunk_id": ""})),
            ("ep-4", json.dumps({"chunk_id": 7})),
            ("ep-5", None),
        ],
        "e-unstamped-edge": [
            ("ep-6", json.dumps({"source_id": "src_2", "chunk_id": "chunk_c"})),
            ("ep-7", json.dumps({"chunk_id": "chunk_d"})),
        ],
    }

    async def _get_graphiti():
        return _FakeGraphiti()

    class _Driver:
        def session(self, **_kwargs):
            return _FakeProvenanceSession(stored, episodes)

    monkeypatch.setattr(graphiti_client, "get_graphiti", _get_graphiti)
    monkeypatch.setattr(graphiti_client, "get_driver", lambda: _Driver())

    got = asyncio.run(graphiti_client.fetch_edge_provenance(list(stored)))

    assert got == {
        "e-raced": {
            "actor_type": "agent",
            "actor_name": "writer",
            "source_id": None,
            "chunk_ids": ["chunk_b", "chunk_a"],
            "episode_ids": ["ep-1", "ep-2", "ep-3", "ep-4", "ep-5"],
        },
        "e-unstamped-edge": {
            "actor_type": None,
            "actor_name": None,
            "source_id": "src_2",
            "chunk_ids": ["chunk_c", "chunk_d"],
            "episode_ids": ["ep-6", "ep-7"],
        },
    }


def test_fetch_edge_provenance_names_the_episodes_behind_each_edge_in_its_own_order(monkeypatch):
    """A connector sync writes one episode per synced item and its change event
    names that episode, so `episode_ids` is how a caller tells which item a fact
    came from. It lists the episodes the lookup matched (the edge's own group),
    in the edge's order, once each: an episode the edge lists that matched
    nothing, being in another group or deleted since, is not echoed back."""
    stored = {"e-one-item": None, "e-two-items": None, "e-orphaned": None}
    episodes = {
        "e-one-item": [("ep-item", json.dumps({"source_id": "src_1"}))],
        "e-two-items": [("ep-b", None), ("ep-a", None)],
    }
    listed = {
        "e-one-item": ["ep-elsewhere", "ep-item"],
        "e-two-items": ["ep-a", "ep-b", "ep-a"],
        "e-orphaned": ["ep-deleted"],
    }

    async def _get_graphiti():
        return _FakeGraphiti()

    class _Driver:
        def session(self, **_kwargs):
            return _FakeProvenanceSession(stored, episodes, listed)

    monkeypatch.setattr(graphiti_client, "get_graphiti", _get_graphiti)
    monkeypatch.setattr(graphiti_client, "get_driver", lambda: _Driver())

    got = asyncio.run(graphiti_client.fetch_edge_provenance(list(stored)))

    assert {uuid: p["episode_ids"] for uuid, p in got.items()} == {
        "e-one-item": ["ep-item"],
        "e-two-items": ["ep-a", "ep-b"],
        "e-orphaned": [],
    }


class _EngineStub:
    """Runs graphiti_core's own Graphiti.search_ with no graph behind it. The
    library's module-level search() is replaced by the test, so everything from
    search_edges down to the recipe the query receives is the real code."""

    clients = None
    search_ = Graphiti.search_


def test_concurrent_searches_keep_their_own_limit(monkeypatch):
    """A search must return up to its own limit even while another search with a
    different limit is in flight. Graphiti.search() writes num_results onto the
    shared EDGE_HYBRID_SEARCH_RRF recipe and reads it back only after awaiting the
    query embedding, so the service's 3-minute keepalive search (limit 1) could cut
    a concurrent /search down to one fact. The stub pauses the first search at that
    same await until the second one has started."""
    second_started = asyncio.Event()

    async def query_graph(_clients, query, _group_ids, config, *_args, **_kwargs):
        if query == "real":
            await second_started.wait()
        else:
            second_started.set()
        edges = [EntityEdge.model_construct(uuid=f"{query}-{i}") for i in range(20)]
        return SearchResults(edges=edges[: config.limit])

    monkeypatch.setattr(graphiti_module, "search", query_graph)
    shared_limit = EDGE_HYBRID_SEARCH_RRF.limit

    async def both():
        engine = _EngineStub()
        return await asyncio.gather(
            graphiti_client.search_edges(engine, "real", ["org_1"], 10),
            graphiti_client.search_edges(engine, "_keepalive", ["_ping"], 1),
        )

    real, keepalive = asyncio.run(both())

    assert len(real) == 10
    assert len(keepalive) == 1
    assert EDGE_HYBRID_SEARCH_RRF.limit == shared_limit


def test_find_fact_returns_both_of_graphitis_retirement_marks(monkeypatch):
    """The brief-citation check resolves one fact by uuid and asks whether it is still
    current, by the same rule as every other read: it needs `expired_at` as well as
    `invalid_at`."""
    calls: list[tuple[str, dict]] = []
    record = {
        "uuid": "e-1",
        "fact": "Release train leaves Friday",
        "invalid_at": _Neo4jTime("2026-01-05T00:00:00Z"),
        "expired_at": _Neo4jTime("2026-01-06T00:00:00Z"),
    }

    class _Session(_FakeSession):
        async def run(self, query, **params):
            self._calls.append((query, params))
            return _FakeSingleResult(record)

    class _Driver(_FakeDriver):
        def session(self, **_kwargs):
            return _Session(self._calls)

    async def _get_graphiti():
        return _FakeGraphiti()

    monkeypatch.setattr(graphiti_client, "get_graphiti", _get_graphiti)
    monkeypatch.setattr(graphiti_client, "get_driver", lambda: _Driver(calls))

    found = asyncio.run(graphiti_client.find_fact("org_1-eng", "e-1"))

    assert "r.expired_at AS expired_at" in calls[0][0]
    assert found == (
        "e-1",
        "Release train leaves Friday",
        "2026-01-05T00:00:00Z",
        "2026-01-06T00:00:00Z",
    )


def test_search_edges_leaves_out_edges_whose_end_has_passed(monkeypatch):
    """/search spends its limit on the edges the query returns. An edge whose
    `invalid_at` has passed is not current, so the query leaves it out rather than
    letting it take a place a current fact would fill. An edge true until a later date
    stays, though Graphiti sets `expired_at` on it the moment it records that date."""
    seen = {}

    async def query_graph(_clients, _query, _group_ids, _config, search_filter, *_args, **_kwargs):
        seen["filter"] = search_filter
        return SearchResults(edges=[])

    monkeypatch.setattr(graphiti_module, "search", query_graph)
    before = datetime.now(timezone.utc)

    asyncio.run(graphiti_client.search_edges(_EngineStub(), "release train", ["org_1"], 10))

    queries, params = edge_search_filter_query_constructor(seen["filter"], GraphProvider.NEO4J)
    assert queries == ["((e.invalid_at IS NULL) OR (e.invalid_at > $invalid_at_0))"]
    assert before <= params["invalid_at_0"] <= datetime.now(timezone.utc)


def _entity_lookup(monkeypatch, *failures):
    """Point `get_entity_with_facts` at a node lookup that raises each of `failures`
    in turn, then finds nothing more to raise. Returns how many lookups ran."""
    lookups = []
    pending = list(failures)

    async def _get_graphiti():
        return _FakeGraphiti()

    async def _get_by_uuid(_driver, uuid):
        lookups.append(uuid)
        raise pending.pop(0) if pending else AssertionError("no lookup expected")

    async def _reset(_seen):
        return None

    monkeypatch.setattr(graphiti_client, "get_graphiti", _get_graphiti)
    monkeypatch.setattr(graphiti_client, "_reset_graphiti", _reset)
    monkeypatch.setattr(EntityNode, "get_by_uuid", _get_by_uuid)
    return lookups


def test_get_entity_with_facts_answers_none_for_an_entity_the_graph_does_not_hold(monkeypatch):
    """graphiti-core raises NodeNotFoundError for an unknown uuid; that is the one
    exception meaning "not found"."""
    _entity_lookup(monkeypatch, NodeNotFoundError("ent-missing"))

    assert asyncio.run(graphiti_client.get_entity_with_facts(["org_1"], "ent-missing")) is None


def test_get_entity_with_facts_raises_a_failed_query_instead_of_answering_not_found(monkeypatch):
    """A broken query is not an absent entity. Answered as None, /entities would say
    404 and the caller would report a real entity as missing."""
    _entity_lookup(monkeypatch, ClientError("Invalid input"))

    with pytest.raises(ClientError):
        asyncio.run(graphiti_client.get_entity_with_facts(["org_1"], "ent-1"))


def test_get_entity_with_facts_raises_when_the_graph_stays_unreachable(monkeypatch):
    """One stale connection is retried on a fresh driver; a second failure means the
    graph is down, which the caller must hear as an error, not as "not found"."""
    lookups = _entity_lookup(
        monkeypatch, ServiceUnavailable("defunct"), ServiceUnavailable("defunct")
    )

    with pytest.raises(ServiceUnavailable):
        asyncio.run(graphiti_client.get_entity_with_facts(["org_1"], "ent-1"))
    assert lookups == ["ent-1", "ent-1"]


def test_get_graphiti_repairs_earlier_role_transfers_once_per_engine(monkeypatch):
    """Holders and copies an earlier transfer_entity_edges wrote stay unloadable until
    repaired, and a scope's duplicated fallback anchors are merged before any write can
    match them, so building the engine runs both, and a reset engine runs them again."""
    steps = []

    class _Engine:
        async def build_indices_and_constraints(self):
            steps.append("indices")

        async def close(self):
            return None

    async def _repair():
        steps.append("repair")
        return 0

    async def _anchors():
        steps.append("anchors")
        return 0

    monkeypatch.setattr(graphiti_client, "_graphiti", _Engine())
    monkeypatch.setattr(graphiti_client, "_indices_built", False)
    monkeypatch.setattr(graphiti_client, "repair_transferred_entities", _repair)
    monkeypatch.setattr(graphiti_client, "ensure_one_fallback_anchor_per_scope", _anchors)

    async def run():
        first = await graphiti_client.get_graphiti()
        await graphiti_client.get_graphiti()
        await graphiti_client._reset_graphiti(first)
        monkeypatch.setattr(graphiti_client, "_graphiti", _Engine())
        await graphiti_client.get_graphiti()

    asyncio.run(run())
    assert steps == ["indices", "repair", "anchors", "indices", "repair", "anchors"]


class _RecordingResult:
    async def data(self):
        return []


class _RecordingTransaction:
    """Records the queries run in it; answers each with no rows."""

    def __init__(self, timeout):
        self.timeout = timeout
        self.queries = []

    async def run(self, query, **_params):
        self.queries.append(query)
        return _RecordingResult()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class _TransactionRecordingSession:
    """Records every transaction begun on it, and refuses a query run outside one."""

    def __init__(self, transactions):
        self._transactions = transactions

    async def begin_transaction(self, timeout=None, **_kwargs):
        tx = _RecordingTransaction(timeout)
        self._transactions.append(tx)
        return tx

    async def run(self, query, **_params):
        raise AssertionError("a source-records query ran outside the bounded transaction")

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


def test_a_source_record_count_is_one_read_under_one_server_side_deadline(monkeypatch):
    # The count reads a whole org's graph in several queries. They run in one transaction
    # the server stops at SOURCE_RECORDS_TIMEOUT_S, so the whole read ends before the app's
    # 20 s wait for it does, however its time is split between the queries.
    transactions = []

    class _Driver:
        def session(self, **_kwargs):
            return _TransactionRecordingSession(transactions)

    async def initialized():
        pass

    monkeypatch.setattr(graphiti_client, "get_graphiti", initialized)
    monkeypatch.setattr(graphiti_client, "get_driver", lambda: _Driver())

    asyncio.run(graphiti_client.count_source_records("a", "src_gh", ["org_a-support"]))

    assert [tx.timeout for tx in transactions] == [graphiti_client.SOURCE_RECORDS_TIMEOUT_S]
    assert len(transactions[0].queries) == 4
    assert 0 < graphiti_client.SOURCE_RECORDS_TIMEOUT_S < 20


@pytest.mark.parametrize(
    ("query", "groups", "keeps_keywords"),
    [
        ("renewal date", 1, True),
        ("renewal date", 60, True),
        ("renewal date", 400, True),
        (" ".join(["word"] * 120), 30, True),
        # Long queries over many groups: the batch bound wins over the keyword half.
        (" ".join(["word"] * 100), 1000, False),
        (" ".join(["word"] * 130), 30, False),
        (" ".join(["word"] * 130), 1000, False),
    ],
)
def test_search_edges_searches_every_group_once_in_a_bounded_number_of_searches(
    monkeypatch, query, groups, keeps_keywords
):
    """A reader granted a scope searches every scope below it, each its own group. Graphiti
    drops the keyword (fulltext) half of a search whose words plus groups reach its query
    limit, so the groups go in batches that keep it, but never more than
    MAX_SEARCH_BATCHES of them, and every group is searched once."""
    from graphiti_core.search.search_utils import fulltext_query

    asked: list[list[str]] = []

    async def query_graph(_clients, _query, group_ids, config, *_args, **_kwargs):
        asked.append(group_ids)
        return SearchResults(
            edges=[
                EntityEdge.model_construct(uuid=f"{g}-{i}", group_id=g)
                for g in group_ids[:2]
                for i in range(2)
            ]
        )

    monkeypatch.setattr(graphiti_module, "search", query_graph)
    group_ids = [f"org_1-s{i:04d}" for i in range(groups)]

    found = asyncio.run(
        graphiti_client.search_edges(_EngineStub(), query, group_ids + group_ids[:1], 10)
    )

    assert sorted(g for batch in asked for g in batch) == sorted(group_ids)
    assert len(asked) <= graphiti_client.MAX_SEARCH_BATCHES
    neo4j_like = type("Driver", (), {"provider": GraphProvider.NEO4J, "fulltext_syntax": ""})()
    assert all(fulltext_query(query, batch, neo4j_like) != "" for batch in asked) == keeps_keywords
    assert len(found) == min(10, sum(min(len(b), 2) * 2 for b in asked))
    # Taken in turn across batches, so the first page holds every batch's best fact.
    assert [edge.uuid for edge in found[: len(asked)]] == [f"{batch[0]}-0" for batch in asked][
        : len(found)
    ]
