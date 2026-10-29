"""Neo4j connection-pool lifecycle: pool options, eviction, retry and the 503.

Railway, 2026-10-01 ~21:00Z: "Failed to read from defunct connection",
"Failed to write data to connection" and "Neo4j raw driver keepalive failed:
failed to obtain a connection from the pool within 60.0s (timeout)". AuraDB had
closed idle connections the pool still held; acquiring one blocked for the
driver's default 60 s, which is exactly the Node app's /ingest budget, so the
app logged "memory service /ingest timed out after 60000ms" while neighbouring
ingests returned 200. Lifecycle, not load.

These tests pin the fix at each layer: both drivers are built with pool options
that retire connections before Aura does and fail acquisition fast; a health check
or keepalive ping that lost its connection evicts the dead driver instead of only
logging; /ingest and /search retry once on a rebuilt engine and answer 503 when the
retry fails too. No live Neo4j: fakes stand in for the driver and the engine.

A busy pool is the other half (Railway, 2026-10-10 00:42Z): a burst of about 1,350
/search calls in 70 s took every pooled connection, and acquisitions timed out.
That is load, not a dead connection, so it must not reset anything; the tests under
"busy pool" pin that, and that a reset after a lost connection happens once however
many callers saw it.
"""

import asyncio
import time
import inspect
from importlib.metadata import version
from pathlib import Path
from types import SimpleNamespace

import pytest
from neo4j import AsyncDriver, AsyncGraphDatabase
from neo4j.exceptions import (
    ConnectionAcquisitionTimeoutError,
    DriverError,
    ServiceUnavailable,
    SessionExpired,
    TransientError,
)

import graphiti_core.driver.neo4j_driver as graphiti_neo4j_driver
from graphiti_core.driver.neo4j_driver import Neo4jDriver

from app import graphiti_client, main
from app.config import Settings, settings

DEFUNCT = ServiceUnavailable(
    "Failed to read from defunct connection IPv4Address(('x.neo4j.io', 7687))"
)
POOL_TIMEOUT = ConnectionAcquisitionTimeoutError(
    "failed to obtain a connection from the pool within 10.0s (timeout)"
)
EXPIRED = SessionExpired("Failed to write data to connection IPv4Address(('x.neo4j.io', 7687))")

INGEST_BODY = {
    "group_id": "org_1",
    "content": "Jane Doe is the CTO of Acme.",
    "actor_id": "user_42",
}
SEARCH_BODY = {"group_id": "org_1", "query": "who runs Acme"}
BULK_BODY = {"group_id": "org_1", "episodes": [INGEST_BODY]}
# A driver error that happens to carry the connection string; nothing from it may
# reach the 503 body.
LEAKY = ServiceUnavailable(
    "Couldn't connect to neo4j+s://neo4j:hunter2@abc123.databases.neo4j.io:7687 (resolved to ())"
)
# env var -> (Settings field, documented default); README and .env.example must agree.
POOL_ENV = {
    "NEO4J_MAX_CONNECTION_LIFETIME_S": ("neo4j_max_connection_lifetime_s", 240),
    "NEO4J_CONNECTION_ACQUISITION_TIMEOUT_S": ("neo4j_connection_acquisition_timeout_s", 10.0),
    "NEO4J_LIVENESS_CHECK_TIMEOUT_S": ("neo4j_liveness_check_timeout_s", 30.0),
    "NEO4J_KEEP_ALIVE": ("neo4j_keep_alive", True),
}
MEMORY_SERVICE = Path(__file__).resolve().parents[1]


# --- fakes ---------------------------------------------------------------------


class _FakePool:
    """Stands in for a neo4j AsyncDriver: remembers whether it was closed and
    answers verify_connectivity from a scripted outcome."""

    def __init__(self, config: dict, verify_error: Exception | None = None):
        self.config = config
        self.closed = False
        self.verify_error = verify_error
        self.queries: list[str] = []

    async def close(self):
        self.closed = True

    async def execute_query(self, query, **_kwargs):
        self.queries.append(query)
        return None

    async def verify_connectivity(self):
        if self.verify_error is not None:
            raise self.verify_error


class _DriverFactory:
    """Replaces AsyncGraphDatabase: records every driver(...) call's config."""

    def __init__(self):
        self.built: list[_FakePool] = []

    def driver(self, uri, *, auth=None, **config):
        pool = _FakePool(config)
        self.built.append(pool)
        return pool


class _FlakyGraphiti:
    """An engine whose next calls raise the scripted errors, then succeed."""

    def __init__(self, errors: list[Exception]):
        self.errors = list(errors)
        self.calls = 0

    def _next(self):
        self.calls += 1
        if self.errors:
            raise self.errors.pop(0)

    async def add_episode(self, **_kwargs):
        self._next()
        return SimpleNamespace(episode=SimpleNamespace(uuid="ep-1"), nodes=[], edges=[])

    async def search_(self, **_kwargs):
        self._next()
        return SimpleNamespace(edges=[])

    async def add_episode_bulk(self, **_kwargs):
        self._next()
        return SimpleNamespace(
            episodes=[SimpleNamespace(uuid="ep-1")], nodes=[], edges=[], episodic_edges=[]
        )


@pytest.fixture
def driver_factory(monkeypatch):
    factory = _DriverFactory()
    monkeypatch.setattr(graphiti_client, "AsyncGraphDatabase", factory)
    monkeypatch.setattr(graphiti_neo4j_driver, "AsyncGraphDatabase", factory)
    monkeypatch.setattr(graphiti_client, "_driver", None)
    # The factory opens nothing, but the service refuses to build a driver for an empty URI.
    monkeypatch.setattr(settings, "neo4j_uri", "bolt://127.0.0.1:7687")
    return factory


@pytest.fixture
def engine(monkeypatch):
    """Wire a scripted engine into main and count engine resets. `ensure_graph_visible`
    is stubbed because the fakes return no edges and that path is not under test."""
    resets = []

    def install(errors):
        fake = _FlakyGraphiti(errors)

        async def _get():
            return fake

        async def _reset(_seen=None):
            resets.append(True)

        async def _visible(**_kwargs):
            return True

        async def _no_provenance(_uuids):
            return {}

        monkeypatch.setattr(main, "get_graphiti", _get)
        monkeypatch.setattr(main, "_reset_graphiti", _reset)
        monkeypatch.setattr(main, "ensure_graph_visible", _visible)
        monkeypatch.setattr(main, "fetch_edge_provenance", _no_provenance)
        return fake, resets

    return install


def _expected_options() -> dict:
    return {
        "max_connection_lifetime": settings.neo4j_max_connection_lifetime_s,
        "connection_acquisition_timeout": settings.neo4j_connection_acquisition_timeout_s,
        "liveness_check_timeout": settings.neo4j_liveness_check_timeout_s,
        "keep_alive": settings.neo4j_keep_alive,
    }


# --- pool options ----------------------------------------------------------------


def test_pool_options_retire_connections_before_aura_does():
    options = graphiti_client.driver_options()
    assert options == _expected_options()
    # Aura closes idle connections after roughly four to five minutes.
    assert options["max_connection_lifetime"] <= 240
    # Two attempts, the reset and the real work must fit the app's 60 s budget.
    assert options["connection_acquisition_timeout"] <= 10
    assert options["liveness_check_timeout"] < options["max_connection_lifetime"]
    assert options["keep_alive"] is True


def test_raw_driver_is_built_with_pool_options(driver_factory):
    driver = graphiti_client.get_driver()
    assert driver is driver_factory.built[0]
    assert driver.config == _expected_options()


def test_graphiti_driver_runs_on_the_pooled_driver(driver_factory):
    driver = asyncio.run(graphiti_client.open_graph_driver())
    # Graphiti built one driver with library defaults; ours replaced it and the
    # unused default was closed rather than left to leak.
    unpooled, pooled = driver_factory.built
    assert unpooled.config == {}
    assert unpooled.closed is True
    assert driver.client is pooled
    assert pooled.config == _expected_options()
    assert pooled.closed is False


# --- eviction ----------------------------------------------------------------------


def test_health_check_evicts_dead_driver_and_retries_on_a_fresh_one(monkeypatch):
    dead = _FakePool({}, verify_error=DEFUNCT)
    fresh = _FakePool({})
    pools = iter([dead, fresh])
    monkeypatch.setattr(graphiti_client, "open_driver", lambda: next(pools))
    monkeypatch.setattr(graphiti_client, "_driver", None)

    assert asyncio.run(graphiti_client.neo4j_healthy()) is True
    assert dead.closed is True
    assert graphiti_client._driver is fresh


def test_health_check_leaves_no_driver_when_both_attempts_fail(monkeypatch):
    pools = [_FakePool({}, verify_error=DEFUNCT), _FakePool({}, verify_error=EXPIRED)]
    remaining = iter(pools)
    monkeypatch.setattr(graphiti_client, "open_driver", lambda: next(remaining))
    monkeypatch.setattr(graphiti_client, "_driver", None)

    assert asyncio.run(graphiti_client.neo4j_healthy()) is False
    assert all(pool.closed for pool in pools)
    assert graphiti_client._driver is None


def test_keepalive_evicts_graphiti_engine_on_defunct_connection(monkeypatch, engine):
    _fake, resets = engine([])

    async def _healthy():
        return True

    async def _defunct_search(_g, _query, _group, _limit):
        raise DEFUNCT

    monkeypatch.setattr(main, "neo4j_healthy", _healthy)
    monkeypatch.setattr(main, "search_edges", _defunct_search)

    asyncio.run(main._keepalive_tick())
    assert resets == [True]


def test_keepalive_keeps_engine_when_ping_only_returns_nothing(monkeypatch, engine):
    _fake, resets = engine([])

    async def _healthy():
        return True

    async def _empty_search(_g, _query, _group, _limit):
        return []

    monkeypatch.setattr(main, "neo4j_healthy", _healthy)
    monkeypatch.setattr(main, "search_edges", _empty_search)

    asyncio.run(main._keepalive_tick())
    assert resets == []


# --- retry and 503 ------------------------------------------------------------------


@pytest.mark.parametrize("error", [DEFUNCT, EXPIRED], ids=type)
def test_ingest_retries_once_on_a_rebuilt_engine(client, headers, engine, error):
    fake, resets = engine([error])
    r = client.post("/ingest", json=INGEST_BODY, headers=headers)
    assert r.status_code == 200
    assert r.json() == {"episode_id": "ep-1"}
    assert fake.calls == 2
    assert resets == [True]


def test_ingest_answers_503_when_the_retry_fails_too(client, headers, engine):
    fake, resets = engine([DEFUNCT, EXPIRED])
    r = client.post("/ingest", json=INGEST_BODY, headers=headers)
    assert r.status_code == 503
    assert "memory graph unavailable" in r.json()["detail"]
    assert "SessionExpired" in r.json()["detail"]
    assert fake.calls == 2
    assert resets == [True]


@pytest.mark.parametrize("error", [DEFUNCT, EXPIRED], ids=type)
def test_search_retries_once_on_a_rebuilt_engine(client, headers, engine, error):
    fake, resets = engine([error])
    r = client.post("/search", json=SEARCH_BODY, headers=headers)
    assert r.status_code == 200
    assert r.json()["facts"] == []
    assert fake.calls == 2
    assert resets == [True]


def test_search_answers_503_not_500_when_the_retry_fails_too(client, headers, engine):
    fake, _resets = engine([EXPIRED, DEFUNCT])
    r = client.post("/search", json=SEARCH_BODY, headers=headers)
    assert r.status_code == 503
    assert "memory graph unavailable" in r.json()["detail"]
    assert fake.calls == 2


# --- QA additions: the claims the first fifteen tests left unpinned ------------


def _documented(value) -> str:
    """How README.md and .env.example spell a default: `true`, `240`, `10`."""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(int(value)) if float(value).is_integer() else str(value)


def test_pool_settings_default_to_the_documented_values(monkeypatch):
    for env_name in POOL_ENV:
        monkeypatch.delenv(env_name, raising=False)
    fresh = Settings(_env_file=None)
    for field, default in POOL_ENV.values():
        assert getattr(fresh, field) == default


def test_pool_settings_are_read_from_the_documented_env_names(monkeypatch):
    overrides = {
        "NEO4J_MAX_CONNECTION_LIFETIME_S": ("120", 120),
        "NEO4J_CONNECTION_ACQUISITION_TIMEOUT_S": ("5.5", 5.5),
        "NEO4J_LIVENESS_CHECK_TIMEOUT_S": ("12", 12.0),
        "NEO4J_KEEP_ALIVE": ("false", False),
    }
    for env_name, (raw, _expected) in overrides.items():
        monkeypatch.setenv(env_name, raw)
    fresh = Settings(_env_file=None)
    for env_name, (_raw, expected) in overrides.items():
        assert getattr(fresh, POOL_ENV[env_name][0]) == expected


def test_readme_and_env_example_state_the_code_defaults():
    # The README wraps at 90 columns; compare on single-spaced text so a reflow
    # cannot fail this test, only a changed number can.
    readme = " ".join((MEMORY_SERVICE / "README.md").read_text().split())
    env_example = (MEMORY_SERVICE / ".env.example").read_text()
    for env_name, (field, _documented_default) in POOL_ENV.items():
        default = _documented(Settings.model_fields[field].default)
        assert f"`{env_name}` ({default})" in readme, f"README default for {env_name}"
        assert f"# {env_name}={default}" in env_example, f".env.example default for {env_name}"


def test_real_neo4j_driver_accepts_the_pool_option_names():
    """The fakes above never validate option names; the real driver does
    (ConfigurationError: "Unexpected config keys"). Construction opens no connection."""
    driver = AsyncGraphDatabase.driver(
        "neo4j://localhost:7687", auth=("neo4j", "unused"), **graphiti_client.driver_options()
    )
    asyncio.run(driver.close())


def test_graphiti_driver_still_needs_the_client_swap():
    """open_graph_driver works around graphiti-core 0.29.1: Neo4jDriver.__init__ takes
    no pool options and keeps its neo4j driver in the `client` attribute that every
    query path reads. requirements.txt does not pin graphiti-core, so if a newer
    release changes either, the swap is wrong or unnecessary; fail loudly here rather
    than silently run on library defaults again."""
    installed = version("graphiti-core")
    params = list(inspect.signature(Neo4jDriver.__init__).parameters)
    assert params == ["self", "uri", "user", "password", "database"], (
        f"graphiti-core {installed}: Neo4jDriver.__init__ now takes {params}; pass "
        "driver_options() straight through and drop the client swap in open_graph_driver"
    )
    assert "self.client.execute_query" in inspect.getsource(Neo4jDriver.execute_query), (
        f"graphiti-core {installed}: execute_query no longer reads self.client; "
        "open_graph_driver's swap would leave Graphiti on an unpooled driver"
    )
    # Outside a running loop the constructor schedules nothing and connects nowhere.
    driver = Neo4jDriver("neo4j://localhost:7687", "neo4j", "unused")
    assert isinstance(driver.client, AsyncDriver)
    asyncio.run(driver.close())


def test_graphiti_index_build_runs_on_the_pooled_driver(driver_factory):
    """Neo4jDriver.__init__ schedules build_indices_and_constraints on the running
    loop. By the time that task runs it must find the pooled driver in `client`, not
    the default one open_graph_driver has already closed."""

    async def scenario():
        await graphiti_client.open_graph_driver()
        unpooled, pooled = driver_factory.built
        for _ in range(50):
            if pooled.queries:
                break
            await asyncio.sleep(0)
        assert pooled.queries, "the scheduled index build never ran"
        assert unpooled.queries == []

    asyncio.run(scenario())


def test_retry_wrapper_reraises_a_non_connection_error_at_once(engine):
    fake, resets = engine([ValueError("episode body is not text")])

    async def _run(g):
        return await g.add_episode()

    with pytest.raises(ValueError, match="episode body"):
        asyncio.run(main._graphiti_with_retry(_run))
    assert fake.calls == 1
    assert resets == []


@pytest.mark.parametrize(
    "path,body", [("/ingest", INGEST_BODY), ("/ingest-bulk", BULK_BODY), ("/search", SEARCH_BODY)]
)
def test_503_names_the_error_class_and_nothing_about_the_connection(
    client, headers, engine, path, body
):
    engine([LEAKY, LEAKY])
    r = client.post(path, json=body, headers=headers)
    assert r.status_code == 503
    detail = r.json()["detail"]
    assert "ServiceUnavailable" in detail
    for fragment in ("hunter2", "neo4j+s://", "abc123", "databases.neo4j.io", "7687"):
        assert fragment not in detail


@pytest.mark.parametrize("error", [DEFUNCT, EXPIRED], ids=type)
def test_ingest_bulk_retries_once_on_a_rebuilt_engine(client, headers, engine, error):
    fake, resets = engine([error])
    r = client.post("/ingest-bulk", json=BULK_BODY, headers=headers)
    assert r.status_code == 200
    assert r.json() == {"episode_ids": ["ep-1"]}
    assert fake.calls == 2
    assert resets == [True]


def test_ingest_bulk_answers_503_when_the_retry_fails_too(client, headers, engine):
    fake, resets = engine([EXPIRED, DEFUNCT])
    r = client.post("/ingest-bulk", json=BULK_BODY, headers=headers)
    assert r.status_code == 503
    assert "ServiceUnavailable" in r.json()["detail"]
    assert fake.calls == 2
    assert resets == [True]


# --- busy pool: load is not a dead connection -----------------------------------------


class _Session:
    """A raw-driver session whose first query fails with the pool's scripted error."""

    def __init__(self, pool: "_QueryPool"):
        self.pool = pool

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False

    async def run(self, *_args, **_kwargs):
        # Yield first, so concurrent callers all reach the failure before any reset.
        await asyncio.sleep(0.01)
        if self.pool.error is not None:
            raise self.pool.error
        return []


class _QueryPool:
    """Stands in for the raw AsyncDriver on the query path: every query on it fails
    with `error`, or succeeds when `error` is None."""

    def __init__(self, error: Exception | None = None):
        self.error = error
        self.closed = False

    def session(self, **_kwargs):
        return _Session(self)

    async def close(self):
        self.closed = True


async def _one_query(session):
    return await session.run("RETURN 1")


@pytest.mark.parametrize(
    "path,body", [("/ingest", INGEST_BODY), ("/ingest-bulk", BULK_BODY), ("/search", SEARCH_BODY)]
)
def test_a_busy_pool_answers_503_without_a_retry_or_a_reset(client, headers, engine, path, body):
    fake, resets = engine([POOL_TIMEOUT])
    r = client.post(path, json=body, headers=headers)
    assert r.status_code == 503
    assert "overloaded" in r.json()["detail"]
    assert r.headers["retry-after"] == "1"
    # Neither a retry nor a rebuild: both add load to a pool that has none to spare.
    assert fake.calls == 1
    assert resets == []


def test_a_transient_neo4j_error_is_retried_on_the_same_engine(client, headers, engine):
    fake, resets = engine([TransientError("Neo.TransientError.Transaction.DeadlockDetected")])
    r = client.post("/search", json=SEARCH_BODY, headers=headers)
    assert r.status_code == 200
    assert fake.calls == 2
    assert resets == []


def test_a_busy_pool_on_a_raw_driver_route_answers_503_and_keeps_the_driver(
    client, headers, monkeypatch
):
    busy = _QueryPool(POOL_TIMEOUT)

    async def _engine_ready():
        return None

    monkeypatch.setattr(graphiti_client, "get_graphiti", _engine_ready)
    monkeypatch.setattr(graphiti_client, "_driver", busy)
    monkeypatch.setattr(graphiti_client, "open_driver", lambda: _QueryPool())

    r = client.post("/graph", json={"group_ids": ["org_1"]}, headers=headers)

    assert r.status_code == 503
    assert "overloaded" in r.json()["detail"]
    assert graphiti_client._driver is busy
    assert busy.closed is False


def test_health_check_on_a_busy_pool_answers_false_and_keeps_the_driver(monkeypatch):
    busy = _FakePool({}, verify_error=POOL_TIMEOUT)
    replacements = []
    monkeypatch.setattr(graphiti_client, "_driver", busy)
    monkeypatch.setattr(
        graphiti_client,
        "open_driver",
        lambda: replacements.append(_FakePool({})) or replacements[-1],
    )

    assert asyncio.run(graphiti_client.neo4j_healthy()) is False
    assert busy.closed is False
    assert graphiti_client._driver is busy
    assert replacements == []


def test_health_answers_degraded_within_its_bound_while_neo4j_does_not_answer(client, monkeypatch):
    async def _no_answer():
        await asyncio.sleep(3)
        return True

    monkeypatch.setattr(main, "neo4j_healthy", _no_answer)
    monkeypatch.setattr(main, "HEALTH_NEO4J_TIMEOUT_S", 0.2, raising=False)

    started = time.monotonic()
    r = client.get("/health")
    elapsed = time.monotonic() - started

    assert elapsed < 1.5
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "degraded"
    assert body["neo4j"] is False
    assert "did not answer" in body["error"]


def test_keepalive_keeps_engine_on_a_busy_pool(monkeypatch, engine):
    _fake, resets = engine([])

    async def _healthy():
        return True

    async def _busy_search(_g, _query, _group, _limit):
        raise POOL_TIMEOUT

    monkeypatch.setattr(main, "neo4j_healthy", _healthy)
    monkeypatch.setattr(main, "search_edges", _busy_search)

    asyncio.run(main._keepalive_tick())
    assert resets == []


def test_callers_that_lose_one_raw_driver_reset_it_once(monkeypatch):
    dead = _QueryPool(DEFUNCT)
    opened: list[_QueryPool] = []

    def _open():
        opened.append(_QueryPool())
        return opened[-1]

    monkeypatch.setattr(graphiti_client, "_driver", dead)
    monkeypatch.setattr(graphiti_client, "open_driver", _open)

    async def burst():
        return await asyncio.gather(
            *(graphiti_client._run_with_retry(_one_query) for _ in range(20))
        )

    assert asyncio.run(burst()) == [[]] * 20
    assert dead.closed is True
    # One replacement, still open: no caller closed the driver another one had just opened.
    assert len(opened) == 1
    assert opened[0].closed is False
    assert graphiti_client._driver is opened[0]


_DRIVER_CLOSED = DriverError("Driver closed")


class _EngineParts:
    """Replaces what building the Graphiti engine constructs, and counts each build.
    The first engine's searches fail with `first_engine_error`; later ones answer."""

    def __init__(
        self,
        monkeypatch,
        first_engine_error: Exception | None = None,
        open_error: Exception | None = None,
        failing_calls: int | None = None,
        closed_error: Exception = _DRIVER_CLOSED,
    ):
        self.drivers_opened = 0
        self.embedders = 0
        self.engines: list = []
        self.open_error = open_error
        parts = self

        class _Engine:
            def __init__(self, **_kwargs):
                self.closed = False
                self.searches = 0
                self.error = first_engine_error if not parts.engines else None
                parts.engines.append(self)

            async def build_indices_and_constraints(self):
                await asyncio.sleep(0.01)

            async def search_(self, **_kwargs):
                # Each call on an engine answers a little later than the one before, so
                # some callers fail on the first engine after its replacement is built
                # (the first retry waits 0.5 s before it asks for the engine again).
                self.searches += 1
                call = self.searches
                await asyncio.sleep(0.04 * call)
                # A query on an engine another caller has closed: "Driver closed", or the
                # lost connection itself when the close cut a query already under way.
                if self.closed:
                    raise closed_error
                if self.error is not None and (failing_calls is None or call <= failing_calls):
                    raise self.error
                return SimpleNamespace(edges=[])

            async def close(self):
                self.closed = True

        class _Embedder:
            def __init__(self, *_args):
                parts.embedders += 1
                self.models = None

        async def _open_graph_driver():
            await asyncio.sleep(0.01)
            parts.drivers_opened += 1
            if parts.open_error is not None:
                raise parts.open_error
            return SimpleNamespace(client=None)

        async def _no_repair():
            return 0

        monkeypatch.setattr(graphiti_client, "Graphiti", _Engine)
        monkeypatch.setattr(graphiti_client, "BGEEmbedder", _Embedder)
        monkeypatch.setattr(graphiti_client, "QuotaAwareLLMClient", lambda *_args, **_kwargs: None)
        monkeypatch.setattr(graphiti_client, "ModelProviderClient", lambda *_args, **_kwargs: None)
        monkeypatch.setattr(graphiti_client, "open_graph_driver", _open_graph_driver)
        monkeypatch.setattr(graphiti_client, "repair_transferred_entities", _no_repair)
        monkeypatch.setattr(graphiti_client, "ensure_one_fallback_anchor_per_scope", _no_repair)
        monkeypatch.setattr(graphiti_client, "_graphiti", None)
        monkeypatch.setattr(graphiti_client, "_indices_built", False)
        monkeypatch.setattr(graphiti_client, "_embedder", None, raising=False)
        monkeypatch.setattr(graphiti_client, "_building", None, raising=False)
        # main imported these by name; point it at the real single-flight versions.
        monkeypatch.setattr(main, "get_graphiti", graphiti_client.get_graphiti)
        monkeypatch.setattr(main, "_reset_graphiti", graphiti_client._reset_graphiti)


def test_concurrent_callers_share_one_engine_build(monkeypatch):
    parts = _EngineParts(monkeypatch)

    async def burst():
        return await asyncio.gather(*(graphiti_client.get_graphiti() for _ in range(50)))

    engines = asyncio.run(burst())
    assert parts.drivers_opened == 1
    assert len(parts.engines) == 1
    assert all(engine is parts.engines[0] for engine in engines)


def test_callers_that_lose_one_engine_rebuild_it_once(monkeypatch):
    parts = _EngineParts(monkeypatch, first_engine_error=DEFUNCT, closed_error=DEFUNCT)

    async def burst():
        await graphiti_client.get_graphiti()
        return await asyncio.gather(
            *(main._graphiti_with_retry(lambda g: g.search_()) for _ in range(20))
        )

    results = asyncio.run(burst())
    assert len(results) == 20
    # The first engine and exactly one rebuild, whatever the number of callers.
    assert parts.drivers_opened == 2
    assert len(parts.engines) == 2
    assert parts.engines[0].closed is True
    assert parts.engines[1].closed is False


def test_a_failed_build_fails_every_waiting_caller_and_the_next_call_builds_again(monkeypatch):
    parts = _EngineParts(monkeypatch, open_error=DEFUNCT)

    async def scenario():
        failed = await asyncio.gather(
            *(graphiti_client.get_graphiti() for _ in range(10)), return_exceptions=True
        )
        parts.open_error = None
        return failed, await graphiti_client.get_graphiti()

    failed, engine = asyncio.run(scenario())
    assert all(result is DEFUNCT for result in failed)
    assert parts.drivers_opened == 2
    assert engine is parts.engines[-1]


def test_a_rebuild_keeps_the_local_model(monkeypatch):
    parts = _EngineParts(monkeypatch, first_engine_error=DEFUNCT)

    asyncio.run(main._graphiti_with_retry(lambda g: g.search_()))

    assert len(parts.engines) == 2
    assert parts.embedders == 1


def test_embed_answers_while_the_graph_engine_cannot_be_built(client, headers, monkeypatch):
    parts = _EngineParts(monkeypatch)

    async def _never_connects():
        await asyncio.sleep(3)

    class _Embedder:
        async def create(self, _text):
            return [0.25] * settings.bge_dim

    monkeypatch.setattr(graphiti_client, "open_graph_driver", _never_connects)
    monkeypatch.setattr(graphiti_client, "_embedder", _Embedder(), raising=False)

    started = time.monotonic()
    r = client.post("/embed", json={"text": "who runs Acme"}, headers=headers)
    elapsed = time.monotonic() - started

    assert r.status_code == 200
    assert len(r.json()["embedding"]) == settings.bge_dim
    assert elapsed < 1.5
    assert parts.engines == []


# --- a driver another caller closed ------------------------------------------------


class _DyingPool(_QueryPool):
    """A raw driver whose first query finds the connection lost; queries already under
    way when it is closed then fail the way neo4j 6 fails them, "Driver closed"."""

    def __init__(self):
        super().__init__()
        self.queries = 0

    def session(self, **_kwargs):
        pool = self

        class _OneSession(_Session):
            async def run(self, *_args, **_kwargs):
                pool.queries += 1
                call = pool.queries
                await asyncio.sleep(0.01 * call)
                if call == 1:
                    raise DEFUNCT
                if pool.closed:
                    raise DriverError("Driver closed")
                return []

        return _OneSession(self)


def test_a_query_on_a_driver_another_caller_closed_retries_on_the_new_one(monkeypatch):
    dying = _DyingPool()
    opened: list[_QueryPool] = []

    def _open():
        opened.append(_QueryPool())
        return opened[-1]

    monkeypatch.setattr(graphiti_client, "_driver", dying)
    monkeypatch.setattr(graphiti_client, "open_driver", _open)

    async def burst():
        return await asyncio.gather(
            *(graphiti_client._run_with_retry(_one_query) for _ in range(5))
        )

    assert asyncio.run(burst()) == [[]] * 5
    assert len(opened) == 1
    assert opened[0].closed is False


def test_driver_closed_on_the_current_driver_is_raised_not_retried(monkeypatch):
    closed = _QueryPool(DriverError("Driver closed"))
    monkeypatch.setattr(graphiti_client, "_driver", closed)
    monkeypatch.setattr(
        graphiti_client, "open_driver", lambda: pytest.fail("nothing replaced the driver")
    )
    queries = []

    async def _counted(session):
        queries.append(1)
        return await _one_query(session)

    with pytest.raises(DriverError, match="Driver closed"):
        asyncio.run(graphiti_client._run_with_retry(_counted))
    assert len(queries) == 1


def test_a_search_on_an_engine_another_caller_closed_retries_on_the_new_one(
    client, headers, monkeypatch
):
    parts = _EngineParts(monkeypatch, first_engine_error=DEFUNCT, failing_calls=1)

    async def burst():
        await graphiti_client.get_graphiti()
        return await asyncio.gather(
            *(main._graphiti_with_retry(lambda g: g.search_()) for _ in range(5))
        )

    results = asyncio.run(burst())
    assert len(results) == 5
    # One rebuild for the lost connection; the callers that then found the old engine
    # closed moved to the new one without another.
    assert len(parts.engines) == 2
    assert parts.engines[1].closed is False
