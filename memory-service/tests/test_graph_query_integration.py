"""POST /graph finds a fact by its query in a scope too large for one page, against a real Neo4j.

NEO4J_PROVENANCE_TEST_URI=bolt://127.0.0.1:17687 python -m pytest tests/test_graph_query_integration.py

Without a query, /graph returns the first `limit` entities ordered by uuid and the
edges leaving them, so in a scope holding more entities than the page a given fact
is simply not there. These cases seed such a scope directly and check that a query
narrows the page to the entities it names, by entity name or by fact text, with the
edges on either side of them, without reaching another group. The test database is
cleared before each case.
"""

import asyncio
import os
from urllib.parse import urlparse

import httpx
import pytest
from neo4j import AsyncGraphDatabase

from app import graphiti_client, main
from app.config import settings
from conftest import API_KEY

URI = os.getenv("NEO4J_PROVENANCE_TEST_URI")
pytestmark = pytest.mark.skipif(not URI, reason="requires disposable local Neo4j")

GROUP = "org_gq-sales"
SIBLING = "org_gq-support"
# More filler pairs than the default page of 50 entities holds.
FILLER_PAIRS = 40


def _filler() -> tuple[list[tuple], list[tuple]]:
    """Pairs of entities whose uuids sort ahead of every entity a case looks for."""
    nodes, edges = [], []
    for i in range(FILLER_PAIRS):
        a, b = f"a-{i:03d}-from", f"a-{i:03d}-to"
        nodes += [(a, f"Filler source {i}", GROUP), (b, f"Filler target {i}", GROUP)]
        edges.append((f"r-filler-{i:03d}", a, b, f"Filler fact number {i}", GROUP))
    return nodes, edges


async def _graph(monkeypatch, body: dict, nodes=(), edges=()) -> dict:
    """Seed the filler plus `nodes`/`edges`, then call POST /graph and return its JSON."""
    parsed = urlparse(URI)
    assert parsed.scheme == "bolt" and parsed.hostname == "127.0.0.1"
    driver = AsyncGraphDatabase.driver(URI, auth=None)

    async def initialized():
        pass

    async def unstamped(edge_uuids):
        return {}

    monkeypatch.setattr(graphiti_client, "get_graphiti", initialized)
    monkeypatch.setattr(graphiti_client, "get_driver", lambda: driver)
    monkeypatch.setattr(main, "fetch_edge_provenance", unstamped)
    monkeypatch.setattr(settings, "neo4j_database", "neo4j")
    filler_nodes, filler_edges = _filler()
    try:
        async with driver.session(database="neo4j") as session:
            await (await session.run("MATCH (n) DETACH DELETE n")).consume()
            await (
                await session.run(
                    "UNWIND $rows AS row CREATE (n:Entity) SET n.uuid = row[0], n.name = row[1], n.group_id = row[2]",
                    rows=[list(n) for n in [*filler_nodes, *nodes]],
                )
            ).consume()
            await (
                await session.run(
                    "UNWIND $rows AS row "
                    "MATCH (a:Entity {uuid: row[1]}), (b:Entity {uuid: row[2]}) "
                    "CREATE (a)-[r:RELATES_TO]->(b) SET r.uuid = row[0], r.fact = row[3], r.group_id = row[4]",
                    rows=[list(e) for e in [*filler_edges, *edges]],
                )
            ).consume()
        transport = httpx.ASGITransport(app=main.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                "/graph", json=body, headers={"Authorization": f"Bearer {API_KEY}"}
            )
        assert response.status_code == 200, response.text
        return response.json()
    finally:
        await driver.close()


# The fact a user is looking for, held by entities whose uuids sort after all the filler.
TARGET_NODES = [("z-acme", "Acme Corp", GROUP), ("z-renewal", "Q3 renewal", GROUP)]
TARGET_EDGE = ("r-target", "z-acme", "z-renewal", "Acme signed the Q3 renewal at 40 seats", GROUP)


def _edge_uuids(body: dict) -> set[str]:
    return {e["uuid"] for e in body["edges"]}


def test_without_a_query_the_fact_is_outside_the_default_page(monkeypatch):
    # Pins the crowded-scope behaviour a query exists to get past.
    body = asyncio.run(_graph(monkeypatch, {"group_ids": [GROUP]}, TARGET_NODES, [TARGET_EDGE]))

    assert "r-target" not in _edge_uuids(body)
    assert len(body["nodes"]) >= 50


def test_query_on_fact_text_finds_the_fact_beyond_the_default_page(monkeypatch):
    body = asyncio.run(
        _graph(
            monkeypatch,
            {"group_ids": [GROUP], "query": "40 seats"},
            TARGET_NODES,
            [TARGET_EDGE],
        )
    )

    assert _edge_uuids(body) == {"r-target"}
    assert {n["uuid"] for n in body["nodes"]} == {"z-acme", "z-renewal"}
    edge = body["edges"][0]
    assert (edge["source"], edge["target"], edge["fact"]) == ("z-acme", "z-renewal", TARGET_EDGE[3])


def test_query_on_entity_name_is_case_insensitive_and_returns_edges_on_both_sides(monkeypatch):
    # "Acme Corp" is the target of one edge and the source of another; both are its neighbourhood.
    nodes = [*TARGET_NODES, ("z-buyer", "Dana Buyer", GROUP)]
    edges = [
        TARGET_EDGE,
        ("r-incoming", "z-buyer", "z-acme", "Dana is the buyer at the account", GROUP),
    ]

    body = asyncio.run(
        _graph(monkeypatch, {"group_ids": [GROUP], "query": "  acme CORP "}, nodes, edges)
    )

    assert _edge_uuids(body) == {"r-target", "r-incoming"}
    assert {n["uuid"] for n in body["nodes"]} == {"z-acme", "z-renewal", "z-buyer"}
    incoming = next(e for e in body["edges"] if e["uuid"] == "r-incoming")
    assert (incoming["source"], incoming["target"]) == ("z-buyer", "z-acme")


def test_query_never_reaches_a_group_it_was_not_given(monkeypatch):
    nodes = [
        *TARGET_NODES,
        ("z-other-acme", "Acme Corp", SIBLING),
        ("z-other-ticket", "Ticket 9", SIBLING),
    ]
    edges = [
        TARGET_EDGE,
        (
            "r-sibling",
            "z-other-acme",
            "z-other-ticket",
            "Acme opened ticket 9 about 40 seats",
            SIBLING,
        ),
    ]

    body = asyncio.run(_graph(monkeypatch, {"group_ids": [GROUP], "query": "acme"}, nodes, edges))

    assert _edge_uuids(body) == {"r-target"}
    assert all(not n["uuid"].startswith("z-other") for n in body["nodes"])


def test_query_drops_an_edge_into_another_group_from_a_matched_entity(monkeypatch):
    # The matched entity is in GROUP, but its edge points into SIBLING: not this caller's to see.
    nodes = [*TARGET_NODES, ("z-other-ticket", "Ticket 9", SIBLING)]
    edges = [TARGET_EDGE, ("r-cross", "z-acme", "z-other-ticket", "Acme opened ticket 9", SIBLING)]

    body = asyncio.run(_graph(monkeypatch, {"group_ids": [GROUP], "query": "acme"}, nodes, edges))

    assert _edge_uuids(body) == {"r-target"}


def test_query_matching_nothing_returns_an_empty_graph(monkeypatch):
    body = asyncio.run(
        _graph(
            monkeypatch,
            {"group_ids": [GROUP], "query": "no such thing"},
            TARGET_NODES,
            [TARGET_EDGE],
        )
    )

    assert body == {"nodes": [], "edges": []}


def test_blank_query_reads_the_same_page_as_no_query(monkeypatch):
    plain = asyncio.run(_graph(monkeypatch, {"group_ids": [GROUP]}, TARGET_NODES, [TARGET_EDGE]))
    blank = asyncio.run(
        _graph(monkeypatch, {"group_ids": [GROUP], "query": "   "}, TARGET_NODES, [TARGET_EDGE])
    )

    assert blank == plain


def test_query_does_not_match_an_entity_through_a_fact_in_another_group(monkeypatch):
    # Both ends are in GROUP, but the only fact mentioning "ticket 9" belongs to SIBLING.
    # Returning either entity would tell the caller that a fact they cannot read says it.
    nodes = [*TARGET_NODES, ("z-buyer", "Dana Buyer", GROUP)]
    edges = [
        TARGET_EDGE,
        ("r-foreign", "z-buyer", "z-acme", "Dana opened ticket 9 for Acme", SIBLING),
    ]

    body = asyncio.run(
        _graph(monkeypatch, {"group_ids": [GROUP], "query": "ticket 9"}, nodes, edges)
    )

    assert body == {"nodes": [], "edges": []}


def test_query_does_not_match_an_entity_through_a_fact_whose_other_end_is_in_another_group(
    monkeypatch,
):
    # The fact is stamped GROUP, but its far end sits in SIBLING; the match must not count it.
    nodes = [*TARGET_NODES, ("z-other-ticket", "Ticket 9", SIBLING)]
    edges = [TARGET_EDGE, ("r-stray", "z-acme", "z-other-ticket", "Acme opened ticket 9", GROUP)]

    body = asyncio.run(
        _graph(monkeypatch, {"group_ids": [GROUP], "query": "ticket 9"}, nodes, edges)
    )

    assert body == {"nodes": [], "edges": []}


def test_query_drops_an_edge_stamped_in_scope_whose_other_end_is_not(monkeypatch):
    # The edge carries GROUP, the entity it reaches does not: neither comes back.
    nodes = [*TARGET_NODES, ("z-other-ticket", "Ticket 9", SIBLING)]
    edges = [TARGET_EDGE, ("r-stray", "z-other-ticket", "z-acme", "Ticket 9 names Acme", GROUP)]

    body = asyncio.run(_graph(monkeypatch, {"group_ids": [GROUP], "query": "acme"}, nodes, edges))

    assert _edge_uuids(body) == {"r-target"}
    assert "z-other-ticket" not in {n["uuid"] for n in body["nodes"]}


def test_query_drops_an_edge_from_another_group_between_two_in_scope_entities(monkeypatch):
    # Both ends are in GROUP, the fact itself belongs to SIBLING.
    nodes = [*TARGET_NODES, ("z-buyer", "Dana Buyer", GROUP)]
    edges = [
        TARGET_EDGE,
        ("r-foreign", "z-buyer", "z-acme", "Dana signed for Acme elsewhere", SIBLING),
    ]

    body = asyncio.run(_graph(monkeypatch, {"group_ids": [GROUP], "query": "acme"}, nodes, edges))

    assert _edge_uuids(body) == {"r-target"}


def test_query_returns_an_edge_between_two_matched_entities_once(monkeypatch):
    # Both ends match "acme", so the both-ways read sees the edge from each side.
    nodes = [("z-acme", "Acme Corp", GROUP), ("z-acme-eu", "Acme EU", GROUP)]
    edges = [("r-sub", "z-acme-eu", "z-acme", "Acme EU reports to Acme Corp", GROUP)]

    body = asyncio.run(_graph(monkeypatch, {"group_ids": [GROUP], "query": "acme"}, nodes, edges))

    assert [e["uuid"] for e in body["edges"]] == ["r-sub"]
    assert (body["edges"][0]["source"], body["edges"][0]["target"]) == ("z-acme-eu", "z-acme")
