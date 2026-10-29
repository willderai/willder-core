"""Request/response models for the memory service HTTP API.

These mirror the TS `MemoryStore` contract in services/memory/. Keep them in
sync. `group_id` is the tenant namespace (= Neon orgId), enforced for isolation.
"""

import re
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from .name_fold import fold_name
from .partitions import org_groups


class IngestRequest(BaseModel):
    group_id: str
    content: str
    source: str = "message"
    name: str | None = None
    reference_time: str | None = None  # ISO-8601; defaults to now in the service
    # Provenance — stamped onto the episode (source_description + episode_metadata).
    actor_type: str = "extraction"  # "human" | "agent" | "extraction"
    actor_id: str
    actor_name: str | None = None
    # Scope tag (ltree path). Stamped into episode metadata; entities inherit it.
    scope_path: str | None = None
    # The connector Source.id, when this episode came from a connector sync. Stamped into
    # source_description alongside the other provenance fields so a later
    # DELETE /groups/{group_id}?source_id=... can purge just this source's
    # own edges out of a scope it shares with another producer. None for
    # chat/manual/upload content.
    source_id: str | None = None
    # The willder `memory_chunks` row the caller already stored this content as. Stamped
    # into source_description with the rest of the provenance, returned on every fact the
    # episode produces (`Fact.chunk_ids`), and used by the caller to tell a current
    # version of a fact from one a later write superseded. None when the caller stored no
    # chunk for this episode.
    chunk_id: str | None = None
    # What kind of record `content` is, when the caller already knows. "decision"
    # stores `content` verbatim as a Decision fact next to whatever the extractor
    # derives from it, so the decision reads back word for word. "document" (a
    # connected source's item) stores verbatim each passage stating a number the
    # extracted facts dropped. None for everything else.
    record_type: Literal["decision", "document"] | None = None
    # The line that names a connected source's item, as the caller's change feed titles it:
    # "Document docs/setup.md in acme/app (<link>)". Extraction keeps what an item says and
    # drops what it is called, so with record_type "document" the heading is also stored in
    # its own words, and the item can be found by its name. None when the item has no such line.
    heading: str | None = Field(default=None, max_length=1000)


class IngestResponse(BaseModel):
    episode_id: str


class SearchRequest(BaseModel):
    group_id: str
    # More groups searched in the same request, beside `group_id`: a reader granted a
    # scope reads every scope below it, and each scope is its own group.
    group_ids: list[str] = Field(default_factory=list)
    query: str
    limit: int = 10


class Fact(BaseModel):
    uuid: str
    fact: str
    valid_at: str | None = None
    # Graphiti's own retirement of the edge, as on `GraphEdge`: unset while it is in force.
    invalid_at: str | None = None
    expired_at: str | None = None
    actor_type: str | None = None  # "human" | "agent" | "extraction" — provenance ranking tier
    actor_name: str | None = (
        None  # who asserted it; a connector stamps its source's display name here
    )
    source_id: str | None = None  # the connected source that ingested it, for citation
    # The `chunk_id` of every episode that asserts this fact, in the edge's own episode
    # order. Empty when no episode behind it carried one (episodes written before the
    # stamp existed). The caller hides a fact only when every chunk behind it was
    # superseded, so a fact one current episode still asserts keeps answering.
    chunk_ids: list[str] = Field(default_factory=list)
    # The episodes in this fact's group recorded on the edge, in its own episode order. A
    # connector sync writes one episode per synced item and names it on the item's change
    # event, so each is an item that states the fact. Not necessarily every one: a bulk
    # ingest can merge a restatement into an existing edge without recording its episode.
    episode_ids: list[str] = Field(default_factory=list)
    # The group the edge is stored in. A search over several groups answers from all of
    # them, and the caller needs each fact's own scope.
    group_id: str | None = None


class ResolveFactResponse(BaseModel):
    """Whether one fact edge exists by uuid within a single group_id, plus the
    fact text and whether it is still in force when it does — deliberately not
    the full Fact shape: the callers (willder's provenance write path and its
    brief-citation check) need to know the edge is real, in this group and
    current, not to read its provenance metadata.

    A miss is `found: false` on HTTP 200, never a 404, so the caller can tell it
    apart from the 404/405 a memory service without this route answers."""

    found: bool
    uuid: str | None = None
    fact: str | None = None
    # Graphiti's retirement marks, as on `Fact`: unset while the edge is in force.
    invalid_at: str | None = None
    expired_at: str | None = None
    # The edge's stamps, as on `Fact`: the stored rows, connected source and episodes
    # behind it, so the caller can check a stored source still stands behind the text.
    chunk_ids: list[str] = Field(default_factory=list)
    source_id: str | None = None
    episode_ids: list[str] = Field(default_factory=list)


class SearchResponse(BaseModel):
    facts: list[Fact]
    # How many distinct groups were searched. A caller that asked for several checks
    # this, so a service that ignored `group_ids` cannot pass for one that read them.
    groups_searched: int


class EntityResponse(BaseModel):
    uuid: str
    name: str
    type: str
    summary: str
    facts: list[Fact]


class EntityLookupRequest(BaseModel):
    uuid: str
    group_ids: list[str] = Field(min_length=1)


class EntityLookupResponse(BaseModel):
    """A miss is `entity: null` on HTTP 200, never a 404, so the caller can tell it
    apart from the 404 a memory service without this route answers."""

    entity: EntityResponse | None = None
    # The group the entity was found in.
    group_id: str | None = None


class EntityGroupsRequest(BaseModel):
    name: str
    group_ids: list[str] = Field(min_length=1)


class EntityGroupsResponse(BaseModel):
    group_ids: list[str]


class FindEntityResponse(BaseModel):
    # uuid is optional: transferEntity's own
    # MERGE clauses can create a replacement Entity node with only name +
    # group_id set, no uuid. A later merge naming that replacement as fromName
    # would otherwise fail FastAPI's response validation on a required str
    # before the caller's merge authorization ever runs. The TS resolver
    # (services/memory/entity-scope.ts) only checks this response for
    # existence, never reads uuid.
    uuid: str | None = None
    type: str


class GraphRequest(BaseModel):
    group_ids: list[str]
    query: str | None = None
    limit: int = 50


class GraphNode(BaseModel):
    uuid: str
    name: str
    type: str


class GraphEdge(BaseModel):
    uuid: str
    source: str  # source entity uuid
    target: str  # target entity uuid
    fact: str
    valid_at: str | None = None
    # How Graphiti retires an edge a newer one contradicts: `invalid_at` is when the
    # fact stopped being true, `expired_at` when the graph recorded that. Graphiti sets
    # `expired_at` whenever it records an `invalid_at`, a future one included, so an
    # edge is no longer current once its `invalid_at` has passed, or, with no
    # `invalid_at`, once `expired_at` is set.
    invalid_at: str | None = None
    expired_at: str | None = None
    actor_type: str | None = None  # "human" | "agent" | "extraction"
    actor_name: str | None = None
    group_id: str | None = None  # the Graphiti group the edge is stored in
    # The `chunk_id` of every episode that asserts this edge, as on `Fact.chunk_ids`.
    chunk_ids: list[str] = Field(default_factory=list)
    # The connected source that ingested it and the episodes asserting it, as on `Fact`.
    source_id: str | None = None
    episode_ids: list[str] = Field(default_factory=list)


class GraphResponse(BaseModel):
    nodes: list[GraphNode]
    edges: list[GraphEdge]


class RemoveResponse(BaseModel):
    removed: bool


class RemoveGroupResponse(BaseModel):
    """Purging a whole group_id (a disconnected/deleted source's scope) has no
    "not found" case the way one fact/episode id does — zero facts removed is
    a normal outcome (a freshly-connected source with nothing synced yet), so
    this always reports a count on 200 rather than 404ing like RemoveResponse
    callers can.

    `removed_count` is the facts (RELATES_TO edges) removed. A source-scoped
    purge also reports the other graph records that source left behind, which
    a whole-group purge leaves at 0 (see `remove_group_facts`)."""

    removed_count: int
    removed_episodes: int = 0
    removed_verbatim_nodes: int = 0
    removed_entities: int = 0
    cleared_summaries: int = 0


class ChunkRetirementResponse(RemoveGroupResponse):
    """A chunk retirement also names the episodes it retired (`removed_episode_ids`), so
    the app can drop the connector records that point at them: a record left pointing
    at a retired episode would make the next sync of its file fail on retiring it."""

    removed_episode_ids: list[str] = Field(default_factory=list)


class GroupResidueRequest(BaseModel):
    group_id: str = Field(min_length=1)


class GroupResidueResponse(BaseModel):
    """What one group_id still holds. Zero in both means the group is empty."""

    facts: int
    episodes: int


class UnstampedFileEpisodesRequest(BaseModel):
    """One page of a group's file episodes that carry no chunk stamp, in uuid order.

    `salt` is the caller's own random value for this run, hashed in front of every value
    the page names (see `UnstampedFileEpisode`), so a digest means nothing outside the run:
    a short passage or a filename cannot be found by hashing guesses against a page kept
    somewhere."""

    group_id: str = Field(min_length=1)
    salt: str = Field(min_length=16, max_length=128)
    # The last uuid of the previous page; omitted for the first.
    after: str | None = None
    limit: int = Field(default=200, ge=1, le=500)


class UnstampedFileEpisode(BaseModel):
    """A file episode as the backfill matches it: never its text or its name, only salted
    digests of them.

    `content_digest` is the hex SHA-256 of `salt + ":" + body` as UTF-8; the body is the
    passage text the app stored as a `memory_chunks` row. `file_name_digest` is the same
    over the filename the episode is named for (`notes.pdf` for `notes.pdf (part 2/5)`).
    `pending_retirement` marks an episode an earlier run stamped as an orphan and did not
    get to retire."""

    uuid: str
    content_digest: str
    file_name_digest: str
    pending_retirement: bool


class UnstampedFileEpisodesResponse(BaseModel):
    episodes: list[UnstampedFileEpisode]
    # How many episodes of the group this page read, listed or not.
    scanned: int
    # Pass as `after` for the next page; null once the group is read through.
    next_after: str | None


class StampEpisodeChunkRequest(BaseModel):
    group_id: str = Field(min_length=1)
    episode_uuid: str = Field(min_length=1)
    chunk_id: str = Field(min_length=1, max_length=200)


class StampEpisodeChunkResponse(BaseModel):
    """`stamped`: the stamp was written. `already`: it already carried this one.
    `refused`: it is not an unstamped file episode (another stamp, a source, or not a
    document), so nothing was written. `missing`: no such episode in the group."""

    outcome: Literal["stamped", "already", "refused", "missing"]


# --- Identifiers shared by the org-wide routes below ---

# A cuid or another single ltree-safe label: never a dotted or dashed path.
ORG_ID_PATTERN = r"^[A-Za-z0-9_]{1,64}$"


# --- What one connected source left in the graph ---


class OrgGraphRequest(BaseModel):
    """One whole org, for its deletion. The bare id, never a scope path: the service
    derives the org's partitions from it (the id, `org_<id>` and every scope under it)."""

    org_id: str = Field(pattern=ORG_ID_PATTERN)

    @field_validator("org_id")
    @classmethod
    def _not_a_root(cls, value: str) -> str:
        # An id spelled like a root scope would make the org's bare partition the root
        # of another org, `org_<x>`, and purging it would reach into that org.
        if value.startswith("org_"):
            raise ValueError("org_id is the bare org id, not its root scope")
        return value


class OrgGraphCounts(BaseModel):
    """Counts only: nodes and relationships in one org's partitions."""

    nodes: int
    relationships: int


class SourceRecordsRequest(BaseModel):
    """One source of one org. `group_ids` are scopes to look for orphans in; the
    source's own records are found by its stamp in every scope of the org."""

    org_id: str = Field(pattern=ORG_ID_PATTERN)
    source_id: str = Field(min_length=1, max_length=64)
    group_ids: list[str] = Field(min_length=1, max_length=50)

    @model_validator(mode="after")
    def _groups_in_org(self) -> "SourceRecordsRequest":
        org = org_groups(self.org_id)
        root = org["root"]
        if any(
            g not in (self.org_id, root) and not g.startswith(org["root_prefix"])
            for g in self.group_ids
        ):
            raise ValueError(f"every group_id must be {root} or a scope under it")
        return self


class SourceGroupRecords(BaseModel):
    """Counts only, for one scope (group_id). Never any of the records' text."""

    group_id: str
    episodes: int  # Episodic nodes stamped with the source
    facts: int  # RELATES_TO edges stamped with it or citing one of its episodes
    fact_embeddings: int  # those edges that carry a vector
    verbatim_nodes: int  # Fact, Decision and Passage nodes whose own edge is one of those facts
    orphans: int  # entities in this scope with no relationship at all
    dangling_facts: int  # unstamped facts in this scope whose listed episodes are all gone


class SourceRecordsResponse(BaseModel):
    """Every scope that was asked about or holds any of the source's records."""

    groups: list[SourceGroupRecords]


# --- Erasing one person ---


def _identifiers(values: list[str]) -> list[str]:
    """Collapse whitespace and fold as the app folds names and addresses (app/name_fold.py,
    fold_name), and refuse anything short enough to match by accident."""
    cleaned = [fold_name(" ".join(v.split())) for v in values]
    if any(len(v) < 3 for v in cleaned):
        raise ValueError("every identifier must be at least 3 characters")
    return sorted(set(cleaned))


_EMAIL = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


class ErasePersonRequest(BaseModel):
    """One person to remove from every partition of one org. The caller resolves
    the person (from a contact, an email or an entity id) and has already
    authorized the request; this service only executes it."""

    org_id: str = Field(pattern=ORG_ID_PATTERN)
    emails: list[str] = Field(default_factory=list, max_length=50)
    names: list[str] = Field(default_factory=list, max_length=50)
    entity_uuids: list[str] = Field(default_factory=list, max_length=50)

    @field_validator("emails")
    @classmethod
    def _emails(cls, values: list[str]) -> list[str]:
        cleaned = _identifiers(values)
        if any(not _EMAIL.match(v) for v in cleaned):
            raise ValueError("every email must be a single address like name@example.com")
        return cleaned

    @field_validator("names")
    @classmethod
    def _names(cls, values: list[str]) -> list[str]:
        """The same rule as the app's (services/memory/person-erasure.ts, isDistinctiveName):
        one word names too many people to erase by."""
        cleaned = _identifiers(values)
        if any(len(v.split()) < 2 or len(v) < 5 for v in cleaned):
            raise ValueError(
                "every name must have at least two words and five characters; find a one-word name by email or entity id"
            )
        return cleaned

    @field_validator("entity_uuids")
    @classmethod
    def _uuids(cls, values: list[str]) -> list[str]:
        cleaned = [v.strip() for v in values]
        if any(not v or len(v) > 64 for v in cleaned):
            raise ValueError("entity uuids must be 1 to 64 characters")
        return sorted(set(cleaned))


class ErasePersonPlanResponse(BaseModel):
    """What an erasure of the same request would remove now. Nothing is changed."""

    episode_ids: list[str]  # uuids of the episodes it would erase


class ErasePersonResponse(BaseModel):
    """What one call removed. A second call for the same person reports zeros."""

    episodes: int  # Episodic nodes that named the person
    nodes: int  # the person's entity nodes, verbatim fact nodes naming them, and
    # entities only their erased episodes mentioned
    edges: int  # relationships removed, counted once each
    summaries: int  # other entities' summaries that quoted the person, now cleared
    episode_ids: list[str]  # uuids of the erased episodes, so connector records can drop them


# --- File extraction ---


class ExtractRequest(BaseModel):
    url: str  # publicly accessible URL (Vercel Blob)
    file_type: str  # "pdf" | "docx" | "image"
    filename: str = "file"  # original filename, used for labelling + MIME detection


class ExtractBytesRequest(BaseModel):
    content_b64: str  # base64-encoded file bytes (local dev fallback, no Blob)
    file_type: str  # "pdf" | "docx" | "image"
    filename: str = "file"


class ExtractResponse(BaseModel):
    chunks: list[str]  # text chunks ready for /ingest, one per add_episode call


class BulkIngestRequest(BaseModel):
    group_id: str
    episodes: list[IngestRequest]  # ordered list; processed as a batch


class BulkIngestResponse(BaseModel):
    episode_ids: list[str]


# --- Entity transfer (org-role change) ---


class TransferEntityRequest(BaseModel):
    group_id: str
    old_name: str  # canonical name of the entity being replaced
    new_name: str  # canonical name to connect the edges to instead


class TransferEntityResponse(BaseModel):
    transferred: int  # number of edges invalidated and recreated


# --- BGE embedding passthrough (for pgvector store) ---


class EmbedRequest(BaseModel):
    text: str


class EmbedResponse(BaseModel):
    embedding: list[float]  # 384-dim BGE-small vector, L2-normalized


# The most texts one /embed-batch request may carry, so one request holds the model for
# one short encode and a read waiting behind it waits for no more than that.
EMBED_BATCH_MAX_TEXTS = 64


class EmbedBatchRequest(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=EMBED_BATCH_MAX_TEXTS)


class EmbedBatchResponse(BaseModel):
    embeddings: list[list[float]]  # one per text, in request order
