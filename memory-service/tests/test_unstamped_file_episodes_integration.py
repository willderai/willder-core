"""The W3c backfill's two routes, against real Cypher on a disposable local Neo4j.

NEO4J_DELETE_TEST_URI=bolt://127.0.0.1:17687 python -m pytest tests/test_unstamped_file_episodes_integration.py

POST /episodes/unstamped-files lists, read-only, the file episodes ingest wrote before the
app stamped each passage's chunk id on its episode. It names them by uuid and by digests of
their text and filename salted with the caller's value, never the text or the name. POST /episodes/stamp-chunk writes that stamp on one
of them and on nothing else. Stamping an orphan with an orphan mark lets DELETE /chunks
retire it. The database is cleared before each case; no model calls.
"""

import asyncio
import hashlib
import json
import os
from urllib.parse import urlparse

import httpx
import pytest
from neo4j import AsyncGraphDatabase

from app import graphiti_client, main
from app.config import settings
from conftest import API_KEY

URI = os.getenv("NEO4J_DELETE_TEST_URI")
pytestmark = pytest.mark.skipif(not URI, reason="requires disposable local Neo4j")

GROUP = "org_a-hb"
OTHER_GROUP = "org_b-hb"
AUTH = {"Authorization": f"Bearer {API_KEY}"}
SALT = "run-salt-0123456789"


def _prov(**fields) -> str:
    base = {
        "actor_type": "human",
        "actor_id": "u1",
        "source": "document",
        "source_id": None,
        "chunk_id": None,
    }
    base.update(fields)
    return json.dumps(base)


def _digest(value: str, salt: str = SALT) -> str:
    return hashlib.sha256(f"{salt}:{value}".encode("utf-8")).hexdigest()


# (uuid, group_id, name, content, source_description)
EPISODES = [
    ("ep-a", GROUP, "notes.pdf (part 1/2)", "Q3 targets: 40 logos.", _prov()),
    ("ep-b", GROUP, "notes.pdf (part 2/2)", "Q4 targets: 55 logos.", _prov()),
    # Already stamped by ingest: not listed.
    ("ep-c", GROUP, "keep.pdf", "Travel needs approval.", _prov(chunk_id="chunk-keep")),
    # A Drive passage carries its source: not listed.
    ("ep-d", GROUP, "handbook.pdf", "Leave is 20 days.", _prov(source_id="src-drive")),
    # Not a document: not listed.
    ("ep-e", GROUP, "episode:u1", "Acme renews in March.", _prov(source="message")),
    # Marked an orphan by an earlier run that did not retire it: listed, pending.
    ("ep-f", GROUP, "old.pdf", "Old plan.", _prov(chunk_id="w3c-orphan:ep-f")),
    # Another group.
    ("ep-g", OTHER_GROUP, "notes.pdf", "Q3 targets: 40 logos.", _prov()),
]


async def _with_graph(monkeypatch, fn):
    parsed = urlparse(URI)
    assert parsed.scheme == "bolt" and parsed.hostname == "127.0.0.1"
    driver = AsyncGraphDatabase.driver(URI, auth=None)

    async def initialized():
        pass

    monkeypatch.setattr(graphiti_client, "get_graphiti", initialized)
    monkeypatch.setattr(graphiti_client, "get_driver", lambda: driver)
    monkeypatch.setattr(settings, "neo4j_database", "neo4j")
    try:
        async with driver.session(database="neo4j") as session:
            await (await session.run("MATCH (n) DETACH DELETE n")).consume()
            for uuid, group_id, name, content, desc in EPISODES:
                await (
                    await session.run(
                        "CREATE (ep:Episodic {uuid: $uuid, group_id: $group_id, name: $name, content: $content, source_description: $desc})",
                        uuid=uuid,
                        group_id=group_id,
                        name=name,
                        content=content,
                        desc=desc,
                    )
                ).consume()
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=main.app), base_url="http://test"
            ) as client:
                return await fn(client, session)
    finally:
        await driver.close()


async def _provenance(session, uuid: str) -> dict:
    rec = await (
        await session.run(
            "MATCH (ep:Episodic {uuid: $uuid}) RETURN ep.source_description AS d", uuid=uuid
        )
    ).single()
    return json.loads(rec["d"])


async def _all_properties(session) -> dict:
    rows = await (
        await session.run("MATCH (n) RETURN n.uuid AS uuid, properties(n) AS props")
    ).data()
    return {r["uuid"]: r["props"] for r in rows}


def test_lists_only_unstamped_file_episodes_by_salted_digest_never_by_text_or_name(monkeypatch):
    async def run(client, session):
        before = await _all_properties(session)
        response = await client.post(
            "/episodes/unstamped-files", json={"group_id": GROUP, "salt": SALT}, headers=AUTH
        )
        return response, before, await _all_properties(session)

    response, before, after = asyncio.run(_with_graph(monkeypatch, run))

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["episodes"] == [
        {
            "uuid": "ep-a",
            "content_digest": _digest("Q3 targets: 40 logos."),
            "file_name_digest": _digest("notes.pdf"),
            "pending_retirement": False,
        },
        {
            "uuid": "ep-b",
            "content_digest": _digest("Q4 targets: 55 logos."),
            "file_name_digest": _digest("notes.pdf"),
            "pending_retirement": False,
        },
        {
            "uuid": "ep-f",
            "content_digest": _digest("Old plan."),
            "file_name_digest": _digest("old.pdf"),
            "pending_retirement": True,
        },
    ]
    assert body["scanned"] == 6
    assert body["next_after"] is None
    for leaked in ("logos", "notes.pdf", "old.pdf", hashlib.sha256(b"Old plan.").hexdigest()):
        assert leaked not in response.text
    # Read-only.
    assert after == before


def test_another_salt_gives_other_digests(monkeypatch):
    async def run(client, _session):
        a = (
            await client.post(
                "/episodes/unstamped-files", json={"group_id": GROUP, "salt": SALT}, headers=AUTH
            )
        ).json()
        b = (
            await client.post(
                "/episodes/unstamped-files",
                json={"group_id": GROUP, "salt": "another-salt-987654"},
                headers=AUTH,
            )
        ).json()
        short = await client.post(
            "/episodes/unstamped-files", json={"group_id": GROUP, "salt": "short"}, headers=AUTH
        )
        return a, b, short

    a, b, short = asyncio.run(_with_graph(monkeypatch, run))

    assert {e["content_digest"] for e in a["episodes"]}.isdisjoint(
        {e["content_digest"] for e in b["episodes"]}
    )
    assert short.status_code == 422


def test_pages_in_uuid_order(monkeypatch):
    async def run(client, _session):
        first = (
            await client.post(
                "/episodes/unstamped-files",
                json={"group_id": GROUP, "salt": SALT, "limit": 2},
                headers=AUTH,
            )
        ).json()
        second = (
            await client.post(
                "/episodes/unstamped-files",
                json={"group_id": GROUP, "salt": SALT, "limit": 2, "after": first["next_after"]},
                headers=AUTH,
            )
        ).json()
        return first, second

    first, second = asyncio.run(_with_graph(monkeypatch, run))

    assert [e["uuid"] for e in first["episodes"]] == ["ep-a", "ep-b"]
    assert first["next_after"] == "ep-b"
    # ep-c and ep-d are read and skipped on the second page.
    assert second["episodes"] == []
    assert second["scanned"] == 2
    assert second["next_after"] == "ep-d"


def test_stamps_one_unstamped_file_episode_and_a_rerun_changes_nothing(monkeypatch):
    async def run(client, session):
        stamp = {"group_id": GROUP, "episode_uuid": "ep-a", "chunk_id": "chunk-q3"}
        first = await client.post("/episodes/stamp-chunk", json=stamp, headers=AUTH)
        after_first = await _all_properties(session)
        second = await client.post("/episodes/stamp-chunk", json=stamp, headers=AUTH)
        return (
            first,
            second,
            after_first,
            await _all_properties(session),
            await _provenance(session, "ep-a"),
        )

    first, second, after_first, after_second, provenance = asyncio.run(
        _with_graph(monkeypatch, run)
    )

    assert first.json() == {"outcome": "stamped"}
    assert second.json() == {"outcome": "already"}
    assert after_second == after_first
    assert provenance["chunk_id"] == "chunk-q3"
    # Everything else ingest stamped is kept.
    assert provenance["actor_id"] == "u1" and provenance["source"] == "document"


@pytest.mark.parametrize(
    ("uuid", "group_id", "outcome"),
    [
        ("ep-c", GROUP, "refused"),  # already carries another chunk's stamp
        ("ep-d", GROUP, "refused"),  # a connector source's passage
        ("ep-e", GROUP, "refused"),  # not a document
        ("ep-g", GROUP, "missing"),  # in another group
        ("ep-none", GROUP, "missing"),
    ],
)
def test_refuses_anything_but_an_unstamped_file_episode_in_the_group(
    monkeypatch, uuid, group_id, outcome
):
    async def run(client, session):
        before = await _all_properties(session)
        response = await client.post(
            "/episodes/stamp-chunk",
            json={"group_id": group_id, "episode_uuid": uuid, "chunk_id": "chunk-x"},
            headers=AUTH,
        )
        return response, before, await _all_properties(session)

    response, before, after = asyncio.run(_with_graph(monkeypatch, run))

    assert response.json() == {"outcome": outcome}
    assert after == before


def test_an_orphan_mark_lets_the_chunk_retirement_remove_the_episode(monkeypatch):
    async def run(client, session):
        mark = "w3c-orphan:ep-b"
        stamped = await client.post(
            "/episodes/stamp-chunk",
            json={"group_id": GROUP, "episode_uuid": "ep-b", "chunk_id": mark},
            headers=AUTH,
        )
        retired = await client.delete(f"/chunks/{mark}", params={"group_id": GROUP}, headers=AUTH)
        listed = (
            await client.post(
                "/episodes/unstamped-files", json={"group_id": GROUP, "salt": SALT}, headers=AUTH
            )
        ).json()
        return stamped, retired, listed, await _all_properties(session)

    stamped, retired, listed, nodes = asyncio.run(_with_graph(monkeypatch, run))

    assert stamped.json() == {"outcome": "stamped"}
    assert retired.status_code == 200 and retired.json()["removed_episodes"] == 1
    assert "ep-b" not in nodes
    assert [e["uuid"] for e in listed["episodes"]] == ["ep-a", "ep-f"]


@pytest.mark.parametrize(
    ("path", "body"),
    [
        ("/episodes/unstamped-files", {"group_id": GROUP, "salt": SALT}),
        (
            "/episodes/stamp-chunk",
            {"group_id": GROUP, "episode_uuid": "ep-a", "chunk_id": "chunk-q3"},
        ),
    ],
)
@pytest.mark.parametrize(
    "headers",
    [{}, {"Authorization": "Bearer wrong-key"}],
    ids=["missing", "wrong"],
)
def test_requires_service_authentication(monkeypatch, path, body, headers):
    async def run(client, session):
        before = await _all_properties(session)
        response = await client.post(path, json=body, headers=headers)
        return response, before, await _all_properties(session)

    response, before, after = asyncio.run(_with_graph(monkeypatch, run))

    assert response.status_code == 401
    assert after == before
