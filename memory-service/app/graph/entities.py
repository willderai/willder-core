"""Entity nodes: looking one up, removing one, and moving a role's facts from one
holder to the next."""

import logging
from collections.abc import Sequence

from graphiti_core.edges import EntityEdge
from graphiti_core.errors import NodeNotFoundError
from graphiti_core.nodes import EntityNode
from neo4j.exceptions import DriverError

from .. import graphiti_client as client

logger = logging.getLogger(__name__)


async def get_entity_with_facts(group_ids: Sequence[str], uuid: str):
    """Fetch an entity by uuid + its facts, scoped to the tenant. Returns
    (node, edges) with the edges of the node's own group, or None if not found /
    not in one of `group_ids` (tenant isolation).

    Any other failure is raised, never answered as None: a graph that is down or a
    query that broke must reach the caller as an error, not as "this entity does not
    exist"."""
    for attempt in range(2):
        engine = None
        try:
            engine = await client.get_graphiti()  # ensures the driver is initialized
            node = await EntityNode.get_by_uuid(client._graph_driver, uuid)
            # A set, not the sequence itself: `in` on a str would match a substring.
            if node.group_id not in set(group_ids):
                return None
            edges = await EntityEdge.get_by_node_uuid(client._graph_driver, uuid)
            return node, [e for e in edges if e.group_id == node.group_id]
        except NodeNotFoundError:
            return None
        except client.CONNECTION_LOST_ERRORS as exc:
            if attempt == 1:
                raise
            logger.warning("Graphiti connection lost in get_entity_with_facts, resetting: %s", exc)
            await client._reset_graphiti(engine)
        except client.OVERLOAD_ERRORS:
            raise
        except DriverError:
            if attempt == 1 or not client.engine_replaced(engine):
                raise


async def remove_entity(group_id: str, uuid: str) -> bool:
    """Delete an entity only when its entire attached graph is in this partition.

    MENTIONS/HAS_MEMBER metadata edges can lack their own group_id; both nodes
    must still belong to the authorized partition. RELATES_TO facts additionally
    require their own matching group_id. Unknown/mixed partitions fail closed.
    """
    if not group_id or not group_id.strip():
        return False
    await client.get_graphiti()

    async def _delete(session):
        result = await session.run(
            """
            MATCH (n:Entity {uuid: $uuid, group_id: $group_id})
            WHERE NOT EXISTS {
                MATCH (n)-[r]-(other)
                WHERE other.group_id IS NULL OR other.group_id <> $group_id
                   OR (r.group_id IS NOT NULL AND r.group_id <> $group_id)
                   OR (type(r) = 'RELATES_TO' AND r.group_id IS NULL)
            }
            OPTIONAL MATCH (n)-[r]-()
            WITH n, collect(DISTINCT r) AS rels
            FOREACH (x IN rels | DELETE x)
            // No DETACH: an additional relationship must abort, not cascade.
            DELETE n
            RETURN count(n) AS removed
            """,
            uuid=uuid,
            group_id=group_id,
        )
        rec = await result.single()
        return bool(rec and rec["removed"])

    return await client._run_with_retry(_delete)


# transfer_entity_edges: the new role holder gets the fields Graphiti needs to load a
# node (uuid, created_at, summary) the first time it is written. coalesce also repairs
# a holder an earlier version left without them.
_SET_TRANSFER_HOLDER = """SET new.uuid = coalesce(new.uuid, randomUUID()),
                new.created_at = coalesce(new.created_at, datetime()),
                new.summary = coalesce(new.summary, '')"""

# transfer_entity_edges: the copy keeps every property of the edge it replaces, so it
# stays a complete Graphiti edge, and is a new, current fact from now.
_SET_TRANSFER_COPY = """SET copy = properties(r),
                copy.uuid = randomUUID(),
                copy.name = coalesce(r.name, 'RELATES_TO'),
                copy.episodes = coalesce(r.episodes, []),
                copy.created_at = datetime(),
                copy.valid_at = datetime(),
                copy.invalid_at = null,
                copy.expired_at = null"""


async def repair_transferred_entities() -> int:
    """Give the nodes and edges an earlier transfer_entity_edges wrote without them the
    fields Graphiti needs to load them: a role holder's uuid, created_at and summary,
    and a copied edge's name, created_at and episodes. Until repaired, every entity such
    an edge touches fails to load. Idempotent; returns how many nodes and edges changed.

    A repaired copy has no episodes, because the old copy did not keep them."""

    async def _repair(session):
        nodes = await session.run(
            """
            MATCH (n:Entity) WHERE n.uuid IS NULL
            SET n.uuid = randomUUID(),
                n.created_at = coalesce(n.created_at, datetime()),
                n.summary = coalesce(n.summary, '')
            RETURN count(n) AS n
            """
        )
        node_count = (await nodes.single())["n"]
        edges = await session.run(
            """
            MATCH ()-[r:RELATES_TO]->()
            WHERE r.name IS NULL OR r.created_at IS NULL OR r.episodes IS NULL
            SET r.name = coalesce(r.name, 'RELATES_TO'),
                r.created_at = coalesce(r.created_at, r.valid_at, datetime()),
                r.episodes = coalesce(r.episodes, [])
            RETURN count(r) AS n
            """
        )
        return node_count + (await edges.single())["n"]

    repaired = await client._run_with_retry(_repair)
    if repaired:
        logger.info("Repaired %d role-transfer nodes and edges Graphiti could not load", repaired)
    return repaired


async def transfer_entity_edges(group_id: str, old_name: str, new_name: str) -> int:
    """Invalidate all active RELATES_TO edges connected to the old entity and
    recreate equivalent edges pointing to the new entity. Used when an org role
    mapping changes (e.g. CEO was Bob, now CEO is Amy).

    For both outgoing (old→other) and incoming (other→old) edges:
      1. Set invalid_at = now() on the old edge.
      2. MERGE the new entity node, giving it a uuid, created_at and summary when
         it is created, or when an earlier transfer left it without them.
      3. CREATE a copy of the old edge with every property it had (fact, name,
         episodes, embeddings, provenance), a new uuid, and created_at/valid_at of
         now. Graphiti cannot load an edge without its name, created_at or
         episodes, nor one whose end has no uuid, so a partial copy would make
         every entity it touches fail to load.

    Returns the total number of edges transferred.
    """
    await client.get_graphiti()
    total = 0

    async def _transfer(session):
        nonlocal total

        # Outgoing: (old)-[r]->(other) → invalidate r, create (new)-[r']->(other)
        out = await session.run(
            """
            MATCH (old:Entity {name: $old_name, group_id: $gid})
            MATCH (old)-[r:RELATES_TO {group_id: $gid}]->(other:Entity {group_id: $gid})
            WHERE r.invalid_at IS NULL
            SET r.invalid_at = datetime()
            WITH other, r
            MERGE (new:Entity {name: $new_name, group_id: $gid})
            %s
            CREATE (new)-[copy:RELATES_TO]->(other)
            %s
            RETURN count(*) AS n
            """
            % (_SET_TRANSFER_HOLDER, _SET_TRANSFER_COPY),
            old_name=old_name,
            new_name=new_name,
            gid=group_id,
        )
        rec = await out.single()
        if rec:
            total += rec["n"]

        # Incoming: (other)-[r]->(old) → invalidate r, create (other)-[r']->(new)
        inc = await session.run(
            """
            MATCH (old:Entity {name: $old_name, group_id: $gid})
            MATCH (other:Entity {group_id: $gid})-[r:RELATES_TO {group_id: $gid}]->(old)
            WHERE r.invalid_at IS NULL
            SET r.invalid_at = datetime()
            WITH other, r
            MERGE (new:Entity {name: $new_name, group_id: $gid})
            %s
            CREATE (other)-[copy:RELATES_TO]->(new)
            %s
            RETURN count(*) AS n
            """
            % (_SET_TRANSFER_HOLDER, _SET_TRANSFER_COPY),
            old_name=old_name,
            new_name=new_name,
            gid=group_id,
        )
        rec = await inc.single()
        if rec:
            total += rec["n"]

    await client._run_with_retry(_transfer)
    return total


async def groups_holding_entity(group_ids: Sequence[str], name: str) -> list[str]:
    """The groups among `group_ids` holding an Entity node named exactly `name`, in
    `group_ids` order. The same node predicate as find_entity_by_name, over a set of
    groups in one query, so the caller resolving which scope owns a name asks every
    candidate scope at once."""

    async def _find(session):
        result = await session.run(
            """
            MATCH (n:Entity {name: $name})
            WHERE n.group_id IN $gids
            RETURN DISTINCT n.group_id AS group_id
            """,
            name=name,
            gids=list(group_ids),
        )
        return [record["group_id"] async for record in result]

    found = set(await client._run_with_retry(_find))
    return [gid for gid in dict.fromkeys(group_ids) if gid in found]


async def find_entity_by_name(group_id: str, name: str):
    """Look up an Entity node by its exact name within one Graphiti group_id.

    Mirrors transfer_entity_edges' own MATCH predicate exactly (`{name: $name,
    group_id: $gid}`) — "found" here means the same node that predicate would
    act on, no more and no less. Deliberately does NOT require an existing
    RELATES_TO edge the way graph_for_group's node listing does, so a
    freshly-seeded, still edge-less entity (e.g. a bare contact/account seed)
    is still found. Used server-side to resolve which real scope (group_id)
    currently owns a named entity, before any access decision is made — see
    willder's services/memory/entity-scope.ts.

    Returns (uuid, labels) or None if no such node exists in this group.
    """

    async def _find(session):
        result = await session.run(
            """
            MATCH (n:Entity {name: $name, group_id: $gid})
            RETURN n.uuid AS uuid, labels(n) AS labels
            LIMIT 1
            """,
            name=name,
            gid=group_id,
        )
        return await result.single()

    rec = await client._run_with_retry(_find)
    if rec is None:
        return None
    return rec["uuid"], rec["labels"]
