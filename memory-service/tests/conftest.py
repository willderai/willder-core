"""Shared fixtures. Endpoint tests mock the Graphiti engine + Neo4j so they're fast
and deterministic (no Groq/Neo4j calls). The real round-trip lives in
test_integration.py (opt-in via RUN_INTEGRATION)."""

import datetime
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app import main
from app.config import settings
from app.extraction_status import ExtractionStatus

API_KEY = "test-key-123"


class _FakeEpisode:
    uuid = "ep-123"


class _FakeAddResult:
    episode = _FakeEpisode()
    nodes: list = []
    edges: list = []


class _FakeEdge:
    """The EntityEdge fields the routes read. `invalid_at` and `expired_at` are
    Graphiti's own retirement marks, unset on an edge still in force."""

    def __init__(
        self, uuid, fact, valid_at=None, invalid_at=None, expired_at=None, group_id="org_1"
    ):
        self.uuid = uuid
        self.fact = fact
        self.group_id = group_id
        self.valid_at = valid_at
        self.invalid_at = invalid_at
        self.expired_at = expired_at


class _FakeNode:
    def __init__(self, uuid, name, summary="", labels=None, group_id="org_1"):
        self.uuid = uuid
        self.name = name
        self.summary = summary
        self.labels = labels or ["Entity", "Company"]
        self.group_id = group_id


class FakeGraphiti:
    """Records calls so tests can assert on args (group_id, actor provenance, etc.)."""

    def __init__(self):
        self.add_calls: list[dict] = []
        self.search_calls: list[dict] = []

    async def add_episode(self, **kwargs):
        self.add_calls.append(kwargs)
        return _FakeAddResult()

    async def search_(self, **kwargs):
        self.search_calls.append(kwargs)
        return SimpleNamespace(
            edges=[
                _FakeEdge(
                    "f1",
                    "Acme's marketing budget is $50,000",
                    datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc),
                )
            ]
        )


def _no_edge_provenance(monkeypatch):
    """Answer the edge-provenance lookup with nothing found: it reads the raw Neo4j driver,
    which these fixtures do not stand up. A test about provenance overrides it."""

    async def _none(uuids):
        return {}

    monkeypatch.setattr(main, "fetch_edge_provenance", _none)


@pytest.fixture(autouse=True)
def _auth_key(monkeypatch):
    monkeypatch.setattr(settings, "graphiti_service_api_key", API_KEY)


@pytest.fixture(autouse=True)
def _fresh_status(monkeypatch):
    """Each test starts with no ingest outcome recorded, so a refusal one test provokes
    cannot turn another test's /health degraded."""
    fresh = ExtractionStatus()
    monkeypatch.setattr(main, "extraction_status", fresh)
    return fresh


@pytest.fixture(autouse=True)
def _no_neo4j(monkeypatch):
    async def _ok():
        return True

    monkeypatch.setattr(main, "neo4j_healthy", _ok)


@pytest.fixture
def fake_graphiti(monkeypatch):
    fake = FakeGraphiti()

    async def _get():
        return fake

    monkeypatch.setattr(main, "get_graphiti", _get)

    # /search's provenance lookup hits the raw Neo4j driver directly,
    # which this fixture doesn't stand up — default it to "nothing found" so
    # existing /search tests don't need to know about it. Tests exercising
    # provenance override `main.fetch_edge_provenance` themselves (see
    # test_search_maps_actor_type).
    async def _no_provenance(uuids):
        return {}

    monkeypatch.setattr(main, "fetch_edge_provenance", _no_provenance)

    # The verbatim node an ingest adds after extraction is written on the raw driver
    # too, and a write that fails answers 503. Stored as asked, unless a test about
    # that write replaces `main.ensure_graph_visible` itself.
    async def _visible(**_kwargs):
        return None

    monkeypatch.setattr(main, "ensure_graph_visible", _visible)
    return fake


@pytest.fixture
def fake_entity(monkeypatch):
    node = _FakeNode("ent-1", "Acme Corp", "A company", ["Entity", "Company"])
    edges = [
        _FakeEdge(
            "f1",
            "Acme is headquartered in Austin",
            datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc),
        )
    ]

    async def _get(group_ids, uuid):
        if uuid == "ent-1" and node.group_id in group_ids:
            return node, edges
        return None

    monkeypatch.setattr(main, "get_entity_with_facts", _get)
    _no_edge_provenance(monkeypatch)
    return node


@pytest.fixture
def fake_graph(monkeypatch):
    async def _g(group_ids, query=None, limit=50):
        if "org_1" not in group_ids:
            return {}, []
        nodes = {
            "n1": {"name": "Acme", "type": "Company"},
            "n2": {"name": "Globex", "type": "Company"},
        }
        edges = [
            {"uuid": "e1", "source": "n1", "target": "n2", "fact": "Acme partners with Globex"}
        ]
        return nodes, edges

    monkeypatch.setattr(main, "graph_for_group", _g)
    _no_edge_provenance(monkeypatch)


@pytest.fixture
def fake_find_entity(monkeypatch):
    async def _find(group_id, name):
        if group_id == "org_1.dealA" and name == "Marcus":
            return "ent-marcus", ["Entity", "Person"]
        # A transfer-created replacement entity can exist with no uuid —
        # transfer_entity_edges' own MERGE clauses only set name + group_id
        # on it.
        if group_id == "org_1.dealA" and name == "Robert":
            return None, ["Entity", "Person"]
        return None

    monkeypatch.setattr(main, "find_entity_by_name", _find)


@pytest.fixture
def fake_find_fact(monkeypatch):
    async def _find(group_id, uuid):
        if group_id == "org_1.dealA" and uuid == "edge-1":
            return "edge-1", "Acme signed the pilot", None, None
        if group_id == "org_1.dealA" and uuid == "edge-old":
            return (
                "edge-old",
                "Acme is on the trial plan",
                "2026-10-01T09:30:00+00:00",
                "2026-10-01T09:31:00+00:00",
            )
        return None

    monkeypatch.setattr(main, "find_fact", _find)


@pytest.fixture
def fake_remove(monkeypatch):
    async def _r(group_id, uuid):
        return uuid == "f1" and group_id == "org_1"

    monkeypatch.setattr(main, "remove_fact", _r)


@pytest.fixture
def fake_remove_episode(monkeypatch):
    async def _r(group_id, episode_uuid):
        # Mirrors remove_episode_facts' real return type (count of edges
        # removed), scoped so a wrong-tenant call finds nothing to retire.
        if group_id == "org_1" and episode_uuid == "ep-1":
            return 2
        return 0

    monkeypatch.setattr(main, "remove_episode_facts", _r)


@pytest.fixture
def fake_remove_group(monkeypatch):
    async def _r(group_id, source_id=None):
        # Mirrors remove_group_facts' real return type (counts by kind).
        # Scoped so a group with no facts (or an unrecognized one) reports 0, not an error — purging an empty/unknown scope is a
        # normal outcome for a source that never synced anything. Item
        # sources-delete-retention-provenance-marker-20260919: when source_id
        # is given, only a matching (group_id, source_id) pair "has facts" —
        # models the real function's marker-scoped path so a test can prove
        # the endpoint actually forwards source_id, not just group_id.
        nothing = {"facts": 0, "episodes": 0, "verbatim_nodes": 0, "entities": 0, "summaries": 0}
        if source_id is not None:
            if (group_id, source_id) == ("org_1.engineering", "src_slack"):
                return {
                    "facts": 2,
                    "episodes": 3,
                    "verbatim_nodes": 1,
                    "entities": 1,
                    "summaries": 2,
                }
            return nothing
        if group_id == "org_1.slack_general":
            return {**nothing, "facts": 3}
        return nothing

    monkeypatch.setattr(main, "remove_group_facts", _r)


@pytest.fixture
def client():
    return TestClient(main.app)


@pytest.fixture
def headers():
    return {"authorization": f"Bearer {API_KEY}"}
