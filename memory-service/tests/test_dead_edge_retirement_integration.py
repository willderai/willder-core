"""A fact whose every episode is gone does not outlive the deletion, on a disposable local Neo4j.

NEO4J_DELETE_TEST_URI=bolt://127.0.0.1:17687 python -m pytest tests/test_dead_edge_retirement_integration.py

An extracted fact (a RELATES_TO edge) carries no provenance stamp of its own, only
`episodes`, the episodes that asserted it. Once none of them exists, no stored fact
can name it and no later delete can match it, yet it still answers graph reads and
blocks deleting its scope. Deleting a stored fact (DELETE /chunks/{id}) must leave
no such edge in its group, and must keep every edge a live episode still asserts.

The first case replays a write and a delete interleaving the way Graphiti's ingest
can: it reads an existing fact, the fact's creator is deleted, then ingest saves its
copy with the new episode appended, recreating the fact. It uses Graphiti's own read
(`EntityEdge.get_by_uuid`) and save (`add_nodes_and_edges_bulk`), not hand-written
Cypher; the model call that decides the facts match is replaced by the append it
causes (`resolved_edge.episodes.append`). The others seed the graph directly.
No model calls; the database is cleared before each case.
"""

import asyncio
import json
import os
import time
from datetime import datetime, timezone
from urllib.parse import urlparse

import httpx
import pytest
from graphiti_core.driver.neo4j_driver import Neo4jDriver
from graphiti_core.edges import EntityEdge, EpisodicEdge
from graphiti_core.nodes import EntityNode, EpisodeType, EpisodicNode
from graphiti_core.utils.bulk_utils import add_nodes_and_edges_bulk, add_nodes_and_edges_bulk_tx
from neo4j import AsyncGraphDatabase
from neo4j.exceptions import Neo4jError

from app import graphiti_client, main
from app.graph import retirement
from app.config import settings
from conftest import API_KEY

URI = os.getenv("NEO4J_DELETE_TEST_URI")
pytestmark = pytest.mark.skipif(not URI, reason="requires disposable local Neo4j")

GROUP = "org_a-deal"
AUTH = {"Authorization": f"Bearer {API_KEY}"}
EMBEDDING = [0.1, 0.2, 0.3]
ANCHOR = graphiti_client._fallback_anchor_uuid(GROUP)


def _stamp(chunk_id: str | None) -> str:
    return json.dumps({"actor_type": "agent", "chunk_id": chunk_id})


def _entity(uuid: str, name: str) -> tuple:
    return ("Entity", uuid, {"name": name, "summary": "", "name_embedding": EMBEDDING})


def _episode(uuid: str, chunk_id: str, group_id: str = GROUP) -> tuple:
    return (
        "Episodic",
        uuid,
        {
            "name": uuid,
            "content": f"{uuid} body",
            "source": "text",
            "source_description": _stamp(chunk_id),
            "entity_edges": [],
            "group_id": group_id,
        },
    )


def _fact(uuid: str, start: str, end: str, episodes: list[str], **props) -> tuple:
    return (
        "RELATES_TO",
        uuid,
        start,
        end,
        {
            "name": "RELATES_TO",
            "fact": f"{uuid} text",
            "episodes": episodes,
            "fact_embedding": EMBEDDING,
            **props,
        },
    )


def _mention(uuid: str, episode: str, entity: str) -> tuple:
    return ("MENTIONS", uuid, episode, entity, {})


async def _seed(session, nodes: list[tuple], edges: list[tuple]) -> None:
    await (await session.run("MATCH (n) DETACH DELETE n")).consume()
    for labels, uuid, props in nodes:
        await (
            await session.run(
                f"CREATE (n:{labels}) SET n = $props, n.uuid = $uuid, n.group_id = $group_id, "
                "n.created_at = datetime(), n.valid_at = datetime()",
                props=props,
                uuid=uuid,
                group_id=props.get("group_id", GROUP),
            )
        ).consume()
    for rel, uuid, start, end, props in edges:
        await (
            await session.run(
                f"MATCH (a {{uuid: $start}}), (b {{uuid: $end}}) "
                f"CREATE (a)-[r:{rel}]->(b) SET r = $props, r.uuid = $uuid, r.group_id = $group_id, "
                "r.created_at = datetime()",
                start=start,
                end=end,
                props=props,
                uuid=uuid,
                group_id=GROUP,
            )
        ).consume()


async def _graph(session) -> tuple[set[str], dict[str, list[str]]]:
    """The node uuids, and each RELATES_TO edge's episodes, left in the database."""
    nodes = await (await session.run("MATCH (n) RETURN n.uuid AS uuid")).data()
    facts = await (
        await session.run(
            "MATCH ()-[r:RELATES_TO]->() RETURN r.uuid AS uuid, coalesce(r.episodes, []) AS episodes"
        )
    ).data()
    return {n["uuid"] for n in nodes}, {f["uuid"]: f["episodes"] for f in facts}


class _Service:
    """The memory service's routes on the test database, with the driver its Cypher uses."""

    def __init__(self, monkeypatch):
        parsed = urlparse(URI)
        assert parsed.scheme == "bolt" and parsed.hostname == "127.0.0.1"
        self.driver = AsyncGraphDatabase.driver(URI, auth=None)

        async def initialized():
            pass

        monkeypatch.setattr(graphiti_client, "get_graphiti", initialized)
        monkeypatch.setattr(graphiti_client, "get_driver", lambda: self.driver)
        monkeypatch.setattr(settings, "neo4j_database", "neo4j")

    async def delete_chunk(self, chunk_id: str) -> httpx.Response:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=main.app), base_url="http://test"
        ) as client:
            return await client.delete(
                f"/chunks/{chunk_id}", params={"group_id": GROUP}, headers=AUTH
            )

    async def residue(self) -> dict:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=main.app), base_url="http://test"
        ) as client:
            response = await client.post("/groups/residue", json={"group_id": GROUP}, headers=AUTH)
        assert response.status_code == 200, response.text
        return response.json()


async def _ingest_saves_a_copy_read_before_a_delete(
    service: _Service, graphiti: Neo4jDriver
) -> None:
    """Chunk 1 created fact f-1 between Acme and March. An ingest of chunk 2 reads f-1,
    chunk 1 is deleted, then the ingest saves its copy of f-1 with episode ep-2 appended."""
    async with service.driver.session(database="neo4j") as session:
        await _seed(
            session,
            nodes=[_entity("acme", "Acme"), _entity("march", "March"), _episode("ep-1", "chunk_1")],
            edges=[
                _mention("m-1-acme", "ep-1", "acme"),
                _mention("m-1-march", "ep-1", "march"),
                _fact("f-1", "acme", "march", ["ep-1"]),
            ],
        )

    # Ingest of chunk 2, before its write: the extracted fact matched f-1.
    resolved = await EntityEdge.get_by_uuid(graphiti, "f-1")
    await resolved.load_fact_embedding(graphiti)
    entities = [await EntityNode.get_by_uuid(graphiti, uuid) for uuid in ("acme", "march")]
    for entity in entities:
        await entity.load_name_embedding(graphiti)
    episode = EpisodicNode(
        uuid="ep-2",
        name="ep-2",
        group_id=GROUP,
        source=EpisodeType.text,
        source_description=_stamp("chunk_2"),
        content="Acme renews in March.",
        valid_at=datetime.now(timezone.utc),
    )
    resolved.episodes.append(episode.uuid)

    deleted_first = await service.delete_chunk("chunk_1")
    assert deleted_first.status_code == 200, deleted_first.text
    assert deleted_first.json()["removed_count"] == 1

    # The ingest's write, in one transaction, as Graphiti's add_episode makes it.
    mentions = [
        EpisodicEdge(
            source_node_uuid=episode.uuid,
            target_node_uuid=entity.uuid,
            group_id=GROUP,
            created_at=datetime.now(timezone.utc),
        )
        for entity in entities
    ]
    await add_nodes_and_edges_bulk(
        graphiti, [episode], mentions, entities, [resolved], embedder=None
    )


def test_a_fact_ingest_recreated_after_its_creator_was_deleted_goes_with_its_last_episode(
    monkeypatch,
):
    async def run():
        service = _Service(monkeypatch)
        graphiti = Neo4jDriver(URI, None, None)
        try:
            await _ingest_saves_a_copy_read_before_a_delete(service, graphiti)
            async with service.driver.session(database="neo4j") as session:
                _, facts = await _graph(session)
            # The race left f-1 recreated, its creator's episode first and gone.
            assert facts == {"f-1": ["ep-1", "ep-2"]}

            response = await service.delete_chunk("chunk_2")
            async with service.driver.session(database="neo4j") as session:
                nodes, facts = await _graph(session)
            return response, nodes, facts, await service.residue()
        finally:
            await graphiti.close()
            await service.driver.close()

    response, nodes, facts, residue = asyncio.run(run())

    assert response.status_code == 200, response.text
    assert response.json()["removed_count"] == 1
    assert facts == {}
    assert nodes == set()
    assert residue == {"facts": 0, "episodes": 0}


# A group that already holds a fact no live episode asserts, beside every shape of
# edge the sweep must leave alone, and one live stored fact (chunk_live) to delete.
SWEEP_NODES = [
    _entity("acme", "Acme"),
    _entity("march", "March"),
    _entity("invoice", "Invoice"),
    _entity("legal", "Legal"),
    _entity("person", "Elena Park"),
    _entity("casey", "Casey Liu"),
    ("Entity:Fact", "verbatim-dead", {"name": "unstamped verbatim", "summary": "old text"}),
    ("Entity:Fact", "verbatim-stamped", {"name": "stamped verbatim", "summary": "kept text"}),
    ("Entity:Fact", "chat-fact", {"name": "chat", "summary": "Typed by a person."}),
    ("Entity:Category", ANCHOR, {"name": graphiti_client.FALLBACK_ANCHOR_NAME}),
    _episode("ep-live", "chunk_live"),
    _episode("ep-other", "chunk_other"),
    _episode("ep-elsewhere", "chunk_elsewhere", group_id="org_a-other"),
]
SWEEP_EDGES = [
    _mention("m-live-acme", "ep-live", "acme"),
    _mention("m-other-invoice", "ep-other", "invoice"),
    # Left by an earlier retirement: lists only an episode that no longer exists.
    _fact("f-dead", "casey", "person", ["ep-gone"]),
    # Same.
    _fact("f-dead-shared", "march", "legal", ["ep-gone-too"]),
    # A verbatim edge that lost its own stamp and its episode.
    _fact("v-dead", "verbatim-dead", ANCHOR, ["ep-gone"], source_description="{}"),
    # Its creator is gone but another stored fact still asserts it.
    _fact("f-alive", "march", "invoice", ["ep-gone", "ep-other"]),
    # Its only episode is in another scope. That episode still exists, so this is
    # not a fact nothing asserts, whatever this scope can read of it.
    _fact("f-elsewhere", "march", "invoice", ["ep-elsewhere"]),
    # A verbatim edge whose own stamp a later delete of its chunk still matches.
    _fact(
        "v-stamped",
        "verbatim-stamped",
        ANCHOR,
        ["ep-gone"],
        source_description=_stamp("chunk_kept"),
    ),
    # A fact typed in chat lists no episode, and none is missing.
    _fact("f-chat", "chat-fact", ANCHOR, [], source_description=_stamp(None)),
    # The stored fact being deleted.
    _fact("f-live", "acme", "march", ["ep-live"]),
]


async def _delete_in_group_holding_dead_facts(
    monkeypatch,
) -> tuple[httpx.Response, set[str], dict, set[str], dict]:
    service = _Service(monkeypatch)
    try:
        async with service.driver.session(database="neo4j") as session:
            await _seed(session, SWEEP_NODES, SWEEP_EDGES)
            nodes_before, facts_before = await _graph(session)
            response = await service.delete_chunk("chunk_live")
            nodes_after, facts_after = await _graph(session)
        return response, nodes_before, facts_before, nodes_after, facts_after
    finally:
        await service.driver.close()


def test_deleting_a_fact_retires_every_fact_in_its_group_no_live_episode_asserts(monkeypatch):
    response, nodes_before, facts_before, nodes_after, facts_after = asyncio.run(
        _delete_in_group_holding_dead_facts(monkeypatch)
    )

    assert response.status_code == 200, response.text
    assert set(facts_before) - set(facts_after) == {"f-live", "f-dead", "f-dead-shared", "v-dead"}
    assert response.json()["removed_count"] == 4
    # The deleted fact's episode goes, with the entity only it mentioned. A swept
    # edge's endpoints stay: a concurrent ingest may be saving them.
    assert nodes_before - nodes_after == {"ep-live", "acme"}


def test_deleting_a_fact_keeps_every_edge_a_live_episode_or_its_own_stamp_still_holds(monkeypatch):
    response, _, facts_before, nodes_after, facts_after = asyncio.run(
        _delete_in_group_holding_dead_facts(monkeypatch)
    )

    assert response.status_code == 200, response.text
    for kept in ("f-alive", "f-elsewhere", "v-stamped", "f-chat"):
        assert facts_after[kept] == facts_before[kept], kept
    assert ANCHOR in nodes_after
    assert {"march", "invoice", "verbatim-stamped", "chat-fact", "ep-other"} <= nodes_after


def test_a_fact_an_ingest_asserts_again_while_the_deletion_runs_stays(monkeypatch):
    """The deletion reads the group, then writes in its own transaction. An ingest that
    commits in between, appending its episode to a fact the read found dead, keeps it."""
    service = _Service(monkeypatch)
    real_run = graphiti_client._run_with_retry
    calls = 0

    async def ingest_commits_between_read_and_write(fn):
        nonlocal calls
        calls += 1
        if calls == 2:
            async with service.driver.session(database="neo4j") as session:
                await (
                    await session.run(
                        "MATCH ()-[r:RELATES_TO {uuid: 'f-dead'}]->() SET r.episodes = r.episodes + 'ep-other'"
                    )
                ).consume()
        return await real_run(fn)

    async def run():
        try:
            async with service.driver.session(database="neo4j") as session:
                await _seed(session, SWEEP_NODES, SWEEP_EDGES)
            monkeypatch.setattr(
                graphiti_client, "_run_with_retry", ingest_commits_between_read_and_write
            )
            response = await service.delete_chunk("chunk_live")
            async with service.driver.session(database="neo4j") as session:
                nodes, facts = await _graph(session)
            return response, nodes, facts
        finally:
            await service.driver.close()

    response, nodes, facts = asyncio.run(run())

    assert response.status_code == 200, response.text
    assert calls == 2
    assert facts["f-dead"] == ["ep-gone", "ep-other"]
    assert {"casey", "person"} <= nodes
    assert "f-dead-shared" not in facts


class _PausedRetirement:
    """Holds the retirement's write transaction open after its first statement whose
    Cypher contains `marker`, so another transaction can run while it holds its locks."""

    def __init__(self, monkeypatch, marker: str):
        self.paused = asyncio.Event()
        self.resume = asyncio.Event()
        real_run_with_retry = graphiti_client._run_with_retry
        retirement = self

        class _Tx:
            def __init__(self, tx):
                self._tx = tx

            async def run(self, query, **params):
                result = await self._tx.run(query, **params)
                if marker in query and not retirement.paused.is_set():
                    await result.consume()
                    retirement.paused.set()
                    await retirement.resume.wait()
                return result

        class _Session:
            def __init__(self, session):
                self._session = session

            def __getattr__(self, name):
                return getattr(self._session, name)

            async def execute_write(self, work):
                return await self._session.execute_write(lambda tx: work(_Tx(tx)))

        async def run_with_retry(fn):
            return await real_run_with_retry(lambda session: fn(_Session(session)))

        monkeypatch.setattr(graphiti_client, "_run_with_retry", run_with_retry)


async def _graphiti_ingest_matching_f_dead(graphiti: Neo4jDriver):
    """The read half of an ingest of chunk_new whose fact matched f-dead, and its
    write: Graphiti's own transaction function, optionally held open before commit."""
    resolved = await EntityEdge.get_by_uuid(graphiti, "f-dead")
    await resolved.load_fact_embedding(graphiti)
    entities = [await EntityNode.get_by_uuid(graphiti, uuid) for uuid in ("casey", "person")]
    for entity in entities:
        await entity.load_name_embedding(graphiti)
    episode = EpisodicNode(
        uuid="ep-new",
        name="ep-new",
        group_id=GROUP,
        source=EpisodeType.text,
        source_description=_stamp("chunk_new"),
        content="Casey Liu reminded Elena Park.",
        valid_at=datetime.now(timezone.utc),
    )
    resolved.episodes.append(episode.uuid)
    mentions = [
        EpisodicEdge(
            source_node_uuid=episode.uuid,
            target_node_uuid=entity.uuid,
            group_id=GROUP,
            created_at=datetime.now(timezone.utc),
        )
        for entity in entities
    ]

    async def write(written: asyncio.Event | None = None, commit: asyncio.Event | None = None):
        async def work(tx):
            await add_nodes_and_edges_bulk_tx(
                tx,
                [episode],
                mentions,
                entities,
                [resolved],
                embedder=None,
                driver=graphiti,
            )
            if written:
                written.set()
                await commit.wait()

        async with graphiti.session() as session:
            await session.execute_write(work)

    return write


async def _ingest_and_deletion_at_once(monkeypatch, when: str):
    service = _Service(monkeypatch)
    graphiti = Neo4jDriver(URI, None, None)
    try:
        async with service.driver.session(database="neo4j") as session:
            await _seed(session, SWEEP_NODES, SWEEP_EDGES)
        write = await _graphiti_ingest_matching_f_dead(graphiti)

        if when == "ingest written, not committed, when the deletion runs":
            written, commit = asyncio.Event(), asyncio.Event()
            ingest = asyncio.create_task(write(written, commit))
            await written.wait()
            deletion = asyncio.create_task(service.delete_chunk("chunk_live"))
            await asyncio.sleep(0.5)
            commit.set()
            await ingest
            response = await deletion
        else:
            marker = {
                "ingest saves while the deletion holds its node locks": "SET n._retire_lock",
                "ingest saves after the deletion locked the edge": "SET r._retire_lock",
            }[when]
            retirement = _PausedRetirement(monkeypatch, marker)
            deletion = asyncio.create_task(service.delete_chunk("chunk_live"))
            await retirement.paused.wait()
            ingest = asyncio.create_task(write())
            await asyncio.sleep(0.5)
            retirement.resume.set()
            response = await deletion
            await ingest

        async with service.driver.session(database="neo4j") as session:
            nodes, facts = await _graph(session)
        return response, nodes, facts
    finally:
        await graphiti.close()
        await service.driver.close()


@pytest.mark.parametrize(
    "when",
    [
        "ingest written, not committed, when the deletion runs",
        "ingest saves while the deletion holds its node locks",
        "ingest saves after the deletion locked the edge",
    ],
)
def test_an_ingest_asserting_a_dead_fact_during_the_deletion_succeeds_and_keeps_it(
    monkeypatch, when
):
    """Graphiti's real write of an ingest that matched f-dead, in its own transaction,
    open at the same time as the deletion's. The ingest must not fail and its fact
    must stay, listing its episode, between the entities it names."""
    # A bound, so a lock wait that never ends fails the case instead of hanging the run.
    response, nodes, facts = asyncio.run(
        asyncio.wait_for(_ingest_and_deletion_at_once(monkeypatch, when), 30)
    )

    assert response.status_code == 200, response.text
    assert facts["f-dead"] == ["ep-gone", "ep-new"]
    assert {"casey", "person", "ep-new"} <= nodes


def test_a_deletion_that_cannot_finish_in_time_is_stopped_and_changes_nothing(monkeypatch):
    """Another transaction holds a dead fact's lock past the retirement's server-side
    limit: the server stops the retirement instead of letting it wait, and rolls it back."""
    monkeypatch.setattr(retirement, "CHUNK_RETIREMENT_TIMEOUT_S", 1.0)

    async def run():
        service = _Service(monkeypatch)
        try:
            async with service.driver.session(database="neo4j") as session:
                await _seed(session, SWEEP_NODES, SWEEP_EDGES)
                before = await _graph(session)
            async with service.driver.session(database="neo4j") as holder:
                tx = await holder.begin_transaction()
                await (
                    await tx.run("MATCH ()-[r:RELATES_TO {uuid: 'f-dead'}]->() SET r.held = true")
                ).consume()
                started = time.monotonic()
                try:
                    # Without a limit the retirement waits for the lock as long as it is held.
                    with pytest.raises(Neo4jError):
                        await asyncio.wait_for(service.delete_chunk("chunk_live"), 20)
                    waited = time.monotonic() - started
                finally:
                    await tx.rollback()
            async with service.driver.session(database="neo4j") as session:
                return waited, before, await _graph(session)
        finally:
            await service.driver.close()

    waited, before, after = asyncio.run(run())

    assert waited < 10
    assert after == before


BACKLOG = 2_500
# The sweep fixture already holds three dead facts: f-dead, f-dead-shared, v-dead.
DEAD_IN_FIXTURE = 3


def test_a_backlog_of_dead_facts_larger_than_one_sweep_drains_over_later_deletions(monkeypatch):
    """A group left holding more dead facts than one deletion sweeps: deleting a stored
    fact still retires that fact, under the service's own time limit, and sweeps a
    bounded share of the rest. Each later deletion sweeps the next share."""

    async def dead_left(session) -> int:
        record = await (
            await session.run(
                """
            MATCH ()-[r:RELATES_TO]->()
            WHERE r.group_id = $group_id AND coalesce(r.source_description, '{}') = '{}'
              AND size(coalesce(r.episodes, [])) > 0
              AND NOT EXISTS { MATCH (ep:Episodic) WHERE ep.uuid IN r.episodes }
            RETURN count(r) AS n
            """,
                group_id=GROUP,
            )
        ).single()
        return record["n"]

    async def run():
        service = _Service(monkeypatch)
        try:
            async with service.driver.session(database="neo4j") as session:
                await _seed(session, SWEEP_NODES, SWEEP_EDGES)
                await (
                    await session.run(
                        "MATCH (a {uuid: 'casey'}), (b {uuid: 'person'}) "
                        "UNWIND range(1, $n) AS i "
                        "CREATE (a)-[:RELATES_TO {uuid: 'backlog-' + i, group_id: $group_id, "
                        "name: 'RELATES_TO', fact: 'old', episodes: ['ep-gone-' + i]}]->(b)",
                        n=BACKLOG,
                        group_id=GROUP,
                    )
                ).consume()
                first = await service.delete_chunk("chunk_live")
                _, facts = await _graph(session)
                left = [await dead_left(session)]
                while left[-1] and len(left) < 10:
                    again = await service.delete_chunk("chunk_live")
                    assert again.status_code == 200, again.text
                    left.append(await dead_left(session))
            return first, facts, left
        finally:
            await service.driver.close()

    first, facts, left = asyncio.run(run())

    per_call = graphiti_client.DEAD_EDGES_PER_RETIREMENT
    backlog = BACKLOG + DEAD_IN_FIXTURE
    assert first.status_code == 200, first.text
    assert first.json()["removed_count"] == 1 + per_call
    assert "f-live" not in facts
    assert left == [max(backlog - per_call * calls, 0) for calls in range(1, len(left) + 1)]
    assert left[-1] == 0
