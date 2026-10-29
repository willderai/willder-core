"""QA: the model queue's priority rule holds at the routes, not only inside the queue.

`test_model_work.py` proves the queue orders FOREGROUND before BACKGROUND. These tests
prove the callers put each model call on the side the rule says: every model call an
/ingest or /ingest-bulk makes (Graphiti's extraction and the verbatim fallback node it
writes afterwards) runs at background priority, and Graphiti's embedder runs on the
shared queue rather than on a thread of its own."""

import asyncio
import threading

from app import main, model_work
from app.graphiti_client import BGEEmbedder


def _priority() -> int:
    return model_work._priority.get()


class _EdgelessEpisode:
    uuid = "ep-1"


class _EdgelessResult:
    episode = _EdgelessEpisode()
    nodes: list = []
    edges: list = []


def test_every_model_call_an_ingest_makes_runs_at_background_priority(client, headers, monkeypatch):
    seen: dict[str, int] = {}

    class _Graphiti:
        async def add_episode(self, **kwargs):
            seen["extraction"] = _priority()
            return _EdgelessResult()

    async def _get():
        return _Graphiti()

    async def _fallback(**kwargs):
        # ensure_graph_visible embeds `content` through the shared embedder.
        seen["fallback"] = _priority()
        return True

    monkeypatch.setattr(main, "get_graphiti", _get)
    monkeypatch.setattr(main, "ensure_graph_visible", _fallback)

    r = client.post(
        "/ingest",
        json={"group_id": "org_1", "content": "an abstract fact", "actor_id": "user_1"},
        headers=headers,
    )
    assert r.status_code == 200
    assert seen == {"extraction": model_work.BACKGROUND, "fallback": model_work.BACKGROUND}


def test_every_model_call_a_bulk_ingest_makes_runs_at_background_priority(
    client, headers, monkeypatch
):
    seen: list[tuple[str, int]] = []

    class _Episode:
        uuid = "ep-a"

    class _BulkResult:
        episodes = [_Episode()]
        nodes: list = []
        edges: list = []
        episodic_edges: list = []

    class _Graphiti:
        async def add_episode_bulk(self, **kwargs):
            seen.append(("extraction", _priority()))
            return _BulkResult()

    async def _get():
        return _Graphiti()

    async def _fallback(**kwargs):
        seen.append(("fallback", _priority()))
        return True

    monkeypatch.setattr(main, "get_graphiti", _get)
    monkeypatch.setattr(main, "ensure_graph_visible", _fallback)

    r = client.post(
        "/ingest-bulk",
        json={
            "group_id": "org_1",
            "episodes": [{"group_id": "org_1", "content": "fact A", "actor_id": "user_1"}],
        },
        headers=headers,
    )
    assert r.status_code == 200
    assert seen == [("extraction", model_work.BACKGROUND), ("fallback", model_work.BACKGROUND)]


class _FakeSentenceModel:
    def encode(self, texts, normalize_embeddings):
        return [_Vector(len(text)) for text in texts]


class _Vector:
    def __init__(self, n):
        self.n = n

    def tolist(self):
        return [float(self.n)]


async def _hold(models: model_work.ModelQueue) -> tuple[asyncio.Task, threading.Event]:
    release, started = threading.Event(), threading.Event()

    def busy():
        started.set()
        release.wait(5)

    task = asyncio.create_task(models.call(busy))
    while not started.is_set():
        await asyncio.sleep(0.001)
    return task, release


def test_the_embedder_waits_its_turn_on_the_shared_queue():
    async def run():
        embedder = BGEEmbedder("unused", 1)
        embedder._model = _FakeSentenceModel()

        busy, release = await _hold(embedder.models)
        single = asyncio.create_task(embedder.create("abc"))
        batch = asyncio.create_task(embedder.create_batch(["a", "bb"]))
        await asyncio.sleep(0.05)
        # The model thread is held, so nothing routed through the queue can have finished.
        waiting = [not task.done() for task in (single, batch)]
        release.set()
        await busy
        return waiting, await single, await batch

    waiting, single, batch = asyncio.run(run())
    assert waiting == [True, True]
    assert single == [3.0]
    assert batch == [[1.0], [2.0]]
