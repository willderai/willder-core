"""Erasing one person from the graph, on a disposable local Neo4j.

NEO4J_DELETE_TEST_URI=bolt://127.0.0.1:17687 python -m pytest tests/test_person_erasure_integration.py

Drives the real FastAPI route and the real Cypher. The fixture puts the same
person in this org's legacy, root and scoped partitions, next to a bystander in
the same org and the same person in another tenant. After one call, nothing in
this org may name the person, and everything else must be exactly as it was.
The database is cleared before each case; no model calls or production
credentials.
"""

import asyncio
import json
import os
import time
import unicodedata
from pathlib import Path
from urllib.parse import urlparse

import httpx
import pytest
from neo4j import AsyncGraphDatabase

from app import graphiti_client, main
from app.name_fold import case_literal, fold_name
from app.config import settings
from conftest import API_KEY

URI = os.getenv("NEO4J_DELETE_TEST_URI")
pytestmark = pytest.mark.skipif(not URI, reason="requires disposable local Neo4j")

ORG = "cerase"
OTHER_ORG = "cother"
EMAIL = "dana_w@acme.example"
NAME = "Dana Whitfield"
MARKERS = [EMAIL, NAME.lower()]

# The spellings the app's erasure, its suppression digests and the graph must all decide alike.
SPELLINGS = json.loads(
    (
        Path(__file__).resolve().parents[2] / "services" / "memory" / "name-fold-spellings.json"
    ).read_text(encoding="utf-8")
)

# The names written without spaces (ASCII spellings, runs up to a hyphen, digits before, %27)
# the app's erasure, its suppression digests and the graph must all decide alike.
RUN_TOGETHER = json.loads(
    (
        Path(__file__).resolve().parents[2] / "services" / "memory" / "name-run-together-forms.json"
    ).read_text(encoding="utf-8")
)

# Every node: (label, uuid, group_id, text property, text).
NODES = [
    # The person's entity in three partitions of this org.
    ("Entity", "dana-root", f"org_{ORG}", "summary", "VP Finance at Acme."),
    ("Entity", "dana-legacy", ORG, "summary", "Prospect."),
    ("Entity", "dana-sales", f"org_{ORG}-sales", "summary", "Wants the annual plan."),
    # A bystander whose summary quotes the person.
    ("Entity", "acme", f"org_{ORG}-sales", "summary", f"Customer. Main contact {NAME}."),
    ("Entity", "kenji", f"org_{ORG}-sales", "summary", "Kenji runs procurement."),
    # Episodes: one names the person by email, one does not.
    ("Episodic", "ep-dana", f"org_{ORG}-sales", "content", f"Call with {NAME} <{EMAIL}>."),
    ("Episodic", "ep-kenji", f"org_{ORG}-sales", "content", "Kenji asked for a quote."),
    # A verbatim fact node naming the person, and one that does not.
    ("Passage", "passage-dana", f"org_{ORG}", "summary", f"{EMAIL} called on 3 March."),
    ("Passage", "passage-other", f"org_{ORG}", "summary", "Quote sent on 4 March."),
    # A lookalike that only matches if "_" were a wildcard.
    ("Episodic", "ep-lookalike", f"org_{ORG}", "content", "danaxw@acme.example wrote in."),
    # The same person in another tenant, including its identical root path.
    ("Entity", "dana-other", f"org_{OTHER_ORG}", "summary", f"{NAME}, {EMAIL}."),
    ("Episodic", "ep-other", f"org_{OTHER_ORG}-sales", "content", f"{NAME} <{EMAIL}>."),
    # A tenant whose id starts with this org's id.
    ("Entity", "dana-prefix", f"org_{ORG}x", "summary", f"{NAME}."),
    # A node with no partition at all.
    ("Entity", "untagged", None, "summary", "No group."),
]

# Every edge: (source, type, target, uuid, group_id, fact, episodes).
EDGES = [
    (
        "dana-sales",
        "RELATES_TO",
        "acme",
        "e-works",
        f"org_{ORG}-sales",
        "works at Acme",
        ["ep-dana"],
    ),
    (
        "kenji",
        "RELATES_TO",
        "acme",
        "e-kenji",
        f"org_{ORG}-sales",
        "Kenji works at Acme",
        ["ep-kenji"],
    ),
    # Created by Kenji's episode, later also matched by the person's episode.
    (
        "kenji",
        "RELATES_TO",
        "acme",
        "e-shared",
        f"org_{ORG}-sales",
        "Acme renews in May",
        ["ep-kenji", "ep-dana"],
    ),
    # Created by the person's episode, the text does not name them.
    (
        "kenji",
        "RELATES_TO",
        "acme",
        "e-owned",
        f"org_{ORG}-sales",
        "The budget is 40k",
        ["ep-dana"],
    ),
    # Names the person by email between two bystanders.
    (
        "kenji",
        "RELATES_TO",
        "acme",
        "e-mentions",
        f"org_{ORG}-sales",
        f"Kenji forwards to {EMAIL}",
        ["ep-kenji"],
    ),
    ("ep-dana", "MENTIONS", "dana-sales", "m-dana", f"org_{ORG}-sales", None, None),
    ("ep-kenji", "MENTIONS", "kenji", "m-kenji", f"org_{ORG}-sales", None, None),
    ("passage-dana", "RELATES_TO", "dana-root", "e-passage", f"org_{ORG}", f"{EMAIL} called", []),
    # Another tenant's edge naming the person: out of reach.
    (
        "dana-other",
        "RELATES_TO",
        "ep-other",
        "e-other",
        f"org_{OTHER_ORG}-sales",
        f"{EMAIL} renewed",
        [],
    ),
]

REMOVED_NODES = {"dana-root", "dana-legacy", "dana-sales", "ep-dana", "passage-dana"}
REMOVED_EDGES = {"e-works", "e-owned", "e-mentions", "m-dana", "e-passage"}


# Derived records: entities only the person's episode ever mentioned. Their names do not
# name the person, so no text match reaches them; they exist only because of that episode.
DERIVED_NODES = [
    ("Entity", "budget", f"org_{ORG}-sales", "summary", "Q3 budget line."),
    ("Entity", "offsite", f"org_{ORG}", "summary", ""),
]
DERIVED_EDGES = [
    # Created by the person's episode, so it goes with it and leaves `budget` with nothing.
    (
        "budget",
        "RELATES_TO",
        "offsite",
        "e-budget",
        f"org_{ORG}-sales",
        "The budget covers the offsite",
        ["ep-dana"],
    ),
    ("ep-dana", "MENTIONS", "budget", "m-budget", f"org_{ORG}-sales", None, None),
    ("ep-dana", "MENTIONS", "offsite", "m-offsite", f"org_{ORG}-sales", None, None),
    # Also mentioned by the person's episode, but Kenji's edges still hold it.
    ("ep-dana", "MENTIONS", "kenji", "m-dana-kenji", f"org_{ORG}-sales", None, None),
]


async def seed(session, extra_edge=None, derived=False, extra_nodes=()):
    """Seed NODES and EDGES. `extra_nodes` are (label, uuid, group_id, text property,
    text, name) tuples, for a case that needs a node's name set explicitly."""
    await (await session.run("MATCH (n) DETACH DELETE n")).consume()
    nodes = [
        (*node, NAME if node[1].startswith("dana-") else node[1])
        for node in NODES + (DERIVED_NODES if derived else [])
    ]
    for label, uuid, group, prop, text, name in nodes + list(extra_nodes):
        labels = f"Entity:{label}" if label == "Passage" else label
        await (
            await session.run(
                f"CREATE (n:{labels} {{uuid: $uuid, group_id: $group, name: $name}}) SET n[$prop] = $text",
                uuid=uuid,
                group=group,
                name=name,
                prop=prop,
                text=text,
            )
        ).consume()
    edges = EDGES + (DERIVED_EDGES if derived else []) + ([extra_edge] if extra_edge else [])
    for source, rel, target, uuid, group, fact, episodes in edges:
        await (
            await session.run(
                f"MATCH (a {{uuid: $source}}), (b {{uuid: $target}}) "
                f"CREATE (a)-[r:{rel} {{uuid: $uuid, group_id: $group}}]->(b) "
                "SET r.fact = $fact, r.episodes = $episodes",
                source=source,
                target=target,
                uuid=uuid,
                group=group,
                fact=fact,
                episodes=episodes,
            )
        ).consume()


async def snapshot(session):
    nodes = await (
        await session.run(
            "MATCH (n) RETURN n.uuid AS uuid, n.group_id AS gid, n.summary AS summary, "
            "n.content AS content ORDER BY uuid"
        )
    ).data()
    edges = await (
        await session.run(
            "MATCH (a)-[r]->(b) RETURN r.uuid AS uuid, r.group_id AS gid, r.fact AS fact, r.episodes AS episodes "
            "ORDER BY uuid"
        )
    ).data()
    return nodes, edges


async def exercise(
    monkeypatch, body, extra_edge=None, authorized=True, calls=1, derived=False, extra_nodes=()
):
    parsed = urlparse(URI)
    assert parsed.scheme == "bolt" and parsed.hostname == "127.0.0.1" and parsed.port == 17687
    driver = AsyncGraphDatabase.driver(URI, auth=None)

    async def initialized():
        pass

    monkeypatch.setattr(graphiti_client, "get_graphiti", initialized)
    monkeypatch.setattr(graphiti_client, "get_driver", lambda: driver)
    monkeypatch.setattr(settings, "neo4j_database", "neo4j")
    try:
        async with driver.session(database="neo4j") as session:
            await seed(session, extra_edge, derived, extra_nodes)
            before = await snapshot(session)
            headers = {"Authorization": f"Bearer {API_KEY}"} if authorized else {}
            responses = []
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=main.app), base_url="http://test"
            ) as client:
                for _ in range(calls):
                    responses.append(await client.post("/people/erase", json=body, headers=headers))
            after = await snapshot(session)
            return responses, before, after
    finally:
        await driver.close()


def body(**overrides):
    return {"org_id": ORG, "emails": [EMAIL], "names": [NAME], "entity_uuids": [], **overrides}


def names_person(record):
    text = " ".join(str(v) for v in record.values() if v is not None).lower()
    return any(marker in text for marker in MARKERS)


def in_org(gid):
    return gid in (ORG, f"org_{ORG}") or (gid or "").startswith(f"org_{ORG}-")


def test_erases_every_trace_in_the_org_and_nothing_else(monkeypatch):
    (response,), before, after = asyncio.run(exercise(monkeypatch, body()))
    assert response.status_code == 200
    assert response.json() == {
        "episodes": 1,
        "nodes": 4,
        "edges": 5,
        "summaries": 1,
        "episode_ids": ["ep-dana"],
    }

    nodes, edges = after
    assert not [n for n in nodes if in_org(n["gid"]) and names_person(n)]
    assert not [e for e in edges if in_org(e["gid"]) and names_person(e)]
    assert {n["uuid"] for n in before[0]} - {n["uuid"] for n in nodes} == REMOVED_NODES
    assert {e["uuid"] for e in before[1]} - {e["uuid"] for e in edges} == REMOVED_EDGES

    by_uuid = {n["uuid"]: n for n in nodes}
    assert by_uuid["acme"]["summary"] == ""
    assert by_uuid["kenji"]["summary"] == "Kenji runs procurement."
    shared = next(e for e in edges if e["uuid"] == "e-shared")
    assert shared["episodes"] == ["ep-kenji"]
    # Other tenants, a tenant sharing this id as a prefix, and the lookalike stay.
    for uuid in (
        "dana-other",
        "ep-other",
        "dana-prefix",
        "ep-lookalike",
        "passage-other",
        "untagged",
    ):
        assert by_uuid[uuid] == next(n for n in before[0] if n["uuid"] == uuid)
    assert next(e for e in edges if e["uuid"] == "e-other") == next(
        e for e in before[1] if e["uuid"] == "e-other"
    )


def test_an_episode_named_for_the_person_goes_even_when_its_text_never_names_them(monkeypatch):
    # memory_ingest names an episode after the entity it is about, and an agent writing
    # about someone it has already named writes "She ...": the name is the episode's only
    # trace of the person. Bystanders' episodes named the same way stay, including an
    # address that only matches if "_" were a wildcard.
    episodes = (
        ("Episodic", "ep-she", f"org_{ORG}-sales", "content", "She wants the annual plan.", NAME),
        ("Episodic", "ep-he", f"org_{ORG}-sales", "content", "He runs procurement.", "Kenji Sato"),
        (
            "Episodic",
            "ep-named-lookalike",
            f"org_{ORG}",
            "content",
            "Asked for a quote.",
            "danaxw@acme.example",
        ),
    )
    (response,), before, after = asyncio.run(exercise(monkeypatch, body(), extra_nodes=episodes))
    assert response.status_code == 200
    assert sorted(response.json()["episode_ids"]) == ["ep-dana", "ep-she"]
    remaining = {n["uuid"] for n in after[0]}
    assert "ep-she" not in remaining
    assert {"ep-he", "ep-named-lookalike"} <= remaining


def episodes(*rows):
    """Episodes in this org's sales scope, as (uuid, name, body) rows."""
    return tuple(
        ("Episodic", uuid, f"org_{ORG}-sales", "content", text, name) for uuid, name, text in rows
    )


def test_a_name_or_address_inside_a_bystanders_is_never_erased(monkeypatch):
    bystanders = episodes(
        ("ep-sal-lin", "Sal Lin", "She signed the order."),
        ("ep-kristal", "Kristal Lindberg", "Owns the renewal."),
        ("ep-sal-email", "sal@acme.example", "Forwarded the deck."),
        ("ep-hal-email", "hal@acme.example.org", "Asked for a quote."),
        ("ep-other-domain", "pricing", "Sent to al@acme.example.org for review."),
        ("ep-text-sal-lin", "pricing", "Sal Lin asked for the annual plan."),
        ("ep-jordan", "jordan@acme.com", "jordan@acme.com asked for the invoice."),
    )
    targets = episodes(
        ("ep-al-li", "Al Li", "He wants SSO."),
        ("ep-al-email", "pricing", "Write to al@acme.example."),
        ("ep-dan", "dan@acme.com", "Asked for the contract."),
    )
    erase = body(emails=["al@acme.example", "dan@acme.com"], names=["al li"])
    (response,), before, after = asyncio.run(
        exercise(monkeypatch, erase, extra_nodes=bystanders + targets)
    )
    assert response.status_code == 200
    assert sorted(response.json()["episode_ids"]) == ["ep-al-email", "ep-al-li", "ep-dan"]
    remaining = {n["uuid"] for n in after[0]}
    assert {b[1] for b in bystanders} <= remaining


def test_the_name_is_found_however_its_words_are_spaced_or_ordered(monkeypatch):
    erased = episodes(
        ("ep-reversed", "Whitfield, Dana", "Notes."),
        ("ep-double-space", "Dana  Whitfield", "Notes."),
        ("ep-tab", "Dana\tWhitfield", "Notes."),
        ("ep-nbsp", "Dana\u00a0Whitfield", "Notes."),
        ("ep-email-name", " DANA_W@acme.example ", "Notes."),
        # Another entity's record whose own text names her goes by the text rule.
        (
            "ep-foundation-names-her",
            "Dana Whitfield Foundation",
            "Dana Whitfield joined the board.",
        ),
    )
    kept = episodes(
        ("ep-honorific", "Ms. Whitfield", "Notes."),
        # An episode's name matches only her whole name: these are other records.
        ("ep-foundation", "Dana Whitfield Foundation", "The budget for 2027 is two million."),
        ("ep-barnes", "Dana Whitfield-Barnes", "Runs procurement."),
        ("ep-barnes-text", "procurement", "Dana Whitfield-Barnes runs procurement."),
    )
    entities = (
        ("Entity", "dana-spaced", f"org_{ORG}-sales", "summary", "Prospect.", "Dana  Whitfield"),
        ("Entity", "dana-reversed", f"org_{ORG}-sales", "summary", "Prospect.", "Whitfield, Dana"),
        # Another entity whose name contains hers: an entity is matched by its whole name.
        (
            "Entity",
            "foundation",
            f"org_{ORG}-sales",
            "summary",
            "A charity.",
            "Dana Whitfield Foundation",
        ),
    )
    (response,), before, after = asyncio.run(
        exercise(monkeypatch, body(), extra_nodes=erased + kept + entities)
    )
    assert response.status_code == 200
    remaining = {n["uuid"] for n in after[0]}
    assert not {e[1] for e in erased} & remaining
    assert not {"dana-spaced", "dana-reversed"} & remaining
    assert {k[1] for k in kept} | {"foundation"} <= remaining


def test_a_hyphen_joins_her_name_to_another_only_between_two_words(monkeypatch):
    # A hyphen joining her surname to another word makes another person; a bullet dash
    # before her name, a dash with nothing after it, or a modifier word after it does not.
    erased = episodes(
        ("ep-modifier", "pricing", "The Dana Whitfield-approved budget renewed."),
        ("ep-modifier-double", "pricing", "A DANA WHITFIELD--LED TEAM."),
        ("ep-bullet", "pricing", "Owners:\n-Dana Whitfield\n-Bo Wu"),
        ("ep-trailing-dash", "pricing", "Ask Dana Whitfield- or Bo Wu."),
        ("ep-modifier-nb-hyphen", "pricing", "The Dana Whitfield\u2011approved budget renewed."),
    )
    kept = episodes(
        ("ep-hyphenated-surname", "pricing", "Dana Whitfield-Barnes runs procurement."),
        ("ep-hyphenated-given-name", "pricing", "Mary-Dana Whitfield runs procurement."),
        ("ep-double-hyphenated-given-name", "pricing", "Mary--Dana Whitfield runs procurement."),
        ("ep-modifier-prefix", "pricing", "Dana Whitfield-Ledbetter runs procurement."),
        # Every hyphen joins alike: a Unicode or non-breaking one too.
        ("ep-nb-hyphenated-surname", "pricing", "Dana Whitfield\u2011Barnes runs procurement."),
        (
            "ep-unicode-hyphenated-surname",
            "pricing",
            "Dana Whitfield\u2010Barnes runs procurement.",
        ),
        (
            "ep-unicode-hyphenated-given-name",
            "pricing",
            "Mary\u2010Dana Whitfield runs procurement.",
        ),
        ("ep-en-dash-given-name", "pricing", "Mary\u2013Dana Whitfield runs procurement."),
    )
    erase = body(names=["dana whitfield"])
    (response,), before, after = asyncio.run(
        exercise(monkeypatch, erase, extra_nodes=erased + kept)
    )
    assert response.status_code == 200
    remaining = {n["uuid"] for n in after[0]}
    assert not {e[1] for e in erased} & remaining
    assert {k[1] for k in kept} <= remaining


def test_a_name_written_without_spaces_is_found_but_never_inside_another(monkeypatch):
    # Her words joined by "_", ".", "-" or a camel-case step, as a file name or an address
    # writes them; never inside a longer word, never joined by a hyphen to another word, never
    # a double surname after a given name or capitalised.
    erased = episodes(
        ("ep-underscores", "files", "Dana_Whitfield_offer.pdf"),
        ("ep-full-stops", "files", "Dana.Whitfield.offer.pdf"),
        ("ep-capitalised-modifier", "files", "Dana_Whitfield-Approved_budget.xlsx"),
        # An em dash is punctuation: it parts her name from the next word.
        ("ep-em-dash-after", "files", "Dana_Whitfield\u2014Barnes.pdf"),
        ("ep-modifier-then-camel", "files", "DanaWhitfield-ledTeam.pdf"),
        ("ep-spaced-modifier-then-digit", "files", "Dana Whitfield-approved2026.pdf"),
        ("ep-camel-space", "files", "DanaWhitfield offer.pdf"),
        ("ep-camel-run-on", "files", "DanaWhitfieldOffer.pdf"),
        ("ep-camel-digit", "files", "DanaWhitfield2026.pdf"),
        ("ep-upper-snake", "files", "DANA_WHITFIELD_OFFER.PDF"),
        ("ep-address", "files", "Write to dana.whitfield@other.example today."),
        ("ep-possessive", "files", "Dana_Whitfield's notes.txt"),
        ("ep-link", "files", "https://drive.example/Dana%20Whitfield%20offer.pdf"),
        ("ep-spaced-then-camel", "files", "Dana WhitfieldOffer.pdf"),
        ("ep-spaced-then-digit", "files", "Dana Whitfield2.pdf"),
        (
            "ep-fullwidth",
            "files",
            "\uff24\uff41\uff4e\uff41\uff3f\uff37\uff48\uff49\uff54\uff46\uff49\uff45\uff4c\uff44.pdf",
        ),
        ("ep-ligature", "files", "Dana Whit\ufb01eld signed the order."),
        ("ep-stray-mark", "files", "\u0001Dana_Whitfield_offer.pdf"),
        # A U+0001 the text already held is dropped before camel-case steps are read, as the
        # app drops it (services/memory/person-name-characters.ts, markWordSteps).
        ("ep-stray-mark-in-camel", "files", "Dana\u0001Whitfield.pdf"),
        ("ep-modifier", "files", "Dana_Whitfield-approved_budget.xlsx"),
        ("ep-record-underscores", "dana_whitfield", "Notes."),
        ("ep-record-camel", "DanaWhitfield", "Notes."),
        # Her whole name run together with nothing between its words, 6 characters or more
        # (services/memory/person-name-characters.ts, concatenatedNames).
        ("ep-one-case", "files", "danawhitfield.pdf"),
        ("ep-run-together-upper", "files", "DANAWHITFIELD offer"),
        ("ep-run-together-possessive", "files", "danawhitfield's notes.txt"),
        ("ep-run-together-modifier", "files", "danawhitfield-approved.pdf"),
        ("ep-run-together-then-camel", "files", "DanawhitfieldOffer.pdf"),
        ("ep-mark-between", "files", "dana\u0001whitfield"),
        ("ep-record-run-together", "danawhitfield", "Notes."),
        ("ep-record-run-together-encoded-space", "danawhitfield%20", "Notes."),
    )
    kept = episodes(
        ("ep-danaher", "files", "Danaher_offer.pdf"),
        ("ep-diana", "files", "Diana_Whitfield_offer.pdf"),
        ("ep-double-surname", "files", "Ana Dana-Whitfield.pdf"),
        ("ep-slug-after-word", "files", "Offer for dana-whitfield.pdf"),
        # Hyphens alone where her own name has whitespace: another person's double surname or
        # compound given name is spelled so, in any case, so her own slug is missed.
        ("ep-hyphens", "files", "dana-whitfield_offer.pdf"),
        ("ep-hyphens-alone", "files", "dana-whitfield.pdf"),
        ("ep-hyphens-modifier", "files", "dana-whitfield-approved.pdf"),
        ("ep-record-login", "dana-whitfield", "Notes."),
        ("ep-unicode-hyphen", "files", "dana\u2010whitfield.pdf"),
        ("ep-slug-after-underscore", "files", "offer_dana-whitfield.pdf"),
        ("ep-slash", "files", "Dana/Whitfield.pdf"),
        ("ep-camel-start", "files", "OfferDanaWhitfield.pdf"),
        ("ep-run-together-longer", "files", "danawhitfieldson.pdf"),
        ("ep-run-together-inside", "files", "offerdanawhitfield.pdf"),
        ("ep-run-together-hyphenated", "files", "danawhitfield-barnes.pdf"),
        ("ep-longer-surname", "files", "DanaWhitfieldson.pdf"),
        ("ep-sentence", "files", "I called Dana. Whitfield answered."),
        ("ep-surname-first", "files", "whitfield_dana.pdf"),
        ("ep-hyphenated-surname", "files", "Dana_Whitfield-Barnes_CV.pdf"),
        ("ep-hyphenated-surname-camel", "files", "DanaWhitfield-Barnes.pdf"),
        ("ep-hyphenated-surname-address", "files", "Write to dana.whitfield-barnes@other.example"),
        ("ep-double-surname-underscore", "files", "Ana_Dana-Whitfield_CV.pdf"),
        ("ep-double-surname-initial", "files", "Ana M. Dana-Whitfield signed."),
        ("ep-double-surname-title", "files", "Mrs. Dana-Whitfield signed."),
        ("ep-stray-mark-camel-start", "files", "Ana\u0001DanaWhitfield.pdf"),
        ("ep-stray-mark-then-camel-start", "files", "Offer\u0001Dana_Whitfield.pdf"),
        # A currency sign is in the app's letter range, so it continues a word here too.
        ("ep-euro-before", "files", "\u20acDana_Whitfield.pdf"),
        ("ep-euro-after", "files", "Dana Whitfield\u20ac signed."),
        # Every dash continues a word; a compatibility hyphen or letter does once folded.
        ("ep-en-dash-after", "files", "Dana_Whitfield\u2013Barnes_CV.pdf"),
        ("ep-en-dash-before", "files", "Barnes\u2013Dana_Whitfield.pdf"),
        ("ep-soft-hyphen-after", "files", "Dana_Whitfield\u00adBarnes.pdf"),
        ("ep-spaced-en-dash", "files", "Dana Whitfield\u2013Barnes runs procurement."),
        ("ep-fullwidth-hyphen", "files", "Dana_Whitfield\uff0dBarnes_CV.pdf"),
        ("ep-ordinal-after", "files", "Dana Whitfield\u00aa signed."),
        ("ep-record-foundation", "Dana_Whitfield_Foundation", "Notes."),
        # Joined by a hyphen to another word, on either side: another person's slug.
        ("ep-slug-double-surname", "files", "dana-whitfield-barnes.pdf"),
        ("ep-slug-word-before", "files", "offer-dana-whitfield.pdf"),
        ("ep-slug-nb-hyphens", "files", "dana\u2011whitfield\u2011barnes.pdf"),
        ("ep-slug-path", "files", "https://people.example/staff/dana-whitfield-barnes"),
        ("ep-modifier-prefix-camel", "files", "DanaWhitfield-Ledbetter.pdf"),
        # Capitalised and joined by hyphens alone: a double surname wherever it stands.
        ("ep-capitalised-file", "files", "Dana-Whitfield.pdf"),
        ("ep-capitalised-unicode-hyphen", "files", "Dana\u2010Whitfield.pdf"),
        ("ep-capitals", "files", "DANA-WHITFIELD.PDF"),
        ("ep-second-capitalised", "files", "dana-Whitfield.pdf"),
        ("ep-citation", "files", "(Dana-Whitfield, 2019)"),
        ("ep-reference", "files", "[3] Dana-Whitfield, A. Pricing at scale."),
        ("ep-record-capitalised", "Dana-Whitfield", "Notes."),
        # "%20" reads as a space only where a name written without spaces is looked for.
        ("ep-link-spaced-surname", "files", "Dana%20Whitfield-Barnes.pdf"),
    )
    erase = body(emails=[], names=["dana whitfield"])
    (response,), before, after = asyncio.run(
        exercise(monkeypatch, erase, extra_nodes=erased + kept)
    )
    assert response.status_code == 200
    remaining = {n["uuid"] for n in after[0]}
    assert sorted(e[1] for e in erased if e[1] in remaining) == []
    assert sorted(k[1] for k in kept if k[1] not in remaining) == []


def test_another_persons_compound_or_double_name_as_a_lower_case_slug_stays(monkeypatch):
    # A lower-case slug of her name is spelled exactly as another person's compound given name
    # (Anne-Marie, Jean-Pierre, Mary-Ann) or double surname (A. Dana-Whitfield) is, in
    # lower-case chat, a file name or a handle. Each is kept.
    kept = episodes(
        ("ep-am-full-name", "chat", "anne-marie laval joined the call"),
        ("ep-am-list", "chat", "attendees: anne-marie laval, bo wu"),
        ("ep-am-cv", "files", "anne-marie_laval_cv.pdf"),
        ("ep-am-handle", "chat", "<@anne-marie.laval> can you check"),
        ("ep-am-given-name", "chat", "anne-marie said the deck is fine"),
        ("ep-am-record", "anne-marie", "Notes."),
        ("ep-jp-full-name", "chat", "jean-pierre dupont joined the call"),
        ("ep-jp-author", "chat", "Author: jean-pierre <jp@other.example>"),
        ("ep-jp-record", "jean-pierre", "Notes."),
        ("ep-ma-full-name", "chat", "mary-ann smith joined"),
        ("ep-dw-reference", "chat", "[3] dana-whitfield, a. pricing at scale"),
        ("ep-dw-citation", "chat", "(dana-whitfield 2019)"),
        ("ep-dw-surname-first", "chat", "dana-whitfield, ana replied"),
    )
    # Her name next to an em dash used as punctuation: each is erased.
    erased = episodes(
        ("ep-em-dash-after", "chat", "I met Dana Whitfield\u2014she signed the lease."),
        ("ep-em-dash-around", "chat", "Our CFO\u2014Dana Whitfield\u2014signed the lease."),
        ("ep-em-dash-sign-off", "chat", "Great quarter, thanks\u2014Dana Whitfield"),
    )
    erase = body(emails=[], names=["anne marie", "jean pierre", "mary ann", "dana whitfield"])
    (response,), before, after = asyncio.run(
        exercise(monkeypatch, erase, extra_nodes=erased + kept)
    )
    assert response.status_code == 200
    remaining = {n["uuid"] for n in after[0]}
    assert sorted(k[1] for k in kept if k[1] not in remaining) == []
    assert sorted(e[1] for e in erased if e[1] in remaining) == []


def test_a_line_break_or_tab_where_her_name_has_a_hyphen_parts_two_people(monkeypatch):
    # Her own hyphen may be written as a space, but a line break or a tab
    # there is how two entries are written: a roster row or a one-per-line list where "Anne" and
    # "Marie Dupont" (or "Lee" and "Ann Park") are two people. Each is kept.
    kept = episodes(
        ("ep-roster-tab", "files", "Mentor\tMentee\nAnne\tMarie Dupont\nBo\tWu"),
        ("ep-list-lines", "chat", "Present:\nAnne\nMarie Dupont\nBo Wu"),
        ("ep-cells-tab", "files", "Lee\tAnn Park"),
        ("ep-list-crlf", "chat", "Present:\r\nLee\r\nAnn Park"),
    )
    erase = body(emails=[], names=["anne-marie dupont", "lee\u2011ann park"])
    (response,), before, after = asyncio.run(exercise(monkeypatch, erase, extra_nodes=kept))
    assert response.status_code == 200
    remaining = {n["uuid"] for n in after[0]}
    assert sorted(k[1] for k in kept if k[1] not in remaining) == []


def test_a_name_with_a_hyphen_or_capital_inside_is_found_written_without_spaces(monkeypatch):
    erased = episodes(
        ("ep-hyphenated-given", "files", "anne_marie_dupont.pdf"),
        ("ep-hyphenated-camel", "files", "AnneMarieDupont.pdf"),
        ("ep-hyphenated-given-capitalised", "files", "Anne-Marie_Dupont.pdf"),
        ("ep-capital-inside", "files", "Rory.McDonald.pdf"),
        # The graph reads case where it matches, so a camel-case step inside her own word
        # does not hide her (the app's rule misses this one; erasure-rule-agreement.realdb.test.ts).
        ("ep-capital-inside-camel", "files", "RoryMcDonald.pdf"),
    )
    kept = episodes(
        ("ep-part-of-given", "files", "Marie_Dupont.pdf"),
        ("ep-other-rory", "files", "Rory_McDonaldson.pdf"),
        # A hyphenated given name ending in an erased one is another person.
        ("ep-anne-marie-laval", "files", "Anne-Marie_Laval_CV.pdf"),
        ("ep-anne-marie-laval-address", "files", "Write to anne-marie.laval@other.example"),
        ("ep-anne-marie-laval-slug", "files", "anne-marie-laval.pdf"),
        ("ep-anne-marie-laval-unicode", "files", "Anne\u2010Marie_Laval_CV.pdf"),
        # A hyphen where her own name has a space makes another name.
        ("ep-anne-double-surname", "files", "Anne Marie-Dupont signed."),
    )
    erase = body(emails=[], names=["anne-marie dupont", "rory mcdonald", "marie laval"])
    (response,), before, after = asyncio.run(
        exercise(monkeypatch, erase, extra_nodes=erased + kept)
    )
    assert response.status_code == 200
    remaining = {n["uuid"] for n in after[0]}
    assert sorted(e[1] for e in erased if e[1] in remaining) == []
    assert sorted(k[1] for k in kept if k[1] not in remaining) == []


def test_a_curly_apostrophe_in_her_name_is_read_as_a_straight_one(monkeypatch):
    # The app folds a curly apostrophe to a straight one before it
    # sends the name, so the graph must fold the text the same way, or "O\u2019Brien" as a word
    # processor writes it keeps her episodes. Removing that fold from _composed fails this test.
    erased = episodes(
        ("ep-curly-spaced", "files", "Siobhan O\u2019Brien signed the order."),
        ("ep-curly-joined", "files", "Siobhan_O\u2019Brien_cv.pdf"),
        ("ep-curly-record", "Siobhan O\u2019Brien", "Notes."),
    )
    kept = episodes(
        ("ep-other-obrien", "files", "Sinead O\u2019Brien signed the order."),
    )
    erase = body(emails=[], names=["siobhan o'brien"])
    (response,), before, after = asyncio.run(
        exercise(monkeypatch, erase, extra_nodes=erased + kept)
    )
    assert response.status_code == 200
    remaining = {n["uuid"] for n in after[0]}
    assert sorted(e[1] for e in erased if e[1] in remaining) == []
    assert sorted(k[1] for k in kept if k[1] not in remaining) == []


def test_a_name_run_together_is_found_without_her_apostrophe_and_only_from_6_characters(
    monkeypatch,
):
    # The app reads her whole name run together as hers, also with her apostrophe left out, at 6
    # characters or more, and a camel-case step may stand inside it
    # (services/memory/person-name-characters.ts, concatenatedNames). The graph mirrors that in
    # _with_concatenated; dropping its apostrophe-free form, its steps or its floor fails here.
    erased = episodes(
        ("ep-run-no-apostrophe", "files", "#siobhanobrien"),
        ("ep-run-no-apostrophe-camel", "files", "SiobhanOBrien.pdf"),
        ("ep-run-with-apostrophe", "files", "siobhano'brien.pdf"),
        ("ep-run-camel-then-digits", "files", "RoryMcDonald2026.pdf"),
        # Over-erasure accepted: a common word spelled as her whole name run together.
        ("ep-run-common-word", "chat", "It takes willpower."),
    )
    kept = episodes(
        # Under 6 characters run together is not read as hers.
        ("ep-run-too-short", "files", "annli_notes.pdf"),
        ("ep-run-other-name", "files", "Alli_report.pdf"),
    )
    erase = body(
        emails=[], names=["siobhan o'brien", "rory mcdonald", "will power", "ann li", "al li"]
    )
    (response,), before, after = asyncio.run(
        exercise(monkeypatch, erase, extra_nodes=erased + kept)
    )
    assert response.status_code == 200
    remaining = {n["uuid"] for n in after[0]}
    assert sorted(e[1] for e in erased if e[1] in remaining) == []
    assert sorted(k[1] for k in kept if k[1] not in remaining) == []


def test_a_name_in_text_is_never_read_surname_first(monkeypatch):
    # Read surname first, a list of people or one name running into another would name
    # her: "Wei Li, Ann Chen" is not "Ann Li". So text naming her surname first is missed,
    # an under-erasure the app's rules share. A record's whole name is still read either way.
    erased = episodes(
        ("ep-name-comma", "Whitfield, Dana", "Notes."),
        ("ep-name-no-comma", "Whitfield Dana", "Notes."),
    )
    kept = episodes(
        ("ep-attendees", "pricing", "Attendees: Wei Li, Ann Chen, Bo Wu."),
        ("ep-cc", "pricing", "Cc: Tom Whitfield, Dana Cole"),
        ("ep-li-ann-tan", "pricing", "Li Ann Tan signed the order."),
        ("ep-no-comma", "pricing", "Whitfield Dana owns the renewal."),
        ("ep-surname-first", "pricing", "Whitfield, Dana owns the renewal."),
        ("ep-surname-first-list", "pricing", "Li, Ann; Bo Wu"),
    )
    erase = body(names=["dana whitfield", "ann li"])
    (response,), before, after = asyncio.run(
        exercise(monkeypatch, erase, extra_nodes=erased + kept)
    )
    assert response.status_code == 200
    remaining = {n["uuid"] for n in after[0]}
    assert not {e[1] for e in erased} & remaining
    assert {k[1] for k in kept} <= remaining


def test_a_name_is_found_however_its_accent_is_encoded(monkeypatch):
    # An accent precomposed (NFC) or typed as a combining mark (NFD) is one letter, in the
    # stored text and in the request. Without the accent it is her ASCII spelling, hers too
    # (_ascii_spelling); continued by another letter, it is someone else's name.
    erased = episodes(
        ("ep-composed", "pricing", "Zo\u00eb Ferrand signed the order."),
        ("ep-decomposed", "pricing", "Zoe\u0308 Ferrand signed the order."),
        ("ep-decomposed-reversed-name", "Ferrand, Zoe\u0308", "Notes."),
        ("ep-decomposed-name", "Zoe\u0308 Ferrand", "Notes."),
        ("ep-no-accent", "Zoe Ferrand", "Zoe Ferrand signed the order."),
    )
    kept = episodes(
        ("ep-longer", "pricing", "Zoe\u0308l Ferrand signed the order."),
        # Composed, this is "Al Lí": the accent continues the name into another one.
        ("ep-accent-continues", "pricing", "Al Li\u0301 signed the order."),
    )
    entities = (
        (
            "Entity",
            "zoe-decomposed",
            f"org_{ORG}-sales",
            "summary",
            "Prospect.",
            "Zoe\u0308 Ferrand",
        ),
    )
    erase = body(emails=["zoe@acme.example"], names=["Zoe\u0308 Ferrand", "al li"])
    (response,), before, after = asyncio.run(
        exercise(monkeypatch, erase, extra_nodes=erased + kept + entities)
    )
    assert response.status_code == 200
    remaining = {n["uuid"] for n in after[0]}
    assert not {e[1] for e in erased} & remaining
    assert "zoe-decomposed" not in remaining
    assert {k[1] for k in kept} <= remaining


def test_every_spelling_of_the_shared_table_is_decided_as_the_app_decides_it(monkeypatch):
    # The table services/memory/erasure-rule-agreement.realdb.test.ts also holds the app's
    # erasure and its suppression digests to: the Turkish dotted and dotless i, final sigma,
    # sharp s, compatibility forms, combining marks and Cyrillic variant letters.
    cases = SPELLINGS["cases"]
    uuid = [f"ep-spelling-{i}" for i in range(len(cases))]
    rows = episodes(
        *((uuid[i], c.get("name", "pricing"), c["content"]) for i, c in enumerate(cases))
    )
    people = SPELLINGS["people"]
    erase = body(emails=[p["email"] for p in people], names=[p["name"] for p in people])
    (response,), before, after = asyncio.run(exercise(monkeypatch, erase, extra_nodes=rows))
    assert response.status_code == 200
    remaining = {n["uuid"] for n in after[0]}
    verdicts = {
        c["label"]: "kept" if uuid[i] in remaining else "erased" for i, c in enumerate(cases)
    }
    assert verdicts == {c["label"]: c["expected"] for c in cases}


def test_every_name_of_the_run_together_table_is_decided_as_the_app_decides_it(monkeypatch):
    # The table services/memory/erasure-rule-agreement.realdb.test.ts also holds the app's
    # erasure and its suppression digests to: her name as ASCII spells it, run together up to
    # her own hyphen, digits before it, a link's %27 for her apostrophe and the 6-character floor.
    cases = RUN_TOGETHER["cases"]
    uuid = [f"ep-run-together-{i}" for i in range(len(cases))]
    rows = episodes(
        *((uuid[i], c.get("name", "pricing"), c["content"]) for i, c in enumerate(cases))
    )
    people = RUN_TOGETHER["people"]
    erase = body(emails=[p["email"] for p in people], names=[p["name"] for p in people])
    (response,), before, after = asyncio.run(exercise(monkeypatch, erase, extra_nodes=rows))
    assert response.status_code == 200
    remaining = {n["uuid"] for n in after[0]}
    verdicts = {
        c["label"]: "kept" if uuid[i] in remaining else "erased" for i, c in enumerate(cases)
    }
    assert verdicts == {c["label"]: c["expected"] for c in cases}


def _case_linked_letters() -> list[set[str]]:
    """Every letter of the Basic Multilingual Plane that stays itself under NFKC, grouped with
    those case links it to: its capital, its lowercase and its fold, wherever each is one
    character. Java's case-insensitive match can only fold letters together within a group."""
    parent: dict[str, str] = {}

    def root(c: str) -> str:
        while parent.setdefault(c, c) != c:
            c = parent[c]
        return c

    def stable(c: str) -> bool:
        return unicodedata.category(c) != "Cn" and unicodedata.normalize("NFKC", c) == c

    for cp in range(1, 0x10000):
        c = chr(cp)
        if 0xD800 <= cp <= 0xDFFF or not stable(c):
            continue
        root(c)
        for other in (c.upper(), c.lower(), fold_name(c)):
            if len(other) == 1 and other != c and stable(other):
                parent[root(other)] = root(c)
    groups: dict[str, set[str]] = {}
    for c in parent:
        groups.setdefault(root(c), set()).add(c)
    return [g for g in groups.values() if len(g) > 1]


async def _cypher_matches(pairs: list[dict]) -> dict[int, bool]:
    """Whether Cypher's `=~` matches each pair's NFKC-normalized text against its pattern."""
    driver = AsyncGraphDatabase.driver(URI, auth=None)
    try:
        async with driver.session(database="neo4j") as session:
            result = await session.run(
                f'UNWIND $pairs AS pair RETURN pair.i AS i, {graphiti_client._composed("pair.text")} =~ pair.pattern AS hit',
                pairs=pairs,
            )
            return {r["i"]: r["hit"] for r in await result.data()}
    finally:
        await driver.close()


def test_each_letter_of_a_name_matches_in_the_graph_exactly_the_letters_the_app_folds_to_it():
    # Letter by letter: the pattern for a folded letter (app/name_fold.py, case_literal) must
    # match a letter of text exactly when the app folds that letter to it. Java alone also
    # folds the dotless i with i, U+0345 with iota and the Cyrillic variants U+1C80 to U+1C88,
    # and does not fold the capital sharp s with the sharp s.
    pairs = []
    for group in _case_linked_letters():
        for text in sorted(group):
            for letter in sorted({fold_name(c) for c in group}):
                pairs.append({"i": len(pairs), "text": text, "letter": letter})
    # A lowercase letter whose capital has no precomposed form is written as its capital and a
    # combining mark ("J" and a caron for "\u01f0"), which the app composes once lowercased.
    for cp in range(1, 0x10000):
        c = chr(cp)
        if 0xD800 <= cp <= 0xDFFF or unicodedata.category(c) == "Cn":
            continue
        capital = unicodedata.normalize("NFKC", c.upper())
        if fold_name(c) == c and len(capital) > 1 and fold_name(capital) == c:
            pairs.append({"i": len(pairs), "text": capital, "letter": c})
    # "i" and a combining dot above, as JavaScript lowercases the dotted capital, is "i".
    pairs.append({"i": len(pairs), "text": "i\u0307", "letter": "i"})
    pairs.append({"i": len(pairs), "text": "\u0131\u0307", "letter": "i"})
    for pair in pairs:
        pair["pattern"] = "(?isu)" + case_literal(pair["letter"])
    hits = asyncio.run(_cypher_matches(pairs))
    wrong = [
        f"{p['text']!r} {'matched' if hits[p['i']] else 'missed'} {p['letter']!r}"
        for p in pairs
        if hits[p["i"]] != (fold_name(p["text"]) == p["letter"])
    ]
    assert wrong == []
    assert len(pairs) > 2000


def test_an_episode_named_after_someone_whose_name_contains_the_persons_stays(monkeypatch):
    kept = episodes(
        ("ep-mary-ann", "Mary Ann Li", "Signed the order on Friday."),
        ("ep-ann-li-wei", "Ann Li Wei", "Owns the renewal."),
        ("ep-liu", "Al Liú", "Signed the order."),
        ("ep-liu-text", "pricing", "Al Liú signed the order."),
    )
    erased = episodes(("ep-ann", "Ann Li", "Wants SSO."), ("ep-li-al", "Li, Al", "Owner."))
    erase = body(emails=["ann.li@acme.example"], names=["ann li", "al li"])
    (response,), before, after = asyncio.run(
        exercise(monkeypatch, erase, extra_nodes=kept + erased)
    )
    assert response.status_code == 200
    remaining = {n["uuid"] for n in after[0]}
    assert {k[1] for k in kept} <= remaining
    assert not {e[1] for e in erased} & remaining


def test_an_entity_only_the_erased_episodes_mention_goes_with_them(monkeypatch):
    (response,), before, after = asyncio.run(exercise(monkeypatch, body(), derived=True))
    assert response.status_code == 200
    assert response.json() == {
        "episodes": 1,
        "nodes": 6,
        "edges": 9,
        "summaries": 1,
        "episode_ids": ["ep-dana"],
    }

    removed = {n["uuid"] for n in before[0]} - {n["uuid"] for n in after[0]}
    assert removed == REMOVED_NODES | {"budget", "offsite"}
    # Kenji was mentioned too, but his own edges still hold him.
    assert "kenji" in {n["uuid"] for n in after[0]}


def test_an_entity_another_episode_still_mentions_stays(monkeypatch):
    # The only thing left holding `offsite` is a surviving episode's MENTIONS, not a fact
    # edge. Any relationship counts as attached, so it stays, and so does that mention.
    held = ("ep-kenji", "MENTIONS", "offsite", "m-kenji-offsite", f"org_{ORG}-sales", None, None)
    (response,), before, after = asyncio.run(
        exercise(monkeypatch, body(), extra_edge=held, derived=True)
    )
    assert response.status_code == 200
    assert response.json() == {
        "episodes": 1,
        "nodes": 5,
        "edges": 9,
        "summaries": 1,
        "episode_ids": ["ep-dana"],
    }

    removed = {n["uuid"] for n in before[0]} - {n["uuid"] for n in after[0]}
    assert removed == REMOVED_NODES | {"budget"}
    assert "m-kenji-offsite" in {e["uuid"] for e in after[1]}


def test_entity_uuid_alone_removes_that_node(monkeypatch):
    (response,), before, after = asyncio.run(
        exercise(monkeypatch, body(emails=[], names=[], entity_uuids=["dana-legacy", "dana-other"]))
    )
    assert response.status_code == 200
    assert response.json() == {
        "episodes": 0,
        "nodes": 1,
        "edges": 0,
        "summaries": 0,
        "episode_ids": [],
    }
    remaining = {n["uuid"] for n in after[0]}
    assert "dana-legacy" not in remaining
    # An entity uuid from another tenant is out of reach.
    assert "dana-other" in remaining


def test_the_plan_names_the_episodes_the_erase_removes_and_changes_nothing(monkeypatch):
    async def plan_then_erase():
        parsed = urlparse(URI)
        assert parsed.scheme == "bolt" and parsed.hostname == "127.0.0.1" and parsed.port == 17687
        driver = AsyncGraphDatabase.driver(URI, auth=None)

        async def initialized():
            pass

        monkeypatch.setattr(graphiti_client, "get_graphiti", initialized)
        monkeypatch.setattr(graphiti_client, "get_driver", lambda: driver)
        monkeypatch.setattr(settings, "neo4j_database", "neo4j")
        try:
            async with driver.session(database="neo4j") as session:
                await seed(session)
                before = await snapshot(session)
                headers = {"Authorization": f"Bearer {API_KEY}"}
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=main.app), base_url="http://test"
                ) as client:
                    plan = await client.post("/people/erase/plan", json=body(), headers=headers)
                    after_plan = await snapshot(session)
                    erase = await client.post("/people/erase", json=body(), headers=headers)
                    replan = await client.post("/people/erase/plan", json=body(), headers=headers)
                return plan, before, after_plan, erase, replan
        finally:
            await driver.close()

    plan, before, after_plan, erase, replan = asyncio.run(plan_then_erase())
    assert plan.status_code == 200 and erase.status_code == 200
    assert after_plan == before
    assert plan.json()["episode_ids"] == erase.json()["episode_ids"] == ["ep-dana"]
    assert replan.json() == {"episode_ids": []}


def test_second_call_removes_nothing_and_succeeds(monkeypatch):
    responses, _, _ = asyncio.run(exercise(monkeypatch, body(), calls=2))
    assert [r.status_code for r in responses] == [200, 200]
    assert responses[1].json() == {
        "episodes": 0,
        "nodes": 0,
        "edges": 0,
        "summaries": 0,
        "episode_ids": [],
    }


@pytest.mark.parametrize("outside", ["dana-other", "untagged"])
def test_a_relationship_out_of_the_org_aborts_without_changes(monkeypatch, outside):
    stray = ("dana-sales", "RELATES_TO", outside, "e-stray", f"org_{ORG}-sales", "knows", [])
    (response,), before, after = asyncio.run(exercise(monkeypatch, body(), extra_edge=stray))
    assert response.status_code == 409
    assert after == before


@pytest.mark.parametrize(
    "payload",
    [
        body(org_id=""),
        body(org_id="org_a-b"),
        body(emails=["ab"]),
        body(names=["  "]),
    ],
)
def test_invalid_request_is_rejected_without_changes(monkeypatch, payload):
    (response,), before, after = asyncio.run(exercise(monkeypatch, payload))
    assert response.status_code == 422
    assert after == before


def test_requires_service_key(monkeypatch):
    (response,), before, after = asyncio.run(exercise(monkeypatch, body(), authorized=False))
    assert response.status_code == 401
    assert after == before


def test_a_hyphen_or_capital_makes_another_name_in_every_script(monkeypatch):
    # A hyphen stands between two of her words only where her own name has one, and a capital
    # after a hyphen marks a double surname or compound given name in any script.
    erased = episodes(
        ("ep-jpd-underscores", "files", "jean_pierre_dupont.pdf"),
    )
    kept = episodes(
        ("ep-jean-pierre", "files", "Jean-Pierre Dupont signed."),
        ("ep-jpd-slug", "files", "jean-pierre-dupont.pdf"),
        ("ep-mihai-slug", "files", "mihai-\u0219tefan.pdf"),
        ("ep-jean-pierre-file", "files", "Jean-Pierre_Dupont_CV.pdf"),
        ("ep-jean-pierre-lower", "files", "jean-pierre_dupont_cv.pdf"),
        ("ep-jean-pierre-record", "jean-pierre_dupont", "Notes."),
        ("ep-mihai-stefan", "files", "Mihai-\u0218tefan Popescu signed the lease."),
        ("ep-mihai-citation", "files", "(Mihai-\u0218tefan, 2019) found the opposite."),
        ("ep-jan-lukasz", "files", "Jan-\u0141ukasz Nowak signed."),
        ("ep-mihai-record", "Mihai-\u0218tefan", "Notes."),
    )
    erase = body(emails=[], names=["jean pierre dupont", "mihai \u0219tefan", "jan \u0142ukasz"])
    (response,), before, after = asyncio.run(
        exercise(monkeypatch, erase, extra_nodes=erased + kept)
    )
    assert response.status_code == 200
    remaining = {n["uuid"] for n in after[0]}
    assert sorted(e[1] for e in erased if e[1] in remaining) == []
    assert sorted(k[1] for k in kept if k[1] not in remaining) == []


def test_long_runs_of_marks_are_read_in_linear_time(monkeypatch):
    # Every pattern opens with her first word, so a long run of spaces, "_" or hyphens is not
    # searched back at every place in it (8,000 underscores took 10 s before).
    hostile = episodes(
        ("ep-underscores", "files", "a" + "_" * 20_000),
        ("ep-spaces", "files", "a" + " " * 20_000),
        ("ep-hyphens", "files", "a" + "-" * 20_000),
    )
    erase = body(emails=[], names=["dana whitfield", "anne-marie dupont"])
    started = time.monotonic()
    (response,), before, after = asyncio.run(exercise(monkeypatch, erase, extra_nodes=hostile))
    assert response.status_code == 200
    assert time.monotonic() - started < 10
    assert {h[1] for h in hostile} <= {n["uuid"] for n in after[0]}
