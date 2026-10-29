"""The model queue (app/model_work.py): one call at a time, a request's own calls before
a background ingest's, and waiting texts encoded together. Each case holds the model
thread busy with a call it releases by hand, so what queues behind it is decided by the
test, not by timing."""

import asyncio
import threading

from app.model_work import ModelQueue, background_priority


class FakeModel:
    """Encodes a text as [its length], recording every batch it was given."""

    def __init__(self, fail_on: str | None = None):
        self.batches: list[list[str]] = []
        self.fail_on = fail_on

    def encode(self, texts: list[str]) -> list[list[float]]:
        self.batches.append(list(texts))
        if self.fail_on in texts:
            raise RuntimeError("model failed")
        return [[float(len(text))] for text in texts]


async def hold_model_thread(models: ModelQueue) -> tuple[asyncio.Task, threading.Event]:
    """Start a call that occupies the model thread until the returned event is set."""
    release = threading.Event()
    started = threading.Event()

    def busy():
        started.set()
        release.wait(5)
        return "held"

    task = asyncio.create_task(models.call(busy))
    while not started.is_set():
        await asyncio.sleep(0.001)
    return task, release


async def queued(coroutine) -> asyncio.Task:
    """Start `coroutine` and let it reach the queue before returning."""
    task = asyncio.create_task(coroutine)
    await asyncio.sleep(0)
    return task


def test_an_idle_queue_encodes_a_text_at_once():
    async def run():
        model = FakeModel()
        models = ModelQueue(model.encode)
        return await models.encode("hello"), model.batches

    vector, batches = asyncio.run(run())
    assert vector == [5.0]
    assert batches == [["hello"]]


def test_texts_waiting_at_one_priority_are_encoded_in_one_call():
    async def run():
        model = FakeModel()
        models = ModelQueue(model.encode)
        busy, release = await hold_model_thread(models)
        waiting = [await queued(models.encode(text)) for text in ("a", "bb", "ccc")]
        release.set()
        await busy
        return [await task for task in waiting], model.batches

    vectors, batches = asyncio.run(run())
    assert vectors == [[1.0], [2.0], [3.0]]
    assert batches == [["a", "bb", "ccc"]]


def test_a_request_is_served_before_background_work_that_queued_first():
    async def run():
        model = FakeModel()
        models = ModelQueue(model.encode)
        busy, release = await hold_model_thread(models)

        async def extraction():
            with background_priority():
                # A task started inside the block inherits its priority.
                return await asyncio.gather(
                    models.encode("bg-1"), models.call(lambda: model.encode(["bg-batch"]))
                )

        background = await queued(extraction())
        await asyncio.sleep(0)
        request = await queued(models.encode("request"))
        release.set()
        await busy
        await request
        await background
        return model.batches

    assert asyncio.run(run()) == [["request"], ["bg-1"], ["bg-batch"]]


def test_a_failed_encode_fails_every_text_in_its_batch_and_the_queue_goes_on():
    async def run():
        model = FakeModel(fail_on="bad")
        models = ModelQueue(model.encode)
        busy, release = await hold_model_thread(models)
        waiting = [await queued(models.encode(text)) for text in ("ok", "bad")]
        release.set()
        await busy
        outcomes = await asyncio.gather(*waiting, return_exceptions=True)
        after = await models.encode("next")
        return outcomes, after

    outcomes, after = asyncio.run(run())
    assert all(isinstance(outcome, RuntimeError) for outcome in outcomes)
    assert after == [4.0]


def test_background_priority_ends_with_its_block():
    async def run():
        model = FakeModel()
        models = ModelQueue(model.encode)
        busy, release = await hold_model_thread(models)
        with background_priority():
            background = await queued(models.encode("bg"))
        request = await queued(models.encode("fg"))
        release.set()
        await asyncio.gather(busy, background, request)
        return model.batches

    assert asyncio.run(run()) == [["fg"], ["bg"]]


def test_calls_run_one_at_a_time():
    async def run():
        models = ModelQueue(FakeModel().encode)
        active = 0
        most = 0
        lock = threading.Lock()

        def call():
            nonlocal active, most
            with lock:
                active += 1
                most = max(most, active)
            threading.Event().wait(0.01)
            with lock:
                active -= 1
            return True

        await asyncio.gather(*(models.call(call) for _ in range(3)))
        return most

    assert asyncio.run(run()) == 1
