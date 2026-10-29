"""Erasing one person from every partition of one org: the episodes, verbatim facts
and entities that name them, and every edge those leave behind."""

from .. import graphiti_client as client
from ..partitions import org_groups
from .name_patterns import (
    joined_record_name_patterns,
    joined_text_patterns,
    names_person,
    record_name_patterns,
    text_patterns,
    with_ascii_spellings,
)
from .org_graph import in_org


class PersonErasureBlocked(Exception):
    """A node to erase is linked to a node outside the org. Nothing was changed."""


# Nodes erased outright: the person's own entity nodes, every episode whose raw
# body names them or whose name is theirs (an ingested episode is named after the
# entity it is about, so its body may only say "She ..."), and every verbatim fact
# node (see VERBATIM_NODE_LABELS) that quotes them. Text is matched by
# text_patterns and joined_text_patterns; an entity's or an episode's own name by
# record_name_patterns and joined_record_name_patterns (names_person).
_ERASE_TARGETS = f"""
    MATCH (n)
    WHERE (n:Entity OR n:Episodic) AND {in_org("n")} AND (
        (n:Episodic AND ({names_person("n.content", "patterns", "joined_patterns")}
                         OR {names_person("n.name", "name_patterns", "joined_name_patterns")}))
     OR ((n:Fact OR n:Decision OR n:Passage)
         AND ({names_person("n.summary", "patterns", "joined_patterns")}
              OR {names_person("n.name", "patterns", "joined_patterns")}))
     OR (n:Entity AND (n.uuid IN $entity_uuids
                       OR {names_person("n.name", "name_patterns", "joined_name_patterns")}))
    )
"""


def _erase_params(
    org_id: str, emails: list[str], names: list[str], entity_uuids: list[str]
) -> dict:
    """The query parameters _ERASE_TARGETS reads, for one person in one org: each name, and
    each as ASCII spells it (_ascii_spelling)."""
    names = with_ascii_spellings(names)
    return {
        **org_groups(org_id),
        "patterns": text_patterns(emails, names),
        "joined_patterns": joined_text_patterns(names),
        "name_patterns": record_name_patterns(emails, names),
        "joined_name_patterns": joined_record_name_patterns(names),
        "entity_uuids": entity_uuids,
    }


async def plan_person_erasure(
    org_id: str, emails: list[str], names: list[str], entity_uuids: list[str]
) -> list[str]:
    """The uuids of the episodes erase_person would remove now, in a read-only
    transaction that changes nothing.

    The app asks before it erases, so it can drop the connector records that point
    at those episodes while it still knows them: once the episodes are gone, a
    repeat of the erasure returns none, and a record still pointing at one would
    fail every later sync of its file."""
    if not emails and not names and not entity_uuids:
        return []
    await client.get_graphiti()
    params = _erase_params(org_id, emails, names, entity_uuids)

    async def _plan(tx):
        rows = await (
            await tx.run(
                _ERASE_TARGETS + "WITH n WHERE n:Episodic RETURN n.uuid AS uuid",
                **params,
            )
        ).data()
        return sorted(r["uuid"] for r in rows)

    async def _in_transaction(session):
        return await session.execute_read(_plan)

    return await client._run_with_retry(_in_transaction)


async def erase_person(
    org_id: str, emails: list[str], names: list[str], entity_uuids: list[str]
) -> dict:
    """Remove one person from every partition of one org, in one transaction.

    Removes the target nodes above, every relationship touching them, every
    RELATES_TO edge whose fact text names the person, and every edge an erased
    episode created (the first entry in its `episodes`, the same ownership rule
    `remove_group_facts` uses), even when the text does not name them. An edge
    another episode created only loses the erased episode's uuid. Other
    entities' summaries that quote the person are cleared rather than
    re-summarised, since re-summarising needs the model and this path must not.
    An entity at the far end of a removed relationship (an erased episode's
    MENTIONS included) is removed too once nothing else is attached to it: it
    exists only because of the person, even when its own name does not name them.
    That covers the verbatim nodes `ensure_graph_visible` writes, which no episode
    MENTIONS (their own edge is what ties them to the erased episode), and a role
    holder `transfer_entity_edges` created whose only facts were about the person.
    The shared fallback anchor is never removed.

    Nothing outside the org is read or written. If a target node is linked to a
    node outside the org, nothing changes and PersonErasureBlocked is raised:
    such a link should not exist, and erasing half of it would hide that.

    Idempotent: a second call finds nothing and returns zeros. The uuids of the
    erased episodes are returned too, so the app can drop the connector records
    that still point at them; a repeat returns none.
    """
    if not emails and not names and not entity_uuids:
        return {"episodes": 0, "nodes": 0, "edges": 0, "summaries": 0, "episode_ids": []}
    await client.get_graphiti()
    params = _erase_params(org_id, emails, names, entity_uuids)

    async def _erase(tx):
        return await _erase_in_transaction(tx, org_id, params)

    async def _in_transaction(session):
        return await session.execute_write(_erase)

    return await client._run_with_retry(_in_transaction)


async def _erase_in_transaction(tx, org_id: str, params: dict) -> dict:
    """`erase_person`'s write transaction, step by step: refuse a cross-org link, find
    the targets, delete their relationships and the edges their episodes created, prune
    the edges that only list those episodes, delete the targets, sweep what is left
    orphaned, and clear the summaries that quote the person."""
    await _refuse_links_outside_org(tx, org_id, params)

    targets = await (
        await tx.run(
            _ERASE_TARGETS
            + """
            RETURN n.uuid AS uuid, n:Episodic AS episode
            """,
            **params,
        )
    ).data()
    target_uuids = [t["uuid"] for t in targets]
    episode_uuids = [t["uuid"] for t in targets if t["episode"]]

    edges_removed, far_ends = await _delete_edges_of_targets(
        tx, params, target_uuids, episode_uuids
    )
    await _prune_erased_episodes(tx, params, episode_uuids)
    await _delete_targets(tx, params, target_uuids)
    orphans_removed = await _delete_orphaned_far_ends(tx, params, far_ends)
    summaries_cleared = await _clear_quoting_summaries(tx, params)

    return {
        "episodes": len(episode_uuids),
        "nodes": len(target_uuids) - len(episode_uuids) + orphans_removed,
        "edges": edges_removed,
        "summaries": summaries_cleared,
        "episode_ids": sorted(episode_uuids),
    }


async def _refuse_links_outside_org(tx, org_id: str, params: dict) -> None:
    """Raise PersonErasureBlocked when a target node is linked to a node, or by a
    relationship, outside the org. Runs first, so nothing has changed yet."""
    blocked = await (
        await tx.run(
            _ERASE_TARGETS
            + f"""
            MATCH (n)-[r]-(other)
            WHERE NOT {in_org("other")} OR (r.group_id IS NOT NULL AND NOT {in_org("r")})
            RETURN count(DISTINCT n) AS blocked
            """,
            **params,
        )
    ).single()
    if blocked["blocked"]:
        raise PersonErasureBlocked(
            f"{blocked['blocked']} node(s) naming this person link outside org {org_id}"
        )


async def _delete_edges_of_targets(
    tx, params: dict, target_uuids: list[str], episode_uuids: list[str]
) -> tuple[int, list[str]]:
    """Delete every relationship of a target, every RELATES_TO edge whose fact names
    the person, and every edge an erased episode created. Returns how many went and the
    element ids of the nodes at their far ends."""
    edges = await (
        await tx.run(
            f"""
            MATCH (a)-[r]-(b)
            WHERE {in_org("a")} AND {in_org("b")} AND (
                a.uuid IN $target_uuids
             OR (type(r) = 'RELATES_TO' AND (
                    {names_person("r.fact", "patterns", "joined_patterns")}
                 OR coalesce(r.episodes, [])[0] IN $episode_uuids))
            )
            WITH collect(DISTINCT r) AS rels, collect(DISTINCT elementId(b)) AS far_ends
            FOREACH (x IN rels | DELETE x)
            RETURN size(rels) AS removed, far_ends
            """,
            target_uuids=target_uuids,
            episode_uuids=episode_uuids,
            **params,
        )
    ).single()
    return int(edges["removed"]), edges["far_ends"]


async def _prune_erased_episodes(tx, params: dict, episode_uuids: list[str]) -> None:
    """An edge another episode created only loses the erased episodes' uuids."""
    await (
        await tx.run(
            f"""
            MATCH ()-[r:RELATES_TO]->()
            WHERE {in_org("r")} AND any(e IN coalesce(r.episodes, []) WHERE e IN $episode_uuids)
            SET r.episodes = [e IN r.episodes WHERE NOT e IN $episode_uuids]
            """,
            episode_uuids=episode_uuids,
            **params,
        )
    ).consume()


async def _delete_targets(tx, params: dict, target_uuids: list[str]) -> None:
    """Every relationship of these nodes is gone above, so a plain DELETE is
    enough; one that appeared since fails the transaction instead of
    being cascaded away unseen."""
    await (
        await tx.run(
            "MATCH (n) WHERE n.uuid IN $target_uuids AND " + in_org("n") + " DELETE n",
            target_uuids=target_uuids,
            **params,
        )
    ).consume()


async def _delete_orphaned_far_ends(tx, params: dict, far_ends: list[str]) -> int:
    """An entity a removed relationship linked to (every MENTIONS of an erased episode
    among them) whose name does not name the person is still theirs when nothing
    else is attached to it: erased means nothing left that exists only because of
    the person. A remaining relationship means something else still knows it, so
    it stays. Matched by element id, since a role holder an earlier
    `transfer_entity_edges` wrote has no uuid until repaired. Never swept: an
    episode, which is its own record, and the scope's fallback anchor (:Category),
    which `ensure_graph_visible` shares between everyone's facts and links to in the
    same statement that merges it."""
    orphans = await (
        await tx.run(
            "MATCH (n:Entity) WHERE elementId(n) IN $candidates AND NOT n:Category AND "
            + in_org("n")
            + " AND NOT (n)--() DELETE n RETURN count(n) AS removed",
            candidates=far_ends,
            **params,
        )
    ).single()
    return int(orphans["removed"])


async def _clear_quoting_summaries(tx, params: dict) -> int:
    """Other entities' summaries that quote the person are cleared rather than
    re-summarised, since re-summarising needs the model and this path must not."""
    summaries = await (
        await tx.run(
            f"""
            MATCH (n:Entity)
            WHERE {in_org("n")} AND {names_person("n.summary", "patterns", "joined_patterns")}
            SET n.summary = ''
            RETURN count(n) AS cleared
            """,
            **params,
        )
    ).single()
    return int(summaries["cleared"])
