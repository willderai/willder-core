"""An org's partitions in the graph, and removing or counting everything in them."""

from .. import graphiti_client as client
from ..partitions import org_groups


def in_org(var: str) -> str:
    """Cypher predicate: `var` belongs to one of the org's partitions — the
    legacy bare org id, the root scope `org_<id>`, or a scope under it
    (`org_<id>-<label>...`, the dashed form of an ltree path). The trailing dash
    keeps an org whose id merely starts with this one out. A missing group_id
    is outside every org, so an untagged node fails closed."""
    gid = f"coalesce({var}.group_id, '')"
    return f"({gid} = $org_id OR {gid} = $root OR {gid} STARTS WITH $root_prefix)"


def org_partitions(var: str) -> str:
    """Cypher predicate: `var` is in one of the org's partitions, as `in_org` reads it,
    written so Neo4j can answer it from a `group_id` range index. A missing group_id
    compares as null and is left out, as `in_org` leaves it out."""
    return f"({var}.group_id IN [$org_id, $root] OR {var}.group_id STARTS WITH $root_prefix)"


# Rows each inner transaction of an org purge deletes, so one org's deletion never
# holds a transaction the size of the org.
ORG_PURGE_BATCH = 1000


async def purge_org_graph(org_id: str) -> dict[str, int]:
    """Remove everything one org holds in the graph, for the org's deletion (the app's
    services/memory/org-deletion, after the seven days). Every node in one of the org's
    partitions goes with all its relationships, then any relationship still stamped
    with one of them (one whose endpoints carry no group, or another org's).

    Bounded by `in_org`, the same predicate every org-wide read uses: the bare org id,
    `org_<id>`, and scopes under it by the trailing dash, so an org whose id merely
    starts with this one is untouched. Nothing here reads a group from the caller.

    Idempotent: a second call finds nothing and removes nothing. Each statement deletes
    in batches of `ORG_PURGE_BATCH`, each its own transaction, so a purge that dies
    part-way leaves a smaller residue for the next call rather than a rolled-back whole.
    """
    await client.get_graphiti()
    params = org_groups(org_id)

    async def _purge(session):
        nodes = await session.run(
            f"""
            MATCH (n) WHERE {in_org('n')}
            CALL {{ WITH n DETACH DELETE n }} IN TRANSACTIONS OF {ORG_PURGE_BATCH} ROWS
            RETURN count(n) AS removed
            """,
            **params,
        )
        removed_nodes = int((await nodes.single())["removed"])
        rels = await session.run(
            f"""
            MATCH ()-[r]->() WHERE {in_org('r')}
            CALL {{ WITH r DELETE r }} IN TRANSACTIONS OF {ORG_PURGE_BATCH} ROWS
            RETURN count(r) AS removed
            """,
            **params,
        )
        removed_rels = int((await rels.single())["removed"])
        return {"nodes": removed_nodes, "relationships": removed_rels}

    return await client._run_with_retry(_purge)


async def count_org_graph(org_id: str) -> dict[str, int]:
    """Count the nodes and relationships in one org's partitions. The org deletion asks
    this after `purge_org_graph` and finishes only when both are zero."""
    await client.get_graphiti()
    params = org_groups(org_id)

    async def _count(session):
        result = await session.run(
            f"""
            CALL {{ MATCH (n) WHERE {in_org('n')} RETURN count(n) AS nodes }}
            CALL {{ MATCH ()-[r]->() WHERE {in_org('r')} RETURN count(r) AS relationships }}
            RETURN nodes, relationships
            """,
            **params,
        )
        rec = await result.single()
        return {"nodes": int(rec["nodes"]), "relationships": int(rec["relationships"])}

    return await client._run_with_retry(_count)
