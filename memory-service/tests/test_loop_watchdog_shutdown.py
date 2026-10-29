"""A stopped watchdog never reports a stall, so a clean shutdown is never turned into a
failure exit (and a restart) once the loop has stopped beating.

`test_stop_ends_the_watcher_thread` in test_loop_watchdog.py cannot tell a working
`stop()` from a no-op: a watcher left running sees the dead loop as a stall within its
join timeout and exits on its own. These tests wait past the limit and assert silence.
"""

import asyncio
import time

from fastapi.testclient import TestClient

from app import main
from app.config import settings
from app.watchdog import LoopWatchdog

STALL_LIMIT_S = 0.3


def test_after_stop_a_dead_loop_is_not_reported():
    stalls: list[float] = []

    async def scenario():
        dog = LoopWatchdog(STALL_LIMIT_S, on_stall=stalls.append, beat_s=0.05)
        dog.start(asyncio.get_running_loop())
        await asyncio.sleep(0.1)
        dog.stop()
        return dog

    dog = asyncio.run(scenario())
    # The loop is closed: nothing beats any more. Wait well past the limit.
    time.sleep(STALL_LIMIT_S * 3)
    dog.join(timeout=1.0)

    assert stalls == []
    assert not dog.is_watching()


def test_app_shutdown_stops_the_watchdog(monkeypatch):
    stalls: list[float] = []
    monkeypatch.setattr(settings, "loop_stall_limit_s", STALL_LIMIT_S)
    monkeypatch.setattr(main, "exit_with_stacks", stalls.append)

    async def no_warmup():
        return None

    monkeypatch.setattr(main, "_warmup", no_warmup)

    with TestClient(main.app) as client:
        assert client.get("/health").status_code == 200

    # The app's loop has ended; a watchdog the lifespan forgot to stop would fire at
    # its next check. The lifespan's watchdog checks once a second, so wait past that.
    time.sleep(1.0 + STALL_LIMIT_S * 3)

    assert stalls == []
