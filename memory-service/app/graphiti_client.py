"""Neo4j + Graphiti wiring (the memory engine).

- LLM (extraction / graph ops): any OpenAI-compatible chat endpoint
  (settings.llm_base_url, OpenAI by default) through QuotaAwareLLMClient, which fails
  fast when the provider's quota is used up.
- Embeddings: BGE, local on CPU (free, data stays in-service).
- Reranking: none. search_edges fuses BM25 and cosine by reciprocal rank. Graphiti
  still requires a cross-encoder client, so it gets UnusedCrossEncoder, which loads
  no model and never reaches a hosted reranker.

EMBEDDING_DIM must be set before importing graphiti_core (it's read at import and
drives the Neo4j vector index dimension). We force it to the BGE model's dim so the
index matches the embedder — a mismatch silently breaks vector search.

This module owns the connections: the raw Neo4j driver, the Graphiti engine, and
the retry rules around both. The graph operations live in `app/graph/`, one module
per concern, and are re-exported at the bottom of this file, so `graphiti_client`
stays the one import surface for main.py and the tests:

- `graph/search.py`: hybrid edge search over many groups;
- `graph/facts.py`: the /graph view, fact provenance, one fact by uuid;
- `graph/entities.py`: entity lookups, entity removal, role transfers;
- `graph/retirement.py`: removing facts, and what a source or stored fact left behind;
- `graph/file_episode_stamps.py`: the backfill that stamps old file episodes;
- `graph/residue.py`: what a group or a source still holds;
- `graph/org_graph.py`: an org's partitions, its purge and count;
- `graph/erasure.py` and `graph/name_patterns.py`: erasing one person;
- `graph/visibility.py`: the fallback node and edge that keep a fact graph-visible.

Those modules reach the connection state through this module's attributes
(`client.get_driver()`, `client._run_with_retry(...)`, `client._graph_driver`), never
by importing the names: a reset rebinds `_driver` and `_graph_driver`, and every
caller must see the replacement.
"""

import os

from .config import settings
from .lab_guard import connectable_neo4j_uri

os.environ["EMBEDDING_DIM"] = str(settings.bge_dim)

import asyncio  # noqa: E402
import logging  # noqa: E402

from neo4j import AsyncDriver, AsyncGraphDatabase  # noqa: E402
from neo4j.exceptions import (  # noqa: E402
    ConnectionAcquisitionTimeoutError,
    DriverError,
    ServiceUnavailable,
    SessionExpired,
)

logger = logging.getLogger(__name__)
from sentence_transformers import SentenceTransformer  # noqa: E402

from graphiti_core import Graphiti  # noqa: E402
from graphiti_core.driver.neo4j_driver import Neo4jDriver  # noqa: E402
from graphiti_core.cross_encoder.client import CrossEncoderClient  # noqa: E402
from graphiti_core.embedder.client import EmbedderClient, EmbedderConfig  # noqa: E402
from graphiti_core.llm_client import LLMConfig  # noqa: E402
from graphiti_core.llm_client.errors import RateLimitError as GraphitiRateLimitError  # noqa: E402
from openai import AsyncOpenAI  # noqa: E402
from graphiti_core.llm_client.openai_generic_client import OpenAIGenericClient  # noqa: E402

from .extraction_status import ExtractionQuotaExhausted, is_quota_refusal  # noqa: E402
from .model_work import ModelQueue  # noqa: E402


class ModelProviderClient(AsyncOpenAI):
    """The OpenAI SDK client, except that it never retries a 429 itself.

    The SDK asks again twice on every 429, a used-up quota included (three calls, not one).
    Graphiti retries rate limits with its own backoff, and QuotaAwareLLMClient stops it for
    a quota refusal, so one layer decides. Timeouts and server errors keep the SDK's retries.
    """

    def _should_retry(self, response) -> bool:
        if response.status_code == 429:
            return False
        return super()._should_retry(response)


class QuotaAwareLLMClient(OpenAIGenericClient):
    """Graphiti's OpenAI-compatible client, except that a quota refusal is not retried.

    Graphiti turns every provider 429 into its RateLimitError and retries it four times
    with backoff, about 45 s in all. That suits a rate limit, which clears; a used-up
    quota or spend limit does not, so the ingest still fails, after the caller's own
    timeout. This client raises ExtractionQuotaExhausted for a quota refusal instead,
    which Graphiti does not retry."""

    async def _generate_response(self, *args, **kwargs):
        try:
            return await super()._generate_response(*args, **kwargs)
        except GraphitiRateLimitError as exc:
            if is_quota_refusal(exc.__cause__):
                raise ExtractionQuotaExhausted() from exc.__cause__
            raise


class BGEEmbedder(EmbedderClient):
    """Local BGE embeddings via sentence-transformers, normalized for cosine similarity.
    Lazy-loaded. Every encode goes through `models` (app/model_work.py), never straight
    to a thread of its own."""

    def __init__(self, model_name: str, dim: int):
        self.config = EmbedderConfig(embedding_dim=dim)
        self._model_name = model_name
        self._model: SentenceTransformer | None = None
        self.models = ModelQueue(self._encode)

    def _ensure(self) -> SentenceTransformer:
        if self._model is None:
            self._model = SentenceTransformer(self._model_name)
        return self._model

    def _encode(self, texts: list[str]) -> list[list[float]]:
        return [v.tolist() for v in self._ensure().encode(texts, normalize_embeddings=True)]

    async def create(self, input_data):
        text = input_data if isinstance(input_data, str) else " ".join(map(str, input_data))
        return await self.models.encode(text)

    async def create_batch(self, input_data_list):
        texts = list(input_data_list)
        return await self.models.call(lambda: self._encode(texts))


class UnusedCrossEncoder(CrossEncoderClient):
    """The cross-encoder slot Graphiti requires, filled with nothing to run.

    This service reranks nothing: search_edges uses EDGE_HYBRID_SEARCH_RRF. Graphiti
    replaces a missing cross-encoder with OpenAIRerankerClient, a hosted paid call, and
    a local BGE reranker costs about 2.3 GB of memory. This client loads no model, and
    `rank` raises, so a search recipe that starts reranking fails loudly instead of
    quietly calling out or loading weights.
    """

    async def rank(self, query: str, passages: list[str]) -> list[tuple[str, float]]:
        raise RuntimeError(
            "no cross-encoder is configured: search_edges fuses results by reciprocal rank"
        )


# Errors that mean the connection to Neo4j is gone, not that the query was wrong or
# that Neo4j is busy: a defunct connection AuraDB already closed. Only these reset a
# shared driver or engine, and every caller that sees one retries once.
CONNECTION_LOST_ERRORS = (ServiceUnavailable, SessionExpired)

# Errors that mean the pool is busy: no connection came free within the acquisition
# timeout because other requests hold them all. Resetting the shared driver for one of
# these closes every other request's connections mid-query and multiplies the load,
# which is how the 2026-10-10 search burst hung this service. The request is answered
# 503 once the acquisition timeout has passed, and nothing is reset.
#
# The cost of that choice: acquisition can also time out on a half-open idle connection
# (the network dropped it without a reset, so the liveness check waits instead of
# failing). That connection is not evicted by a reset any more; it costs one request a
# 10 s wait and a 503, and the pool drops it when the check gives up or its lifetime ends.
OVERLOAD_ERRORS = (ConnectionAcquisitionTimeoutError,)


def driver_options() -> dict:
    """Pool settings shared by both Neo4j drivers. See the README's
    "Neo4j driver settings" for why each value is what it is."""
    return {
        "max_connection_lifetime": settings.neo4j_max_connection_lifetime_s,
        "connection_acquisition_timeout": settings.neo4j_connection_acquisition_timeout_s,
        "liveness_check_timeout": settings.neo4j_liveness_check_timeout_s,
        "keep_alive": settings.neo4j_keep_alive,
    }


def neo4j_uri() -> str:
    """The URI every Neo4j driver here is opened with, once app/lab_guard.py allows it: never
    empty, and in lab mode never another machine."""
    return connectable_neo4j_uri(settings.neo4j_uri, os.environ)


def open_driver() -> AsyncDriver:
    """A new neo4j driver for this service's database with the pool settings applied."""
    return AsyncGraphDatabase.driver(
        neo4j_uri(),
        auth=(settings.neo4j_username, settings.neo4j_password),
        **driver_options(),
    )


# --- raw Neo4j driver, used only by /health and direct Cypher queries ---
_driver: AsyncDriver | None = None


def get_driver() -> AsyncDriver:
    global _driver
    if _driver is None:
        _driver = open_driver()
    return _driver


async def _close_quietly(resource) -> None:
    """Close a driver or engine that is being replaced; a close that fails changes nothing."""
    try:
        await resource.close()
    except Exception:  # noqa: BLE001 — the resource is already being dropped
        pass


async def _reset_driver(seen: AsyncDriver) -> None:
    """Drop the raw driver `seen`, if it is still the current one, so the next
    get_driver() call opens a fresh one. Every caller that failed on the same dead
    driver asks to reset it; only the first does, and the rest find a new driver
    already in place and leave it alone."""
    global _driver
    if _driver is not seen:
        return
    _driver = None
    await _close_quietly(seen)


async def _run_with_retry(fn, **session_config):
    """Run fn(session) against the raw driver. On a lost connection, reset the driver
    and retry once: AuraDB drops idle connections, and this makes it self-healing. A
    busy pool (OVERLOAD_ERRORS) is raised at once, with nothing reset.

    `session_config` is passed to `driver.session()`, such as the retry budget of the
    managed transactions fn runs. A retry after a lost connection runs fn again, so fn
    must be safe to run twice: the commit may have landed before the connection went."""
    db = settings.neo4j_database or None
    for attempt in range(2):
        driver = get_driver()
        try:
            async with driver.session(database=db, **session_config) as session:
                return await fn(session)
        except OVERLOAD_ERRORS:
            raise
        except CONNECTION_LOST_ERRORS as exc:
            if attempt == 0:
                logger.warning("Neo4j connection lost, resetting driver and retrying: %s", exc)
                await _reset_driver(driver)
                continue
            raise
        except DriverError:
            # Another caller lost its connection and closed this driver under us
            # ("Driver closed"): retry once on the one that replaced it, resetting nothing.
            if attempt == 0 and _driver is not driver:
                continue
            raise


async def neo4j_healthy() -> bool:
    """Verify the raw driver can reach Neo4j. A lost connection closes the driver so
    the next caller opens a fresh pool instead of inheriting dead connections, and one
    retry on the fresh driver tells a stale pool apart from a database that is really
    down. Any other failure, a busy pool included, answers False and resets nothing."""
    for attempt in range(2):
        driver = get_driver()
        try:
            await driver.verify_connectivity()
            return True
        except CONNECTION_LOST_ERRORS as exc:
            logger.warning("Neo4j health check lost its connection, resetting driver: %s", exc)
            await _reset_driver(driver)
            if attempt == 0:
                continue
            return False
        except Exception as exc:  # noqa: BLE001 — a probe reports, it does not raise
            logger.warning("Neo4j health check failed: %s", exc)
            return False
    return False


# --- the Graphiti engine (lazy; indices built once) ---
_graphiti: Graphiti | None = None
_graph_driver: Neo4jDriver | None = None
_indices_built = False
# The one build of the engine in progress, shared by every caller that needs it.
_building: asyncio.Task | None = None
# The local embedding model. It holds no Neo4j connection, so a reset keeps it: a
# rebuild after every lost connection would otherwise load it again.
_embedder: "BGEEmbedder | None" = None


async def _reset_graphiti(seen: Graphiti | None) -> None:
    """Drop the engine `seen`, if it is still the current one, so the next call
    rebuilds it. Like `_reset_driver`, any number of callers that failed on one engine
    cause one reset."""
    global _graphiti, _indices_built
    if seen is None or _graphiti is not seen:
        return
    _graphiti = None
    _indices_built = False
    await _close_quietly(seen)


def engine_replaced(seen: Graphiti | None) -> bool:
    """Whether `seen` is no longer the current engine: a reset after another caller's
    lost connection closed it, so its queries fail with "Driver closed"."""
    return seen is not None and _graphiti is not seen


def local_embedder() -> "BGEEmbedder":
    """The embedder the engine uses, without the engine: embedding needs no Neo4j."""
    global _embedder
    if _embedder is None:
        _embedder = BGEEmbedder(settings.bge_model, settings.bge_dim)
    return _embedder


async def open_graph_driver() -> Neo4jDriver:
    """Graphiti's Neo4j driver, on a connection pool with this service's settings.

    Two things Graphiti's constructor does not let us set: the database (it hardcodes
    "neo4j", which doesn't exist on this AuraDB instance; an empty setting means the
    home database) and the pool options. graphiti-core 0.29.1's Neo4jDriver.__init__
    builds its own neo4j driver with library defaults and accepts no pool kwargs, so
    we put a driver built with ours in the `client` slot everything else in Graphiti
    reads from. The default one has opened no connection yet; closing it is bookkeeping.
    """
    driver = Neo4jDriver(
        neo4j_uri(),
        settings.neo4j_username,
        settings.neo4j_password,
        database=settings.neo4j_database or None,
    )
    unpooled = driver.client
    driver.client = open_driver()
    await unpooled.close()
    return driver


async def get_graphiti() -> Graphiti:
    """The Graphiti engine, built on first use and after a reset. Concurrent callers
    share one build: they all wait for it, and all get its error if it fails, so a
    burst of requests after a reset opens one pool and builds the indices once."""
    global _building
    if _graphiti is not None and _indices_built:
        return _graphiti
    if _building is None:
        _building = asyncio.ensure_future(_build_graphiti())
        _building.add_done_callback(_build_finished)
    # Shielded: a caller that gives up waiting must not cancel the build the others share.
    return await asyncio.shield(_building)


def _build_finished(task: asyncio.Task) -> None:
    global _building
    if _building is task:
        _building = None


async def _build_graphiti() -> Graphiti:
    global _graphiti, _graph_driver, _indices_built
    if _graphiti is None:
        # An OpenAI-compatible endpoint. The generic client uses real structured
        # outputs (json_schema), unlike Graphiti's GroqClient which only does
        # json_object mode and makes models parrot the schema, so the extraction
        # model MUST support json_schema. max_tokens is passed to
        # the constructor (it overrides config there); Groq caps scout at 8192.
        llm = QuotaAwareLLMClient(
            LLMConfig(
                api_key=settings.llm_api_key,
                base_url=settings.llm_base_url,
                model=settings.llm_model_extract,
                small_model=settings.llm_model_extract,
                temperature=0,
            ),
            max_tokens=8192,
            client=ModelProviderClient(
                api_key=settings.llm_api_key, base_url=settings.llm_base_url
            ),
        )
        driver = await open_graph_driver()
        _graph_driver = driver
        _graphiti = Graphiti(
            graph_driver=driver,
            llm_client=llm,
            embedder=local_embedder(),
            cross_encoder=UnusedCrossEncoder(),
        )
    if not _indices_built:
        await _graphiti.build_indices_and_constraints()
        await repair_transferred_entities()
        await ensure_one_fallback_anchor_per_scope()
        _indices_built = True
    return _graphiti


async def close_driver() -> None:
    global _driver
    if _driver is not None:
        await _driver.close()
        _driver = None


async def close_graphiti() -> None:
    global _graphiti, _indices_built
    if _graphiti is not None:
        try:
            await _graphiti.close()
        except Exception:  # noqa: BLE001 — best-effort on shutdown
            pass
        _graphiti = None
        _indices_built = False


# --- the graph operations, re-exported (see the module docstring) ---
# Imported last: each module reads the connection state above through this module, so
# it must be defined before they load. `_build_graphiti` calls the two repairs through
# these names, which is also where a test replaces them.
#
# The constants below (timeouts, batch sizes, retry delays) are copies: the code reads
# them in the module that owns them. To change one in a test, patch it there, e.g.
# `monkeypatch.setattr(retirement, "CHUNK_RETIREMENT_TIMEOUT_S", 1.0)` or
# `monkeypatch.setattr(visibility, "VISIBILITY_RETRY_SECONDS", 0.0)`. Setting it on
# `graphiti_client` changes nothing.
from .graph.entities import (  # noqa: E402
    find_entity_by_name,
    get_entity_with_facts,
    groups_holding_entity,
    remove_entity,
    repair_transferred_entities,
    transfer_entity_edges,
)
from .graph.erasure import PersonErasureBlocked, erase_person, plan_person_erasure  # noqa: E402
from .graph.facts import fetch_edge_provenance, find_fact, graph_for_group  # noqa: E402
from .graph.file_episode_stamps import (  # noqa: E402
    ORPHAN_CHUNK_PREFIX,
    list_unstamped_file_episodes,
    stamp_episode_chunk,
)
from .graph.org_graph import ORG_PURGE_BATCH, count_org_graph, purge_org_graph  # noqa: E402
from .graph.residue import SOURCE_RECORDS_TIMEOUT_S, count_group_residue, count_source_records  # noqa: E402
from .graph.retirement import (  # noqa: E402
    CHUNK_RETIREMENT_TIMEOUT_S,
    DEAD_EDGES_PER_RETIREMENT,
    remove_chunk_facts,
    remove_episode_facts,
    remove_fact,
    remove_group_facts,
)
from .graph.search import (  # noqa: E402
    MAX_SEARCH_BATCHES,
    SEARCH_BATCH_CONCURRENCY,
    group_batches,
    interleave,
    search_edges,
)
from .graph.visibility import (  # noqa: E402
    FALLBACK_ANCHOR_NAME,
    VERBATIM_NODE_LABELS,
    VISIBILITY_ATTEMPT_TIMEOUT_S,
    VISIBILITY_RETRY_SECONDS,
    GraphVisibilityError,
    ensure_graph_visible,
    ensure_one_fallback_anchor_per_scope,
)

# Older private names the tests still reach through this module.
from .graph.name_patterns import composed as _composed  # noqa: E402, F401
from .graph.search import _not_yet_ended  # noqa: E402, F401
from .graph.visibility import fallback_anchor_uuid as _fallback_anchor_uuid  # noqa: E402, F401

__all__ = [
    "BGEEmbedder",
    "CHUNK_RETIREMENT_TIMEOUT_S",
    "close_driver",
    "close_graphiti",
    "CONNECTION_LOST_ERRORS",
    "count_group_residue",
    "count_org_graph",
    "count_source_records",
    "DEAD_EDGES_PER_RETIREMENT",
    "driver_options",
    "engine_replaced",
    "ensure_graph_visible",
    "ensure_one_fallback_anchor_per_scope",
    "erase_person",
    "FALLBACK_ANCHOR_NAME",
    "fetch_edge_provenance",
    "find_entity_by_name",
    "find_fact",
    "get_driver",
    "get_entity_with_facts",
    "get_graphiti",
    "graph_for_group",
    "GraphVisibilityError",
    "group_batches",
    "groups_holding_entity",
    "interleave",
    "list_unstamped_file_episodes",
    "local_embedder",
    "MAX_SEARCH_BATCHES",
    "ModelProviderClient",
    "neo4j_healthy",
    "neo4j_uri",
    "open_driver",
    "open_graph_driver",
    "ORG_PURGE_BATCH",
    "ORPHAN_CHUNK_PREFIX",
    "OVERLOAD_ERRORS",
    "PersonErasureBlocked",
    "plan_person_erasure",
    "purge_org_graph",
    "QuotaAwareLLMClient",
    "remove_chunk_facts",
    "remove_entity",
    "remove_episode_facts",
    "remove_fact",
    "remove_group_facts",
    "repair_transferred_entities",
    "SEARCH_BATCH_CONCURRENCY",
    "search_edges",
    "SOURCE_RECORDS_TIMEOUT_S",
    "stamp_episode_chunk",
    "transfer_entity_edges",
    "UnusedCrossEncoder",
    "VERBATIM_NODE_LABELS",
    "VISIBILITY_ATTEMPT_TIMEOUT_S",
    "VISIBILITY_RETRY_SECONDS",
]
