"""The graph partitions (Graphiti group ids) of one org, the one place this service
names them.

The app names every partition with `toGid` (services/memory/graphiti-store.ts): an org's
bare id, its root scope `org_<id>`, and each scope under the root as the root followed by
a dash and the rest of the path's encoding. Org ids are [A-Za-z0-9_] (`ORG_ID_PATTERN`),
so the root keeps its name, and no other org's partition starts with `org_<id>-`.
"""


def org_groups(org_id: str) -> dict[str, str]:
    """The bare id, the root scope's group id, and the prefix of every scope's under it."""
    return {"org_id": org_id, "root": f"org_{org_id}", "root_prefix": f"org_{org_id}-"}
