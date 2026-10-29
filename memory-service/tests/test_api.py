"""Endpoint tests for the memory service (engine mocked)."""

import datetime
import json
from types import SimpleNamespace

import pytest

from app import main
from conftest import _FakeEdge


def test_health_ok(client):
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["neo4j"] is True


def test_ingest_requires_auth(client):
    r = client.post("/ingest", json={"group_id": "o1", "content": "hi", "actor_id": "u1"})
    assert r.status_code == 401


def test_ingest_rejects_bad_key(client):
    r = client.post(
        "/ingest",
        json={"group_id": "o1", "content": "hi", "actor_id": "u1"},
        headers={"authorization": "Bearer wrong"},
    )
    assert r.status_code == 401


def test_ingest_validates_body(client, headers):
    # missing group_id and actor_id
    r = client.post("/ingest", json={"content": "no tenant"}, headers=headers)
    assert r.status_code == 422


def test_ingest_success_and_actor_provenance(client, headers, fake_graphiti):
    r = client.post(
        "/ingest",
        json={
            "group_id": "org_1",
            "content": "Jane Doe is the CTO of Acme.",
            "actor_type": "human",
            "actor_id": "user_42",
            "actor_name": "Jane Doe",
        },
        headers=headers,
    )
    assert r.status_code == 200
    assert r.json() == {"episode_id": "ep-123"}

    # Engine called once, scoped to the tenant, with actor stamped into provenance.
    assert len(fake_graphiti.add_calls) == 1
    call = fake_graphiti.add_calls[0]
    assert call["group_id"] == "org_1"
    assert call["episode_body"] == "Jane Doe is the CTO of Acme."
    prov = json.loads(call["source_description"])
    assert prov["actor_type"] == "human"
    assert prov["actor_id"] == "user_42"
    assert prov["actor_name"] == "Jane Doe"
    # No source_id on this call (a human-asserted fact, not a connector sync)
    # — the field must default to null, never be silently omitted, so a
    # later remove_group_facts(..., source_id=...) call reliably fails to
    # match it rather than depending on a missing-key check.
    assert prov["source_id"] is None


def test_ingest_stamps_connector_source_id_into_provenance(client, headers, fake_graphiti):
    # The field a
    # later DELETE /groups/{group_id}?source_id=... purge matches on.
    r = client.post(
        "/ingest",
        json={
            "group_id": "org_1",
            "content": "shipped the connector fix",
            "actor_type": "extraction",
            "actor_id": "slack-sync:src_slack",
            "source_id": "src_slack",
        },
        headers=headers,
    )
    assert r.status_code == 200

    call = fake_graphiti.add_calls[0]
    prov = json.loads(call["source_description"])
    assert prov["source_id"] == "src_slack"


def test_ingest_stamps_chunk_id_into_provenance(client, headers, fake_graphiti):
    # Conflict detection: the caller's memory_chunks row id rides on the
    # episode so /search can hand it back and the caller can drop a superseded version.
    # An ingest that names no chunk stamps null, never an omitted key, so a reader can
    # tell "no chunk" from "an older episode nothing stamped".
    for body, expected in (
        ({"chunk_id": "chunk_abc"}, "chunk_abc"),
        ({}, None),
    ):
        fake_graphiti.add_calls.clear()
        r = client.post(
            "/ingest",
            json={
                "group_id": "org_1",
                "content": "The release train leaves on Monday.",
                "actor_type": "agent",
                "actor_id": "writer-a",
                **body,
            },
            headers=headers,
        )
        assert r.status_code == 200
        assert json.loads(fake_graphiti.add_calls[0]["source_description"])["chunk_id"] == expected


def test_search_returns_every_chunk_a_fact_was_asserted_from(client, headers, monkeypatch):
    """A fact carries the chunk id of every episode that asserts it, so the caller hides
    it only when all of them lost a write race, and an unstamped fact comes back with an
    empty list rather than a missing field."""

    class _TwoEdgeGraphiti:
        async def search_(self, **kwargs):
            return SimpleNamespace(
                edges=[
                    _FakeEdge("f-twice", "the release train leaves on Monday"),
                    _FakeEdge("f-legacy", "Dana owns the release"),
                ]
            )

    async def _get():
        return _TwoEdgeGraphiti()

    monkeypatch.setattr(main, "get_graphiti", _get)

    async def _provenance(uuids):
        return {
            "f-twice": {"actor_type": "agent", "chunk_ids": ["chunk_a", "chunk_b"]},
            "f-legacy": {"actor_type": "human"},
        }

    monkeypatch.setattr(main, "fetch_edge_provenance", _provenance)

    r = client.post("/search", json={"group_id": "org_1", "query": "release"}, headers=headers)
    assert r.status_code == 200
    assert {f["uuid"]: f["chunk_ids"] for f in r.json()["facts"]} == {
        "f-twice": ["chunk_a", "chunk_b"],
        "f-legacy": [],
    }


def test_search_names_the_episodes_behind_each_fact(client, headers, monkeypatch):
    """/search returns the episodes the provenance lookup found behind each fact, so the
    caller can name the synced item a fact came from. A fact with none, or a lookup that
    failed, comes back with an empty list rather than a missing field."""

    class _ThreeEdgeGraphiti:
        async def search_(self, **kwargs):
            return SimpleNamespace(
                edges=[
                    _FakeEdge("f-synced", "the deploy freeze starts on Friday"),
                    _FakeEdge("f-twice", "the release train leaves on Monday"),
                    _FakeEdge("f-legacy", "Dana owns the release"),
                ]
            )

    async def _get():
        return _ThreeEdgeGraphiti()

    monkeypatch.setattr(main, "get_graphiti", _get)

    async def _provenance(uuids):
        return {
            "f-synced": {"source_id": "src_1", "episode_ids": ["ep-item"]},
            "f-twice": {"episode_ids": ["ep-a", "ep-b"]},
            "f-legacy": {"actor_type": "human"},
        }

    monkeypatch.setattr(main, "fetch_edge_provenance", _provenance)

    r = client.post("/search", json={"group_id": "org_1", "query": "release"}, headers=headers)
    assert r.status_code == 200
    assert {f["uuid"]: f["episode_ids"] for f in r.json()["facts"]} == {
        "f-synced": ["ep-item"],
        "f-twice": ["ep-a", "ep-b"],
        "f-legacy": [],
    }

    async def _boom(uuids):
        raise RuntimeError("neo4j driver stale")

    monkeypatch.setattr(main, "fetch_edge_provenance", _boom)
    r = client.post("/search", json={"group_id": "org_1", "query": "release"}, headers=headers)
    assert r.status_code == 200
    assert [f["episode_ids"] for f in r.json()["facts"]] == [[], [], []]


def test_ingest_fallback_edge_carries_actor_provenance(client, headers, fake_graphiti, monkeypatch):
    # ensure_graph_visible()'s fallback RELATES_TO edge must carry a
    # source_description, or a human-asserted fact that hits the fallback path
    # (fake_graphiti's result always has 0 edges, same as Graphiti extracting
    # 0 entities for abstract/technical content) comes back actor_type None
    # from fetch_edge_provenance() and ranks as extraction.
    # main.py already builds the same provenance JSON for the primary add_episode
    # call above; this pins that it's actually threaded into the fallback call too.
    calls = []

    async def _spy(**kwargs):
        calls.append(kwargs)
        return True

    monkeypatch.setattr(main, "ensure_graph_visible", _spy)

    r = client.post(
        "/ingest",
        json={
            "group_id": "org_1",
            "content": "the board approved the raise",
            "actor_type": "human",
            "actor_id": "user_42",
            "actor_name": "Jane Doe",
        },
        headers=headers,
    )
    assert r.status_code == 200

    assert len(calls) == 1
    prov = json.loads(calls[0]["source_description"])
    assert prov["actor_type"] == "human"
    assert prov["actor_id"] == "user_42"
    assert prov["actor_name"] == "Jane Doe"


def test_ingest_decision_record_is_stored_verbatim_even_when_the_extractor_found_edges(
    client, headers, fake_graphiti, monkeypatch
):
    # The extractor paraphrases a dated decision into something like "Jordan
    # is a Decision that specifies operational procedures for crew runs". A
    # decision record must be written in its own words whether or not
    # extraction produced edges of its own.
    calls = []

    async def _spy(**kwargs):
        calls.append(kwargs)
        return True

    class _ResultWithEdges:
        episode = type("Episode", (), {"uuid": "ep-123"})()
        nodes = ["n1"]
        edges = [
            _FakeEdge(
                "e1", "Jordan is a Decision that specifies operational procedures for crew runs"
            )
        ]

    async def _add_episode(**kwargs):
        fake_graphiti.add_calls.append(kwargs)
        return _ResultWithEdges()

    monkeypatch.setattr(main, "ensure_graph_visible", _spy)
    monkeypatch.setattr(fake_graphiti, "add_episode", _add_episode)
    decision = "Decision by Jordan on 2026-09-24: every crew run reads Willder memory after its control check."

    r = client.post(
        "/ingest",
        json={
            "group_id": "org_1",
            "content": decision,
            "actor_type": "agent",
            "actor_id": "agent_claude",
            "record_type": "decision",
        },
        headers=headers,
    )

    assert r.status_code == 200
    assert len(calls) == 1
    assert calls[0]["node_label"] == "Decision"
    assert calls[0]["content"] == decision
    assert calls[0]["episode_uuid"] == "ep-123"
    assert json.loads(calls[0]["source_description"])["actor_id"] == "agent_claude"


def test_ingest_document_keeps_only_passages_whose_number_extraction_dropped(
    client, headers, fake_graphiti, monkeypatch
):
    # A README bullet about "55 updates/min" can come back as "Example repo
    # uses WebSocket for live price ticks", with the number gone.
    calls = []

    async def _spy(**kwargs):
        calls.append(kwargs)
        return True

    class _ResultWithEdges:
        episode = type("Episode", (), {"uuid": "ep-123"})()
        nodes = ["n1"]
        edges = [
            _FakeEdge("e1", "Example repo uses WebSocket for live price ticks"),
            _FakeEdge("e2", "Example repo handles 3 exchanges"),
        ]

    async def _add_episode(**kwargs):
        return _ResultWithEdges()

    monkeypatch.setattr(main, "ensure_graph_visible", _spy)
    monkeypatch.setattr(fake_graphiti, "add_episode", _add_episode)
    readme = (
        "README of example-org/example-repo\n\n"
        "- WebSocket server pushes live price ticks to the UI at up to 55 updates/min\n"
        "- Handles 3 exchanges\n"
    )

    r = client.post(
        "/ingest",
        json={
            "group_id": "org_1",
            "content": readme,
            "actor_id": "github-sync:src_1",
            "source_id": "src_1",
            "record_type": "document",
        },
        headers=headers,
    )

    assert r.status_code == 200
    assert [c["content"] for c in calls] == [
        "WebSocket server pushes live price ticks to the UI at up to 55 updates/min",
    ]
    assert calls[0]["node_label"] == "Passage"
    assert calls[0]["episode_uuid"] == "ep-123"
    assert json.loads(calls[0]["source_description"])["source_id"] == "src_1"


def test_ingest_document_caps_verbatim_passages(client, headers, fake_graphiti, monkeypatch):
    calls = []

    async def _spy(**kwargs):
        calls.append(kwargs)
        return True

    class _ResultWithEdges:
        episode = type("Episode", (), {"uuid": "ep-123"})()
        nodes = ["n1"]
        edges = [_FakeEdge("e1", "The document lists limits")]

    async def _add_episode(**kwargs):
        return _ResultWithEdges()

    monkeypatch.setattr(main, "ensure_graph_visible", _spy)
    monkeypatch.setattr(fake_graphiti, "add_episode", _add_episode)
    document = "\n".join(f"Limit {n} is {n * 10} requests" for n in range(1, 30))

    r = client.post(
        "/ingest",
        json={
            "group_id": "org_1",
            "content": document,
            "actor_id": "u1",
            "record_type": "document",
        },
        headers=headers,
    )

    assert r.status_code == 200
    assert len(calls) == main.MAX_VERBATIM_PASSAGES


@pytest.mark.parametrize(
    ("heading", "record_type", "expected"),
    [
        # A synced doc's heading states no number, so before the heading was kept no stored
        # fact named the doc, and memory_query by its name or path found nothing.
        (
            "Document docs/setup.md in acme/app (https://github.com/acme/app/blob/main/docs/setup.md)",
            "document",
            [
                "Document docs/setup.md in acme/app (https://github.com/acme/app/blob/main/docs/setup.md)"
            ],
        ),
        # A heading whose lines also state a number extraction dropped is kept once, not twice.
        (
            "Review of pull request #12 by bob: approved\n- Keep 3 retries",
            "document",
            ["Review of pull request #12 by bob: approved\n- Keep 3 retries"],
        ),
        # Blank, or on a record that is not a source's item, it stores nothing of its own.
        ("   ", "document", []),
        ("Document docs/setup.md in acme/app", None, []),
    ],
)
def test_ingest_document_keeps_its_heading_verbatim(
    client, headers, fake_graphiti, monkeypatch, heading, record_type, expected
):
    calls = []

    async def _spy(**kwargs):
        calls.append(kwargs)
        return True

    class _ResultWithEdges:
        episode = type("Episode", (), {"uuid": "ep-123"})()
        nodes = ["n1"]
        edges = [_FakeEdge("e1", "Setup needs Node and a Postgres database")]

    async def _add_episode(**kwargs):
        return _ResultWithEdges()

    monkeypatch.setattr(main, "ensure_graph_visible", _spy)
    monkeypatch.setattr(fake_graphiti, "add_episode", _add_episode)

    r = client.post(
        "/ingest",
        json={
            "group_id": "org_1",
            "content": f"{heading}\n\nSetup needs Node and a Postgres database.",
            "actor_id": "github-sync:src_1",
            "source_id": "src_1",
            "record_type": record_type,
            "heading": heading,
        },
        headers=headers,
    )

    assert r.status_code == 200
    assert [c["content"] for c in calls] == expected
    for call in calls:
        assert call["node_label"] == "Passage"
        assert call["episode_uuid"] == "ep-123"
        assert json.loads(call["source_description"])["source_id"] == "src_1"


def test_ingest_without_record_type_keeps_extracted_edges_only(
    client, headers, fake_graphiti, monkeypatch
):
    calls = []

    async def _spy(**kwargs):
        calls.append(kwargs)
        return True

    class _ResultWithEdges:
        episode = type("Episode", (), {"uuid": "ep-123"})()
        nodes = ["n1"]
        edges = [_FakeEdge("e1", "Jane Doe is the CTO of Acme")]

    async def _add_episode(**kwargs):
        return _ResultWithEdges()

    monkeypatch.setattr(main, "ensure_graph_visible", _spy)
    monkeypatch.setattr(fake_graphiti, "add_episode", _add_episode)

    r = client.post(
        "/ingest",
        json={"group_id": "org_1", "content": "Jane Doe is the CTO of Acme.", "actor_id": "u1"},
        headers=headers,
    )

    assert r.status_code == 200
    assert calls == []


def test_ingest_rejects_an_unknown_record_type(client, headers, fake_graphiti):
    r = client.post(
        "/ingest",
        json={"group_id": "org_1", "content": "x", "actor_id": "u1", "record_type": "opinion"},
        headers=headers,
    )
    assert r.status_code == 422


def test_ingest_bulk_fallback_edges_carry_per_episode_actor_provenance(
    client, headers, monkeypatch
):
    # Same finding as above, for the bulk path (ingest_bulk): each episode's
    # fallback call must carry THAT episode's own provenance, not the last one
    # built in the loop that constructs raw_episodes.
    class _FakeBulkEpisode:
        def __init__(self, uuid):
            self.uuid = uuid

    class _FakeBulkResult:
        episodes = [_FakeBulkEpisode("ep-a"), _FakeBulkEpisode("ep-b")]
        nodes: list = []
        edges: list = []
        episodic_edges: list = []

    async def _get():
        class _Fake:
            async def add_episode_bulk(self, **kwargs):
                return _FakeBulkResult()

        return _Fake()

    monkeypatch.setattr(main, "get_graphiti", _get)

    calls = []

    async def _spy(**kwargs):
        calls.append(kwargs)
        return True

    monkeypatch.setattr(main, "ensure_graph_visible", _spy)

    r = client.post(
        "/ingest-bulk",
        json={
            "group_id": "org_1",
            "episodes": [
                {
                    "group_id": "org_1",
                    "content": "fact A",
                    "actor_type": "human",
                    "actor_id": "user_1",
                },
                {
                    "group_id": "org_1",
                    "content": "fact B",
                    "actor_type": "agent",
                    "actor_id": "agent_1",
                },
            ],
        },
        headers=headers,
    )
    assert r.status_code == 200

    assert len(calls) == 2
    prov_a = json.loads(calls[0]["source_description"])
    prov_b = json.loads(calls[1]["source_description"])
    assert prov_a["actor_type"] == "human"
    assert prov_a["actor_id"] == "user_1"
    assert prov_b["actor_type"] == "agent"
    assert prov_b["actor_id"] == "agent_1"


class _BulkResultWithoutRelations:
    episodes = [type("Episode", (), {"uuid": "ep-a"})()]
    nodes: list = []
    edges: list = []
    episodic_edges: list = []


@pytest.mark.parametrize(
    "path, body",
    [
        ("/ingest", {"group_id": "org_1", "content": "the queue uses SQS", "actor_id": "u1"}),
        (
            "/ingest",
            {
                "group_id": "org_1",
                "content": "Decision: use SQS",
                "actor_id": "u1",
                "record_type": "decision",
            },
        ),
        (
            "/ingest-bulk",
            {
                "group_id": "org_1",
                "episodes": [
                    {"group_id": "org_1", "content": "the queue uses SQS", "actor_id": "u1"}
                ],
            },
        ),
    ],
    ids=["fallback", "decision", "bulk fallback"],
)
def test_an_ingest_whose_graph_write_failed_answers_503_not_done(
    client, headers, fake_graphiti, monkeypatch, path, body
):
    # The caller keeps an ingest that did not answer 2xx and extracts it again later
    # (services/memory/graph-extraction-retry.ts); a 200 here would drop the fact
    # from the graph for good.
    async def _failed(**_kwargs):
        raise main.GraphVisibilityError(
            "the graph-visibility write failed after 12 attempt(s): TransientError"
        )

    async def _add_episode_bulk(**_kwargs):
        return _BulkResultWithoutRelations()

    monkeypatch.setattr(main, "ensure_graph_visible", _failed)
    monkeypatch.setattr(fake_graphiti, "add_episode_bulk", _add_episode_bulk, raising=False)

    r = client.post(path, json=body, headers=headers)

    assert r.status_code == 503
    assert r.headers["Retry-After"] == "1"
    assert "episode_id" not in r.json() and "episode_ids" not in r.json()


def test_search_requires_auth(client):
    r = client.post("/search", json={"group_id": "o1", "query": "x"})
    assert r.status_code == 401


def test_search_success_maps_facts(client, headers, fake_graphiti):
    r = client.post(
        "/search",
        json={"group_id": "org_1", "query": "marketing budget", "limit": 3},
        headers=headers,
    )
    assert r.status_code == 200
    facts = r.json()["facts"]
    assert len(facts) == 1
    assert facts[0]["uuid"] == "f1"
    assert facts[0]["fact"] == "Acme's marketing budget is $50,000"
    assert facts[0]["valid_at"].startswith("2026-01-01")

    # scoped to the tenant, limit forwarded
    call = fake_graphiti.search_calls[0]
    assert call["group_ids"] == ["org_1"]
    assert call["config"].limit == 3


def test_search_maps_actor_type(client, headers, monkeypatch):
    """/search must return actor_type so the Node-side GuardedMemoryStore
    can rank human > agent > extraction. This drives the real
    endpoint end to end (fake Graphiti engine + a fake provenance lookup, not a
    hand-rolled fact object), asserting on the actual HTTP response body."""

    class _TwoEdgeGraphiti:
        async def search_(self, **kwargs):
            return SimpleNamespace(
                edges=[
                    _FakeEdge("f-human", "the CEO confirmed the renewal date"),
                    _FakeEdge("f-extracted", "a contract PDF mentions a renewal date"),
                ]
            )

    async def _get():
        return _TwoEdgeGraphiti()

    monkeypatch.setattr(main, "get_graphiti", _get)

    async def _provenance(uuids):
        assert set(uuids) == {"f-human", "f-extracted"}
        return {"f-human": {"actor_type": "human"}, "f-extracted": {"actor_type": "extraction"}}

    monkeypatch.setattr(main, "fetch_edge_provenance", _provenance)

    r = client.post(
        "/search",
        json={"group_id": "org_1", "query": "renewal date"},
        headers=headers,
    )
    assert r.status_code == 200
    facts = {f["uuid"]: f["actor_type"] for f in r.json()["facts"]}
    assert facts == {"f-human": "human", "f-extracted": "extraction"}


def test_search_actor_type_lookup_failure_falls_back_unranked(
    client, headers, fake_graphiti, monkeypatch
):
    """The provenance lookup is best-effort: a failure (e.g. a stale Neo4j
    connection on the raw driver, separate from Graphiti's own) must not fail
    the whole search — every fact just comes back with actor_type unset, which
    the Node-side ranker already treats as its lowest tier."""

    async def _boom(uuids):
        raise RuntimeError("neo4j driver stale")

    monkeypatch.setattr(main, "fetch_edge_provenance", _boom)

    r = client.post(
        "/search",
        json={"group_id": "org_1", "query": "marketing budget"},
        headers=headers,
    )
    assert r.status_code == 200
    facts = r.json()["facts"]
    assert len(facts) == 1
    assert facts[0]["actor_type"] is None
    assert facts[0]["source_id"] is None


def test_search_returns_source_id_and_actor_name_for_citation(client, headers, monkeypatch):
    """A connector-ingested fact comes back with the source_id and actor_name its
    ingest stamped, so the caller can cite the source; a fact with no stamped
    source (a manual assertion) comes back with source_id unset and its actor."""

    class _TwoEdgeGraphiti:
        async def search_(self, **kwargs):
            return SimpleNamespace(
                edges=[
                    _FakeEdge("f-synced", "the release ships on Friday"),
                    _FakeEdge("f-manual", "Dana owns the release"),
                ]
            )

    async def _get():
        return _TwoEdgeGraphiti()

    monkeypatch.setattr(main, "get_graphiti", _get)

    async def _provenance(uuids):
        return {
            "f-synced": {
                "actor_type": "extraction",
                "actor_name": "eng-updates",
                "source_id": "src_1",
            },
            "f-manual": {"actor_type": "human", "actor_name": "Dana", "source_id": None},
        }

    monkeypatch.setattr(main, "fetch_edge_provenance", _provenance)

    r = client.post("/search", json={"group_id": "org_1", "query": "release"}, headers=headers)
    assert r.status_code == 200
    facts = {f["uuid"]: (f["source_id"], f["actor_name"]) for f in r.json()["facts"]}
    assert facts == {"f-synced": ("src_1", "eng-updates"), "f-manual": (None, "Dana")}


def test_entity_requires_auth(client):
    assert client.get("/entities/ent-1?group_id=org_1").status_code == 401


def test_entity_requires_group_id(client, headers, fake_entity):
    # group_id is a required query param
    assert client.get("/entities/ent-1", headers=headers).status_code == 422


def test_entity_found(client, headers, fake_entity):
    r = client.get("/entities/ent-1?group_id=org_1", headers=headers)
    assert r.status_code == 200
    body = r.json()
    assert body["uuid"] == "ent-1"
    assert body["name"] == "Acme Corp"
    assert body["type"] == "Company"  # first non-"Entity" label
    assert body["facts"][0]["fact"] == "Acme is headquartered in Austin"


def test_entity_facts_carry_the_chunks_they_were_asserted_from(
    client, headers, fake_entity, monkeypatch
):
    """The entity view answers with fact text a reader takes as current, so each fact must
    carry the same `chunk_ids` /search does: without them the caller cannot tell a version
    that lost a write race from the one that won, and serves both."""

    async def _provenance(uuids):
        assert uuids == ["f1"]
        return {"f1": {"actor_type": "agent", "chunk_ids": ["chunk_a"]}}

    monkeypatch.setattr(main, "fetch_edge_provenance", _provenance)

    r = client.get("/entities/ent-1?group_id=org_1", headers=headers)
    assert r.status_code == 200
    assert [f["chunk_ids"] for f in r.json()["facts"]] == [["chunk_a"]]


def test_entity_answers_unstamped_when_the_provenance_lookup_fails(
    client, headers, fake_entity, monkeypatch
):
    async def _boom(uuids):
        raise RuntimeError("neo4j down")

    monkeypatch.setattr(main, "fetch_edge_provenance", _boom)

    r = client.get("/entities/ent-1?group_id=org_1", headers=headers)
    assert r.status_code == 200
    assert [f["chunk_ids"] for f in r.json()["facts"]] == [[]]


def test_entity_not_found(client, headers, fake_entity):
    r = client.get("/entities/missing?group_id=org_1", headers=headers)
    assert r.status_code == 404


def test_find_entity_requires_auth(client):
    assert client.get("/entities/find?name=Marcus&group_id=org_1.dealA").status_code == 401


def test_find_entity_found(client, headers, fake_find_entity):
    r = client.get("/entities/find?name=Marcus&group_id=org_1.dealA", headers=headers)
    assert r.status_code == 200
    body = r.json()
    assert body["uuid"] == "ent-marcus"
    assert body["type"] == "Person"  # first non-"Entity" label


def test_find_entity_not_found_in_this_group(client, headers, fake_find_entity):
    # Same name, different group_id — must not leak across the group boundary
    # (the exact shape resolveEntityScope relies on: a hit in one scope must
    # never be mistaken for a hit in a sibling one).
    r = client.get("/entities/find?name=Marcus&group_id=org_1.dealB", headers=headers)
    assert r.status_code == 404


def test_find_entity_not_found_no_match(client, headers, fake_find_entity):
    r = client.get("/entities/find?name=Nobody&group_id=org_1.dealA", headers=headers)
    assert r.status_code == 404


def test_find_entity_found_with_no_uuid(client, headers, fake_find_entity):
    # transferEntity's own MERGE clauses can create a replacement entity with
    # only name + group_id set, no uuid. A later /entities/find lookup on
    # that replacement must still resolve (response validation must not 500
    # on a null uuid) — the TS resolver only checks this response for
    # existence, never reads uuid.
    r = client.get("/entities/find?name=Robert&group_id=org_1.dealA", headers=headers)
    assert r.status_code == 200
    body = r.json()
    assert body["uuid"] is None
    assert body["type"] == "Person"


def test_resolve_fact_requires_auth(client):
    assert client.get("/facts/edge-1/resolve?group_id=org_1.dealA").status_code == 401


def test_resolve_fact_found(client, headers, fake_find_fact):
    r = client.get("/facts/edge-1/resolve?group_id=org_1.dealA", headers=headers)
    assert r.status_code == 200
    body = r.json()
    assert body["found"] is True
    assert body["uuid"] == "edge-1"
    assert body["fact"] == "Acme signed the pilot"
    assert body["invalid_at"] is None


def test_resolve_fact_reports_when_an_edge_was_invalidated(client, headers, fake_find_fact):
    # A Graphiti edge's text never changes; a newer contradicting edge sets
    # invalid_at on the old one instead. A caller checking whether a fact it
    # quoted is still current needs that timestamp, not just "found".
    r = client.get("/facts/edge-old/resolve?group_id=org_1.dealA", headers=headers)
    assert r.status_code == 200
    body = r.json()
    assert body["found"] is True
    assert body["invalid_at"] == "2026-10-01T09:30:00+00:00"
    assert body["expired_at"] == "2026-10-01T09:31:00+00:00"


def test_resolve_fact_carries_the_edges_stamps(client, headers, fake_find_fact, monkeypatch):
    # The caller checks a stored source still stands behind a resolved fact before it calls
    # it current, so the edge's chunk ids, source and episodes come back as /search's do.
    async def _provenance(uuids):
        assert uuids == ["edge-1"]
        return {"edge-1": {"chunk_ids": ["chunk_a"], "source_id": "src-1", "episode_ids": ["ep-1"]}}

    monkeypatch.setattr(main, "fetch_edge_provenance", _provenance)
    body = client.get("/facts/edge-1/resolve?group_id=org_1.dealA", headers=headers).json()
    assert (body["chunk_ids"], body["source_id"], body["episode_ids"]) == (
        ["chunk_a"],
        "src-1",
        ["ep-1"],
    )


def test_resolve_fact_answers_unstamped_when_the_provenance_lookup_fails(
    client, headers, fake_find_fact, monkeypatch
):
    async def _boom(uuids):
        raise RuntimeError("neo4j down")

    monkeypatch.setattr(main, "fetch_edge_provenance", _boom)
    body = client.get("/facts/edge-1/resolve?group_id=org_1.dealA", headers=headers).json()
    assert body["found"] is True
    assert (body["chunk_ids"], body["source_id"], body["episode_ids"]) == ([], None, [])


# Every miss answers this one shape, so a miss in a sibling scope reads as a uuid that exists nowhere.
NOT_FOUND = {
    "found": False,
    "uuid": None,
    "fact": None,
    "invalid_at": None,
    "expired_at": None,
    "chunk_ids": [],
    "source_id": None,
    "episode_ids": [],
}


def test_resolve_fact_not_found_in_this_group(client, headers, fake_find_fact):
    # The boundary the provenance write path depends on: a real edge in a
    # sibling scope must answer exactly as a uuid that exists nowhere, so a
    # caller cannot mint a provenance row against a fact outside the scope
    # they are authorized for, nor learn that the uuid is real.
    r = client.get("/facts/edge-1/resolve?group_id=org_1.dealB", headers=headers)
    assert r.status_code == 200
    assert r.json() == NOT_FOUND


def test_resolve_fact_not_found_unknown_uuid(client, headers, fake_find_fact):
    r = client.get("/facts/edge-nope/resolve?group_id=org_1.dealA", headers=headers)
    assert r.status_code == 200
    assert r.json() == NOT_FOUND


def test_resolve_fact_requires_group_id(client, headers, fake_find_fact):
    assert client.get("/facts/edge-1/resolve", headers=headers).status_code == 422


def test_resolve_fact_path_is_not_shadowed_by_delete(client, headers, fake_find_fact, fake_remove):
    # The lookup must hang off a sub-path: `GET /facts/{uuid}` directly would
    # answer with 405 and `allow: DELETE`, because the removal route below
    # claims every single-segment `/facts/*`. Both routes must stay reachable,
    # each on its own method and path.
    assert (
        client.get("/facts/edge-1/resolve?group_id=org_1.dealA", headers=headers).status_code == 200
    )
    assert client.delete("/facts/f1?group_id=org_1", headers=headers).status_code == 200


def test_graph_requires_auth(client):
    assert client.post("/graph", json={"group_ids": ["org_1"]}).status_code == 401


def test_graph_success_maps_nodes_and_edges(client, headers, fake_graph):
    r = client.post("/graph", json={"group_ids": ["org_1"], "limit": 10}, headers=headers)
    assert r.status_code == 200
    body = r.json()
    assert {n["uuid"] for n in body["nodes"]} == {"n1", "n2"}
    assert body["edges"][0]["source"] == "n1"
    assert body["edges"][0]["target"] == "n2"
    assert body["edges"][0]["fact"] == "Acme partners with Globex"


def test_graph_returns_each_edges_group(client, headers, monkeypatch):
    # The app tells a current fact from a superseded one in the graph view by the group
    # the edge is stored in (services/memory/superseded-facts.ts), so the response must
    # carry the `group_id` graph_for_group reads off each edge, not drop it.
    async def _g(group_ids, query=None, limit=50):
        nodes = {"n1": {"name": "Release train", "type": "Project"}}
        edges = [
            {
                "uuid": "e1",
                "source": "n1",
                "target": "n1",
                "fact": "Leaves Monday",
                "group_id": "org_1-release",
            },
            {
                "uuid": "e2",
                "source": "n1",
                "target": "n1",
                "fact": "Leaves Tuesday",
                "group_id": "org_1-ops",
            },
        ]
        return nodes, edges

    monkeypatch.setattr(main, "graph_for_group", _g)
    r = client.post("/graph", json={"group_ids": ["org_1-release", "org_1-ops"]}, headers=headers)
    assert r.status_code == 200
    assert {e["uuid"]: e.get("group_id") for e in r.json()["edges"]} == {
        "e1": "org_1-release",
        "e2": "org_1-ops",
    }


def test_graph_edges_carry_the_chunks_they_were_asserted_from(
    client, headers, fake_graph, monkeypatch
):
    """The graph view marks a version that lost a write race as superseded by its chunk
    stamp, as /search does; an edge with no stamp comes back with an empty list."""

    async def _provenance(uuids):
        assert uuids == ["e1"]
        return {"e1": {"actor_type": "agent", "chunk_ids": ["chunk_a", "chunk_b"]}}

    monkeypatch.setattr(main, "fetch_edge_provenance", _provenance)

    r = client.post("/graph", json={"group_ids": ["org_1"]}, headers=headers)
    assert r.status_code == 200
    assert {e["uuid"]: e["chunk_ids"] for e in r.json()["edges"]} == {"e1": ["chunk_a", "chunk_b"]}


def test_graph_edges_carry_their_source_and_episodes(client, headers, fake_graph, monkeypatch):
    async def _provenance(uuids):
        return {"e1": {"source_id": "src-1", "episode_ids": ["ep-1"]}}

    monkeypatch.setattr(main, "fetch_edge_provenance", _provenance)
    [edge] = client.post("/graph", json={"group_ids": ["org_1"]}, headers=headers).json()["edges"]
    assert (edge["chunk_ids"], edge["source_id"], edge["episode_ids"]) == ([], "src-1", ["ep-1"])


def test_graph_answers_unstamped_when_the_provenance_lookup_fails(
    client, headers, fake_graph, monkeypatch
):
    async def _boom(uuids):
        raise RuntimeError("neo4j down")

    monkeypatch.setattr(main, "fetch_edge_provenance", _boom)

    r = client.post("/graph", json={"group_ids": ["org_1"]}, headers=headers)
    assert r.status_code == 200
    assert [e["chunk_ids"] for e in r.json()["edges"]] == [[]]


def test_delete_fact_requires_auth(client):
    assert client.delete("/facts/f1?group_id=org_1").status_code == 401


def test_delete_fact_success(client, headers, fake_remove):
    r = client.delete("/facts/f1?group_id=org_1", headers=headers)
    assert r.status_code == 200
    assert r.json() == {"removed": True}


def test_delete_fact_not_found(client, headers, fake_remove):
    r = client.delete("/facts/missing?group_id=org_1", headers=headers)
    assert r.status_code == 404


def test_delete_episode_requires_auth(client):
    assert client.delete("/episodes/ep-1?group_id=org_1").status_code == 401


def test_delete_episode_success(client, headers, fake_remove_episode):
    r = client.delete("/episodes/ep-1?group_id=org_1", headers=headers)
    assert r.status_code == 200
    assert r.json() == {"removed": True}


def test_delete_episode_not_found(client, headers, fake_remove_episode):
    # Right episode, wrong tenant: fake_remove_episode only matches org_1/ep-1,
    # so this proves the group_id actually reaches remove_episode_facts and
    # isn't just accepted-and-ignored, the same gap class as
    # remove_fact/remove_entity's original UUID-only matching.
    r = client.delete("/episodes/ep-1?group_id=org_2", headers=headers)
    assert r.status_code == 404


def test_delete_episode_no_facts_contributed(client, headers, fake_remove_episode):
    r = client.delete("/episodes/ep-empty?group_id=org_1", headers=headers)
    assert r.status_code == 404


def test_delete_group_requires_auth(client):
    assert client.delete("/groups/org_1.slack_general").status_code == 401


def test_source_records_requires_auth(client):
    body = {"org_id": "1", "source_id": "src_slack", "group_ids": ["org_1-slack_general"]}
    assert client.post("/sources/records", json=body).status_code == 401


def test_delete_group_success(client, headers, fake_remove_group):
    r = client.delete("/groups/org_1.slack_general", headers=headers)
    assert r.status_code == 200
    assert r.json() == {
        "removed_count": 3,
        "removed_episodes": 0,
        "removed_verbatim_nodes": 0,
        "removed_entities": 0,
        "cleared_summaries": 0,
    }


def test_delete_group_no_facts_is_not_an_error(client, headers, fake_remove_group):
    # Unlike /episodes/{uuid} and /facts/{uuid}, a group/scope with nothing to
    # remove is a normal outcome (a freshly-connected source with nothing
    # synced yet, or one already fully retired by a prior call) — 200 with
    # removed_count: 0, never 404.
    r = client.delete("/groups/org_1.empty_source", headers=headers)
    assert r.status_code == 200
    assert r.json() == {
        "removed_count": 0,
        "removed_episodes": 0,
        "removed_verbatim_nodes": 0,
        "removed_entities": 0,
        "cleared_summaries": 0,
    }


def test_delete_group_forwards_source_id_query_param(client, headers, fake_remove_group):
    # The route
    # always sends this now, so the shared scope's other producer's content
    # survives — pins that the query param actually reaches
    # remove_group_facts as source_id, not silently dropped.
    r = client.delete("/groups/org_1.engineering?source_id=src_slack", headers=headers)
    assert r.status_code == 200
    assert r.json() == {
        "removed_count": 2,
        "removed_episodes": 3,
        "removed_verbatim_nodes": 1,
        "removed_entities": 1,
        "cleared_summaries": 2,
    }


def test_delete_group_source_id_mismatch_removes_nothing(client, headers, fake_remove_group):
    r = client.delete("/groups/org_1.engineering?source_id=src_figma", headers=headers)
    assert r.status_code == 200
    assert r.json() == {
        "removed_count": 0,
        "removed_episodes": 0,
        "removed_verbatim_nodes": 0,
        "removed_entities": 0,
        "cleared_summaries": 0,
    }


def test_delete_group_without_source_id_still_does_the_whole_group_purge(
    client, headers, fake_remove_group
):
    # Omitting source_id is still a valid, real mode (see remove_group_facts'
    # own docstring) — not removed by this item, just no longer what the
    # sources route calls by default.
    r = client.delete("/groups/org_1.slack_general", headers=headers)
    assert r.status_code == 200
    assert r.json() == {
        "removed_count": 3,
        "removed_episodes": 0,
        "removed_verbatim_nodes": 0,
        "removed_entities": 0,
        "cleared_summaries": 0,
    }


def test_interactive_docs_are_not_served(client):
    # The Swagger and ReDoc pages would advertise every route and schema to
    # anonymous callers; the service's only client is the Node app.
    assert client.get("/docs").status_code == 404
    assert client.get("/redoc").status_code == 404


def test_openapi_schema_requires_auth(client):
    assert client.get("/openapi.json").status_code == 401
    r = client.get("/openapi.json", headers={"authorization": "Bearer wrong"})
    assert r.status_code == 401


def test_openapi_schema_served_with_key(client, headers):
    r = client.get("/openapi.json", headers=headers)
    assert r.status_code == 200
    assert "/ingest-bulk" in r.json()["paths"]


# Graphiti retires an edge a newer one contradicts by setting `invalid_at` (when the
# fact stopped being true) and `expired_at` (when the graph learned it). Every view
# that returns fact text carries both, so the caller can leave a retired fact out of
# an answer and mark it in the graph view, rather than present it as current.
_RETIRED_AT = datetime.datetime(2026, 1, 5, tzinfo=datetime.timezone.utc)
_EXPIRED_AT = datetime.datetime(2026, 1, 6, tzinfo=datetime.timezone.utc)
_RETIRED_EDGES = [
    _FakeEdge("f-current", "Release train leaves Tuesday"),
    _FakeEdge(
        "f-invalidated",
        "Release train leaves Friday",
        invalid_at=_RETIRED_AT,
        expired_at=_EXPIRED_AT,
    ),
    _FakeEdge("f-expired", "Release train leaves Sunday", expired_at=_EXPIRED_AT),
]
_RETIREMENT = {
    "f-current": (None, None),
    "f-invalidated": (_RETIRED_AT.isoformat(), _EXPIRED_AT.isoformat()),
    "f-expired": (None, _EXPIRED_AT.isoformat()),
}


def _retirement(facts):
    return {f["uuid"]: (f["invalid_at"], f["expired_at"]) for f in facts}


def test_entity_facts_carry_graphiti_retirement(client, headers, monkeypatch):
    async def _get(group_ids, uuid):
        return SimpleNamespace(
            uuid="ent-1", name="Release train", labels=["Entity"], summary=""
        ), _RETIRED_EDGES

    monkeypatch.setattr(main, "get_entity_with_facts", _get)
    monkeypatch.setattr(main, "fetch_edge_provenance", _no_provenance)

    r = client.get("/entities/ent-1?group_id=org_1", headers=headers)
    assert r.status_code == 200
    assert _retirement(r.json()["facts"]) == _RETIREMENT


def test_search_facts_carry_graphiti_retirement(client, headers, fake_graphiti, monkeypatch):
    async def _search(**kwargs):
        return SimpleNamespace(edges=_RETIRED_EDGES)

    monkeypatch.setattr(fake_graphiti, "search_", _search)

    r = client.post(
        "/search", json={"group_id": "org_1", "query": "release train"}, headers=headers
    )
    assert r.status_code == 200
    assert _retirement(r.json()["facts"]) == _RETIREMENT


def test_graph_edges_carry_graphiti_retirement(client, headers, monkeypatch):
    async def _g(group_ids, query=None, limit=50):
        nodes = {"n1": {"name": "Release train", "type": "Project"}}
        edges = [
            {
                "uuid": uuid,
                "source": "n1",
                "target": "n1",
                "fact": uuid,
                "invalid_at": invalid_at,
                "expired_at": expired_at,
            }
            for uuid, (invalid_at, expired_at) in _RETIREMENT.items()
        ]
        return nodes, edges

    monkeypatch.setattr(main, "graph_for_group", _g)
    monkeypatch.setattr(main, "fetch_edge_provenance", _no_provenance)

    r = client.post("/graph", json={"group_ids": ["org_1"]}, headers=headers)
    assert r.status_code == 200
    assert _retirement(r.json()["edges"]) == _RETIREMENT


def test_a_naive_retirement_time_is_reported_as_utc(client, headers, monkeypatch):
    # Graphiti treats a datetime without an offset as UTC. Sent on without one, a
    # reader would parse it in its own time zone and move the moment the fact ended.
    naive = _FakeEdge(
        "f-naive",
        "Release train leaves Monday",
        valid_at=datetime.datetime(2026, 1, 1),
        invalid_at=datetime.datetime(2026, 1, 5),
        expired_at=datetime.datetime(2026, 1, 6),
    )

    async def _get(group_ids, uuid):
        return SimpleNamespace(uuid="ent-1", name="Release train", labels=["Entity"], summary=""), [
            naive
        ]

    monkeypatch.setattr(main, "get_entity_with_facts", _get)
    monkeypatch.setattr(main, "fetch_edge_provenance", _no_provenance)

    r = client.get("/entities/ent-1?group_id=org_1", headers=headers)
    assert r.status_code == 200
    (fact,) = r.json()["facts"]
    assert (fact["valid_at"], fact["invalid_at"], fact["expired_at"]) == (
        "2026-01-01T00:00:00+00:00",
        "2026-01-05T00:00:00+00:00",
        "2026-01-06T00:00:00+00:00",
    )


async def _no_provenance(uuids):
    return {}


def test_search_over_several_groups_says_how_many_it_searched_and_where_each_fact_is(
    client, headers, fake_graphiti, monkeypatch
):
    async def _search(**kwargs):
        fake_graphiti.search_calls.append(kwargs)
        return SimpleNamespace(
            edges=[_FakeEdge("f-eng", "Renewal is March 3", group_id="org_1-eng")]
        )

    monkeypatch.setattr(fake_graphiti, "search_", _search)

    r = client.post(
        "/search",
        json={
            "group_id": "org_1",
            "group_ids": ["org_1-eng", "org_1-sales", "org_1"],
            "query": "renewal",
        },
        headers=headers,
    )

    assert r.status_code == 200
    assert r.json()["groups_searched"] == 3
    assert [(f["uuid"], f["group_id"]) for f in r.json()["facts"]] == [("f-eng", "org_1-eng")]
    assert fake_graphiti.search_calls[0]["group_ids"] == ["org_1", "org_1-eng", "org_1-sales"]


@pytest.mark.parametrize(
    ("group_ids", "found_in"),
    [
        (["org_1-eng", "org_1"], "org_1"),
        (["org_1-eng"], None),
        # A group named by a prefix of the entity's own is a different group.
        (["org_"], None),
    ],
)
def test_entity_lookup_over_groups_finds_it_only_in_a_group_asked(
    client, headers, fake_entity, group_ids, found_in
):
    r = client.post(
        "/entities/lookup", json={"uuid": "ent-1", "group_ids": group_ids}, headers=headers
    )

    assert r.status_code == 200
    body = r.json()
    assert body["group_id"] == found_in
    assert (body["entity"] or {}).get("uuid") == ("ent-1" if found_in else None)


def test_entity_lookup_and_groups_refuse_an_empty_group_list(client, headers):
    assert (
        client.post(
            "/entities/lookup", json={"uuid": "ent-1", "group_ids": []}, headers=headers
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/entities/groups", json={"name": "Marcus", "group_ids": []}, headers=headers
        ).status_code
        == 422
    )
