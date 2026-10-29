"""The backfill that stamps old file episodes: an uploaded file's passage ingested
before the app stamped each episode with its stored fact (`chunk_id`) cannot be retired
when that fact is deleted. The app lists those episodes here and stamps each one."""

import hashlib
import json
import re

from .. import graphiti_client as client
from .provenance import parse_provenance


# The chunk stamp the app's W3c backfill gives a file episode whose passage is gone, so
# the chunk retirement (`remove_chunk_facts`) can retire it like any deleted fact's.
ORPHAN_CHUNK_PREFIX = "w3c-orphan:"


def _is_unstamped_file_episode(provenance: dict) -> bool:
    """A document episode ingest wrote for no connector source and with no chunk stamp:
    an uploaded file's passage from before the app stamped them, or one an earlier
    backfill run marked as an orphan and did not get to retire."""
    if provenance.get("source") != "document" or provenance.get("source_id"):
        return False
    chunk_id = provenance.get("chunk_id")
    return not chunk_id or str(chunk_id).startswith(ORPHAN_CHUNK_PREFIX)


_PART_NAME = re.compile(r"^(.*) \(part \d+/\d+\)$", re.DOTALL)


def _file_name_of_episode(name: str) -> str:
    """The filename a file episode is named for: `notes.pdf` for `notes.pdf (part 2/5)`."""
    part = _PART_NAME.match(name)
    return part.group(1) if part else name


def _salted_digest(salt: str, value: str) -> str:
    return hashlib.sha256(f"{salt}:{value}".encode("utf-8")).hexdigest()


async def list_unstamped_file_episodes(
    group_id: str, after: str | None, limit: int, salt: str
) -> dict:
    """One page of `group_id`'s episodes, in uuid order after `after`, keeping the
    unstamped file episodes among them. Read-only. An episode's text and name never leave
    the service: each is named by its uuid and salted digests of its body and filename."""
    await client.get_graphiti()

    async def _read(session):
        result = await session.run(
            """
            MATCH (ep:Episodic)
            WHERE ep.group_id = $group_id AND ($after IS NULL OR ep.uuid > $after)
            RETURN ep.uuid AS uuid, ep.name AS name, ep.content AS content,
                   ep.source_description AS source_description
            ORDER BY ep.uuid
            LIMIT $limit
            """,
            group_id=group_id,
            after=after,
            limit=limit,
        )
        return [rec async for rec in result]

    records = await client._run_with_retry(_read, default_access_mode="READ")
    episodes = []
    for rec in records:
        provenance = parse_provenance(rec["source_description"])
        if not _is_unstamped_file_episode(provenance):
            continue
        episodes.append(
            {
                "uuid": rec["uuid"],
                "content_digest": _salted_digest(salt, rec["content"] or ""),
                "file_name_digest": _salted_digest(salt, _file_name_of_episode(rec["name"] or "")),
                "pending_retirement": bool(provenance.get("chunk_id")),
            }
        )
    next_after = records[-1]["uuid"] if len(records) == limit else None
    return {"episodes": episodes, "scanned": len(records), "next_after": next_after}


async def stamp_episode_chunk(group_id: str, episode_uuid: str, chunk_id: str) -> str:
    """Write `chunk_id` into one unstamped file episode's provenance, as ingest would
    have, so the chunk retirement finds it. Only an episode `list_unstamped_file_episodes`
    lists is stamped; one already carrying this stamp is left as it is, so a rerun is a
    no-op. The write is conditional on the provenance it read, so a concurrent change
    makes it refuse rather than overwrite."""
    await client.get_graphiti()

    async def _stamp(tx):
        rec = await (
            await tx.run(
                "MATCH (ep:Episodic {uuid: $uuid}) WHERE ep.group_id = $group_id "
                "RETURN ep.source_description AS source_description",
                uuid=episode_uuid,
                group_id=group_id,
            )
        ).single()
        if rec is None:
            return "missing"
        provenance = parse_provenance(rec["source_description"])
        if provenance.get("chunk_id") == chunk_id:
            return "already"
        if not _is_unstamped_file_episode(provenance):
            return "refused"
        provenance["chunk_id"] = chunk_id
        written = await (
            await tx.run(
                "MATCH (ep:Episodic {uuid: $uuid}) "
                "WHERE ep.group_id = $group_id AND ep.source_description = $old "
                "SET ep.source_description = $new RETURN count(ep) AS n",
                uuid=episode_uuid,
                group_id=group_id,
                old=rec["source_description"],
                new=json.dumps(provenance),
            )
        ).single()
        return "stamped" if written["n"] == 1 else "refused"

    async def _run(session):
        return await session.execute_write(_stamp)

    return await client._run_with_retry(_run)
