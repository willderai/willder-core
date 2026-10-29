"""After a person is erased, no entity id their records produced resolves on /entities/{uuid}.

NEO4J_DELETE_TEST_URI=bolt://127.0.0.1:17687 python -m pytest tests/test_person_erasure_entity_lookup_integration.py

The graph is written the way ingestion writes it, with no model call: Graphiti's own node,
edge and episode models for what extraction produces, and the real `ensure_graph_visible`
for the verbatim nodes the service adds itself (a fallback Fact when extraction finds no
relation, a Decision stored word for word). The person is the one a contact and an agent's
note create: a contact episode at the org root, a note in a scope, a distilled sentence of
that note and a decision from it, each episode named after the person as `memory_ingest`
names it. Next to them is a bystander whose records share an entity and the fallback anchor
with the person's. Entity ids are collected through POST /graph before the erasure, as a
reader finds them, and looked up through GET /entities/{uuid} before (each must resolve,
or "not found" afterwards proves nothing) and after.
"""

import asyncio
import os
from datetime import datetime, timezone
from urllib.parse import urlparse

import httpx
import pytest
from graphiti_core.driver.neo4j_driver import Neo4jDriver
from graphiti_core.edges import EntityEdge, EpisodicEdge
from graphiti_core.nodes import EntityNode, EpisodeType, EpisodicNode
from neo4j import AsyncGraphDatabase

from app import graphiti_client, main
from app.config import settings
from conftest import API_KEY

URI = os.getenv("NEO4J_DELETE_TEST_URI")
pytestmark = pytest.mark.skipif(not URI, reason="requires disposable local Neo4j")

ORG = "cerase"
LEGACY = ORG
SCOPE = f"org_{ORG}-demo"
GROUPS = [LEGACY, f"org_{ORG}", SCOPE]
NOW = datetime(2026, 10, 8, tzinfo=timezone.utc)
# Neo4j's vector procedures refuse a null embedding; the value itself is unused.
EMBEDDING = [0.1] * settings.bge_dim

NAME = "Tavelo Marsenqui"
EMAIL = "tavelo.marsenqui.3fa2c1@erasure-probe.example"
PHONE = "+1 201 555 0142"
STUDIO = "Rimarfal Tavo Studio"
SHARED = "Harbor Loft"
HEADERS = {"Authorization": f"Bearer {API_KEY}"}


class _Embedder:
    async def create(self, _text):
        return EMBEDDING


class _Graphiti:
    embedder = _Embedder()


async def _graphiti():
    return _Graphiti()


async def _episode(driver, uuid, group, name, content):
    await EpisodicNode(
        uuid=uuid,
        name=name,
        group_id=group,
        source=EpisodeType.text,
        source_description="{}",
        content=content,
        valid_at=NOW,
        created_at=NOW,
    ).save(driver)


async def _entity(driver, uuid, group, name, labels=(), summary=""):
    await EntityNode(
        uuid=uuid,
        name=name,
        group_id=group,
        labels=list(labels),
        summary=summary,
        created_at=NOW,
        name_embedding=EMBEDDING,
    ).save(driver)


async def _fact(driver, uuid, group, source, target, fact, episode):
    await EntityEdge(
        uuid=uuid,
        source_node_uuid=source,
        target_node_uuid=target,
        name="RELATES_TO",
        fact=fact,
        group_id=group,
        episodes=[episode],
        created_at=NOW,
        valid_at=NOW,
        fact_embedding=EMBEDDING,
    ).save(driver)


async def _mentions(driver, episode, group, *entities):
    for entity in entities:
        await EpisodicEdge(
            uuid=f"m-{episode}-{entity}",
            source_node_uuid=episode,
            target_node_uuid=entity,
            group_id=group,
            created_at=NOW,
        ).save(driver)


async def _seed(driver, bystander_fact_on_anchor=True):
    """The person's records and a bystander's, as ingestion leaves them. Without
    `bystander_fact_on_anchor`, the person's fallback facts are the anchor's only edges."""
    # POST /api/contacts: one episode at the legacy org root, named after the contact.
    await _episode(
        driver,
        "ep-contact",
        LEGACY,
        NAME,
        f"{NAME} is a other. Seeded test record. Direct line {PHONE}.",
    )
    await _entity(driver, "person-legacy", LEGACY, NAME, ["Person"])
    await _entity(driver, "phone", LEGACY, PHONE)
    await _fact(
        driver,
        "e-phone",
        LEGACY,
        "person-legacy",
        "phone",
        f"{NAME}'s direct line is {PHONE}",
        "ep-contact",
    )
    await _mentions(driver, "ep-contact", LEGACY, "person-legacy", "phone")

    # memory_ingest in the scope: the raw note, named after the person.
    await _episode(
        driver,
        "ep-note",
        SCOPE,
        NAME,
        f"Seeded test record. {NAME} is the sole founder of {STUDIO}, which works out of {SHARED}. "
        f"Reach {NAME} at {EMAIL} or {PHONE}.",
    )
    await _entity(driver, "person-demo", SCOPE, NAME, ["Person"])
    await _entity(driver, "studio", SCOPE, STUDIO, ["Company"])
    await _entity(driver, "shared", SCOPE, SHARED)
    await _fact(
        driver,
        "e-founder",
        SCOPE,
        "person-demo",
        "studio",
        f"{NAME} is the sole founder of {STUDIO}",
        "ep-note",
    )
    await _fact(
        driver,
        "e-studio-shared",
        SCOPE,
        "studio",
        "shared",
        f"{STUDIO} works out of {SHARED}",
        "ep-note",
    )
    await _mentions(driver, "ep-note", SCOPE, "person-demo", "studio", "shared")

    # A distilled sentence of the note that names only the studio. Extraction found no
    # relation in it, so main.py's /ingest-bulk stored it as a fallback Fact node, linked to
    # the scope's anchor by an edge carrying this episode and nothing else.
    distilled = f"{STUDIO} has exactly one founder."
    await _episode(driver, "ep-distilled", SCOPE, NAME, distilled)
    await graphiti_client.ensure_graph_visible(SCOPE, distilled, NOW, "ep-distilled")

    # A decision the note states, stored word for word as a Decision node.
    decision = f"Decision on 2026-10-08: {STUDIO} gets the annual plan."
    await _episode(driver, "ep-decision", SCOPE, NAME, decision)
    await graphiti_client.ensure_graph_visible(
        SCOPE, decision, NOW, "ep-decision", node_label="Decision"
    )

    # A bystander: their own episode, their own fallback fact on the same anchor, and the
    # place the person's studio also works out of.
    await _episode(driver, "ep-kenji", SCOPE, "Kenji Sato", f"Kenji Sato rents a desk at {SHARED}.")
    await _entity(driver, "kenji", SCOPE, "Kenji Sato", ["Person"])
    await _fact(
        driver,
        "e-kenji",
        SCOPE,
        "kenji",
        "shared",
        f"Kenji Sato rents a desk at {SHARED}",
        "ep-kenji",
    )
    await _mentions(driver, "ep-kenji", SCOPE, "kenji", "shared")
    if bystander_fact_on_anchor:
        lease = f"The {SHARED} lease renews in May."
        await _episode(driver, "ep-lease", SCOPE, SHARED, lease)
        await graphiti_client.ensure_graph_visible(SCOPE, lease, NOW, "ep-lease")


async def _ids_named(client, needle):
    """Entity ids POST /graph returns for nodes whose name contains `needle`, read one
    partition at a time: read across several, /graph folds same-named nodes into one."""
    ids = set()
    for group in GROUPS:
        response = await client.post(
            "/graph", json={"group_ids": [group], "query": needle, "limit": 100}, headers=HEADERS
        )
        assert response.status_code == 200, response.text
        ids |= {n["uuid"] for n in response.json()["nodes"] if needle.lower() in n["name"].lower()}
    return ids


async def _resolving(client, ids):
    """Each id GET /entities/{uuid} still answers for in one of the org's partitions, with
    the facts it answers with."""
    found = {}
    for uuid in ids:
        for group in GROUPS:
            response = await client.get(
                f"/entities/{uuid}", params={"group_id": group}, headers=HEADERS
            )
            assert response.status_code in (200, 404), response.text
            if response.status_code == 200:
                found[uuid] = [f["fact"] for f in response.json()["facts"]]
    return found


async def _nodes(raw):
    """Every node in the database, as (uuid, name, labels), uuid-less ones included."""
    async with raw.session(database="neo4j") as session:
        rows = await (
            await session.run(
                "MATCH (n) RETURN n.uuid AS uuid, n.name AS name, labels(n) AS labels"
            )
        ).data()
    return [(r["uuid"], r["name"], sorted(r["labels"])) for r in rows]


async def _erase_and_look(monkeypatch, bystander_fact_on_anchor=True, before_erasure=None):
    """Seed, collect ids as a reader finds them, look each up, erase, and look again.
    `before_erasure` is another write path run on the seeded graph first."""
    parsed = urlparse(URI)
    assert parsed.scheme == "bolt" and parsed.hostname == "127.0.0.1" and parsed.port == 17687
    raw = AsyncGraphDatabase.driver(URI, auth=None)
    graph = Neo4jDriver(uri=URI, user=None, password=None)
    monkeypatch.setattr(graphiti_client, "get_graphiti", _graphiti)
    monkeypatch.setattr(graphiti_client, "get_driver", lambda: raw)
    monkeypatch.setattr(graphiti_client, "_graph_driver", graph)
    monkeypatch.setattr(settings, "neo4j_database", "neo4j")
    try:
        async with raw.session(database="neo4j") as session:
            await (await session.run("MATCH (n) DETACH DELETE n")).consume()
        await _seed(graph, bystander_fact_on_anchor)
        if before_erasure:
            await before_erasure()
        nodes_before = await _nodes(raw)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=main.app), base_url="http://test"
        ) as client:
            persons = (
                await _ids_named(client, NAME)
                | await _ids_named(client, STUDIO)
                | await _ids_named(client, PHONE)
            )
            bystanders = await _ids_named(client, SHARED) | await _ids_named(client, "Kenji Sato")
            before = await _resolving(client, persons | bystanders)
            erased = await client.post(
                "/people/erase",
                headers=HEADERS,
                json={
                    "org_id": ORG,
                    "emails": [EMAIL],
                    "names": [NAME.lower()],
                    "entity_uuids": [],
                },
            )
            assert erased.status_code == 200, erased.text
            after = await _resolving(client, persons | bystanders)
            return (
                persons,
                bystanders,
                before,
                after,
                erased.json(),
                nodes_before,
                await _nodes(raw),
            )
    finally:
        await graph.close()
        await raw.close()


def test_no_entity_id_only_the_persons_records_produced_resolves_after_the_erasure(monkeypatch):
    persons, bystanders, before, after, *_ = asyncio.run(_erase_and_look(monkeypatch))

    # Positive control: the reader found the person's records and the bystander's, and every id resolved.
    assert {"person-legacy", "person-demo", "studio", "phone"} <= persons
    assert (
        len(persons) == 6
    ), "two entities named for the person, the studio, the phone, the distilled fact, the decision"
    assert {"shared", "kenji"} <= bystanders and len(
        bystanders
    ) == 3, "the shared place, Kenji and his fallback fact"
    assert set(before) == persons | bystanders

    assert (
        set(after) & persons == set()
    ), "an entity only the erased records produced still resolves"
    assert (
        set(after) == bystanders
    ), "a bystander entity, or one a bystander also mentions, was removed"
    # The bystander's own facts are all still there, the one on the anchor the person's
    # fallback fact shared included; only the person's link to the shared place is gone.
    assert after["kenji"] == before["kenji"]
    (lease,) = bystanders - {"shared", "kenji"}
    assert after[lease] == before[lease] == [f"The {SHARED} lease renews in May."]
    assert after["shared"] == [f"Kenji Sato rents a desk at {SHARED}"]


def test_the_count_includes_every_entity_removed_with_the_person(monkeypatch):
    persons, _, _, _, counts, *_ = asyncio.run(_erase_and_look(monkeypatch))
    assert sorted(counts["episode_ids"]) == ["ep-contact", "ep-decision", "ep-distilled", "ep-note"]
    assert counts["nodes"] == len(persons)


def test_the_shared_fallback_anchor_stays_when_the_persons_facts_were_its_last(monkeypatch):
    # ensure_graph_visible merges the anchor and links a new fact to it in one statement;
    # removing it under a concurrent write would drop that write. It holds no content.
    persons, bystanders, _, after, counts, before_nodes, after_nodes = asyncio.run(
        _erase_and_look(monkeypatch, bystander_fact_on_anchor=False)
    )
    anchor = graphiti_client._fallback_anchor_uuid(SCOPE)
    anchors_before = [n for n in before_nodes if n[0] == anchor]
    assert anchors_before == [
        (anchor, graphiti_client.FALLBACK_ANCHOR_NAME, ["Category", "Entity"])
    ]
    assert [n for n in after_nodes if n[0] == anchor] == anchors_before
    assert set(after) == bystanders == {"shared", "kenji"}
    assert counts["nodes"] == len(persons) == 6, "the anchor is not counted as removed"


def test_a_role_holder_whose_only_facts_were_about_the_person_goes(monkeypatch):
    # transfer_entity_edges (an org role changing hands) MERGEs the new holder by name, with
    # no MENTIONS, and copies the old holder's facts to it word for word. When
    # every fact it holds is a copy naming the erased person, those copies go with the
    # person and the holder is left with nothing attached: intended, it goes too.
    holder = "Ilse Brandt"

    async def hand_over_the_role():
        await graphiti_client.transfer_entity_edges(SCOPE, NAME, holder)

    persons, _, _, _, counts, before_nodes, after_nodes = asyncio.run(
        _erase_and_look(monkeypatch, before_erasure=hand_over_the_role)
    )
    [(holder_uuid, _, labels)] = [n for n in before_nodes if n[1] == holder]
    assert holder_uuid and labels == ["Entity"]
    assert [n for n in after_nodes if n[1] == holder] == []
    assert counts["nodes"] == len(persons) + 1
