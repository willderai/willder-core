"""Always-on checks for POST /people/erase; the real graph is covered in
test_person_erasure_integration.py, which needs a disposable local Neo4j."""

import asyncio
import json
from pathlib import Path

import pytest

from app import graphiti_client
from app.name_fold import fold_name
from conftest import API_KEY


@pytest.mark.parametrize(
    "body",
    [
        {"org_id": "org_a-b", "emails": ["a@b.example"]},
        {"org_id": "", "emails": ["a@b.example"]},
        {"org_id": "a", "emails": ["ab"]},
        {"org_id": "a", "names": ["  "]},
        # One word names too many people to erase by, however it is spaced.
        {"org_id": "a", "names": ["dana"]},
        {"org_id": "a", "names": ["  dana\t"]},
        {"org_id": "a", "names": ["al"]},
        {"org_id": "a", "emails": ["not-an-address"]},
        {"org_id": "a", "entity_uuids": [""]},
    ],
)
def test_malformed_request_never_reaches_the_graph(client, monkeypatch, body):
    async def unexpected(*args):
        pytest.fail("a malformed request must not reach the graph")

    monkeypatch.setattr("app.main.erase_person", unexpected)
    response = client.post(
        "/people/erase", json=body, headers={"Authorization": f"Bearer {API_KEY}"}
    )
    assert response.status_code == 422


def test_nothing_to_match_never_opens_the_database(monkeypatch):
    async def unexpected():
        pytest.fail("nothing to erase must not initialize the database")

    monkeypatch.setattr(graphiti_client, "get_graphiti", unexpected)
    result = asyncio.run(graphiti_client.erase_person("a", [], [], []))
    assert result == {"episodes": 0, "nodes": 0, "edges": 0, "summaries": 0, "episode_ids": []}


def test_names_and_addresses_reach_the_graph_composed(client, monkeypatch):
    # The graph compares its stored text composed (NFC), so a name sent with its accent
    # as a combining mark must arrive in the same form, or it would match nothing.
    received = {}

    async def capture(org_id, emails, names, entity_uuids):
        received.update(emails=emails, names=names)
        return {"episodes": 0, "nodes": 0, "edges": 0, "summaries": 0, "episode_ids": []}

    monkeypatch.setattr("app.main.erase_person", capture)
    response = client.post(
        "/people/erase",
        json={"org_id": "a", "emails": ["Zoë@Acme.example"], "names": ["Zoë  Ferrand"]},
        headers={"Authorization": f"Bearer {API_KEY}"},
    )
    assert response.status_code == 200
    assert received == {"emails": ["zoë@acme.example"], "names": ["zoë ferrand"]}


def test_names_reach_the_graph_folded_as_the_app_folds_them(client, monkeypatch):
    # A caller that sends a name unfolded (erasure-lineage sends a record's name as written)
    # still gets the app's fold: "\u0130" as "i", a final sigma as "\u03c3", a ligature undone.
    received = {}

    async def capture(org_id, emails, names, entity_uuids):
        received.update(emails=emails, names=names)
        return {"episodes": 0, "nodes": 0, "edges": 0, "summaries": 0, "episode_ids": []}

    monkeypatch.setattr("app.main.erase_person", capture)
    names = [
        "DANA WH\u0130TF\u0130ELD",
        "\u039d\u038a\u039a\u039f\u03a3 \u03a0\u0391\u03a0\u0386\u03a3",
        "Dana Whit\ufb01eld",
    ]
    response = client.post(
        "/people/erase",
        json={"org_id": "a", "emails": ["AL\u0130@ACME.EXAMPLE"], "names": names},
        headers={"Authorization": f"Bearer {API_KEY}"},
    )
    assert response.status_code == 200
    assert received == {
        "emails": ["ali@acme.example"],
        "names": [
            "dana whitfield",
            "\u03bd\u03af\u03ba\u03bf\u03c3 \u03c0\u03b1\u03c0\u03ac\u03c3",
        ],
    }


def test_every_spelling_of_the_shared_table_is_folded_as_the_app_folds_it():
    # services/memory/name-fold-spellings.json: the folds the app and Postgres are held to.
    path = Path(__file__).resolve().parents[2] / "services" / "memory" / "name-fold-spellings.json"
    folds = json.loads(path.read_text(encoding="utf-8"))["folds"]
    assert [fold_name(f["text"]) for f in folds] == [f["folded"] for f in folds]


def test_plan_with_nothing_to_match_never_opens_the_database(monkeypatch):
    async def unexpected():
        pytest.fail("nothing to plan must not initialize the database")

    monkeypatch.setattr(graphiti_client, "get_graphiti", unexpected)
    assert asyncio.run(graphiti_client.plan_person_erasure("a", [], [], [])) == []


def test_plan_reaches_the_graph_with_the_erase_requests_rules(client, monkeypatch):
    # The plan takes the erase request's body, validated and composed the same way.
    received = {}

    async def capture(org_id, emails, names, entity_uuids):
        received.update(org_id=org_id, emails=emails, names=names, entity_uuids=entity_uuids)
        return ["ep-1"]

    monkeypatch.setattr("app.main.plan_person_erasure", capture)
    headers = {"Authorization": f"Bearer {API_KEY}"}
    refused = client.post(
        "/people/erase/plan", json={"org_id": "a", "names": ["dana"]}, headers=headers
    )
    assert refused.status_code == 422 and received == {}
    response = client.post(
        "/people/erase/plan", json={"org_id": "a", "names": ["Zoë Ferrand"]}, headers=headers
    )
    assert response.status_code == 200
    assert response.json() == {"episode_ids": ["ep-1"]}
    assert received == {"org_id": "a", "emails": [], "names": ["zoë ferrand"], "entity_uuids": []}
