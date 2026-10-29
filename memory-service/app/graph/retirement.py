"""Removing facts: one fact by uuid, an episode's facts, and everything a connected
source or a stored fact left in a group (the stamped retirement)."""

from dataclasses import dataclass

from neo4j import unit_of_work

from .. import graphiti_client as client
from .provenance import has_retirement_stamp, parse_provenance


async def remove_fact(group_id: str, uuid: str) -> bool:
    """Delete only a fact and endpoints in the caller's authorized partition."""
    if not group_id or not group_id.strip():
        return False
    await client.get_graphiti()

    async def _delete(session):
        result = await session.run(
            """
            MATCH (:Entity {group_id: $group_id})
                  -[r:RELATES_TO {uuid: $uuid, group_id: $group_id}]->
                  (:Entity {group_id: $group_id})
            WITH collect(r) AS rels
            FOREACH (x IN rels | DELETE x)
            RETURN size(rels) AS removed
            """,
            uuid=uuid,
            group_id=group_id,
        )
        rec = await result.single()
        return bool(rec and rec["removed"])

    return await client._run_with_retry(_delete)


async def remove_episode_facts(group_id: str, episode_uuid: str) -> int:
    """Retire every RELATES_TO edge that a specific episode contributed to, by
    matching on Graphiti's own `episodes` property (the list of episode uuids
    that mention/support an edge — stamped by `add_episode` on every edge it
    creates or touches, including the `ensure_graph_visible` fallback path).

    Used by the Node connector sync so an edited or deleted upstream
    Slack message / Figma comment retires its OLD episode's facts before (or
    instead of) a re-ingest, instead of leaving two contradicting episodes
    live at once (the same rule user-edited facts follow).

    Scoped by `group_id` (unlike `remove_fact`/`remove_entity`, which match by
    UUID alone — see their docstrings):
    episode uuids are generated per-ingest, not shared across tenants, but this
    is a brand-new code path, so it is written with the tenant predicate from
    the start rather than relying on UUID uniqueness alone. Returns the number
    of edges removed (0 if the episode contributed none, or doesn't exist)."""
    await client.get_graphiti()

    async def _delete(session):
        result = await session.run(
            """
            MATCH ()-[r:RELATES_TO]->()
            WHERE r.group_id = $group_id AND $episode_uuid IN r.episodes
            WITH collect(r) AS rels
            FOREACH (x IN rels | DELETE x)
            RETURN size(rels) AS removed
            """,
            group_id=group_id,
            episode_uuid=episode_uuid,
        )
        rec = await result.single()
        return int(rec["removed"]) if rec else 0

    return await client._run_with_retry(_delete)


# What `remove_group_facts` reports for a group or source with nothing to retire.
_NOTHING_RETIRED = {"facts": 0, "episodes": 0, "verbatim_nodes": 0, "entities": 0, "summaries": 0}


async def remove_group_facts(group_id: str, source_id: str | None = None) -> dict[str, int]:
    """Retire what was ingested into one `group_id`: every RELATES_TO edge there
    or, given `source_id`, everything one connected source wrote there. Used to
    retire a disconnected/deleted source's content in one call, since per-file
    episode ids are not recorded for every connector path.

    Bounded by `group_id`, the same tenant/scope boundary `remove_episode_facts`
    uses. A `group_id` (a `Scope.path`) is org-prefixed, so it cannot cross a
    tenant, but it is NOT exclusive to one source within an org: a
    caller-supplied scopePath lets two sources, or a source and ordinary chat
    memory, share one group_id. Omitting `source_id` purges every edge in the
    group regardless of
    provenance, which is only safe when the caller has established the scope is
    exclusive to one source. The sources route always passes `source_id`.

    With `source_id`, provenance is read the way `fetch_edge_provenance` reads it for citation: an
    edge's own `source_description` first, and for an edge with no source stamp
    of its own (every edge Graphiti's extractor writes), the in-group episodes
    listed in its `episodes`. Stamps are parsed as JSON in Python, since a raw
    substring match on the JSON text could match a similarly-prefixed id.

    An extracted edge is owned by the episode that created it, the first in its
    `episodes`. An edge this source created is deleted, however many other
    episodes later matched it, because its text is still this source's
    sentence. An edge another producer created stays and only loses this
    source's episode uuids, which stops it citing the disconnected source.

    The edges are not all a source leaves behind (bar 2 of
    docs/consent-deletion-suite.md), so
    the same transaction also removes:

    - the source's own episodes, which hold the raw ingested body, with their
      MENTIONS edges;
    - the verbatim Fact, Decision and Passage nodes whose own edge was deleted,
      since their summary is the source text;
    - the summaries of entities this source's episodes mentioned, which can
      quote it. They are cleared, not re-summarised, because re-summarising
      needs the model and this path must not. The entity stays when anything
      else still links to it, since another source can name the same person;
    - an entity this source's episodes mentioned that is left with no
      relationship at all, since nothing else knows it and its name came from
      this source.

    Any edge in the group with no source or chunk stamp of its own that lists
    episodes, none of which still exists once this source's are deleted, is
    deleted too, whoever created it. No stored fact asserts it any more and no
    later delete could match it, so it would otherwise answer graph reads and
    block deleting its scope forever. Graphiti leaves one when an ingest reads an
    edge, a retirement deletes that edge with the episode that created it, and
    the ingest then saves its copy with its own episode appended: the edge is
    back, owned by a deleted episode, and deleting the ingest's fact later only
    prunes it. These are the `dangling_facts` `count_source_records` reports. An
    edge listing no episodes at all, such as a fact typed in chat, is not one.

    Each such edge is write-locked late in the transaction and checked again
    from what is committed then, so an ingest that asserts it concurrently keeps
    its fact in every order. One that committed earlier is seen, and the edge
    stays. One whose write holds the edge makes the lock wait for its commit,
    and the edge stays. One that reaches the edge after the lock deadlocks with
    this transaction, since each holds what the other needs; Neo4j stops one and
    the driver retries it, and either way the ingest's save then creates the
    edge again, or finds it kept, listing its episode. At most
    `DEAD_EDGES_PER_RETIREMENT` such edges go per call; the rest go on later
    retirements in the group. The edge's endpoints are never deleted here, even
    when left with no relationship: an ingest that matched the edge is saving
    those same nodes, and deleting one under its save fails that ingest. They
    stay as entities with no fact, which `count_source_records` reports as
    orphans.

    A node of these kinds that still has another relationship is kept rather
    than cascaded. Those nodes are write-locked at the start of the
    transaction, so concurrent disconnects of sources that share an entity
    run their removal checks one after another and the last one removes it.
    Idempotent: a second call finds nothing and returns zeros.
    Returns counts by kind; 0 everywhere is a normal outcome for a source that
    never synced anything, not an error."""
    await client.get_graphiti()
    if source_id is None:
        return {**_NOTHING_RETIRED, "facts": await _remove_every_group_fact(group_id)}
    return await _retire_stamped(group_id, "source_id", source_id)


async def _remove_every_group_fact(group_id: str) -> int:
    """Delete every RELATES_TO edge in `group_id`, whatever its provenance."""

    async def _delete(session):
        result = await session.run(
            """
            MATCH ()-[r:RELATES_TO]->()
            WHERE r.group_id = $group_id
            WITH collect(r) AS rels
            FOREACH (x IN rels | DELETE x)
            RETURN size(rels) AS removed
            """,
            group_id=group_id,
        )
        rec = await result.single()
        return int(rec["removed"]) if rec else 0

    return await client._run_with_retry(_delete)


# Each of a stored fact's retirement transactions, the read and the write, is stopped on
# the server after this long, so a slow retirement never runs on after nobody wants it;
# a stopped transaction changes nothing. The driver retries a write that loses a
# deadlock, each attempt under this limit, so the whole call can outlast the app's 20 s
# wait: the app may see a 504 for a retirement that commits later. Retirement is
# idempotent, so retrying the delete after a 504 is safe.
CHUNK_RETIREMENT_TIMEOUT_S = 8.0

# The most edges with no live episode one retirement deletes. A group can hold a backlog
# of them; capping each call keeps the stored fact's own retirement inside its time
# limit, and every later retirement in the group deletes the next share.
DEAD_EDGES_PER_RETIREMENT = 1_000


async def remove_chunk_facts(group_id: str, chunk_id: str) -> dict:
    """Retire what one stored fact left in `group_id`: the episodes ingest() stamped
    with `chunk_id` (the caller's `memory_chunks` row), the edges they created, and
    what those leave behind. The app calls this after it deleted that row, so a
    deleted fact does not keep answering from the graph.

    The same retirement a source disconnect runs (`remove_group_facts`), keyed on
    the chunk stamp instead of the source stamp; its docstring has the rules. An
    edge another episode created and this one only matched keeps its text and
    loses this episode. Returns counts by kind, and under `episode_ids` the uuids of
    the episodes it retired, so the app can drop the records that point at them (a
    Drive file's `SourceFile.episodeIds`); zeros and no ids are normal for a fact whose
    ingest never reached the graph."""
    await client.get_graphiti()
    episode_ids: list[str] = []
    retired = await _retire_stamped(
        group_id,
        "chunk_id",
        chunk_id,
        timeout_s=CHUNK_RETIREMENT_TIMEOUT_S,
        retired_episodes=episode_ids,
    )
    return {**retired, "episode_ids": episode_ids}


async def _retire_stamped(
    group_id: str,
    stamp_key: str,
    stamp_value: str,
    timeout_s: float | None = None,
    retired_episodes: list[str] | None = None,
) -> dict[str, int]:
    """Retire everything in `group_id` whose provenance stamp has `stamp_key` equal to
    `stamp_value`, as `remove_group_facts` describes for `source_id`. With `timeout_s`,
    the server stops each of its two transactions after that many seconds.

    Two transactions: a read of the group, from which `_plan_retirement` decides what
    goes, then `_apply_retirement`, which removes it and re-checks what may have changed
    in between."""

    async def _select(session):
        async with await session.begin_transaction(timeout=timeout_s) as tx:
            return await _read_group_for_retirement(tx, group_id, stamp_value)

    edge_records, episode_records = await client._run_with_retry(_select)
    plan = _plan_retirement(edge_records, episode_records, stamp_key, stamp_value)
    if plan.is_empty():
        return dict(_NOTHING_RETIRED)

    if retired_episodes is not None:
        retired_episodes[:] = sorted(plan.own_episodes)
    params = plan.params(group_id)

    async def _retire(tx):
        return await _apply_retirement(tx, params)

    async def _in_transaction(session):
        return await session.execute_write(unit_of_work(timeout=timeout_s)(_retire))

    return await client._run_with_retry(_in_transaction)


async def _read_group_for_retirement(tx, group_id: str, stamp_value: str) -> tuple[list, list]:
    """Every RELATES_TO edge in the group with its listed episodes, and the group's
    episodes whose stamp text contains `stamp_value`."""
    # Each listed episode is looked up by uuid, one at a time: matched as a list
    # beside the group, the planner can pick the group index and read every
    # episode in the group once per edge.
    edges = await tx.run(
        """
        MATCH ()-[r:RELATES_TO]->()
        WHERE r.group_id = $group_id
        CALL (r) {
            UNWIND coalesce(r.episodes, []) AS listed
            OPTIONAL MATCH (ep:Episodic {uuid: listed})
            RETURN collect(CASE WHEN ep.group_id = r.group_id
                                THEN [ep.uuid, ep.source_description] END) AS episodes,
                   collect(ep.uuid) AS existing_episodes
        }
        RETURN r.uuid AS uuid, r.source_description AS source_description,
               coalesce(r.episodes, []) AS episode_order, episodes, existing_episodes
        """,
        group_id=group_id,
    )
    edge_records = [rec async for rec in edges]
    # CONTAINS only narrows the read; ownership is decided by the parse in _plan_retirement.
    episodes = await tx.run(
        """
        MATCH (ep:Episodic)
        WHERE ep.group_id = $group_id AND ep.source_description CONTAINS $stamp_value
        RETURN ep.uuid AS uuid, ep.source_description AS source_description
        """,
        group_id=group_id,
        stamp_value=stamp_value,
    )
    return edge_records, [rec async for rec in episodes]


@dataclass
class _RetirementPlan:
    """What one stamped retirement removes, decided from the read of the group."""

    # Edges this stamp's episodes created, or whose own stamp is this one: deleted.
    delete_uuids: list[str]
    # Edges another producer created that list one of this stamp's episodes: they
    # only lose those episodes.
    prune_uuids: list[str]
    # This stamp's episodes: deleted with their MENTIONS.
    own_episodes: set[str]
    # Edges no later delete could match once `own_episodes` are gone (at most
    # DEAD_EDGES_PER_RETIREMENT): deleted if still so when the write runs.
    dead_uuids: list[str]

    def is_empty(self) -> bool:
        return (
            not self.delete_uuids
            and not self.prune_uuids
            and not self.own_episodes
            and not self.dead_uuids
        )

    def params(self, group_id: str) -> dict:
        return {
            "group_id": group_id,
            "delete_uuids": self.delete_uuids,
            "prune_uuids": self.prune_uuids,
            "own_episodes": sorted(self.own_episodes),
            "dead_uuids": self.dead_uuids,
        }


def _plan_retirement(
    edge_records, episode_records, stamp_key: str, stamp_value: str
) -> _RetirementPlan:
    """Sort the group's edges by what the retirement does to each: an edge's own stamp
    decides first; an unstamped edge goes when this stamp's episode created it (first in
    its `episodes`) and is pruned when it only lists one."""
    own_episodes = {
        rec["uuid"]
        for rec in episode_records
        if parse_provenance(rec["source_description"]).get(stamp_key) == stamp_value
    }
    delete_uuids: list[str] = []
    prune_uuids: list[str] = []
    for rec in edge_records:
        own_stamp = parse_provenance(rec["source_description"]).get(stamp_key)
        if own_stamp:
            if own_stamp == stamp_value:
                delete_uuids.append(rec["uuid"])
            continue
        episode_stamps = {
            uuid: parse_provenance(desc).get(stamp_key) for uuid, desc in rec["episodes"] if uuid
        }
        mine = [uuid for uuid in rec["episode_order"] if episode_stamps.get(uuid) == stamp_value]
        if not mine:
            continue
        own_episodes.update(mine)
        if rec["episode_order"][0] in mine:
            delete_uuids.append(rec["uuid"])
        else:
            prune_uuids.append(rec["uuid"])

    # Edges no later delete could match: no stamp of their own, and every episode
    # they list is gone once this call's are. Checked again when the deletes run.
    dead_uuids = sorted(
        rec["uuid"]
        for rec in edge_records
        if rec["uuid"] not in delete_uuids
        and not has_retirement_stamp(rec["source_description"])
        and rec["episode_order"]
        and not set(rec["existing_episodes"]) - own_episodes
    )[:DEAD_EDGES_PER_RETIREMENT]
    return _RetirementPlan(delete_uuids, prune_uuids, own_episodes, dead_uuids)


async def _apply_retirement(tx, params: dict) -> dict[str, int]:
    """The write transaction of a stamped retirement, step by step. The order matters:
    nodes are locked before anything is read, verbatim nodes are read before their
    edges go, and orphans are swept last."""
    await _lock_removable_nodes(tx, params)
    await _prune_own_episodes_from_shared_edges(tx, params)
    verbatim_uuids = await _verbatim_nodes_of_deleted_edges(tx, params)
    facts_removed = await _delete_owned_edges(tx, params)
    mentioned_uuids, summaries_cleared = await _clear_mentioned_summaries(tx, params)
    episodes_removed = await _delete_own_episodes(tx, params)
    dead_removed = await _delete_dead_edges(tx, params)
    orphans = await _delete_orphaned_nodes(tx, params, set(verbatim_uuids) | set(mentioned_uuids))
    return {
        "facts": facts_removed + dead_removed,
        "episodes": episodes_removed,
        "verbatim_nodes": int(orphans["verbatim"]),
        "entities": int(orphans["entities"]),
        "summaries": summaries_cleared,
    }


async def _lock_removable_nodes(tx, params: dict) -> None:
    """Lock every node this call may remove before reading its relationships.
    Retirements running at once can share an entity, and under Neo4j's
    read-committed isolation each transaction would otherwise still see
    the others' mentions and none would remove it. With the lock, a later
    transaction waits for the earlier one to commit and sees its deletes."""
    await (
        await tx.run(
            """
        CALL {
            MATCH (n)-[r:RELATES_TO]->()
            WHERE r.group_id = $group_id AND r.uuid IN $delete_uuids
              AND n.group_id = $group_id AND (n:Fact OR n:Decision OR n:Passage)
            RETURN n
            UNION
            MATCH (ep:Episodic)-[:MENTIONS]->(n:Entity)
            WHERE ep.group_id = $group_id AND ep.uuid IN $own_episodes AND n.group_id = $group_id
            RETURN n
        }
        WITH DISTINCT n ORDER BY n.uuid
        SET n._retire_lock = true
        REMOVE n._retire_lock
        """,
            **params,
        )
    ).consume()


async def _prune_own_episodes_from_shared_edges(tx, params: dict) -> None:
    await (
        await tx.run(
            """
        MATCH ()-[r:RELATES_TO]->()
        WHERE r.group_id = $group_id AND r.uuid IN $prune_uuids
        SET r.episodes = [e IN r.episodes WHERE NOT e IN $own_episodes]
        """,
            **params,
        )
    ).consume()


async def _verbatim_nodes_of_deleted_edges(tx, params: dict) -> list[str]:
    """Read before the edges go: a verbatim node is retired because its own edge is."""
    verbatim = await (
        await tx.run(
            """
        MATCH (n)-[r:RELATES_TO]->()
        WHERE r.group_id = $group_id AND r.uuid IN $delete_uuids
          AND n.group_id = $group_id AND (n:Fact OR n:Decision OR n:Passage)
        RETURN collect(DISTINCT n.uuid) AS uuids
        """,
            **params,
        )
    ).single()
    return verbatim["uuids"]


async def _delete_owned_edges(tx, params: dict) -> int:
    facts = await (
        await tx.run(
            """
        MATCH ()-[d:RELATES_TO]->()
        WHERE d.group_id = $group_id AND d.uuid IN $delete_uuids
        WITH collect(d) AS rels
        FOREACH (x IN rels | DELETE x)
        RETURN size(rels) AS removed
        """,
            **params,
        )
    ).single()
    return int(facts["removed"])


async def _clear_mentioned_summaries(tx, params: dict) -> tuple[list[str], int]:
    """Clear the summaries of the entities this stamp's episodes mentioned, which can
    quote them. Returns those entities' uuids and how many summaries were cleared."""
    mentioned = await (
        await tx.run(
            """
        MATCH (ep:Episodic)-[:MENTIONS]->(n:Entity)
        WHERE ep.group_id = $group_id AND ep.uuid IN $own_episodes AND n.group_id = $group_id
        WITH collect(DISTINCT n) AS entities
        WITH entities, [e IN entities WHERE coalesce(e.summary, '') <> ''] AS quoting
        FOREACH (n IN quoting | SET n.summary = '')
        RETURN [e IN entities | e.uuid] AS uuids, size(quoting) AS cleared
        """,
            **params,
        )
    ).single()
    return mentioned["uuids"], int(mentioned["cleared"])


async def _delete_own_episodes(tx, params: dict) -> int:
    episodes = await (
        await tx.run(
            """
        MATCH (ep:Episodic)
        WHERE ep.group_id = $group_id AND ep.uuid IN $own_episodes
        DETACH DELETE ep
        RETURN count(ep) AS removed
        """,
            **params,
        )
    ).single()
    return int(episodes["removed"])


async def _delete_dead_edges(tx, params: dict) -> int:
    """Lock the edges first, then decide again from what is committed now. An
    ingest that already wrote its episode onto one makes the lock wait for its
    commit, and the read after it sees that episode and keeps the edge."""
    await (
        await tx.run(
            """
        MATCH ()-[r:RELATES_TO]->()
        WHERE r.group_id = $group_id AND r.uuid IN $dead_uuids
        SET r._retire_lock = true
        REMOVE r._retire_lock
        """,
            **params,
        )
    ).consume()
    dead = await (
        await tx.run(
            """
        MATCH ()-[r:RELATES_TO]->()
        WHERE r.group_id = $group_id AND r.uuid IN $dead_uuids
          AND NOT EXISTS { MATCH (ep:Episodic) WHERE ep.uuid IN r.episodes }
        WITH collect(r) AS rels
        FOREACH (x IN rels | DELETE x)
        RETURN size(rels) AS removed
        """,
            **params,
        )
    ).single()
    return int(dead["removed"])


async def _delete_orphaned_nodes(tx, params: dict, candidates: set[str]):
    """Only a node with nothing left attached goes; a remaining relationship
    means something else still knows it. Returns the counts of verbatim nodes and
    entities removed."""
    return await (
        await tx.run(
            """
        MATCH (n)
        WHERE n.group_id = $group_id AND n.uuid IN $candidates AND NOT (n)--()
        WITH n, (n:Fact OR n:Decision OR n:Passage) AS is_verbatim
        DELETE n
        RETURN count(CASE WHEN is_verbatim THEN 1 END) AS verbatim,
               count(CASE WHEN NOT is_verbatim THEN 1 END) AS entities
        """,
            candidates=sorted(candidates),
            **params,
        )
    ).single()
