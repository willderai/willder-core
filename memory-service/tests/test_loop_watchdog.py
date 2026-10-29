"""The event-loop watchdog: a loop that stops turning ends the process, one that is
only waiting does not.

The seam is `LoopWatchdog.start(loop)` with an injected `on_stall`, so a test can block
a real loop and see the watchdog fire without ending the test run. The app-level test
drives the real lifespan through TestClient and blocks its loop thread directly.
"""

import asyncio
import functools
import threading
import time

from fastapi.testclient import TestClient

from app import main, watchdog
from app.config import settings
from app.watchdog import LoopWatchdog


def _run_with_watchdog(body, stall_limit_s: float) -> list[float]:
    """Run `body` on a fresh loop under a watchdog and return each stall it reported."""
    stalls: list[float] = []

    def on_stall(stalled_s: float) -> None:
        stalls.append(stalled_s)

    async def scenario():
        dog = LoopWatchdog(stall_limit_s, on_stall=on_stall, beat_s=0.05)
        dog.start(asyncio.get_running_loop())
        try:
            await body()
            # Give the watcher thread one more check after the body returns.
            await asyncio.sleep(0.2)
        finally:
            dog.stop()

    asyncio.run(scenario())
    return stalls


def test_a_blocked_loop_is_reported_once():
    async def block_the_loop():
        # A synchronous call on the loop thread: nothing else on this loop can run.
        time.sleep(1.5)  # noqa: ASYNC251 — blocking the loop is the scenario

    stalls = _run_with_watchdog(block_the_loop, stall_limit_s=0.3)

    assert len(stalls) == 1, "the watchdog fires once per stall, not on every check"
    assert stalls[0] >= 0.3


def test_the_watchdog_fires_before_the_blocking_call_returns():
    """A hung process never returns from the blocking call, so firing only afterwards
    would be no fix at all: the report has to come from the watcher thread mid-block."""
    seen_mid_block: list[bool] = []
    stalls: list[float] = []

    async def block_the_loop():
        time.sleep(1.5)  # noqa: ASYNC251 — blocking the loop is the scenario
        # Still on the blocked loop thread: nothing has run on the loop since the sleep.
        seen_mid_block.append(bool(stalls))

    def on_stall(stalled_s: float) -> None:
        stalls.append(stalled_s)

    async def scenario():
        dog = LoopWatchdog(0.3, on_stall=on_stall, beat_s=0.05)
        dog.start(asyncio.get_running_loop())
        try:
            await block_the_loop()
        finally:
            dog.stop()

    asyncio.run(scenario())
    assert seen_mid_block == [True]


def test_a_loop_that_is_only_waiting_is_not_a_stall():
    """Awaiting for longer than the limit leaves the loop free to run the heartbeat:
    a slow Neo4j call or a long ingest must never restart the service."""

    async def wait_a_while():
        await asyncio.sleep(1.0)

    assert _run_with_watchdog(wait_a_while, stall_limit_s=0.3) == []


def test_stop_ends_the_watcher_thread():
    async def scenario():
        dog = LoopWatchdog(0.3, on_stall=lambda _s: None, beat_s=0.05)
        dog.start(asyncio.get_running_loop())
        await asyncio.sleep(0.1)
        dog.stop()
        return dog

    dog = asyncio.run(scenario())
    dog.join(timeout=1.0)
    assert not dog.is_watching()


def test_the_app_lifespan_runs_the_watchdog(monkeypatch):
    """The service itself, not just the class: block the app's own loop thread and the
    stall handler the lifespan installed is called.

    The loop thread is held until the handler has run (or a generous deadline passes), so
    no timing assumption decides the outcome. The lifespan builds its watchdog with the
    default 1 s beat, so a fixed 1 s block raced the watcher's 1 s check (2026-10-22:
    count 0 under CI load); the beat is shortened here so an idle loop never trips it."""
    stalls: list[float] = []
    fired = threading.Event()

    def on_stall(stalled_s: float) -> None:
        stalls.append(stalled_s)
        fired.set()

    monkeypatch.setattr(settings, "loop_stall_limit_s", 0.3)
    monkeypatch.setattr(main, "exit_with_stacks", on_stall)
    monkeypatch.setattr(main, "LoopWatchdog", functools.partial(LoopWatchdog, beat_s=0.05))

    async def no_warmup():
        return None

    monkeypatch.setattr(main, "_warmup", no_warmup)

    with TestClient(main.app) as client:
        assert client.get("/health").status_code == 200
        # Runs on the app's event-loop thread and holds it until the watcher reports.
        client.portal.call(fired.wait, 10.0)  # noqa: ASYNC251 — blocking the loop is the scenario

    assert len(stalls) == 1


def test_exit_with_stacks_dumps_every_thread_then_exits_with_failure(monkeypatch, capfd):
    exits: list[int] = []
    monkeypatch.setattr(watchdog.os, "_exit", exits.append)

    watchdog.exit_with_stacks(61.0)

    err = capfd.readouterr().err
    assert "test_exit_with_stacks_dumps_every_thread_then_exits_with_failure" in err
    assert exits == [watchdog.STALL_EXIT_STATUS]
    assert watchdog.STALL_EXIT_STATUS != 0


def test_exit_with_stacks_still_exits_when_stderr_cannot_take_the_dump(monkeypatch):
    exits: list[int] = []
    monkeypatch.setattr(watchdog.os, "_exit", exits.append)

    def no_descriptor(**_kwargs):
        raise ValueError("sys.stderr has no file descriptor")

    monkeypatch.setattr(watchdog.faulthandler, "dump_traceback", no_descriptor)

    try:
        watchdog.exit_with_stacks(61.0)
    except ValueError:
        pass  # the real os._exit never returns, so the error never surfaces in production

    assert exits == [watchdog.STALL_EXIT_STATUS]
