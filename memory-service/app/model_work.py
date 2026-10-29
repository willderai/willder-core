"""One queue for every local model call, so a request is never stuck behind an ingest.

The embedding model runs on this service's CPU. One encode already spreads across every
core, so two encodes side by side only slow each other down, and a write's own embedding
(POST /embed, on the request path of every memory write) used to wait behind the graph
extraction of earlier writes: with twelve writes at once plus their extraction running,
that one call went from about 30 ms alone to the better part of a second.

The rule this module enforces: model calls run one at a time on one dedicated thread, and
every call made while serving a request goes before any call made by a background ingest
(see `background_priority`). Texts waiting to be encoded at the same priority are encoded
together in one call, so a burst of single texts costs about one batch, not one encode
each. An idle queue starts a call at once: nothing waits for a batch to fill.
"""

import asyncio
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Callable, Iterator

FOREGROUND = 0
BACKGROUND = 1

_priority: ContextVar[int] = ContextVar("model_priority", default=FOREGROUND)


@contextmanager
def background_priority() -> Iterator[None]:
    """Run the model calls made inside this block, and in tasks it starts, after every
    request's own calls. For work no caller is waiting on, such as graph extraction."""
    token = _priority.set(BACKGROUND)
    try:
        yield
    finally:
        _priority.reset(token)


@dataclass
class _Encode:
    text: str
    result: asyncio.Future = field(repr=False)


@dataclass
class _Call:
    run: Callable[[], object]
    result: asyncio.Future = field(repr=False)


class ModelQueue:
    """Runs model calls in priority order on one thread. `encode` takes the function that
    turns a list of texts into a list of vectors, so batching is this queue's business."""

    def __init__(self, encode: Callable[[list[str]], list[list[float]]]):
        self._encode = encode
        self._thread = ThreadPoolExecutor(max_workers=1, thread_name_prefix="model")
        self._waiting: tuple[deque, deque] = (deque(), deque())
        # The running drain, held here because the event loop keeps only a weak
        # reference to a task: an unreferenced one can be collected mid-run.
        self._drainer: asyncio.Task | None = None

    async def encode(self, text: str) -> list[float]:
        """The vector for one text, encoded with whatever else is waiting at its priority."""
        return await self._enqueue(lambda future: _Encode(text, future))

    async def call(self, run: Callable[[], object]):
        """Run `run` on the model thread in its turn and return what it returns."""
        return await self._enqueue(lambda future: _Call(run, future))

    async def _enqueue(self, make):
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        self._waiting[_priority.get()].append(make(future))
        if self._drainer is None:
            self._drainer = loop.create_task(self._drain())
        return await future

    def _next(self) -> tuple[Callable[[], object], list]:
        """The next unit of work and the waiters it answers: every waiting text of the
        highest waiting priority in one encode, or the oldest call."""
        queue = self._waiting[FOREGROUND] or self._waiting[BACKGROUND]
        if isinstance(queue[0], _Encode):
            texts = [item for item in queue if isinstance(item, _Encode)]
            calls = [item for item in queue if not isinstance(item, _Encode)]
            queue.clear()
            queue.extend(calls)
            batch = [item.text for item in texts]
            return (lambda: self._encode(batch)), texts
        item = queue.popleft()
        return item.run, [item]

    async def _drain(self) -> None:
        loop = asyncio.get_running_loop()
        try:
            while self._waiting[FOREGROUND] or self._waiting[BACKGROUND]:
                run, waiters = self._next()
                try:
                    result = await loop.run_in_executor(self._thread, run)
                except Exception as exc:  # every waiter on this unit gets the failure
                    for waiter in waiters:
                        if not waiter.result.done():
                            waiter.result.set_exception(exc)
                    continue
                results = result if isinstance(waiters[0], _Encode) else [result]
                for waiter, value in zip(waiters, results, strict=False):
                    if not waiter.result.done():
                        waiter.result.set_result(value)
        finally:
            self._drainer = None
