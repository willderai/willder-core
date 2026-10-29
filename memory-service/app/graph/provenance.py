"""The provenance stamp ingest() writes as a record's `source_description`, read back."""

import json


def parse_provenance(source_description: str | None) -> dict:
    """The provenance JSON ingest() stamps, or {} when absent or unparseable."""
    try:
        parsed = json.loads(source_description or "{}")
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def has_retirement_stamp(source_description: str | None) -> bool:
    """Whether a record's own provenance names something a retirement is keyed on,
    a connected source or a stored fact, so deleting that thing can still match it."""
    stamp = parse_provenance(source_description)
    return bool(stamp.get("source_id") or stamp.get("chunk_id"))
