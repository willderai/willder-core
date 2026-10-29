"""What a group or a connected source still holds in the graph, counted so a caller
can tell whether a delete or a disconnect removed it."""

from .. import graphiti_client as client
from ..partitions import org_groups
from .org_graph import org_partitions
from .provenance import has_retirement_stamp, parse_provenance
from .visibility import fallback_anchor_uuid


async def count_group_residue(group_id: str) -> dict[str, int]:
    """Count what one `group_id` still holds: its RELATES_TO edges (facts) and
    its Episodic nodes (the raw ingested bodies those facts came from).

    Deleting a scope asks this before it removes the scope row, because a scope
    recreated at the same path gets the same `group_id` and would inherit both.
    Each count reads the group directly; it does not go through `graph_for_group`,
    whose `limit` caps entities and returns only their outgoing edges, so an edge
    whose source falls outside the page is not seen there.
    """
    await client.get_graphiti()

    async def _count(session):
        result = await session.run(
            """
            CALL {
                MATCH ()-[r:RELATES_TO]->()
                WHERE r.group_id = $group_id
                RETURN count(r) AS facts
            }
            CALL {
                MATCH (ep:Episodic)
                WHERE ep.group_id = $group_id
                RETURN count(ep) AS episodes
            }
            RETURN facts, episodes
            """,
            group_id=group_id,
        )
        rec = await result.single()
        return {"facts": int(rec["facts"]), "episodes": int(rec["episodes"])}

    return await client._run_with_retry(_count)


# A source-records count is one read transaction the server stops after this long, below
# the app's 20 s wait for the whole call, so a slow read never runs on after nobody wants it.
SOURCE_RECORDS_TIMEOUT_S = 15.0


async def count_source_records(org_id: str, source_id: str, group_ids: list[str]) -> list[dict]:
    """Count what one connected source has in the graph of one org, by scope, so a
    caller can tell whether a disconnect removed it. Read-only; counts, never text.

    The source's records are found by its provenance stamp in every partition of the
    org, not only the scopes named, because a reconnect can move a source and leave
    what it wrote under the scope it left. They are attributed the way
    `remove_group_facts` retires them:

    - episodes: Episodic nodes whose stamp names the source;
    - facts: RELATES_TO edges whose own stamp names it, or that carry no stamp of their
      own and list one of its episodes (an edge another source created and this one
      only matched counts too, since it still cites this source until retired);
    - fact_embeddings: those edges that carry a vector (Graphiti's `fact_embedding`, or
      the `embedding` a verbatim edge is written with);
    - verbatim_nodes: the Fact, Decision and Passage nodes those edges leave from.

    Entities, and facts whose episodes are gone, carry no stamp, so once a source's
    episodes are deleted what they leave behind cannot be attributed to it. What can
    be counted, for each of `group_ids`, is the defect that would leave them:

    - orphans: entities there with no relationship at all. The scope's fallback anchor
      is not one: `ensure_graph_visible` links every verbatim fact in a scope to it, it
      carries no text of its own, and it stays when its last fact goes (person erasure
      keeps it the same way);
    - dangling_facts: facts there with no source or chunk stamp of their own that list
      episodes, none of which exists any more: the facts `remove_chunk_facts` and
      `remove_group_facts` delete from their group. A fact typed in chat lists none
      and is not one; a fact stamped with its stored fact's chunk is retired with it.

    Returns one entry per scope that was named or holds any of these records, in
    group_id order. Its queries run in one transaction, which the server stops at
    `SOURCE_RECORDS_TIMEOUT_S` however the time is split between them.
    """
    await client.get_graphiti()
    org = org_groups(org_id)

    async def _read(session):
        async with await session.begin_transaction(timeout=SOURCE_RECORDS_TIMEOUT_S) as tx:
            return await _read_source_records(tx, org, source_id, group_ids)

    own, edges, orphans, dangling = await client._run_with_retry(_read)
    return _tally_source_records(source_id, group_ids, own, edges, orphans, dangling)


async def _read_source_records(tx, org: dict, source_id: str, group_ids: list[str]):
    """The four reads behind `count_source_records`, in one transaction: the source's
    episodes, the edges that may cite it, and each named group's orphans and dangling facts."""
    episodes = await (
        await tx.run(
            f"""
        MATCH (ep:Episodic)
        WHERE {org_partitions("ep")} AND ep.source_description CONTAINS $source_id
        RETURN ep.uuid AS uuid, ep.group_id AS group_id, ep.source_description AS source_description
        """,
            source_id=source_id,
            **org,
        )
    ).data()
    # CONTAINS only narrows the read; the stamp is matched exactly here.
    own = [
        e
        for e in episodes
        if parse_provenance(e["source_description"]).get("source_id") == source_id
    ]
    edges = await (
        await tx.run(
            f"""
        MATCH (n)-[r:RELATES_TO]->()
        WHERE {org_partitions("r")}
          AND (r.source_description CONTAINS $source_id
               OR any(e IN coalesce(r.episodes, []) WHERE e IN $own_episodes))
        RETURN r.group_id AS group_id, r.source_description AS source_description,
               coalesce(r.episodes, []) AS episodes,
               coalesce(r.fact_embedding, r.embedding) IS NOT NULL AS has_vector,
               CASE WHEN n:Fact OR n:Decision OR n:Passage THEN n.uuid END AS verbatim
        """,
            source_id=source_id,
            own_episodes=[e["uuid"] for e in own],
            **org,
        )
    ).data()
    orphans = await (
        await tx.run(
            """
        UNWIND $groups AS g
        OPTIONAL MATCH (n:Entity)
        WHERE n.group_id = g.id AND n.uuid <> g.anchor AND NOT (n)--()
        RETURN g.id AS group_id, count(n) AS orphans
        """,
            groups=[{"id": g, "anchor": fallback_anchor_uuid(g)} for g in group_ids],
        )
    ).data()
    dangling = await (
        await tx.run(
            """
        MATCH ()-[r:RELATES_TO]->()
        WHERE r.group_id IN $group_ids AND size(coalesce(r.episodes, [])) > 0
          AND none(e IN r.episodes WHERE EXISTS { MATCH (ep:Episodic {uuid: e}) })
        RETURN r.group_id AS group_id, r.source_description AS source_description
        """,
            group_ids=group_ids,
        )
    ).data()
    return own, edges, orphans, dangling


def _tally_source_records(
    source_id: str, group_ids: list[str], own, edges, orphans, dangling
) -> list[dict]:
    """`count_source_records`' answer from its reads: one entry per scope, in group_id order."""
    counts: dict[str, dict] = {}

    def group(group_id: str) -> dict:
        return counts.setdefault(
            group_id,
            {
                "group_id": group_id,
                "episodes": 0,
                "facts": 0,
                "fact_embeddings": 0,
                "verbatim_nodes": set(),
                "orphans": 0,
                "dangling_facts": 0,
            },
        )

    for gid in group_ids:
        group(gid)
    own_uuids = {e["uuid"] for e in own}
    for e in own:
        group(e["group_id"])["episodes"] += 1
    for r in edges:
        stamp = parse_provenance(r["source_description"]).get("source_id")
        cites = stamp == source_id if stamp else any(uuid in own_uuids for uuid in r["episodes"])
        if not cites:
            continue
        g = group(r["group_id"])
        g["facts"] += 1
        g["fact_embeddings"] += 1 if r["has_vector"] else 0
        if r["verbatim"]:
            g["verbatim_nodes"].add(r["verbatim"])
    for row in orphans:
        group(row["group_id"])["orphans"] = int(row["orphans"])
    for r in dangling:
        if not has_retirement_stamp(r["source_description"]):
            group(r["group_id"])["dangling_facts"] += 1

    return [{**g, "verbatim_nodes": len(g["verbatim_nodes"])} for _, g in sorted(counts.items())]
