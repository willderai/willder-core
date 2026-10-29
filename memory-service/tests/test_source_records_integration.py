"""POST /sources/records against real Cypher on a disposable local Neo4j.

NEO4J_DELETE_TEST_URI=bolt://127.0.0.1:17687 python -m pytest tests/test_source_records_integration.py

The route counts what one connected source left in the graph of one org: its
episodes, the facts that cite it, the vectors on those facts, the verbatim nodes
behind them, and the entities in the named scopes that nothing links to any more.
Each case seeds the graph directly, then asks the route before and after the real
disconnect route (DELETE /groups/{group_id}?source_id=) has run, so the counts are
read off what retirement actually leaves. Setup and safety rules match
test_source_retirement_integration.py.
"""

import asyncio
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

ORG = "a"
GROUP = "org_a-support"
OTHER_GROUP = "org_a-sales"
FOREIGN_GROUP = "org_b-support"
SOURCE = "src_gh"
OTHER_SOURCE = "src_slack"
VECTOR = [0.1, 0.2, 0.3]
ANCHOR = graphiti_client._fallback_anchor_uuid(GROUP)
HEADERS = {"Authorization": f"Bearer {API_KEY}"}


def _stamp(source_id: str) -> str:
    return json.dumps({"actor_type": "extraction", "source_id": source_id})


# (labels, uuid, group_id, properties)
NODES = [
    (
        "Episodic",
        "ep-gh",
        GROUP,
        {"content": "Dana says the renewal is at risk.", "source_description": _stamp(SOURCE)},
    ),
    ("Entity", "dana", GROUP, {"name": "Dana", "summary": "Dana reports the renewal risk."}),
    ("Entity:Passage", "passage-gh", GROUP, {"name": "passage", "summary": "Q3: renewal at risk."}),
    ("Entity", "acme", GROUP, {"name": "Acme", "summary": "Customer."}),
    (
        "Episodic",
        "ep-slack",
        GROUP,
        {"content": "Acme renewed the seats.", "source_description": _stamp(OTHER_SOURCE)},
    ),
    ("Entity", "beta", GROUP, {"name": "Beta", "summary": "Partner of Acme."}),
    # The scope's fallback anchor, which stays when its last fact goes.
    ("Entity:Category", ANCHOR, GROUP, {"name": graphiti_client.FALLBACK_ANCHOR_NAME}),
    # The same source wrote under a second scope of the org before a reconnect moved it.
    (
        "Episodic",
        "ep-gh-sales",
        OTHER_GROUP,
        {"content": "Kai owns pricing.", "source_description": _stamp(SOURCE)},
    ),
    ("Entity", "kai", OTHER_GROUP, {"name": "Kai", "summary": "Pricing owner."}),
    ("Entity", "pricing", OTHER_GROUP, {"name": "Pricing", "summary": ""}),
    # A source whose id merely starts with this one's.
    (
        "Episodic",
        "ep-gh2",
        GROUP,
        {"content": "Beta signed.", "source_description": _stamp(SOURCE + "2")},
    ),
    # The same source id in another tenant.
    (
        "Episodic",
        "ep-foreign",
        FOREIGN_GROUP,
        {"content": "Foreign.", "source_description": _stamp(SOURCE)},
    ),
    ("Entity", "foreign-entity", FOREIGN_GROUP, {"name": "Dana", "summary": "Foreign."}),
]

# (type, uuid, from, to, group_id, properties)
EDGES = [
    ("MENTIONS", "m-gh-dana", "ep-gh", "dana", GROUP, {}),
    ("MENTIONS", "m-gh-acme", "ep-gh", "acme", GROUP, {}),
    ("MENTIONS", "m-slack-acme", "ep-slack", "acme", GROUP, {}),
    ("MENTIONS", "m-slack-beta", "ep-slack", "beta", GROUP, {}),
    (
        "RELATES_TO",
        "f-gh",
        "dana",
        "acme",
        GROUP,
        {"fact": "Dana: renewal at risk", "episodes": ["ep-gh"], "fact_embedding": VECTOR},
    ),
    # Created by the other source; this source's episode only matched it.
    (
        "RELATES_TO",
        "f-slack",
        "acme",
        "beta",
        GROUP,
        {
            "fact": "Acme partners with Beta",
            "episodes": ["ep-slack", "ep-gh"],
            "fact_embedding": VECTOR,
        },
    ),
    (
        "RELATES_TO",
        "v-gh",
        "passage-gh",
        ANCHOR,
        GROUP,
        {"fact": "Q3: renewal at risk.", "source_description": _stamp(SOURCE), "embedding": VECTOR},
    ),
    ("MENTIONS", "m-sales-kai", "ep-gh-sales", "kai", OTHER_GROUP, {}),
    ("MENTIONS", "m-sales-pricing", "ep-gh-sales", "pricing", OTHER_GROUP, {}),
    (
        "RELATES_TO",
        "f-sales",
        "kai",
        "pricing",
        OTHER_GROUP,
        {"fact": "Kai owns pricing", "episodes": ["ep-gh-sales"]},
    ),
    ("MENTIONS", "m-foreign", "ep-foreign", "foreign-entity", FOREIGN_GROUP, {}),
]


async def _seed(session, nodes, edges) -> None:
    await (await session.run("MATCH (n) DETACH DELETE n")).consume()
    for labels, uuid, group_id, props in nodes:
        await (
            await session.run(
                f"CREATE (n:{labels}) SET n = $props, n.uuid = $uuid, n.group_id = $group_id",
                props=props,
                uuid=uuid,
                group_id=group_id,
            )
        ).consume()
    for rel, uuid, start, end, group_id, props in edges:
        await (
            await session.run(
                f"MATCH (a {{uuid: $start}}), (b {{uuid: $end}}) "
                f"CREATE (a)-[r:{rel}]->(b) SET r = $props, r.uuid = $uuid, r.group_id = $group_id",
                start=start,
                end=end,
                props=props,
                uuid=uuid,
                group_id=group_id,
            )
        ).consume()


def _records_body(source_id=SOURCE, group_ids=(GROUP,), org_id=ORG) -> dict:
    return {"org_id": org_id, "source_id": source_id, "group_ids": list(group_ids)}


async def _run(monkeypatch, nodes=NODES, edges=EDGES, steps=()):
    """Seed, then run `steps` in order against the real app. A step is
    ("records", body) or ("disconnect", group_id, source_id) or
    ("disconnect_together", [(group_id, source_id), ...]). Returns each records answer."""
    parsed = urlparse(URI)
    assert parsed.scheme == "bolt" and parsed.hostname == "127.0.0.1"
    driver = AsyncGraphDatabase.driver(URI, auth=None)

    async def initialized():
        pass

    monkeypatch.setattr(graphiti_client, "get_graphiti", initialized)
    monkeypatch.setattr(graphiti_client, "get_driver", lambda: driver)
    monkeypatch.setattr(settings, "neo4j_database", "neo4j")
    answers = []
    try:
        async with driver.session(database="neo4j") as session:
            await _seed(session, nodes, edges)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=main.app), base_url="http://test"
        ) as client:

            def disconnect(group_id, source_id):
                return client.delete(
                    f"/groups/{group_id}", params={"source_id": source_id}, headers=HEADERS
                )

            for step in steps:
                if step[0] == "records":
                    answers.append(
                        await client.post("/sources/records", json=step[1], headers=HEADERS)
                    )
                elif step[0] == "disconnect":
                    response = await disconnect(step[1], step[2])
                    assert response.status_code == 200, response.text
                else:
                    responses = await asyncio.gather(*(disconnect(g, s) for g, s in step[1]))
                    assert [r.status_code for r in responses] == [200] * len(responses)
        return answers
    finally:
        await driver.close()


def _groups(response) -> dict:
    assert response.status_code == 200, response.text
    return {g.pop("group_id"): g for g in response.json()["groups"]}


ZERO = {
    "episodes": 0,
    "facts": 0,
    "fact_embeddings": 0,
    "verbatim_nodes": 0,
    "orphans": 0,
    "dangling_facts": 0,
}


def test_counts_what_one_source_left_in_every_scope_of_its_org(monkeypatch):
    [answer] = asyncio.run(_run(monkeypatch, steps=[("records", _records_body())]))

    assert _groups(answer) == {
        # ep-gh; f-gh and v-gh it created and f-slack that cites it; the vectors on
        # f-gh and v-gh and f-slack; the passage behind v-gh.
        GROUP: {**ZERO, "episodes": 1, "facts": 3, "fact_embeddings": 3, "verbatim_nodes": 1},
        # Found by the source stamp, though the request named only GROUP.
        OTHER_GROUP: {**ZERO, "episodes": 1, "facts": 1},
    }


def test_counts_nothing_once_every_scope_it_wrote_to_is_retired(monkeypatch):
    before, after = asyncio.run(
        _run(
            monkeypatch,
            steps=[
                ("records", _records_body()),
                ("disconnect", GROUP, SOURCE),
                ("disconnect", OTHER_GROUP, SOURCE),
                ("records", _records_body(group_ids=(GROUP, OTHER_GROUP))),
            ],
        )
    )

    assert sum(g["episodes"] for g in _groups(before).values()) == 2
    # The scope's anchor is left with no relationship by design and is not an orphan.
    assert _groups(after) == {GROUP: ZERO, OTHER_GROUP: ZERO}


def test_a_scope_the_retirement_missed_still_counts(monkeypatch):
    # Retiring the current scope only, as a disconnect that forgot where the source
    # used to write would, leaves the earlier scope's records, and the count says so.
    [after] = asyncio.run(
        _run(
            monkeypatch,
            steps=[
                ("disconnect", GROUP, SOURCE),
                ("records", _records_body()),
            ],
        )
    )

    assert _groups(after) == {
        GROUP: ZERO,
        OTHER_GROUP: {**ZERO, "episodes": 1, "facts": 1},
    }


def test_an_entity_nothing_links_to_is_an_orphan(monkeypatch):
    nodes = NODES + [
        (
            "Entity",
            "left-behind",
            GROUP,
            {"name": "Left behind", "summary": "Only the source said this."},
        ),
        # Outside the scopes asked about, so not this answer's to count.
        ("Entity", "elsewhere", FOREIGN_GROUP, {"name": "Elsewhere"}),
    ]
    [answer] = asyncio.run(_run(monkeypatch, nodes=nodes, steps=[("records", _records_body())]))

    assert _groups(answer)[GROUP]["orphans"] == 1
    assert FOREIGN_GROUP not in _groups(answer)


def test_a_fact_whose_episodes_are_all_gone_is_dangling(monkeypatch):
    # A retirement that deleted the source's episode but not the fact it created leaves
    # the fact's text and vector behind with nothing stamped to the source: by the stamp
    # alone the source holds nothing. Counted at the scope instead.
    nodes = [n for n in NODES if n[1] != "ep-gh"] + [
        ("Entity:Fact", "chat-fact", GROUP, {"name": "chat", "summary": "Typed by a person."}),
        ("Entity:Fact", "stored-fact", GROUP, {"name": "stored", "summary": "Kept by its row."}),
    ]
    edges = [e for e in EDGES if e[2] != "ep-gh"] + [
        # A fact written in chat: no source, no episodes, and nothing missing.
        (
            "RELATES_TO",
            "v-chat",
            "chat-fact",
            ANCHOR,
            GROUP,
            {"fact": "Typed by a person.", "source_description": _stamp(None), "episodes": []},
        ),
        # Its episode is gone, but deleting its stored fact by chunk id still retires it.
        (
            "RELATES_TO",
            "v-stored",
            "stored-fact",
            ANCHOR,
            GROUP,
            {
                "fact": "Kept by its row.",
                "episodes": ["ep-gh"],
                "source_description": json.dumps({"actor_type": "agent", "chunk_id": "chunk_1"}),
            },
        ),
    ]
    [answer] = asyncio.run(
        _run(monkeypatch, nodes=nodes, edges=edges, steps=[("records", _records_body())])
    )

    # f-gh lists only the deleted ep-gh; f-slack still has ep-slack; v-gh carries its own stamp.
    assert _groups(answer)[GROUP] == {
        **ZERO,
        "facts": 1,
        "fact_embeddings": 1,
        "verbatim_nodes": 1,
        "dangling_facts": 1,
    }


def test_another_tenants_records_and_a_lookalike_source_id_are_not_counted(monkeypatch):
    [other_org, lookalike] = asyncio.run(
        _run(
            monkeypatch,
            steps=[
                ("records", _records_body(org_id="b", group_ids=("org_b-support",))),
                ("records", _records_body(source_id=SOURCE + "2")),
            ],
        )
    )

    assert _groups(other_org) == {FOREIGN_GROUP: {**ZERO, "episodes": 1}}
    assert _groups(lookalike) == {GROUP: {**ZERO, "episodes": 1}}


def test_a_scope_outside_the_org_is_refused(monkeypatch):
    [answer] = asyncio.run(
        _run(
            monkeypatch,
            steps=[
                ("records", _records_body(group_ids=(GROUP, FOREIGN_GROUP))),
            ],
        )
    )

    assert answer.status_code == 422


# Six sources in one scope, every one mentioning the same entity, disconnected at
# once: the shared entity must go with the last of them, and nothing may be left
# that no source links to.
SHARED = [f"src_{i}" for i in range(6)]


def _shared_entity_graph():
    nodes = [("Entity", "hub", GROUP, {"name": "Dana", "summary": "Dana, per every source."})]
    edges = []
    for s in SHARED:
        nodes += [
            (
                "Episodic",
                f"ep-{s}",
                GROUP,
                {"content": f"only {s} said this", "source_description": _stamp(s)},
            ),
            ("Entity", f"own-{s}", GROUP, {"name": f"Own {s}", "summary": f"only {s} said this"}),
        ]
        edges += [
            ("MENTIONS", f"m-hub-{s}", f"ep-{s}", "hub", GROUP, {}),
            ("MENTIONS", f"m-own-{s}", f"ep-{s}", f"own-{s}", GROUP, {}),
            (
                "RELATES_TO",
                f"f-{s}",
                f"own-{s}",
                "hub",
                GROUP,
                {"fact": f"only {s} said this", "episodes": [f"ep-{s}"], "fact_embedding": VECTOR},
            ),
        ]
    return nodes, edges


@pytest.mark.parametrize("attempt", range(3))
def test_sources_disconnected_together_leave_no_records_and_no_orphan(monkeypatch, attempt):
    nodes, edges = _shared_entity_graph()
    answers = asyncio.run(
        _run(
            monkeypatch,
            nodes=nodes,
            edges=edges,
            steps=[
                ("disconnect_together", [(GROUP, s) for s in SHARED]),
                *(("records", _records_body(source_id=s)) for s in SHARED),
            ],
        )
    )

    assert [_groups(a) for a in answers] == [{GROUP: ZERO}] * len(SHARED)
