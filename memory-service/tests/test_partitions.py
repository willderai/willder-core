"""An org's partitions, as the app names them with toGid (services/memory/graphiti-store.ts).

A scope whose label the app escapes (`eng-secrets` is `org_<id>--eng_2Dsecrets`) must stay
inside its org's prefix, so the org purge, residue and erasure predicates reach it and a
source-records request may name it, and must stay outside every other org's.
"""

import pytest
from pydantic import ValidationError

from app.partitions import org_groups
from app.schemas import SourceRecordsRequest

ESCAPED_CHILD = "org_a--eng_2Dsecrets"  # toGid("org_a.eng-secrets")


def test_an_escaped_scope_is_inside_its_own_org_and_no_other():
    assert ESCAPED_CHILD.startswith(org_groups("a")["root_prefix"])
    assert not ESCAPED_CHILD.startswith(org_groups("a_")["root_prefix"])
    assert not ESCAPED_CHILD.startswith(org_groups("b")["root_prefix"])


def test_a_source_records_request_names_an_escaped_scope_only_in_its_own_org():
    assert SourceRecordsRequest(org_id="a", source_id="s", group_ids=[ESCAPED_CHILD]).group_ids == [
        ESCAPED_CHILD
    ]
    with pytest.raises(ValidationError):
        SourceRecordsRequest(org_id="b", source_id="s", group_ids=[ESCAPED_CHILD])
