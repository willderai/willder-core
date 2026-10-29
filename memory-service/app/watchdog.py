"""Ends this process when its event loop stops turning, so the platform restarts it.

Every route here is async, so nothing is answered while the event loop is stuck, not
even `/health`. On 2026-10-14 the deployed service went silent on every route right
after a Neo4j connection loss and stayed that way until it was restarted by hand: the
process was still alive, so the platform had nothing to restart. A loop that has not
run for `LOOP_STALL_LIMIT_S` is not coming back by itself.

The rule this module enforces: the loop stamps a heartbeat every `beat_s`, and a plain
thread, which needs no loop to run, checks it. A heartbeat older than the limit writes
every thread's stack to stderr, which names the call that blocked, and then ends the
process with a failure status, which the platform's restart policy answers with a
fresh one. Waiting is not stalling: a request awaiting a slow Neo4j call leaves the
loop free to beat, so only a loop that cannot run at all trips it.

A native call that holds the GIL and never returns stops this thread too; that case
is out of reach of anything written in Python.
"""

import asyncio
import faulthandler
import logging
import os
import sys
import threading
import time
from collections.abc import Callable

logger = logging.getLogger(__name__)

# The exit status after a stall. Non-zero, so an on-failure restart policy restarts.
STALL_EXIT_STATUS = 70


def exit_with_stacks(stalled_s: float) -> None:
    """Write every thread's stack to stderr, then end the process at once. `os._exit`,
    not `sys.exit`: shutdown would run on the stuck loop and never finish."""
    logger.critical(
        "event loop has not run for %.0f s; dumping every thread's stack and exiting so the service restarts",
        stalled_s,
    )
    try:
        for handler in logging.getLogger().handlers:
            handler.flush()
        faulthandler.dump_traceback(file=sys.stderr, all_threads=True)
        sys.stderr.flush()
    finally:
        # The stacks are for diagnosis; the restart is the fix, so it happens even if
        # stderr cannot take the dump (no file descriptor behind it).
        os._exit(STALL_EXIT_STATUS)


class LoopWatchdog:
    """Calls `on_stall(seconds)` once, from its own thread, when the loop it watches
    has not run for `stall_limit_s`."""

    def __init__(
        self,
        stall_limit_s: float,
        on_stall: Callable[[float], None] = exit_with_stacks,
        beat_s: float = 1.0,
    ):
        self._stall_limit_s = stall_limit_s
        self._on_stall = on_stall
        self._beat_s = beat_s
        self._last_beat = time.monotonic()
        self._beat_handle: asyncio.TimerHandle | None = None
        self._stopped = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        """Start beating on `loop` and watching from a daemon thread. Call it on the loop."""
        self._loop = loop
        self._beat()
        self._thread = threading.Thread(target=self._watch, name="loop-watchdog", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        """Stop beating and watching. Call it on the loop."""
        self._stopped.set()
        if self._beat_handle is not None:
            self._beat_handle.cancel()

    def join(self, timeout: float | None = None) -> None:
        if self._thread is not None:
            self._thread.join(timeout)

    def is_watching(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def _beat(self) -> None:
        self._last_beat = time.monotonic()
        self._beat_handle = self._loop.call_later(self._beat_s, self._beat)

    def _watch(self) -> None:
        while not self._stopped.wait(self._beat_s):
            stalled_s = time.monotonic() - self._last_beat
            if stalled_s > self._stall_limit_s:
                self._on_stall(stalled_s)
                return
