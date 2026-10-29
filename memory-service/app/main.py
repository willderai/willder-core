"""Willder memory service — FastAPI app.

The Node app's `MemoryStore` (services/memory/) is the only caller. Endpoints are
bearer-authed with GRAPHITI_SERVICE_API_KEY, except /health, which pings Neo4j and
reports whether graph extraction is working. /ingest writes episodes through Graphiti
(model extraction plus local BGE embedding); /search, /embed and /graph run locally
with no hosted model. A model-provider refusal answers 503 with Retry-After
(app/extraction_status.py), never 500.
"""

import hmac
import json
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import logging

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse
import asyncio

from neo4j.exceptions import DriverError, TransientError

from graphiti_core.nodes import EpisodeType
from graphiti_core.utils.datetime_utils import ensure_utc
from pydantic import BaseModel

from . import schemas
from .config import settings
from .extraction_status import extraction_status, refusal_error, refusal_kind
from .lab_guard import refuse_remote_in_lab_mode
from .model_work import background_priority
from .passages import MAX_VERBATIM_PASSAGES, passages, passages_with_dropped_numbers
from .watchdog import LoopWatchdog, exit_with_stacks
from .graphiti_client import (
    CONNECTION_LOST_ERRORS,
    OVERLOAD_ERRORS,
    _reset_graphiti,
    close_driver,
    engine_replaced,
    close_graphiti,
    count_group_residue,
    list_unstamped_file_episodes,
    stamp_episode_chunk,
    count_org_graph,
    purge_org_graph,
    count_source_records,
    GraphVisibilityError,
    PersonErasureBlocked,
    ensure_graph_visible,
    erase_person,
    fetch_edge_provenance,
    find_fact,
    find_entity_by_name,
    get_entity_with_facts,
    get_graphiti,
    graph_for_group,
    groups_holding_entity,
    local_embedder,
    neo4j_healthy,
    plan_person_erasure,
    remove_chunk_facts,
    remove_entity,
    remove_episode_facts,
    remove_fact,
    remove_group_facts,
    search_edges,
    transfer_entity_edges,
)


# ---------------------------------------------------------------------------
# Entity type definitions — passed to graphiti's add_episode so the extraction
# LLM knows what categories to produce. We extend beyond the default (Person,
# Org) to also capture products, platforms, and deal-specific terms that are
# meaningful graph nodes but not traditional named entities.
# ---------------------------------------------------------------------------


class Person(BaseModel):
    """A named individual — full name required. Excludes generic role titles
    like 'the VP' or 'CROs' that aren't specific people."""


class Company(BaseModel):
    """A named organisation, startup, or enterprise. Includes customers,
    suppliers, and partner organisations."""


class Product(BaseModel):
    """A named software product, platform, or service — e.g. 'HubSpot', 'Fiserv',
    'Jack Henry', 'Salesforce'. Excludes generic categories like 'CRM'."""


class Technology(BaseModel):
    """A named technical concept, integration, or system — e.g. 'Slack Connect',
    'Gmail API', 'Pub/Sub', 'Neo4j'. Not generic tech words like 'API' or 'webhook'."""


class DealTerm(BaseModel):
    """A specific financial or commercial term tied to a real deal or event —
    e.g. 'net-60 payment terms', '$22M contract', 'three-year renewal'. Excludes generic phrases."""


class Document(BaseModel):
    """A named file, report, contract, or formal document — e.g. 'Q3 Hiring Plan',
    'Master Services Agreement', 'Meridian NDA'. Excludes generic document types."""


class Process(BaseModel):
    """A named business process, workflow, or methodology — e.g. 'outreach cadence',
    'pilot onboarding', 'quarterly review'. Excludes generic verbs."""


class Asset(BaseModel):
    """A named tangible or intangible business asset — e.g. 'Slack Connect integration',
    'APAC pipeline', 'Fiserv channel'. Excludes generic terms like 'revenue' or 'data'."""


class Decision(BaseModel):
    """A specific choice a team made among real alternatives, usually with a stated
    reason — e.g. 'ltree over a closure table for the scope hierarchy', 'default-deny
    access for new scopes', 'capability tokens instead of service accounts for agents'.
    Name it after the choice itself (what was picked, and ideally what it was picked
    over), not the general topic area it falls under."""


class Concept(BaseModel):
    """A specific named technical or business framework, model, pattern, or idea being
    applied or referenced — e.g. 'bi-temporal fact invalidation', 'default-deny access
    model', 'blue ocean strategy'. Must be a specific, nameable idea, not a generic
    topic word like 'architecture' or 'strategy' on its own."""


class Constraint(BaseModel):
    """A specific limitation, restriction, or hard requirement that shaped a decision —
    e.g. 'ltree labels are restricted to [A-Za-z0-9_]', 'Groq caps scout at 8192
    tokens', 'the 30-day data-retention window'. Must be a concrete, specific limit,
    not a vague statement that something is 'hard' or 'limited'."""


class Tradeoff(BaseModel):
    """A specific cost, downside, or risk knowingly accepted in exchange for a
    benefit — e.g. 'two systems to keep in sync operationally', 'more setup friction
    for new orgs', 'a bigger permission surface to reason about'. Must name the actual
    cost accepted, not just that a tradeoff exists."""


ENTITY_TYPES: dict[str, type[BaseModel]] = {
    "Person": Person,
    "Company": Company,
    "Product": Product,
    "Technology": Technology,
    "DealTerm": DealTerm,
    "Document": Document,
    "Process": Process,
    "Asset": Asset,
    "Decision": Decision,
    "Concept": Concept,
    "Constraint": Constraint,
    "Tradeoff": Tradeoff,
}

EXTRACTION_INSTRUCTIONS = (
    "Extract specific, named entities — including the specific decisions, concepts, "
    "constraints, and tradeoffs embedded in technical/architecture/product content, "
    "not just people and companies. "
    "Do NOT extract generic role titles (e.g. 'VPs of Sales', 'CMOs', 'CROs', 'founders'), "
    "generic nouns ('inbox', 'context', 'pipeline', 'team'), "
    "or vague topic words with no specific claim attached (e.g. 'architecture', 'strategy' "
    "on their own, with nothing named). "
    "DO extract: full names of real people, specific company names, named products and platforms, "
    "named technical systems, specific deal terms with dollar amounts or round labels, "
    "named documents and contracts, named business processes, and named assets. "
    "For technical/abstract content specifically, ALSO extract: each specific DECISION made "
    "(name it after the actual choice, e.g. 'ltree over a closure table'), each named CONCEPT "
    "or framework being applied or referenced, each specific CONSTRAINT that shaped a decision, "
    "and each specific TRADEOFF that was knowingly accepted. A sentence explaining WHY a team "
    "chose one approach over another is exactly the kind of content that should produce a "
    "Decision (and often a Constraint or Tradeoff) entity, even if it names no person or company."
)

logger = logging.getLogger(__name__)


# A Graphiti call that fails with one of these is asked once more. Only a lost
# connection (the socket gone, or AuraDB having closed it) rebuilds the engine first;
# a transient Neo4j error, such as a deadlock, is retried on the engine it hit.
RESET_ERRORS = CONNECTION_LOST_ERRORS + (ConnectionError, OSError)
RETRYABLE_ERRORS = RESET_ERRORS + (TransientError,)

# How long /health waits for Neo4j before answering degraded. Short, so a probe gets
# an answer while every pooled connection is busy, instead of waiting out the pool's
# acquisition timeout.
HEALTH_NEO4J_TIMEOUT_S = 2.0

OVERLOADED_DETAIL = (
    "memory graph overloaded: no Neo4j connection came free in time because other "
    "requests hold them all; retry shortly, or send fewer requests at once"
)


def _overloaded(exc: Exception) -> HTTPException:
    """The 503 for a busy pool, sent once the pool's acquisition timeout has passed. It
    names no connection detail, like the lost-connection 503."""
    logger.warning("Neo4j pool busy, answering 503: %s", type(exc).__name__)
    return HTTPException(status_code=503, detail=OVERLOADED_DETAIL, headers={"Retry-After": "1"})


async def _graphiti_with_retry(fn):
    """Call fn(graphiti), retrying once on a RETRYABLE_ERRORS failure and rebuilding the
    engine first when the connection was lost. A second failure answers 503 straight
    away: with the pool's 10 s acquisition timeout both attempts fit inside the Node
    app's 60 s ingest budget, so the caller gets a clear retryable error, not a timeout.
    A busy pool answers 503 after its one acquisition wait, with no retry and no
    rebuild: both would add load."""
    for attempt in range(2):
        g = None
        try:
            g = await get_graphiti()
            return await fn(g)
        except OVERLOAD_ERRORS as exc:
            raise _overloaded(exc) from exc
        except RETRYABLE_ERRORS as exc:
            if attempt == 0:
                logger.warning("Graphiti connection error, retrying once: %s", exc)
                if isinstance(exc, RESET_ERRORS):
                    await _reset_graphiti(g)
                await asyncio.sleep(0.5)
                continue
            logger.error("Graphiti connection error persisted after one retry: %s", exc)
            raise HTTPException(
                status_code=503,
                detail=(
                    "memory graph unavailable: Neo4j connection failed twice "
                    f"({type(exc).__name__}); retry the request"
                ),
            ) from exc
        except DriverError:
            # Another caller lost its connection and closed this engine under us
            # ("Driver closed"): retry once on the one that replaced it, resetting nothing.
            if attempt == 0 and engine_replaced(g):
                continue
            raise


async def require_api_key(authorization: str = Header(default="")) -> None:
    expected = settings.graphiti_service_api_key
    token = authorization.removeprefix("Bearer ").strip()
    # Constant time: `!=` returns at the first differing byte, so response timing would
    # leak how much of a guessed key is right. Compared as bytes because compare_digest
    # refuses a str with non-ASCII characters, and an attacker picks the header.
    if not expected or not hmac.compare_digest(token.encode("utf-8"), expected.encode("utf-8")):
        raise HTTPException(status_code=401, detail="invalid service api key")


async def _keepalive_tick() -> None:
    """Ping both Neo4j drivers, and evict the one whose connections are dead.

    The ping keeps idle pooled connections under AuraDB's idle cutoff. When it fails
    anyway the pool is holding defunct connections, and leaving it in place means
    the next real request pays the acquisition timeout; `neo4j_healthy` closes the
    raw driver on a lost connection, and a lost connection on the Graphiti search
    closes the engine, so each is rebuilt fresh on its next use. A busy pool is not
    dead: the tick leaves both alone."""
    if await neo4j_healthy():
        logger.debug("Neo4j raw driver keepalive OK")
    else:
        logger.warning("Neo4j raw driver keepalive failed; reset only if the connection was lost")
    g = None
    try:
        g = await get_graphiti()
        await search_edges(g, "_keepalive", ["_ping"], 1)
    except RESET_ERRORS as exc:
        logger.warning(
            "Graphiti keepalive hit a dead connection; engine reset, rebuilds on next use: %s", exc
        )
        await _reset_graphiti(g)
    except Exception:  # noqa: BLE001
        pass  # a busy pool or a search error, not a dead connection: the ping did its job


async def _keepalive_loop() -> None:
    """Run `_keepalive_tick` every 3 minutes, under the pool's connection lifetime
    and AuraDB's idle cutoff."""
    while True:
        await asyncio.sleep(180)
        await _keepalive_tick()


async def _warmup() -> None:
    """Eagerly build the Graphiti engine and load the BGE embedder at startup, so the
    FIRST real /search or /graph isn't paying the cold init (model load + build_indices
    + AuraDB connect). Runs as a background task so it never blocks the platform
    liveness/health check. Idempotent with the lazy path."""
    try:
        g = await get_graphiti()  # builds engine + indices
        # Force the embedder to actually load its weights with a dummy search
        # (limit 1; empty group => returns nothing, just warms).
        await search_edges(g, "_warmup", ["_warmup"], 1)
        logger.info("memory-service warmup complete (embedder + engine loaded)")
    except Exception as exc:  # noqa: BLE001 — warmup is best-effort
        logger.warning("memory-service warmup failed (will lazy-init on first call): %s", exc)


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Before anything connects: in lab mode, only to this machine (app/lab_guard.py).
    refuse_remote_in_lab_mode(os.environ, settings.neo4j_uri)
    # Looked up here, not bound at import, so the stall handler can be replaced in tests.
    watchdog = LoopWatchdog(settings.loop_stall_limit_s, on_stall=lambda s: exit_with_stacks(s))
    watchdog.start(asyncio.get_running_loop())
    warmup = asyncio.create_task(_warmup())
    task = asyncio.create_task(_keepalive_loop())
    try:
        yield
    finally:
        watchdog.stop()
        warmup.cancel()
        task.cancel()
        await close_graphiti()
        await close_driver()


def _episode_type(source: str) -> EpisodeType:
    try:
        return EpisodeType[source]
    except KeyError:
        return EpisodeType.text


def _reference_time(value: str | None) -> datetime:
    if not value:
        return datetime.now(timezone.utc)
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return datetime.now(timezone.utc)
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


# No interactive docs, and the schema only behind the service key: an anonymous
# caller must not get the full route and payload map of an internal service.
app = FastAPI(
    title="Willder Memory Service",
    version="0.1.0",
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


@app.get("/openapi.json", include_in_schema=False, dependencies=[Depends(require_api_key)])
async def openapi_schema() -> dict:
    """The OpenAPI schema, for smoke tests and deploy checks that hold the key."""
    return app.openapi()


async def _busy_pool(_request: Request, exc: Exception) -> JSONResponse:
    """A busy pool on any route answers 503 with Retry-After, not a 500: the request
    was not wrong, and asking again once the burst has passed can succeed."""
    busy = _overloaded(exc)
    return JSONResponse(
        status_code=busy.status_code, content={"detail": busy.detail}, headers=busy.headers
    )


for _busy_error in OVERLOAD_ERRORS:
    app.add_exception_handler(_busy_error, _busy_pool)


@app.exception_handler(GraphVisibilityError)
async def _graph_write_failed(_request: Request, exc: GraphVisibilityError) -> JSONResponse:
    """An ingest whose graph-visibility write did not commit answers 503, not 200: its
    fact is not in the graph, and the caller keeps the write to extract it again."""
    return JSONResponse(
        status_code=503,
        content={"detail": f"memory graph write did not commit; retry the ingest ({exc})"},
        headers={"Retry-After": "1"},
    )


@app.get("/health")
async def health() -> dict:
    """Liveness, Neo4j connectivity within HEALTH_NEO4J_TIMEOUT_S, and graph extraction.
    Unauthenticated on purpose (no secrets). `status` is "degraded" when Neo4j did not
    answer or `extraction.status` is "degraded" (the model provider refused an ingest in
    the last few minutes, app/extraction_status.py), and "ok" otherwise; the process
    answering at all is the liveness signal, so the HTTP status stays 200."""
    neo4j_ok, error = False, None
    try:
        neo4j_ok = await asyncio.wait_for(neo4j_healthy(), HEALTH_NEO4J_TIMEOUT_S)
    except TimeoutError:
        error = f"Neo4j did not answer within {HEALTH_NEO4J_TIMEOUT_S:g} s: the pool is busy or Neo4j is unreachable"
    except Exception as exc:  # noqa: BLE001 — report, don't crash the probe
        error = str(exc)
    extraction = extraction_status.snapshot()
    healthy = neo4j_ok and extraction["status"] != "degraded"
    return {
        "status": "ok" if healthy else "degraded",
        "neo4j": neo4j_ok,
        "error": error,
        "extraction": extraction,
    }


async def _extract_into_graph(fn):
    """Run an ingest's Graphiti call (`fn(graphiti)`) and record its outcome for /health.
    A model-provider refusal answers 503 with Retry-After instead of escaping as a 500."""
    try:
        result = await _graphiti_with_retry(fn)
    except Exception as exc:
        kind = refusal_kind(exc)
        if kind is None:
            raise
        extraction_status.record_failure(kind)
        logger.error("ingest: the model provider refused graph extraction (%s)", kind)
        raise refusal_error(kind, "graph extraction") from exc
    extraction_status.record_success()
    return result


async def _keep_document_passages(body: schemas.IngestRequest, result, provenance: str) -> None:
    """Store, in its own words, the item's heading and each passage of a source
    document that states a number none of the extracted facts kept (see
    passages.py). The extractor states what an item says, never what it is called,
    so without its heading a synced doc ("Document docs/setup.md in acme/app") could
    not be found by its name or path. Each passage carries the episode uuid and
    provenance, so retiring the episode or purging the source removes it with the
    extracted facts."""
    heading = (body.heading or "").strip()
    if heading:
        await ensure_graph_visible(
            group_id=body.group_id,
            content=heading,
            reference_time=_reference_time(body.reference_time),
            episode_uuid=result.episode.uuid,
            source_description=provenance,
            node_label="Passage",
        )
        logger.info("ingest: verbatim heading stored (group=%s)", body.group_id)
    # A passage the heading already holds word for word is not stored a second time.
    in_heading = set(passages(heading))
    dropped = [
        passage
        for passage in passages_with_dropped_numbers(
            body.content, [edge.fact for edge in result.edges]
        )
        if passage not in in_heading
    ]
    if len(dropped) > MAX_VERBATIM_PASSAGES:
        logger.warning(
            "ingest: %d passages lost a number in extraction, keeping the first %d (group=%s)",
            len(dropped),
            MAX_VERBATIM_PASSAGES,
            body.group_id,
        )
    kept = dropped[:MAX_VERBATIM_PASSAGES]
    for passage in kept:
        await ensure_graph_visible(
            group_id=body.group_id,
            content=passage,
            reference_time=_reference_time(body.reference_time),
            episode_uuid=result.episode.uuid,
            source_description=provenance,
            node_label="Passage",
        )
    if kept:
        logger.info("ingest: %d verbatim passages stored (group=%s)", len(kept), body.group_id)


@app.post(
    "/ingest",
    response_model=schemas.IngestResponse,
    dependencies=[Depends(require_api_key)],
)
async def ingest(body: schemas.IngestRequest) -> schemas.IngestResponse:
    # Qwen (via Groq) extracts entities/facts, local BGE embeds them, Graphiti dedupes
    # + stores temporally in Neo4j, partitioned by group_id. Actor provenance is stamped
    # into source_description (parseable JSON) so facts inherit who asserted them.
    provenance = json.dumps(
        {
            "actor_type": body.actor_type,
            "actor_id": body.actor_id,
            "actor_name": body.actor_name,
            "source": body.source,
            "scope_path": body.scope_path,
            "source_id": body.source_id,
            "chunk_id": body.chunk_id,
        }
    )

    async def _run(g):
        return await g.add_episode(
            name=body.name or f"episode:{body.actor_id}",
            episode_body=body.content,
            source_description=provenance,
            reference_time=_reference_time(body.reference_time),
            source=_episode_type(body.source),
            group_id=body.group_id,
            entity_types=ENTITY_TYPES,
            custom_extraction_instructions=EXTRACTION_INSTRUCTIONS,
        )

    # Nobody waits on an ingest: every model call it makes, the extraction and any
    # verbatim fallback node it embeds afterwards, goes after every request's own.
    import time

    with background_priority():
        t0 = time.time()
        result = await _extract_into_graph(_run)
        logger.info("ingest: %.2fs (group=%s)", time.time() - t0, body.group_id)

        if body.record_type == "decision":
            # A decision is stored in its own words whatever the extractor made of it:
            # the extractor paraphrases, and a paraphrase once kept only "Jordan is a
            # Decision that specifies operational procedures" of a dated decision.
            await ensure_graph_visible(
                group_id=body.group_id,
                content=body.content,
                reference_time=_reference_time(body.reference_time),
                episode_uuid=result.episode.uuid,
                source_description=provenance,
                node_label="Decision",
            )
            logger.info("ingest: verbatim decision fact stored (group=%s)", body.group_id)
        elif result.edges and body.record_type == "document":
            await _keep_document_passages(body, result, provenance)
        elif not result.edges:
            # No RELATES_TO edge — the fact is graph-invisible even if `result.nodes` is
            # non-empty: a lone entity node with no edge is excluded by /graph's and
            # /search's edge-based queries. This is the common case for abstract/technical
            # content and for a one-entity sentence: the extractor often proposes an
            # orphan entity but fails to resolve a relation for it ("Target entity not
            # found in nodes for edge relation" in Graphiti's own logs). Don't let the
            # fact go graph-invisible: hang it on the entities extraction did resolve,
            # so a later fact about them lands on the same entity.
            await ensure_graph_visible(
                group_id=body.group_id,
                content=body.content,
                reference_time=_reference_time(body.reference_time),
                episode_uuid=result.episode.uuid,
                source_description=provenance,
                entity_uuids=[node.uuid for node in result.nodes],
            )
            logger.info(
                "ingest: no relation extracted (group=%s); fallback graph edge stored",
                body.group_id,
            )

        return schemas.IngestResponse(episode_id=result.episode.uuid)


@app.post(
    "/ingest-bulk",
    response_model=schemas.BulkIngestResponse,
    dependencies=[Depends(require_api_key)],
)
async def ingest_bulk(body: schemas.BulkIngestRequest) -> schemas.BulkIngestResponse:
    """Ingest multiple episodes in a single add_episode_bulk call.
    Significantly faster than N serial /ingest calls for document chunks.
    Episodes must all belong to the same group_id."""
    import time
    from graphiti_core.utils.bulk_utils import RawEpisode

    raw_episodes = []
    episode_provenances = []
    for ep in body.episodes:
        provenance = json.dumps(
            {
                "actor_type": ep.actor_type,
                "actor_id": ep.actor_id,
                "actor_name": ep.actor_name,
                "source": ep.source,
                "scope_path": ep.scope_path,
                "source_id": ep.source_id,
                "chunk_id": ep.chunk_id,
            }
        )
        episode_provenances.append(provenance)
        raw_episodes.append(
            RawEpisode(
                name=ep.name or f"episode:{ep.actor_id}",
                content=ep.content,
                source_description=provenance,
                reference_time=_reference_time(ep.reference_time),
                source=_episode_type(ep.source),
            )
        )

    async def _run(g):
        return await g.add_episode_bulk(
            bulk_episodes=raw_episodes,
            group_id=body.group_id,
            entity_types=ENTITY_TYPES,
            custom_extraction_instructions=EXTRACTION_INSTRUCTIONS,
        )

    with background_priority():
        t0 = time.time()
        results = await _extract_into_graph(_run)
        elapsed = time.time() - t0
        logger.info(
            "ingest-bulk: %.2fs for %d episodes (group=%s)",
            elapsed,
            len(raw_episodes),
            body.group_id,
        )
        episode_ids = [ep.uuid for ep in results.episodes]

        # Per-episode fallback: `results.nodes`/`results.edges` are aggregated across the
        # whole batch, so we can't tell which episode produced nothing from those alone.
        # `episodic_edges` link episode uuid -> entity node uuid (regardless of whether
        # that node ends up in any RELATES_TO edge). A node with no RELATES_TO edge is as
        # graph-invisible as no node at all (excluded by /graph's and /search's edge-based
        # queries — Graphiti's extractor often proposes an orphan entity but fails to
        # resolve a relation for it). So: for each episode, check whether ANY of its
        # associated entity nodes actually participate in a RELATES_TO edge; fall back if
        # not. This is the common bulk path for distilled facts (`distill-facts` in
        # lib/inngest.ts calls ingestBulk) — abstract/technical facts are exactly the ones
        # likely to hit this.
        nodes_by_episode: dict[str, set[str]] = {}
        for ee in results.episodic_edges:
            nodes_by_episode.setdefault(ee.source_node_uuid, set()).add(ee.target_node_uuid)
        nodes_with_edges = {e.source_node_uuid for e in results.edges} | {
            e.target_node_uuid for e in results.edges
        }
        fallback_count = 0
        for ep, raw, provenance in zip(
            results.episodes, body.episodes, episode_provenances, strict=False
        ):
            episode_nodes = nodes_by_episode.get(ep.uuid, set())
            if episode_nodes & nodes_with_edges:
                continue
            await ensure_graph_visible(
                group_id=body.group_id,
                content=raw.content,
                reference_time=_reference_time(raw.reference_time),
                episode_uuid=ep.uuid,
                source_description=provenance,
                entity_uuids=sorted(episode_nodes),
            )
            fallback_count += 1
        if fallback_count:
            logger.info(
                "ingest-bulk: %d/%d episodes had no extracted relation (group=%s); fallback graph edges stored",
                fallback_count,
                len(raw_episodes),
                body.group_id,
            )

        return schemas.BulkIngestResponse(episode_ids=episode_ids)


@app.post(
    "/search",
    response_model=schemas.SearchResponse,
    dependencies=[Depends(require_api_key)],
)
async def search(body: schemas.SearchRequest) -> schemas.SearchResponse:
    # Hybrid edge search (BM25 + embedding cosine), fused by reciprocal rank fusion
    # (EDGE_HYBRID_SEARCH_RRF in search_edges), scoped to group_id plus any group_ids.
    # No cross-encoder scores these results. App-side access check happens before this
    # is called (UC2), over every group asked. Returns facts (graph edges).
    groups = list(dict.fromkeys([body.group_id, *body.group_ids]))
    try:
        edges = await _graphiti_with_retry(
            lambda g: search_edges(g, body.query, groups, body.limit)
        )
    except HTTPException:
        raise  # the retry wrapper's 503 is the answer, not an internal error
    except Exception as exc:
        logger.error("search failed for group=%s query=%r: %s", body.group_id, body.query, exc)
        raise HTTPException(status_code=500, detail=f"search failed: {exc}") from exc
    # Stamped provenance per edge: actor_type for the Node-side ranker (human >
    # agent > extraction), actor_name and source_id so a reader can cite where a
    # fact came from, chunk_ids so the caller can drop a version a later write
    # superseded, and episode_ids so it can name the synced item a fact came
    # from. Best-effort: a lookup failure must not fail the whole search, it just
    # means every fact in this response comes back unranked and uncited.
    try:
        provenance = await fetch_edge_provenance([edge.uuid for edge in edges])
    except Exception as exc:
        logger.warning(
            "provenance lookup failed for group=%s, facts return unranked: %s", body.group_id, exc
        )
        provenance = {}
    facts = []
    for edge in edges:
        stamped = provenance.get(edge.uuid, {})
        try:
            facts.append(
                _fact(
                    edge,
                    actor_type=stamped.get("actor_type"),
                    actor_name=stamped.get("actor_name"),
                    source_id=stamped.get("source_id"),
                    chunk_ids=stamped.get("chunk_ids") or [],
                    episode_ids=stamped.get("episode_ids") or [],
                    group_id=edge.group_id,
                )
            )
        except Exception as exc:
            logger.warning("skipping malformed edge %s: %s", getattr(edge, "uuid", "?"), exc)
    return schemas.SearchResponse(facts=facts, groups_searched=len(groups))


@app.post(
    "/entities/lookup",
    response_model=schemas.EntityLookupResponse,
    dependencies=[Depends(require_api_key)],
)
async def lookup_entity(body: schemas.EntityLookupRequest) -> schemas.EntityLookupResponse:
    # The entity with this uuid when it is stored in one of `group_ids`, with the group
    # it is in: a reader granted a scope finds an entity anywhere below it in one call.
    found = await get_entity_with_facts(body.group_ids, body.uuid)
    if found is None:
        return schemas.EntityLookupResponse()
    node, _edges = found
    return schemas.EntityLookupResponse(
        entity=await _entity_response(*found), group_id=node.group_id
    )


@app.post(
    "/entities/groups",
    response_model=schemas.EntityGroupsResponse,
    dependencies=[Depends(require_api_key)],
)
async def entity_groups(body: schemas.EntityGroupsRequest) -> schemas.EntityGroupsResponse:
    # Which of `group_ids` hold an entity with exactly this name, in the order asked.
    # Server-side resolution helper (willder's services/memory/entity-scope.ts), never
    # called with caller-supplied groups.
    return schemas.EntityGroupsResponse(
        group_ids=await groups_holding_entity(body.group_ids, body.name)
    )


@app.get(
    "/entities/find",
    response_model=schemas.FindEntityResponse,
    dependencies=[Depends(require_api_key)],
)
async def find_entity(name: str, group_id: str) -> schemas.FindEntityResponse:
    # Exact-name existence lookup, scoped to one group_id. Server-side resolution
    # helper only (willder's services/memory/entity-scope.ts) — never called with
    # a caller-supplied group_id, only server-derived candidates.
    #
    # Registered BEFORE /entities/{uuid} below: Starlette matches routes in
    # registration order, and a static "/entities/find" would otherwise be
    # captured by "/entities/{uuid}" first, with "find" bound as the uuid path
    # param — caught by test_find_entity_found failing 404 (it matched
    # get_entity's "not found" branch, not this handler at all) before this
    # reordering.
    found = await find_entity_by_name(group_id, name)
    if found is None:
        raise HTTPException(status_code=404, detail="entity not found")
    uuid, labels = found
    rest = [label for label in (labels or []) if label != "Entity"]
    return schemas.FindEntityResponse(uuid=uuid, type=rest[0] if rest else "Entity")


@app.get(
    "/entities/{uuid}",
    response_model=schemas.EntityResponse,
    dependencies=[Depends(require_api_key)],
)
async def get_entity(uuid: str, group_id: str) -> schemas.EntityResponse:
    # "What we know about X" — the entity + its facts, scoped to the tenant.
    found = await get_entity_with_facts([group_id], uuid)
    if found is None:
        raise HTTPException(status_code=404, detail="entity not found")
    return await _entity_response(*found)


async def _entity_response(node, edges) -> schemas.EntityResponse:
    labels = [label for label in getattr(node, "labels", []) if label != "Entity"]
    stamps = await _stamps_by_edge([e.uuid for e in edges], f"entity {node.uuid}")
    return schemas.EntityResponse(
        uuid=node.uuid,
        name=node.name,
        type=labels[0] if labels else "Entity",
        summary=getattr(node, "summary", "") or "",
        facts=[_fact(e, **stamps.get(e.uuid, _NO_STAMPS)) for e in edges],
    )


def _fact(edge, **provenance) -> schemas.Fact:
    """One Graphiti edge as a `Fact`, with Graphiti's own retirement marks. A retired edge
    is returned, not dropped: the caller decides whether an answer leaves it out or a
    history marks it, the same way /graph reports every edge."""

    def iso(value):
        # Graphiti reads a datetime without an offset as UTC; say so, or a reader in
        # another time zone would move the moment.
        return ensure_utc(value).isoformat() if value else None

    return schemas.Fact(
        uuid=edge.uuid,
        fact=edge.fact,
        valid_at=iso(edge.valid_at),
        invalid_at=iso(edge.invalid_at),
        expired_at=iso(edge.expired_at),
        **provenance,
    )


_NO_STAMPS: dict[str, object] = {"chunk_ids": [], "source_id": None, "episode_ids": []}


async def _stamps_by_edge(edge_uuids: list[str], label: str) -> dict[str, dict[str, object]]:
    """The stamps behind each edge (its chunk ids, the connected source that ingested it and
    the episodes asserting it), so every view that answers with fact text lets the caller
    drop a version a later write superseded and check, as it serves the text, that a stored
    source still stands behind it, the way /search does. Best-effort, like /search's
    provenance lookup: on a failure the edges come back unstamped, which the caller treats
    as unresolved, rather than failing the read."""
    try:
        provenance = await fetch_edge_provenance(edge_uuids)
    except Exception as exc:
        logger.warning("stamp lookup failed for %s, facts return unstamped: %s", label, exc)
        return {}
    return {
        uuid: {
            "chunk_ids": list(stamped.get("chunk_ids") or []),
            "source_id": stamped.get("source_id"),
            "episode_ids": list(stamped.get("episode_ids") or []),
        }
        for uuid, stamped in provenance.items()
    }


@app.post(
    "/graph",
    response_model=schemas.GraphResponse,
    dependencies=[Depends(require_api_key)],
)
async def graph(body: schemas.GraphRequest) -> schemas.GraphResponse:
    # Entities (nodes) + facts (edges) for the node-explorer, scoped to one or more
    # group_ids. Each scope path is its own Graphiti group_id; passing multiple
    # group_ids enables org-root aggregation across all scope graphs.
    # App-side access check (UC2) runs before this is called.
    nodes, edges = await graph_for_group(body.group_ids, query=body.query, limit=body.limit)
    stamps = await _stamps_by_edge([e["uuid"] for e in edges], "graph")
    return schemas.GraphResponse(
        nodes=[
            schemas.GraphNode(uuid=uuid, name=meta["name"], type=meta["type"])
            for uuid, meta in nodes.items()
        ],
        edges=[schemas.GraphEdge(**e, **stamps.get(e["uuid"], _NO_STAMPS)) for e in edges],
    )


def _raise_file_extraction_error(exc: Exception, filename: str, file_type: str):
    """A failed file extraction as an HTTP error: a model-provider refusal is a retryable
    503 that names only its kind (the provider's message names the account), anything
    else a 422 naming the failure."""
    kind = refusal_kind(exc)
    if kind is not None:
        logger.error(
            "Extraction of %s (%s): the model provider refused (%s)", filename, file_type, kind
        )
        raise refusal_error(kind, "file extraction") from exc
    logger.error("Extraction failed for %s (%s): %s", filename, file_type, exc)
    raise HTTPException(status_code=422, detail=f"extraction failed: {exc}") from exc


@app.post(
    "/extract",
    response_model=schemas.ExtractResponse,
    dependencies=[Depends(require_api_key)],
)
async def extract(body: schemas.ExtractRequest) -> schemas.ExtractResponse:
    # Download the file from the given URL (Vercel Blob) and extract text chunks.
    # Runs in a thread so blocking PDF/DOCX parsing doesn't stall the event loop.
    from .extractor import extract_file

    try:
        chunks = await asyncio.to_thread(
            extract_file,
            body.url,
            body.file_type,
            body.filename,
            settings.llm_api_key,
            settings.blob_read_write_token,
        )
    except Exception as exc:
        _raise_file_extraction_error(exc, body.filename, body.file_type)
    return schemas.ExtractResponse(chunks=chunks)


@app.post(
    "/extract-bytes",
    response_model=schemas.ExtractResponse,
    dependencies=[Depends(require_api_key)],
)
async def extract_bytes_endpoint(body: schemas.ExtractBytesRequest) -> schemas.ExtractResponse:
    # Local dev fallback: accepts base64-encoded file content directly (no Blob URL needed).
    from .extractor import extract_bytes
    import base64 as _b64

    try:
        raw = _b64.b64decode(body.content_b64)
        chunks = await asyncio.to_thread(
            extract_bytes, raw, body.file_type, body.filename, settings.llm_api_key
        )
    except Exception as exc:
        _raise_file_extraction_error(exc, body.filename, body.file_type)
    return schemas.ExtractResponse(chunks=chunks)


@app.post(
    "/embed",
    response_model=schemas.EmbedResponse,
    dependencies=[Depends(require_api_key)],
)
async def embed(body: schemas.EmbedRequest) -> schemas.EmbedResponse:
    """Return a BGE-384 embedding for the given text. Used by the pgvector chunk
    store so both stores share the same embedding space for consistent retrieval.
    Needs no Neo4j, so it answers while the graph is busy or being rebuilt."""
    vec = await local_embedder().create(body.text)
    return schemas.EmbedResponse(embedding=vec if isinstance(vec, list) else list(vec))


@app.post(
    "/embed-batch",
    response_model=schemas.EmbedBatchResponse,
    dependencies=[Depends(require_api_key)],
)
async def embed_batch(body: schemas.EmbedBatchRequest) -> schemas.EmbedBatchResponse:
    """Return a BGE-384 embedding for each text, in order. The pgvector chunk store sends a
    long row's passages here, a bounded batch per request, instead of one /embed request
    per passage. The texts are queued together, so the model queue (app/model_work.py)
    encodes them in one call, alongside any other request's texts waiting at the time."""
    embedder = local_embedder()
    vectors = await asyncio.gather(*(embedder.create(text) for text in body.texts))
    return schemas.EmbedBatchResponse(
        embeddings=[v if isinstance(v, list) else list(v) for v in vectors]
    )


@app.post(
    "/transfer-entity",
    response_model=schemas.TransferEntityResponse,
    dependencies=[Depends(require_api_key)],
)
async def transfer_entity(body: schemas.TransferEntityRequest) -> schemas.TransferEntityResponse:
    # Invalidate edges on the old entity and recreate them on the new entity.
    # Called by the Node app when an org role mapping changes (CEO: Bob → Amy).
    if body.old_name == body.new_name:
        return schemas.TransferEntityResponse(transferred=0)
    transferred = await transfer_entity_edges(body.group_id, body.old_name, body.new_name)
    return schemas.TransferEntityResponse(transferred=transferred)


@app.delete(
    "/entities/{uuid}",
    response_model=schemas.RemoveResponse,
    dependencies=[Depends(require_api_key)],
)
async def delete_entity_endpoint(uuid: str, group_id: str = Query(...)) -> schemas.RemoveResponse:
    # Hard-delete an entity node + all its edges. Privileged — app gates on memory.delete.
    removed = await remove_entity(group_id, uuid)
    if not removed:
        raise HTTPException(status_code=404, detail="entity not found")
    return schemas.RemoveResponse(removed=True)


@app.post(
    "/people/erase/plan",
    response_model=schemas.ErasePersonPlanResponse,
    dependencies=[Depends(require_api_key)],
)
async def plan_person_erasure_endpoint(
    body: schemas.ErasePersonRequest,
) -> schemas.ErasePersonPlanResponse:
    # The episodes POST /people/erase would remove for the same body, read-only.
    # The app asks first and drops its connector records' pointers to them, so a
    # failure after the erase cannot leave a pointer to an episode that is gone.
    episode_ids = await plan_person_erasure(body.org_id, body.emails, body.names, body.entity_uuids)
    return schemas.ErasePersonPlanResponse(episode_ids=episode_ids)


@app.post(
    "/people/erase",
    response_model=schemas.ErasePersonResponse,
    dependencies=[Depends(require_api_key)],
)
async def erase_person_endpoint(body: schemas.ErasePersonRequest) -> schemas.ErasePersonResponse:
    # Removes one person from every partition of one org. The app authorizes the
    # request (access.manage on the org root) and audits it before calling here.
    # 409 means a node naming the person links outside the org and nothing changed.
    try:
        counts = await erase_person(body.org_id, body.emails, body.names, body.entity_uuids)
    except PersonErasureBlocked as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return schemas.ErasePersonResponse(**counts)


@app.get(
    "/facts/{uuid}/resolve",
    response_model=schemas.ResolveFactResponse,
    dependencies=[Depends(require_api_key)],
)
async def resolve_fact(uuid: str, group_id: str = Query(...)) -> schemas.ResolveFactResponse:
    # Existence lookup for one fact edge inside one group_id. The app calls this
    # to resolve a caller-supplied fact uuid against the scope that caller is
    # actually authorized for, before recording anything that references it
    # (willder's services/facts/provenance.ts). An edge in another group answers
    # `found: false`, identical to a uuid that exists nowhere, so the answer
    # carries no information across the group boundary.
    #
    # Two shape decisions, both so a service older than this route cannot be
    # mistaken for an answer:
    #  * the sub-path, because `DELETE /facts/{uuid}` below already claims
    #    `/facts/<one segment>`, and a service without this route answers any
    #    GET there with 405, not 404;
    #  * `found: false` with HTTP 200 rather than a 404, because a 404 is also
    #    what any service answers for a route it does not serve. The caller must
    #    be able to tell "this fact is not here" from "this service cannot say".
    found = await find_fact(group_id, uuid)
    if found is None:
        return schemas.ResolveFactResponse(found=False)
    found_uuid, fact, invalid_at, expired_at = found
    # The edge's stamps, as /search returns them, so the caller can check a stored source
    # still stands behind the text before it treats the fact as current.
    stamps = (
        (await _stamps_by_edge([found_uuid], f"fact {found_uuid}")).get(found_uuid, _NO_STAMPS)
        if found_uuid
        else _NO_STAMPS
    )
    return schemas.ResolveFactResponse(
        found=True,
        uuid=found_uuid,
        fact=fact,
        invalid_at=invalid_at,
        expired_at=expired_at,
        **stamps,
    )


@app.delete(
    "/facts/{uuid}",
    response_model=schemas.RemoveResponse,
    dependencies=[Depends(require_api_key)],
)
async def delete_fact(uuid: str, group_id: str = Query(...)) -> schemas.RemoveResponse:
    # Privileged removal of a fact, scoped to the tenant. The app gates this on
    # `memory.delete` (write+) and audits it before calling here.
    removed = await remove_fact(group_id, uuid)
    if not removed:
        raise HTTPException(status_code=404, detail="fact not found")
    return schemas.RemoveResponse(removed=True)


@app.delete(
    "/episodes/{uuid}",
    response_model=schemas.RemoveResponse,
    dependencies=[Depends(require_api_key)],
)
async def delete_episode(uuid: str, group_id: str = Query(...)) -> schemas.RemoveResponse:
    # Retires every fact one episode contributed: the Node
    # connector sync calls this before re-ingesting an edited Slack message /
    # Figma comment, or when one has vanished upstream, so a stale episode's
    # facts don't keep coexisting with the corrected/removed content.
    removed = await remove_episode_facts(group_id, uuid)
    if removed == 0:
        raise HTTPException(status_code=404, detail="episode contributed no facts")
    return schemas.RemoveResponse(removed=True)


@app.delete(
    "/chunks/{chunk_id}",
    response_model=schemas.ChunkRetirementResponse,
    dependencies=[Depends(require_api_key)],
)
async def delete_chunk(
    chunk_id: str, group_id: str = Query(..., min_length=1)
) -> schemas.ChunkRetirementResponse:
    # Retires what one stored fact left in the graph: the episodes stamped with its
    # chunk id and the facts they produced. The app calls this after it deleted that
    # `memory_chunks` row behind a `memory.delete` check, passing the row's own scope
    # as the group. No 404: a fact whose ingest never reached the graph left nothing.
    retired = await remove_chunk_facts(group_id, chunk_id)
    return schemas.ChunkRetirementResponse(
        removed_count=retired["facts"],
        removed_episodes=retired["episodes"],
        removed_verbatim_nodes=retired["verbatim_nodes"],
        removed_entities=retired["entities"],
        cleared_summaries=retired["summaries"],
        removed_episode_ids=retired.get("episode_ids", []),
    )


@app.post(
    "/episodes/unstamped-files",
    response_model=schemas.UnstampedFileEpisodesResponse,
    dependencies=[Depends(require_api_key)],
)
async def unstamped_file_episodes(
    body: schemas.UnstampedFileEpisodesRequest,
) -> schemas.UnstampedFileEpisodesResponse:
    # Read-only. The app's file-episode backfill (scripts/backfill-file-episode-stamps.ts) pages a
    # group's file episodes written before passages were stamped, to match each to its
    # stored passage and its file by salted digests. No text or name is ever returned.
    page = await list_unstamped_file_episodes(body.group_id, body.after, body.limit, body.salt)
    return schemas.UnstampedFileEpisodesResponse(**page)


@app.post(
    "/episodes/stamp-chunk",
    response_model=schemas.StampEpisodeChunkResponse,
    dependencies=[Depends(require_api_key)],
)
async def stamp_chunk(body: schemas.StampEpisodeChunkRequest) -> schemas.StampEpisodeChunkResponse:
    # The backfill's only graph write besides DELETE /chunks: stamp one unstamped file
    # episode with the passage it was extracted from, or with an orphan mark that
    # DELETE /chunks then retires.
    outcome = await stamp_episode_chunk(body.group_id, body.episode_uuid, body.chunk_id)
    return schemas.StampEpisodeChunkResponse(outcome=outcome)


@app.post(
    "/groups/residue",
    response_model=schemas.GroupResidueResponse,
    dependencies=[Depends(require_api_key)],
)
async def group_residue(body: schemas.GroupResidueRequest) -> schemas.GroupResidueResponse:
    # Counts the facts and episodes left in one group_id. The app asks this
    # before deleting a scope (services/memory/scope-deletion.ts) and refuses
    # while either is nonzero, since a scope recreated at the same path gets
    # the same group_id. The app authorizes the scope before calling here.
    counts = await count_group_residue(body.group_id)
    return schemas.GroupResidueResponse(**counts)


@app.post(
    "/orgs/purge",
    response_model=schemas.OrgGraphCounts,
    dependencies=[Depends(require_api_key)],
)
async def purge_org(body: schemas.OrgGraphRequest) -> schemas.OrgGraphCounts:
    # Removes every node and relationship in one org's partitions. The app calls this
    # only from its org deletion job, once the seven days have passed; it has already
    # decided the org is to go, so there is nothing to authorize per scope here.
    return schemas.OrgGraphCounts(**await purge_org_graph(body.org_id))


@app.post(
    "/orgs/residue",
    response_model=schemas.OrgGraphCounts,
    dependencies=[Depends(require_api_key)],
)
async def org_residue(body: schemas.OrgGraphRequest) -> schemas.OrgGraphCounts:
    # Counts what one org still has in the graph; the deletion job finishes only at zero.
    return schemas.OrgGraphCounts(**await count_org_graph(body.org_id))


@app.post(
    "/sources/records",
    response_model=schemas.SourceRecordsResponse,
    dependencies=[Depends(require_api_key)],
)
async def source_records(body: schemas.SourceRecordsRequest) -> schemas.SourceRecordsResponse:
    # Counts what one connected source left in the graph of one org, so the app can
    # show whether a disconnect removed everything. Counts only, never text. The app
    # authorizes every scope the answer names before returning it.
    groups = await count_source_records(body.org_id, body.source_id, body.group_ids)
    return schemas.SourceRecordsResponse(groups=[schemas.SourceGroupRecords(**g) for g in groups])


@app.delete(
    "/groups/{group_id}",
    response_model=schemas.RemoveGroupResponse,
    dependencies=[Depends(require_api_key)],
)
async def delete_group(
    group_id: str, source_id: str | None = Query(default=None)
) -> schemas.RemoveGroupResponse:
    # Retires facts in a whole scope in one call (item
    # sources-delete-retention-gap-20260919): DELETE /api/sources/:id calls
    # this with the disconnected source's own scope_path (its group_id) so
    # that source's ingested content stops being retrievable, not just the
    # one episode /episodes/{uuid} above can target. No 404 case — a source
    # that never synced anything has zero facts to remove, which is a normal
    # outcome, not an error.
    #
    # source_id: when given, only removes edges stamped with a matching source_id
    # (see remove_group_facts's own docstring) — a group_id/scope_path is not
    # guaranteed exclusive to one source, so the route always passes this
    # rather than purging (or refusing to purge) the whole scope.
    #
    # A source-scoped purge also removes that source's episodes, verbatim fact
    # nodes and the entity summaries quoting it.
    retired = await remove_group_facts(group_id, source_id=source_id)
    return schemas.RemoveGroupResponse(
        removed_count=retired["facts"],
        removed_episodes=retired["episodes"],
        removed_verbatim_nodes=retired["verbatim_nodes"],
        removed_entities=retired["entities"],
        cleared_summaries=retired["summaries"],
    )
