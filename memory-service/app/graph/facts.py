"""Reading facts: the /graph view of a scope, the provenance of a set of edges, and
one fact by uuid."""

import json
import re

from .. import graphiti_client as client
from .provenance import parse_provenance


def _iso(v):
    """A Neo4j temporal as an ISO-8601 string, or None when unset."""
    if v is None:
        return None
    if hasattr(v, "iso_format"):
        return v.iso_format()
    return str(v)


# The /graph window: which entities, ordered by uuid and capped at $limit.
_GRAPH_WINDOW_ALL = """
    MATCH (n:Entity)
    WHERE n.group_id IN $gids
      AND ((n)-[:RELATES_TO]-() OR ()-[:RELATES_TO]-(n))
    ORDER BY n.uuid
    WITH n LIMIT $limit
"""
_GRAPH_WINDOW_MATCHING = """
    MATCH (n:Entity)
    WHERE n.group_id IN $gids
      AND ((n)-[:RELATES_TO]-() OR ()-[:RELATES_TO]-(n))
      AND (toLower(coalesce(n.name, '')) CONTAINS $needle
           OR EXISTS {
             MATCH (n)-[f:RELATES_TO]-(o:Entity)
             WHERE f.group_id IN $gids AND o.group_id IN $gids
               AND toLower(coalesce(f.fact, '')) CONTAINS $needle
           })
    ORDER BY n.uuid
    WITH n LIMIT $limit
"""

# The /graph edges of each windowed entity, and what each row returns.
_GRAPH_EDGE_COLUMNS = """
    RETURN n.uuid AS n_uuid, n.name AS n_name, labels(n) AS n_labels,
           r.uuid AS r_uuid, r.fact AS r_fact,
           r.valid_at AS r_valid_at, r.invalid_at AS r_invalid_at,
           r.expired_at AS r_expired_at,
           r.source_description AS r_source_desc,
           r.group_id AS r_group_id,
           startNode(r) = n AS r_leaves_n,
           m.uuid AS m_uuid, m.name AS m_name, labels(m) AS m_labels
"""
_GRAPH_EDGES_OUTGOING = (
    """
    OPTIONAL MATCH (n)-[r:RELATES_TO]->(m:Entity)
    WHERE r.group_id IN $gids AND m.group_id IN $gids
"""
    + _GRAPH_EDGE_COLUMNS
)
_GRAPH_EDGES_BOTH_WAYS = (
    """
    OPTIONAL MATCH (n)-[r:RELATES_TO]-(m:Entity)
    WHERE r.group_id IN $gids AND m.group_id IN $gids
"""
    + _GRAPH_EDGE_COLUMNS
)


async def graph_for_group(group_ids: list[str], query: str | None = None, limit: int = 50):
    """Entities (nodes) + the facts linking them (RELATES_TO edges) for one or more
    Graphiti group_ids, as a node graph. Each scope path is its own group_id, so
    isolation is at the graph level — no edge-level scope filtering needed.

    `group_ids` may be a single scope or a list (for org-root aggregation across all
    scope graphs). Without a `query`, the window is every connected entity in those
    groups, with the edges leaving each one. With a `query`, the window holds only
    the entities whose name, or one of whose facts, contains it (case-insensitive,
    a plain substring match, no model), with the edges on both sides of each one, so
    a fact can be found in a scope holding more entities than one page. Either way
    the window is capped at `limit` entities and an edge is returned only when it and
    both its ends are in `group_ids`. A blank query is no query.

    The node window is ordered by uuid before the cap is applied, so two reads of
    an unchanged scope return the same `limit` nodes in the same order — without
    it, `WITH n LIMIT` takes whatever order the query planner happens to produce,
    which is not guaranteed stable between calls. A caller that treats a fixed-size
    prefix of this result as "the scope's current facts" (services/facts/
    conflicts.ts findScopeContradictions) depends on that window not
    drifting between views for reasons unrelated to what actually changed.

    Returns (nodes: dict[uuid -> {name,type}], edges: list[{uuid,source,target,...}]).
    """
    await client.get_graphiti()  # ensure the engine/driver are initialized
    needle = (query or "").strip().lower()
    if needle:
        cypher = _GRAPH_WINDOW_MATCHING + _GRAPH_EDGES_BOTH_WAYS
    else:
        cypher = _GRAPH_WINDOW_ALL + _GRAPH_EDGES_OUTGOING

    async def _fetch(session):
        result = await session.run(cypher, gids=group_ids, limit=limit, needle=needle)
        return [rec async for rec in result]

    nodes, edges = _graph_from_rows(await client._run_with_retry(_fetch))
    if len(group_ids) > 1:
        return _merge_same_named_entities(nodes, edges)
    return nodes, edges


def _entity_type(labels: list[str]) -> str:
    """The type /graph shows for an entity: its first label other than `Entity`."""
    rest = [label for label in (labels or []) if label != "Entity"]
    return rest[0] if rest else "Entity"


def _actor_of(source_description: str | None) -> tuple[object, object]:
    """(actor_type, actor_name) from an edge's own provenance stamp, each None when unset
    or when the stamp does not parse."""
    try:
        src = json.loads(source_description or "{}")
        return src.get("actor_type"), src.get("actor_name")
    except Exception:
        return None, None


def _graph_from_rows(rows) -> tuple[dict[str, dict], list[dict]]:
    """The nodes and edges of the /graph query's rows, each node and edge once."""
    nodes: dict[str, dict] = {}
    edges: list[dict] = []
    returned_edges: set[str] = set()
    for rec in rows:
        n_uuid = rec["n_uuid"]
        m_uuid = rec["m_uuid"]
        r_uuid = rec["r_uuid"]

        if n_uuid and n_uuid not in nodes:
            nodes[n_uuid] = {"name": rec["n_name"] or "", "type": _entity_type(rec["n_labels"])}
        if m_uuid and m_uuid not in nodes:
            nodes[m_uuid] = {"name": rec["m_name"] or "", "type": _entity_type(rec["m_labels"])}

        # Read both ways, an edge between two matched entities comes back twice.
        if r_uuid and n_uuid and m_uuid and r_uuid not in returned_edges:
            returned_edges.add(r_uuid)
            source, target = (n_uuid, m_uuid) if rec["r_leaves_n"] else (m_uuid, n_uuid)
            actor_type, actor_name = _actor_of(rec["r_source_desc"])
            edges.append(
                {
                    "uuid": r_uuid,
                    "source": source,
                    "target": target,
                    "fact": rec["r_fact"] or "",
                    "valid_at": _iso(rec["r_valid_at"]),
                    "invalid_at": _iso(rec["r_invalid_at"]),
                    "expired_at": _iso(rec["r_expired_at"]),
                    "actor_type": actor_type,
                    "actor_name": actor_name,
                    "group_id": rec["r_group_id"],
                }
            )
    return nodes, edges


def _dedup_key(name: str) -> str:
    """An entity name normalised for deduplication: lowercase, leading article
    stripped, outer whitespace trimmed. "The Sales Team" == "sales team"."""
    return re.sub(r"^(the|a|an)\s+", "", name.strip().lower()).strip()


def _merge_same_named_entities(
    nodes: dict[str, dict], edges: list[dict]
) -> tuple[dict[str, dict], list[dict]]:
    """When aggregating multiple group_ids (org-root view), the same real-world entity
    may exist in several scope graphs with different UUIDs. Deduplicate by normalised
    name: keep the first-seen UUID, remap all edges that reference a duplicate to the
    canonical UUID so the graph stays connected."""
    name_to_uuid: dict[str, str] = {}
    remap: dict[str, str] = {}
    for uuid, node in list(nodes.items()):
        key = _dedup_key(node["name"])
        if key in name_to_uuid:
            remap[uuid] = name_to_uuid[key]
        else:
            name_to_uuid[key] = uuid
    if not remap:
        return nodes, edges
    # Drop duplicate nodes.
    for dup_uuid in remap:
        nodes.pop(dup_uuid, None)
    # Remap edges that reference a duplicate node UUID.
    deduped_edges: list[dict] = []
    seen_edges: set[str] = set()
    for e in edges:
        src = remap.get(e["source"], e["source"])
        tgt = remap.get(e["target"], e["target"])
        if src == tgt:
            continue  # self-loop after merge — drop
        key = f"{src}:{tgt}:{e['fact']}"
        if key in seen_edges:
            continue  # duplicate edge after merge — drop
        seen_edges.add(key)
        deduped_edges.append({**e, "source": src, "target": tgt})
    return nodes, deduped_edges


async def fetch_edge_provenance(uuids: list[str]) -> dict[str, dict[str, object]]:
    """Stamped provenance for a set of RELATES_TO edges, by uuid: `actor_type`
    ("human" | "agent" | "extraction", for GuardedMemoryStore's ranking),
    `actor_name`, `source_id` (the connected source that ingested the fact, so a
    caller can cite it), `chunk_ids` (the caller's stored row for every
    episode asserting the fact, so the caller can tell a current version of a
    fact from one a later write superseded), and `episode_ids` (the episodes
    asserting the fact, so the caller can name the item a fact came from: a
    connector sync writes one episode per item, and its change event names it).

    `chunk_ids` collects every episode's stamp rather than the first, because an
    edge several ingests asserted is current while any one of them is. A caller
    that hid it on the first stamp alone would lose a fact a current episode
    still asserts.

    ingest() stamps the provenance JSON as `source_description` on the episode
    it writes. Graphiti copies it nowhere else: an edge its extractor creates
    carries only `episodes`, the uuids of the episodes that asserted it. Only
    the fallback and verbatim edges `ensure_graph_visible` writes hold their own
    `source_description`. So an edge's own stamp is read first and, when it
    names no source, `source_id` falls back to the first of the edge's episodes,
    in the edge's own order, that does. `actor_type` and `actor_name` stay
    edge-only on purpose: `actor_type` drives GuardedMemoryStore's ranking, and
    this lookup exists for citation.

    One follow-up query keyed on the uuids search() already picked, not a second
    graph traversal. An episode is only read when it shares the edge's
    `group_id`. A field with no stamped or inherited value maps to None.
    `episode_ids` lists only those episodes, in the edge's own order, each once:
    an episode the edge names in another group, or one since deleted, is left
    out rather than echoed back."""
    if not uuids:
        return {}
    await client.get_graphiti()  # ensures the driver is initialized

    provenance: dict[str, dict[str, object]] = {}

    async def _fetch(session):
        result = await session.run(
            """
            MATCH ()-[r:RELATES_TO]->()
            WHERE r.uuid IN $uuids
            OPTIONAL MATCH (ep:Episodic)
            WHERE ep.uuid IN coalesce(r.episodes, []) AND ep.group_id = r.group_id
            RETURN r.uuid AS uuid, r.source_description AS source_description,
                   coalesce(r.episodes, []) AS episode_order,
                   collect([ep.uuid, ep.source_description]) AS episodes
            """,
            uuids=uuids,
        )
        async for rec in result:
            provenance[rec["uuid"]] = _edge_provenance(rec)

    await client._run_with_retry(_fetch)
    return provenance


def _edge_provenance(rec) -> dict[str, object]:
    """One edge's citation fields, from its own stamp and its in-group episodes'
    (`fetch_edge_provenance` has the rules)."""
    src = parse_provenance(rec["source_description"])
    episode_stamps = {uuid: desc for uuid, desc in rec["episodes"] if uuid}
    # The edge's own stamp first, then its episodes in the edge's own order.
    stamps = [src] + [
        parse_provenance(episode_stamps.get(episode_uuid)) for episode_uuid in rec["episode_order"]
    ]
    source_id = next((stamp.get("source_id") for stamp in stamps if stamp.get("source_id")), None)
    chunk_ids: list[str] = []
    for stamp in stamps:
        chunk_id = stamp.get("chunk_id")
        if isinstance(chunk_id, str) and chunk_id and chunk_id not in chunk_ids:
            chunk_ids.append(chunk_id)
    episode_ids: list[str] = []
    for episode_uuid in rec["episode_order"]:
        if episode_uuid in episode_stamps and episode_uuid not in episode_ids:
            episode_ids.append(episode_uuid)
    return {
        "actor_type": src.get("actor_type"),
        "actor_name": src.get("actor_name"),
        "source_id": source_id or None,
        "chunk_ids": chunk_ids,
        "episode_ids": episode_ids,
    }


async def find_fact(group_id: str, uuid: str):
    """Look up one RELATES_TO fact edge by uuid within a single group_id.

    Mirrors `remove_fact`'s MATCH predicate exactly (endpoints and edge all
    carrying `group_id`) so "found" here means the same edge that predicate
    would act on, no more and no less. Existence only: a caller asking about an
    edge stored in a different group gets the same answer as one asking about a
    uuid that does not exist anywhere, so this cannot be used to probe across
    the group boundary.

    Used server-side to resolve a caller-supplied fact uuid against the scope
    the caller is actually authorized for, before a write that references it —
    see willder's services/facts/provenance.ts.

    Returns (uuid, fact, invalid_at, expired_at) or None if no such edge exists
    in this group. The last two are Graphiti's retirement marks, as on `Fact`,
    each None while unset: an edge's text never changes, so they are the only
    way a caller can tell a fact it quoted is no longer current.
    """
    if not group_id or not group_id.strip():
        return None
    await client.get_graphiti()

    async def _find(session):
        result = await session.run(
            """
            MATCH (:Entity {group_id: $group_id})
                  -[r:RELATES_TO {uuid: $uuid, group_id: $group_id}]->
                  (:Entity {group_id: $group_id})
            RETURN r.uuid AS uuid, r.fact AS fact,
                   r.invalid_at AS invalid_at, r.expired_at AS expired_at
            LIMIT 1
            """,
            uuid=uuid,
            group_id=group_id,
        )
        return await result.single()

    rec = await client._run_with_retry(_find)
    if rec is None:
        return None
    return rec["uuid"], rec["fact"] or "", _iso(rec["invalid_at"]), _iso(rec["expired_at"])
